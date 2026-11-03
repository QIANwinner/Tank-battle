// tb_bonddex_smoke.js — v0.3.12 羁绊图鉴专项冒烟验证(CDP 驱动无头 Chrome)
// 稳定性设计:准备+断言合并单次 evaluate(含 awaitPromise)
// 用法: node tb_bonddex_smoke.js [url]
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = process.env.TB_CHROME || 'C:/Users/21889/.agent-browser/browsers/chrome-win64/chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8124/index.html?test=1';
const PORT = 9353;

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
  const profile = process.env.TB_PROFILE || 'C:/tmp/tbbonddex-profile';
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
  // 打开商店宠物 Tab 并返回图鉴 DOM 摘要
  const openPetsAndSnap = `(function(){
    const T = window.__tbTest;
    T.setShopTab("pets"); T.renderShop();
    const dex = document.querySelector(".bondDex");
    const rows = dex ? Array.from(dex.querySelectorAll(".bdRow")).map(r => ({
      text: r.textContent, on: r.classList.contains("on")
    })) : [];
    return JSON.stringify({ hasDex: !!dex, rows });
  })()`;

  const R = [];
  const t = (name, pass, detail) => R.push({ name, pass: !!pass, detail: String(detail ?? '') });

  // ===== D1: 图鉴渲染 3 条,名称齐全 =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      T.setHero("none"); T.clearPet();
      return ${openPetsAndSnap};
    })()`));
    const allText = o.rows.map(r => r.text).join('|');
    const ok = o.hasDex && o.rows.length === 3 &&
      allText.indexOf('铜墙铁壁') >= 0 && allText.indexOf('刀口舔金') >= 0 && allText.indexOf('动如雷震') >= 0;
    t('D1 图鉴渲染 3 条名称齐全', ok, JSON.stringify(o).slice(0, 300));
  } catch (e) { t('D1 图鉴渲染 3 条', false, e.message); }

  // ===== D2: 默认无英雄 → 全部未激活(无 .on) =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      T.setHero("none"); T.clearPet();
      return ${openPetsAndSnap};
    })()`));
    const anyOn = o.rows.some(r => r.on);
    t('D2 默认全部未激活', o.hasDex && o.rows.length === 3 && !anyOn, JSON.stringify(o).slice(0, 300));
  } catch (e) { t('D2 默认全部未激活', false, e.message); }

  // ===== D3: 堡垒+守护龟 → 铜墙铁壁行激活(.on + 「激活中」) =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      T.setHero("fortress"); T.setPet("turtle", 1);
      return ${openPetsAndSnap};
    })()`));
    const row = o.rows.find(r => r.text.indexOf('铜墙铁壁') >= 0);
    const others = o.rows.filter(r => r.text.indexOf('铜墙铁壁') < 0);
    t('D3 匹配羁绊激活(铜墙铁壁 on · 其余 off)',
      !!row && row.on === true && row.text.indexOf('激活中') >= 0 && others.every(r => !r.on),
      JSON.stringify(o).slice(0, 300));
  } catch (e) { t('D3 匹配羁绊激活', false, e.message); }

  // ===== D4: 行文案含组合与效果(堡垒 × 守护龟 · 开局护盾) =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      T.setHero("none"); T.clearPet();
      return ${openPetsAndSnap};
    })()`));
    const row = o.rows.find(r => r.text.indexOf('铜墙铁壁') >= 0);
    const ok = !!row && row.text.indexOf('堡垒') >= 0 && row.text.indexOf('守护龟') >= 0 && row.text.indexOf('开局护盾') >= 0;
    t('D4 行文案含组合与效果', ok, row ? row.text : 'no row');
  } catch (e) { t('D4 行文案含组合与效果', false, e.message); }

  chrome.kill();

  let pass = 0, fail = 0;
  for (const r of R) {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
    r.pass ? pass++ : fail++;
  }
  console.log('----');
  console.log('bonddex smoke: ' + pass + ' pass, ' + fail + ' fail, ' + R.length + ' total');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
