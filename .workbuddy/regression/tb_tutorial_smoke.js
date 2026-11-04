// tb_tutorial_smoke.js — v0.3.24 新手指引系统说明(英雄/宠物/羁绊)专项冒烟验证(CDP 驱动无头 Chrome)
// 设计:准备+断言合并单次 evaluate(JS 单线程同步块,确定性成立)
// 用法: node tb_tutorial_smoke.js [url]
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = process.env.TB_CHROME || 'C:/Users/21889/.agent-browser/browsers/chrome-win64/chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8124/index.html?test=1';
const PORT = 9367;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function httpJson(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { resolve(d); }
      });
    });
    req.on('error', reject); req.end();
  });
}
function httpWaitJson(path, method, tries = 40) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tick = () => httpJson(path, method).then(resolve).catch(() => {
      if (++n >= tries) return reject(new Error('CDP not ready: ' + path));
      setTimeout(tick, 250);
    });
    tick();
  });
}
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const open = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  function send(method, params = {}) {
    return new Promise((resolve) => {
      const i = ++id; pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  return { ws, open, send };
}

async function main() {
  const profile = process.env.TB_PROFILE || 'C:/tmp/tbtutorial-profile';
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--mute-audio', '--hide-scrollbars', '--run-all-compositor-stages-before-draw',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' });
  console.log('chrome pid', chrome.pid);

  const ver = await httpWaitJson('/json/version');
  console.log('CDP ready:', ver.Browser);

  const targets = await httpJson('/json/list');
  let page = targets.find(t => t.type === 'page');
  if (!page) { page = await httpJson('/json/new?about:blank', 'PUT'); }
  const client = cdp(page.webSocketDebuggerUrl);
  await client.open;
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  try { await client.send('Page.bringToFront'); } catch (e) {}
  await client.send('Page.navigate', { url: URL });

  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(300);
    const r = await client.send('Runtime.evaluate', { expression: '!!window.__tbTest', returnByValue: true });
    ready = r.result && r.result.result && r.result.result.value === true;
  }
  if (!ready) { console.log('FAIL: game test hook never appeared'); chrome.kill(); process.exit(2); }
  console.log('game test hook ready');

  async function ev(expr) {
    const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  }

  const R = [];
  const t = (name, pass, detail) => R.push({ name, pass: !!pass, detail: String(detail ?? '') });

  // ===== T1: resetTutorial + showTutorial → tutBox 显示 =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.resetTutorial();
      T.showTutorial();
      return JSON.stringify({ shown: T.tutorialShown(), done: T.tutorialNow() });
    })()`));
    t('T1 引导显示', o.shown === true && o.done === false, JSON.stringify(o));
  } catch (e) { t('T1 引导显示', false, e.message); }

  // ===== T2: tutBody 含宠物/英雄/羁绊系统说明(桌面版) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      const b = T.tutorialBodyNow();
      return JSON.stringify({ has: !!(b && /宠物/.test(b) && /英雄/.test(b) && /羁绊/.test(b)), len: (b || '').length });
    })()`));
    t('T2 引导含宠物/英雄/羁绊说明', o.has === true && o.len > 0, JSON.stringify(o));
  } catch (e) { t('T2 引导含系统说明', false, e.message); }

  // ===== T3: 触屏版引导同样含系统说明(html.touch 类切换) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      document.documentElement.classList.add('touch');
      T.resetTutorial(); T.showTutorial();
      const b = T.tutorialBodyNow();
      document.documentElement.classList.remove('touch');
      return JSON.stringify({ has: !!(b && /宠物/.test(b) && /英雄/.test(b) && /羁绊/.test(b)), len: (b || '').length });
    })()`));
    t('T3 触屏引导含系统说明', o.has === true && o.len > 0, JSON.stringify(o));
  } catch (e) { t('T3 触屏引导含系统说明', false, e.message); }

  // ===== T4: dismissTutorial → 隐藏 + done =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.dismissTutorial();
      return JSON.stringify({ shown: T.tutorialShown(), done: T.tutorialNow() });
    })()`));
    t('T4 关闭引导隐藏+标记完成', o.shown === false && o.done === true, JSON.stringify(o));
  } catch (e) { t('T4 关闭引导', false, e.message); }

  chrome.kill();

  let pass = 0, fail = 0;
  for (const r of R) {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
    r.pass ? pass++ : fail++;
  }
  console.log('----');
  console.log('tutorial smoke: ' + pass + ' pass, ' + fail + ' fail, ' + R.length + ' total');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
