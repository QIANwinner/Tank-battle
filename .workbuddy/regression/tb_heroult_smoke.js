// tb_heroult_smoke.js — v0.3.7 英雄大招专项冒烟验证(任务122②,CDP 驱动无头 Chrome)
// 稳定性设计:触发+读取合并为单次 evaluate,避免 CDP 往返期间游戏实时衰减造成断言抖动
// 用法: node tb_heroult_smoke.js [url]
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = process.env.TB_CHROME || 'C:/Users/21889/.agent-browser/browsers/chrome-win64/chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8124/index.html?test=1';
const PORT = 9339;

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
  const profile = process.env.TB_PROFILE || 'C:/tmp/tbheroult-profile';
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
  // 单次 evaluate 内:设英雄 → 开局 → 跳过开场 → 触发大招 → 快照(零往返衰减)
  const triggerAndSnap = (hid) => ev(`(function(){
    const T = window.__tbTest;
    T.setHero("${hid}"); T.startGame(); T.skipIntro();
    T.triggerHeroUltNow();
    return JSON.stringify(T.heroUltNow());
  })()`);

  const R = [];
  const t = (name, pass, detail) => R.push({ name, pass: !!pass, detail: String(detail ?? '') });

  // ===== U1: 无英雄时大招无效(不发、不进冷却) =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      T.setPetCoins(99); T.buyHeroNow("sniper"); T.buyHeroNow("vanguard"); T.setHero("none"); T.startGame(); T.skipIntro();
      T.triggerHeroUltNow();
      return JSON.stringify(T.heroUltNow());
    })()`));
    t('U1 无英雄触发无效(cd=0 · 无效果)', o.cd === 0 && o.rapid === 0, JSON.stringify(o));
  } catch (e) { t('U1 无英雄触发无效', false, e.message); }

  // ===== U2: 剑刃「狂暴速射」→ 双倍射速生效 + 进入冷却(快照内零衰减,rapid=5 整) =====
  try {
    const o = JSON.parse(await triggerAndSnap('blade'));
    t('U2 剑刃狂暴速射(rapid=5 · cd=45)', o.rapid === 5 && o.cd === 45, JSON.stringify(o));
  } catch (e) { t('U2 剑刃狂暴速射', false, e.message); }

  // ===== U3: 堡垒「圣盾冲击」→ 5 秒无敌(300 帧) =====
  try {
    const o = JSON.parse(await triggerAndSnap('fortress'));
    t('U3 堡垒圣盾冲击(inv=300)', o.inv === 300, JSON.stringify(o));
  } catch (e) { t('U3 堡垒圣盾冲击', false, e.message); }

  // ===== U4: 狙击「穿透一击」→ 下一发 pen999/×1.5 速/+2 体,射后清除 =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      T.setHero("sniper"); T.startGame(); T.skipIntro();
      T.triggerHeroUltNow();
      const snipe = T.heroUltNow().snipe;
      T.fireOnce();
      const b1 = T.bullets().slice(-1)[0];
      const cleared = T.heroUltNow().snipe;
      T.setPcd(0); T.fireOnce();
      const b2 = T.bullets().slice(-1)[0];
      return JSON.stringify({ snipe, b1, cleared, b2pen: b2.pen });
    })()`));
    t('U4 狙击穿透一击(pen999 · 9.75速 · size7 · 一次性)',
      o.snipe === true && o.b1.pen === 999 && Math.abs(o.b1.speed - 9.75) < 0.01 && o.b1.size === 7 && o.cleared === false && o.b2pen === 0,
      JSON.stringify(o));
  } catch (e) { t('U4 狙击穿透一击', false, e.message); }

  // ===== U5: 先锋「先锋冲锋」→ 1 秒无敌 + 进入冷却(位移随地形,断言无敌与冷却) =====
  try {
    const o = JSON.parse(await triggerAndSnap('vanguard'));
    t('U5 先锋冲锋(inv=60 · cd=45)', o.inv === 60 && o.cd === 45, JSON.stringify(o));
  } catch (e) { t('U5 先锋冲锋', false, e.message); }

  // ===== U6: 冷却单调衰减(30 起步,300ms 后必然下降;不受往返时长影响) =====
  try {
    const pair = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.setHero("blade"); T.startGame(); T.skipIntro();
      T.setHeroUltCd(30);
      const a = T.heroUltNow().cd;
      await new Promise(r => setTimeout(r, 300));
      const b = T.heroUltNow().cd;
      return JSON.stringify({ a, b });
    })()`));
    t('U6 冷却单调衰减(a=30 · b<a)', pair.a === 30 && pair.b < pair.a, 'a=' + pair.a + ' b=' + pair.b);
  } catch (e) { t('U6 冷却单调衰减', false, e.message); }

  // ===== U7: B 键触发就绪的大招 =====
  try {
    await ev('window.__tbTest.setHero("blade"); window.__tbTest.startGame(); window.__tbTest.skipIntro();');
    await ev('window.__tbTest.setHeroUltCd(0)');
    await ev('window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true }))');
    const cd = await ev('window.__tbTest.heroUltNow().cd');
    t('U7 B 键触发(进入冷却 cd>40)', cd > 40 && cd <= 45, 'cd=' + cd);
  } catch (e) { t('U7 B 键触发', false, e.message); }

  // ===== U8: 冷却中重复触发不重置(30 中途触发后仍在 30 附近,而非回到 45) =====
  try {
    await ev('window.__tbTest.setHero("blade"); window.__tbTest.startGame(); window.__tbTest.skipIntro();');
    await ev('window.__tbTest.setHeroUltCd(30)');
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      T.triggerHeroUltNow();
      return JSON.stringify(T.heroUltNow().cd);
    })()`));
    t('U8 冷却中重复触发无效(cd 仍在 30 附近,未重置 45)', o < 44 && o > 25, 'cd=' + o);
  } catch (e) { t('U8 冷却中重复触发无效', false, e.message); }

  chrome.kill();

  let pass = 0, fail = 0;
  for (const r of R) {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
    r.pass ? pass++ : fail++;
  }
  console.log('----');
  console.log('heroult smoke: ' + pass + ' pass, ' + fail + ' fail, ' + R.length + ' total');

process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error("ERR", e); process.exit(1); });
