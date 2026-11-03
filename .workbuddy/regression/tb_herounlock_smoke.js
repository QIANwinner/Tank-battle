// tb_herounlock_smoke.js — v0.3.9 英雄解锁经济专项冒烟验证(CDP 驱动无头 Chrome)
// 稳定性设计:准备+断言合并单次 evaluate(含 awaitPromise)
// 用法: node tb_herounlock_smoke.js [url]
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = process.env.TB_CHROME || 'C:/Users/21889/.agent-browser/browsers/chrome-win64/chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8124/index.html?test=1';
const PORT = 9347;

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
  const profile = process.env.TB_PROFILE || 'C:/tmp/tbherounlock-profile';
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
  async function reload() {
    await client.send('Page.navigate', { url: URL });
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      const r = await client.send('Runtime.evaluate', { expression: '!!window.__tbTest', returnByValue: true });
      if (r.result && r.result.result && r.result.result.value === true) return true;
    }
    return false;
  }

  const R = [];
  const t = (name, pass, detail) => R.push({ name, pass: !!pass, detail: String(detail ?? '') });

  // ===== N1: 默认免费三件套已购,高价英雄未购 =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      return JSON.stringify({ owned: T.heroOwnedAll(), hero: T.heroNow(),
        sniperOwned: T.heroOwnedNow("sniper"), vanguardOwned: T.heroOwnedNow("vanguard"),
        bladeOwned: T.heroOwnedNow("blade"), fortressOwned: T.heroOwnedNow("fortress") });
    })()`));
    t('N1 默认免费三件套已购 · 狙击/先锋未购',
      o.sniperOwned === false && o.vanguardOwned === false && o.bladeOwned === true && o.fortressOwned === true && o.hero === 'none',
      JSON.stringify(o));
  } catch (e) { t('N1 默认免费三件套已购', false, e.message); }

  // ===== N2: 未购装备被拒 + 按钮渲染价格角标 =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      const ok = T.setHero("sniper");
      let btnTxt = "";
      document.querySelectorAll("#heroSeg button").forEach(b => { if (b.dataset.hero === "sniper") btnTxt = b.textContent; });
      return JSON.stringify({ ok, hero: T.heroNow(), btnTxt });
    })()`));
    t('N2 未购装备被拒 · 按钮价签(8🐾)', o.ok === false && o.hero === 'none' && o.btnTxt.indexOf('8🐾') >= 0, JSON.stringify(o));
  } catch (e) { t('N2 未购装备被拒', false, e.message); }

  // ===== N3: 解锁成功:扣🐾 + 自动装备 + 记入已拥有 =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      T.setPetCoins(20);
      const ok = T.buyHeroNow("sniper");
      return JSON.stringify({ ok, coins: T.petCoins(), hero: T.heroNow(), owned: T.heroOwnedNow("sniper") });
    })()`));
    t('N3 解锁狙击(-8🐾 · 自动装备)', o.ok === true && o.coins === 12 && o.hero === 'sniper' && o.owned === true, JSON.stringify(o));
  } catch (e) { t('N3 解锁狙击', false, e.message); }

  // ===== N4: 余额不足解锁被拒(先锋 12🐾 > 余 8🐾) =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      T.setHero("none"); T.setPetCoins(8);
      const ok = T.buyHeroNow("vanguard");
      return JSON.stringify({ ok, coins: T.petCoins(), hero: T.heroNow(), owned: T.heroOwnedNow("vanguard") });
    })()`));
    t('N4 余额不足解锁被拒(余8 < 12)', o.ok === false && o.coins === 8 && o.hero === 'none' && o.owned === false, JSON.stringify(o));
  } catch (e) { t('N4 余额不足解锁被拒', false, e.message); }

  // ===== N5: 重复购买只装备不扣费 =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      T.setPetCoins(30);
      const ok1 = T.buyHeroNow("vanguard");   // -12 → 18
      const c1 = T.petCoins();
      const ok2 = T.buyHeroNow("vanguard");   // 已拥有 → 仅装备
      return JSON.stringify({ ok1, c1, ok2, c2: T.petCoins(), hero: T.heroNow() });
    })()`));
    t('N5 重复购买只装备不扣费(18 保持)', o.ok1 === true && o.c1 === 18 && o.ok2 === true && o.c2 === 18 && o.hero === 'vanguard', JSON.stringify(o));
  } catch (e) { t('N5 重复购买只装备不扣费', false, e.message); }

  // ===== N6: 老档 grandfather(免费期已装备高价英雄 → 自动拥有) =====
  try {
    await ev('window.__tbTest.setRawSave("tank-battle-heros", "[]")');
    await ev('window.__tbTest.setRawSave("tank-battle-hero", "sniper")');
    await ev('window.__tbTest.setRawSave("tank-battle-petcoin", "5")');
    const ok = await reload();
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      return JSON.stringify({ hero: T.heroNow(), owned: T.heroOwnedNow("sniper"), coins: T.petCoins() });
    })()`));
    t('N6 老档 grandfather(自动拥有狙击)', ok && o.hero === 'sniper' && o.owned === true && o.coins === 5, JSON.stringify(o));
  } catch (e) { t('N6 老档 grandfather', false, e.message); }

  // ===== N7: 免费英雄随时可装备 · 解锁状态跨刷新持久化 =====
  try {
    const ok = await reload();
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      const blade = T.setHero("blade");
      const sniperOwned = T.heroOwnedNow("sniper");
      return JSON.stringify({ blade, sniperOwned, hero: T.heroNow() });
    })()`));
    t('N7 免费随时装备 · 解锁持久化', ok && o.blade === true && o.sniperOwned === true && o.hero === 'blade', JSON.stringify(o));
  } catch (e) { t('N7 免费随时装备 · 解锁持久化', false, e.message); }

  chrome.kill();

  let pass = 0, fail = 0;
  for (const r of R) {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
    r.pass ? pass++ : fail++;
  }
  console.log('----');
  console.log('herounlock smoke: ' + pass + ' pass, ' + fail + ' fail, ' + R.length + ' total');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
