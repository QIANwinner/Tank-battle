// tb_achpet_smoke.js — v0.3.10 成就面板双币进度专项冒烟验证(CDP 驱动无头 Chrome)
// 稳定性设计:准备+断言合并单次 evaluate(含 awaitPromise)
// 用法: node tb_achpet_smoke.js [url]
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = process.env.TB_CHROME || 'C:/Users/21889/.agent-browser/browsers/chrome-win64/chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8124/index.html?test=1';
const PORT = 9349;

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
  const profile = process.env.TB_PROFILE || 'C:/tmp/tbachpet-profile';
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

  // ===== P1: 空成就 → got=0,total=全部成就 petReward 之和(测试内独立求和对比) =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      T.setAch([]);
      const all = T.achAllDefs();
      let expect = 0;
      for (const id of all) expect += T.achPetReward(id);
      const s = T.achPetStats();
      return JSON.stringify({ got: s.got, total: s.total, expect });
    })()`));
    t('P1 空成就 got=0 · total=全成就🐾之和', o.got === 0 && o.total === o.expect && o.total > 0, JSON.stringify(o));
  } catch (e) { t('P1 空成就 got=0', false, e.message); }

  // ===== P2: 解锁成就 → got 按档位累加(1+3),total 不变 =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      const before = T.achPetStats();
      T.grantAch("first");     // 1🐾
      T.grantAch("score5k");   // 3🐾
      const after = T.achPetStats();
      return JSON.stringify({ g0: before.got, g1: after.got, t0: before.total, t1: after.total });
    })()`));
    t('P2 解锁累加 got(0→4) · total 不变', o.g0 === 0 && o.g1 === 4 && o.t0 === o.t1, JSON.stringify(o));
  } catch (e) { t('P2 解锁累加 got', false, e.message); }

  // ===== P3: 面板统计条渲染(打开成就面板,DOM 含「宠物币进度」) =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      T.openAchNow();
      const body = document.getElementById("achBody");
      const html = body ? body.innerHTML : "";
      const statEl = body ? body.querySelector(".achPetStat") : null;
      return JSON.stringify({ hasRow: !!statEl, text: statEl ? statEl.textContent : "" });
    })()`));
    t('P3 面板统计条渲染(含🐾进度与🏅计数)', o.hasRow === true && o.text.indexOf('宠物币进度') >= 0 && o.text.indexOf('4') >= 0, JSON.stringify(o));
  } catch (e) { t('P3 面板统计条渲染', false, e.message); }

  // ===== P4: 全解锁 → got === total(进度封顶) =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      T.setAch(T.achAllDefs());
      const s = T.achPetStats();
      return JSON.stringify({ got: s.got, total: s.total });
    })()`));
    t('P4 全解锁 got===total', o.got === o.total && o.total > 0, JSON.stringify(o));
  } catch (e) { t('P4 全解锁 got===total', false, e.message); }

  chrome.kill();

  let pass = 0, fail = 0;
  for (const r of R) {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
    r.pass ? pass++ : fail++;
  }
  console.log('----');
  console.log('achpet smoke: ' + pass + ' pass, ' + fail + ' fail, ' + R.length + ' total');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
