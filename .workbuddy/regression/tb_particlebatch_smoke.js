// tb_particlebatch_smoke.js — v0.3.25 粒子 draw 合批专项冒烟验证(CDP 驱动无头 Chrome)
// 设计:准备+渲染+断言合并单次 evaluate(JS 单线程同步块,确定性成立)
// 用法: node tb_particlebatch_smoke.js [url]
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = process.env.TB_CHROME || 'C:/Users/21889/.agent-browser/browsers/chrome-win64/chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8124/index.html?test=1';
const PORT = 9368;

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
  const profile = process.env.TB_PROFILE || 'C:/tmp/tbparticlebatch-profile';
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

  // ===== PB1: 生成30个同色粒子 → 渲染 → 合批 buckets < particles =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.startGame(); T.skipIntro();
      T.particleRecycleAll();
      T.particleSpawn(200, 200, '#ff2d55', 30);   // 30 个同色粒子
      const before = T.particleInfo();
      T.renderOnce();                              // 渲染一帧(真实 draw)
      const stat = T.particleBatchNow();
      const after = T.particleInfo();
      return JSON.stringify({ before, stat, after });
    })()`));
    t('PB1 合批生效 buckets<particles(30)', o.stat.particles === 30 && o.stat.buckets < 30 && o.stat.buckets >= 1, JSON.stringify(o));
  } catch (e) { t('PB1 合批生效', false, e.message); }

  // ===== PB2: 渲染不破坏粒子(active 保持) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.particleRecycleAll();
      T.particleSpawn(200, 200, '#39ff14', 20);
      T.renderOnce();
      const info = T.particleInfo();
      return JSON.stringify({ active: info.active });
    })()`));
    t('PB2 渲染后粒子仍在(20)', o.active === 20, JSON.stringify(o));
  } catch (e) { t('PB2 渲染不破坏', false, e.message); }

  // ===== PB3: 无粒子 → buckets=0(空渲染安全) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.particleRecycleAll();
      T.renderOnce();
      const stat = T.particleBatchNow();
      return JSON.stringify({ particles: stat.particles, buckets: stat.buckets });
    })()`));
    t('PB3 无粒子 buckets=0', o.particles === 0 && o.buckets === 0, JSON.stringify(o));
  } catch (e) { t('PB3 无粒子', false, e.message); }

  chrome.kill();

  let pass = 0, fail = 0;
  for (const r of R) {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
    r.pass ? pass++ : fail++;
  }
  console.log('----');
  console.log('particlebatch smoke: ' + pass + ' pass, ' + fail + ' fail, ' + R.length + ' total');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
