// tb_magnet_hero_smoke.js — v0.3.21 第5英雄磁暴(磁力主题)专项冒烟验证(CDP 驱动无头 Chrome)
// 设计:准备+断言合并单次 evaluate(JS 单线程同步块,确定性成立)
// 用法: node tb_magnet_hero_smoke.js [url]
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = process.env.TB_CHROME || 'C:/Users/21889/.agent-browser/browsers/chrome-win64/chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8124/index.html?test=1';
const PORT = 9365;

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
  const profile = process.env.TB_PROFILE || 'C:/tmp/tbmagnethero-profile';
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

  // ===== H1: HEROES 含 magnet(price 16) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      const defs = T.heroDefsNow();
      return JSON.stringify({ n: defs.length, has: defs.includes('magnet') });
    })()`));
    t('H1 第5英雄磁暴定义(共6名含magnet)', o.n === 6 && o.has === true, JSON.stringify(o));
  } catch (e) { t('H1 磁暴定义', false, e.message); }

  // ===== H2: 磁暴被动磁力半径 ×1.3(磁力猪 Lv1=48 → 62.4) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.setPetCoins(99); T.buyHeroNow('magnet'); T.setPet('pig', 1);
      const r = T.magnetRadiusNow();      // 48*1.3=62.4(无羁绊无风暴)
      return JSON.stringify({ r });
    })()`));
    t('H2 磁暴被动 48*1.3=62.4', Math.abs(o.r - 62.4) < 0.01, JSON.stringify(o));
  } catch (e) { t('H2 磁暴被动', false, e.message); }

  // ===== H3: 磁暴大招磁力风暴 ×3 → 62.4*3=187.2 =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.setMagnetStorm(3);
      const r = T.magnetRadiusNow();
      return JSON.stringify({ r });
    })()`));
    t('H3 磁暴大招 62.4*3=187.2', Math.abs(o.r - 187.2) < 0.01, JSON.stringify(o));
  } catch (e) { t('H3 磁暴大招', false, e.message); }

  // ===== H4: 磁暴大招触发 → magnetStorm>0 + 冷却>0 =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.startGame(); T.skipIntro();
      T.setMagnetStorm(0);
      T.triggerHeroUltNow();
      return JSON.stringify({ storm: T.magnetStormNow(), cd: T.heroUltNow ? T.heroUltNow() : -1 });
    })()`));
    t('H4 触发磁暴大招 storm>0 cd>0', o.storm > 0 && o.cd && o.cd.cd > 0 && o.cd.hero === 'magnet', JSON.stringify(o));
  } catch (e) { t('H4 触发磁暴大招', false, e.message); }

  chrome.kill();

  let pass = 0, fail = 0;
  for (const r of R) {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
    r.pass ? pass++ : fail++;
  }
  console.log('----');
  console.log('magnethero smoke: ' + pass + ' pass, ' + fail + ' fail, ' + R.length + ' total');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
