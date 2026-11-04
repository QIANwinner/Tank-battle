// tb_endlessbond_smoke.js — v0.3.20 无尽里程碑×羁绊联动专项冒烟验证(CDP 驱动无头 Chrome)
// 设计:准备+断言合并单次 evaluate(JS 单线程同步块,确定性成立)
// 用法: node tb_endlessbond_smoke.js [url]
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = process.env.TB_CHROME || 'C:/Users/21889/.agent-browser/browsers/chrome-win64/chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8124/index.html?test=1';
const PORT = 9364;

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
  const profile = process.env.TB_PROFILE || 'C:/tmp/tbendlessbond-profile';
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

  // ===== E1: 无尽 + 11 波 + 无羁绊 → milestone=1 =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.startEndless(); T.setLevel(11);
      T.setHero('none'); T.setPetOwn([]);
      return JSON.stringify({ m: T.endlessMilestoneNow() });
    })()`));
    t('E1 无尽11波无羁绊 +1🐾', o.m === 1, JSON.stringify(o));
  } catch (e) { t('E1 无羁绊里程碑', false, e.message); }

  // ===== E2: 无尽 + 11 波 + 羁绊激活(剑刃×招财猫) → ×2 =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.startEndless(); T.setLevel(11);
      T.setHero('blade'); T.setPet('cat', 1);   // bondgold 激活
      const bond = T.bondNow();
      return JSON.stringify({ m: T.endlessMilestoneNow(), bond });
    })()`));
    t('E2 羁绊激活里程碑 ×2(+2🐾)', o.m === 2 && o.bond === 'bondgold', JSON.stringify(o));
  } catch (e) { t('E2 羁绊激活×2', false, e.message); }

  // ===== E3: 非里程碑波(10 波)→ 0 =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.startEndless(); T.setLevel(10);   // (10-1)%10=9≠0
      return JSON.stringify({ m: T.endlessMilestoneNow() });
    })()`));
    t('E3 非里程碑波 0', o.m === 0, JSON.stringify(o));
  } catch (e) { t('E3 非里程碑波', false, e.message); }

  // ===== E4: 非无尽模式 → 0 =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.startGame(); T.setLevel(11);   // normal 非无尽
      return JSON.stringify({ m: T.endlessMilestoneNow() });
    })()`));
    t('E4 非无尽 0', o.m === 0, JSON.stringify(o));
  } catch (e) { t('E4 非无尽', false, e.message); }

  // ===== E5: 宠物币来源提示含羁绊×2 说明(v0.3.28 文案更新) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      const hint = T.petEarnHintNow();
      // 用 ASCII/Unicode 转义匹配(避免中文编码不一致):+1( 与 ×(\u00d7)
      return JSON.stringify({ hint, ok: !!(hint && hint.indexOf('+1(') >= 0 && hint.indexOf('\u00d7') >= 0) });
    })()`));
    t('E5 宠物币来源提示含羁绊×2', o.ok === true, JSON.stringify(o));
  } catch (e) { t('E5 宠物币来源提示', false, e.message); }

  chrome.kill();

  let pass = 0, fail = 0;
  for (const r of R) {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
    r.pass ? pass++ : fail++;
  }
  console.log('----');
  console.log('endlessbond smoke: ' + pass + ' pass, ' + fail + ' fail, ' + R.length + ' total');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
