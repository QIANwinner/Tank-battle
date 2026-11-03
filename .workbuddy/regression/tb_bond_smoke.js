// tb_bond_smoke.js — v0.3.8 宠物羁绊专项冒烟验证(任务122③,CDP 驱动无头 Chrome)
// 稳定性设计:准备+触发+读取合并单次 evaluate(含 awaitPromise),消除往返衰减抖动
// 用法: node tb_bond_smoke.js [url]
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = process.env.TB_CHROME || 'C:/Users/21889/.agent-browser/browsers/chrome-win64/chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8124/index.html?test=1';
const PORT = 9345;

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
  const profile = process.env.TB_PROFILE || 'C:/tmp/tbbond-profile';
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

  // ===== B1: 堡垒无宠物 → 无羁绊,开局护盾仅英雄被动 180 帧 =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.setPetCoins(99); T.buyHeroNow("sniper"); T.buyHeroNow("vanguard"); T.setHero("fortress"); T.clearPet();
      T.startGame(); T.skipIntro();
      return JSON.stringify({ inv: T.playerInvNow(), bond: T.bondNow() });
    })()`));
    t('B1 堡垒无宠物(inv=180 · 无羁绊)', o.inv === 180 && o.bond === null, JSON.stringify(o));
  } catch (e) { t('B1 堡垒无宠物', false, e.message); }

  // ===== B2 铜墙铁壁开局:堡垒+守护龟Lv2 → 120(龟)+180(堡垒)+120(羁绊)=420 =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.setHero("fortress"); T.setPet("turtle", 2);
      T.startGame(); T.skipIntro();
      return JSON.stringify({ inv: T.playerInvNow(), bond: T.bondNow() });
    })()`));
    t('B2 铜墙铁壁开局护盾(inv=420)', o.inv === 420 && o.bond === 'bondwall', JSON.stringify(o));
  } catch (e) { t('B2 铜墙铁壁开局护盾', false, e.message); }

  // ===== B3 铜墙铁壁大招:圣盾冲击无敌 300+120=420 =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.setHero("fortress"); T.setPet("turtle", 2);
      T.startGame(); T.skipIntro();
      T.triggerHeroUltNow();
      return JSON.stringify({ inv: T.heroUltNow().inv });
    })()`));
    t('B3 铜墙铁壁圣盾冲击(inv=420)', o.inv === 420, JSON.stringify(o));
  } catch (e) { t('B3 铜墙铁壁圣盾冲击', false, e.message); }

  // ===== B4 刀口舔金:剑刃+招财猫,狂暴期间金币 ×2 =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.setHero("blade"); T.setPet("cat", 1);
      T.setCoins(0);
      T.startGame(); T.skipIntro();
      T.triggerHeroUltNow();
      const during = T.addGold(100);   // 狂暴中:100 × 1.1(招财猫Lv1被动) × 2(羁绊) = 220
      return JSON.stringify({ during, bond: T.bondNow() });
    })()`));
    t('B4 刀口舔金狂暴金币×2(100×1.1×2=220)', o.during === 220 && o.bond === 'bondgold', JSON.stringify(o));
  } catch (e) { t('B4 刀口舔金狂暴金币×2', false, e.message); }

  // ===== B5 动如雷震:先锋+幸运兔,冲锋无敌 60+30=90 =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.setHero("vanguard"); T.setPet("bunny", 1);
      T.startGame(); T.skipIntro();
      T.triggerHeroUltNow();
      return JSON.stringify({ inv: T.heroUltNow().inv, bond: T.bondNow() });
    })()`));
    t('B5 动如雷震冲锋无敌(inv=90)', o.inv === 90 && o.bond === 'bonddash', JSON.stringify(o));
  } catch (e) { t('B5 动如雷震冲锋无敌', false, e.message); }

  // ===== B6 羁绊门控:错配组合不激活(堡垒+招财猫) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.setHero("fortress"); T.setPet("cat", 1);
      T.startGame(); T.skipIntro();
      return JSON.stringify({ bond: T.bondNow(), inv: T.playerInvNow() });
    })()`));
    t('B6 错配组合不激活(bond=null · inv=180)', o.bond === null && o.inv === 180, JSON.stringify(o));
  } catch (e) { t('B6 错配组合不激活', false, e.message); }

  // ===== B7 羁绊定义 3 条 + 商店描述含羁绊提示 =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      const defs = T.bondsDef();
      T.setShopTab("pets"); T.renderShop();
      const body = document.getElementById("shopBody");
      const html = body ? body.innerHTML : "";
      return JSON.stringify({ defs, hasTip: html.indexOf("羁绊") >= 0 });
    })()`));
    t('B7 羁绊定义3条 · 商店描述含羁绊提示', o.defs.length === 3 && o.hasTip === true, JSON.stringify(o));
  } catch (e) { t('B7 羁绊定义与商店提示', false, e.message); }

  chrome.kill();

  let pass = 0, fail = 0;
  for (const r of R) {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
    r.pass ? pass++ : fail++;
  }
  console.log('----');
  console.log('bond smoke: ' + pass + ' pass, ' + fail + ' fail, ' + R.length + ' total');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
