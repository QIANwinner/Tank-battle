// tb_save_migrate.js — v0.3.3 存档 schema 版本迁移专项冒烟验证（CDP 驱动无头 Chrome）
// 用法: node tb_save_migrate.js [url]
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = process.env.TB_CHROME || 'C:/Users/21889/.agent-browser/browsers/chrome-win64/chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8124/index.html?test=1';
const PORT = 9335;

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
  const profile = process.env.TB_PROFILE || 'C:/tmp/tbsave-profile';
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

  async function loadGame() {
    await client.send('Page.navigate', { url: URL });
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      const r = await client.send('Runtime.evaluate', { expression: '!!window.__tbTest', returnByValue: true });
      if (r.result && r.result.result && r.result.result.value === true) return true;
    }
    return false;
  }
  // 直接在当前页执行表达式并取回值（同步探针）
  async function ev(expr) {
    const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.result && r.result.result) return r.result.result.value;
    return undefined;
  }

  const R = [];
  const t = (name, pass, detail) => R.push({ name, pass: !!pass, detail: String(detail ?? '') });

  if (!(await loadGame())) { console.log('FAIL: game test hook never appeared'); chrome.kill(); process.exit(2); }
  console.log('game test hook ready');

  // ===== M0: 空存档 → 首次加载自动登记版本 =====
  try {
    await ev('localStorage.clear()');
    await loadGame();                       // 重新加载，migrateSave 对空档执行
    const lv = await ev('window.__tbTest.lsVer()');
    const sv = await ev('window.__tbTest.saveVer()');
    t('M0 空存档首次加载自动登记 LS_VER=1', lv === 1 && sv === 1, 'lsVer=' + lv + ' saveVer=' + sv);
  } catch (e) { t('M0 空存档首次加载自动登记 LS_VER=1', false, e.message); }

  // ===== M1: v0 存档（无版本号但有数据）→ 迁移后数据保留 =====
  try {
    await ev('localStorage.clear()');
    await ev("localStorage.setItem('tank-battle-coins','500')");
    await ev("localStorage.setItem('tank-battle-best','1200')");
    await ev("localStorage.setItem('tank-battle-bonus','{\"lifeup\":2,\"spd\":1}')");
    await loadGame();
    const lv = await ev('window.__tbTest.lsVer()');
    const coins = await ev('window.__tbTest.coinsNow()');
    const best = await ev('window.__tbTest.bestNow()');
    t('M1 v0 存档迁移后版本登记且数据保留', lv === 1 && coins === 500 && best === 1200, 'lsVer=' + lv + ' coins=' + coins + ' best=' + best);
  } catch (e) { t('M1 v0 存档迁移后版本登记且数据保留', false, e.message); }

  // ===== M2: 未来版本（LS_VER=99）→ 不被降级覆盖 =====
  try {
    await ev('localStorage.clear()');
    await ev("localStorage.setItem('tank-battle-ver','99')");
    await ev("localStorage.setItem('tank-battle-coins','777')");
    await loadGame();
    const lv = await ev('window.__tbTest.lsVer()');
    const coins = await ev('window.__tbTest.coinsNow()');
    t('M2 未来版本 99 不被覆盖且数据保留', lv === 99 && coins === 777, 'lsVer=' + lv + ' coins=' + coins);
  } catch (e) { t('M2 未来版本 99 不被覆盖且数据保留', false, e.message); }

  // ===== M3: 已是最新（LS_VER=1）→ no-op =====
  try {
    await ev('localStorage.clear()');
    await ev("localStorage.setItem('tank-battle-ver','1')");
    await ev("localStorage.setItem('tank-battle-coins','333')");
    await loadGame();
    const lv = await ev('window.__tbTest.lsVer()');
    const coins = await ev('window.__tbTest.coinsNow()');
    t('M3 已最新 LS_VER=1 no-op 数据保留', lv === 1 && coins === 333, 'lsVer=' + lv + ' coins=' + coins);
  } catch (e) { t('M3 已最新 LS_VER=1 no-op 数据保留', false, e.message); }

  // ===== M4: 迁移幂等（手动再跑一次不重复/不破坏） =====
  try {
    await ev('localStorage.clear()');
    await ev("localStorage.setItem('tank-battle-coins','100')");
    await loadGame();                        // 自动迁移 → lsVer=1
    const before = await ev('window.__tbTest.lsVer()');
    await ev('window.__tbTest.migrateNow()'); // 手动再触发
    const after = await ev('window.__tbTest.lsVer()');
    const coins = await ev('window.__tbTest.coinsNow()');
    t('M4 迁移幂等（重复执行不破坏）', before === 1 && after === 1 && coins === 100, 'before=' + before + ' after=' + after + ' coins=' + coins);
  } catch (e) { t('M4 迁移幂等（重复执行不破坏）', false, e.message); }

  chrome.kill();

  let pass = 0, fail = 0;
  for (const r of R) {
    if (r.pass) { pass++; console.log('  PASS ' + r.name); }
    else { fail++; console.log('  FAIL ' + r.name + ' — ' + r.detail); }
  }
  console.log('---');
  console.log(pass + ' pass, ' + fail + ' fail, ' + R.length + ' total');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
