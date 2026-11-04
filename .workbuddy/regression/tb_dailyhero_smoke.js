// tb_dailyhero_smoke.js — v0.3.18 每日挑战「今日英雄」推荐机制专项冒烟验证(CDP 驱动无头 Chrome)
// 设计:准备+断言合并单次 evaluate(JS 单线程同步块,确定性成立)
// 用法: node tb_dailyhero_smoke.js [url]
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = process.env.TB_CHROME || 'C:/Users/21889/.agent-browser/browsers/chrome-win64/chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8124/index.html?test=1';
const PORT = 9363;

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
  const profile = process.env.TB_PROFILE || 'C:/tmp/tbdailyhero-profile';
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

  // ===== D1: 注入种子 → dailyHero 确定且属池 =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      const a = T.setDailySeed(20261104);
      const b = T.setDailySeed(20261104);
      const pool = T.dailyHeroPool();
      return JSON.stringify({ a, b, pool });
    })()`));
    t('D1 注入种子稳定 + 属英雄池', o.a === o.b && o.pool.includes(o.a), JSON.stringify(o));
  } catch (e) { t('D1 种子稳定', false, e.message); }

  // ===== D2: 连续 4 种子覆盖 4 英雄 =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      const set = {};
      for (const s of [20261101, 20261102, 20261103, 20261104]) set[s] = T.setDailySeed(s);
      const uniq = Object.values(set).filter((v, i, a) => a.indexOf(v) === i);
      return JSON.stringify({ set, uniq });
    })()`));
    t('D2 4 种子覆盖 4 英雄', o.uniq.length === 4, JSON.stringify(o));
  } catch (e) { t('D2 种子覆盖', false, e.message); }

  // ===== D3: 每日挑战启动 + 玩家 none → 自动装备推荐(免费) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.setDailySeed(20261104);      // 推荐 blade(免费)
      T.setHero('none');
      T.startMode('daily');
      return JSON.stringify({ rec: T.dailyHeroNow(), hero: T.heroNow() });
    })()`));
    t('D3 none→自动装备推荐(blade)', o.rec === 'blade' && o.hero === 'blade', JSON.stringify(o));
  } catch (e) { t('D3 自动装备', false, e.message); }

  // ===== D4: 玩家已选英雄 → 不覆盖 =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.setDailySeed(20261104);      // 推荐 blade
      T.setHero('fortress');         // 已选堡垒
      T.startMode('daily');
      return JSON.stringify({ rec: T.dailyHeroNow(), hero: T.heroNow() });
    })()`));
    t('D4 已选英雄不覆盖', o.hero === 'fortress', JSON.stringify(o));
  } catch (e) { t('D4 不覆盖', false, e.message); }

  // ===== D5: 推荐未拥有 → 回退免费 / 已拥有 → 直接装备 =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.setDailySeed(20261102);      // 推荐 sniper(高价)
      const owned = T.heroOwnedNow('sniper');
      T.setHero('none');
      T.startMode('daily');
      const hero = T.heroNow();
      const freeOk = (hero === 'blade' || hero === 'fortress');   // 回退免费
      const directOk = hero === 'sniper';                          // 已拥有直接装备
      return JSON.stringify({ owned, hero, ok: owned ? directOk : freeOk });
    })()`));
    t('D5 未拥有回退 / 已拥有装备', o.ok === true, JSON.stringify(o));
  } catch (e) { t('D5 回退/装备', false, e.message); }

  // ===== D6: 每日词条完整描述(7条定义含desc + 抽取后_descfull含格式) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      const defs = T.dailyModDefsNow();
      const allDesc = defs.every(d => d.desc && d.desc.length > 0 && d.desc !== d.name);
      T.setDailySeed(20261104); T.setHero('none');
      T.startMode('daily');
      const d = T.daily();
      const full = d._descFull || '';
      return JSON.stringify({ n: defs.length, allDesc, full, hasParen: full.indexOf('(') >= 0 && full.indexOf(')') >= 0 });
    })()`));
    t('D6 词条7条含描述 + 抽取_descfull含(名(描述))', o.n === 7 && o.allDesc && o.hasParen && o.full.length > 0, JSON.stringify(o));
  } catch (e) { t('D6 词条描述', false, e.message); }

  // ===== U1: 标题页展示「今日英雄」提示 =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.dailyHeroTipShow('title');
      const tip = T.dailyHeroTipNow();
      return JSON.stringify(tip);
    })()`));
    t('U1 标题页提示显示+含今日英雄', o.display === 'block' && /今日英雄/.test(o.text || ''), JSON.stringify(o));
  } catch (e) { t('U1 标题页提示', false, e.message); }

  // ===== U2: 非标题页隐藏 =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.dailyHeroTipShow('paused');
      const tip = T.dailyHeroTipNow();
      return JSON.stringify(tip);
    })()`));
    t('U2 非标题页隐藏', o.display === 'none', JSON.stringify(o));
  } catch (e) { t('U2 非标题页隐藏', false, e.message); }

  // ===== U3: 今日英雄提示含英雄特性(desc 括号格式) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.dailyHeroTipShow('title');
      const tip = T.dailyHeroTipNow();
      return JSON.stringify({ text: tip ? tip.text : '' });
    })()`));
    t('U3 今日英雄提示含特性', o.text.indexOf('\uff08') >= 0 && o.text.indexOf('\uff09') >= 0, JSON.stringify(o));
  } catch (e) { t('U3 英雄特性', false, e.message); }

  chrome.kill();

  let pass = 0, fail = 0;
  for (const r of R) {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
    r.pass ? pass++ : fail++;
  }
  console.log('----');
  console.log('dailyhero smoke: ' + pass + ' pass, ' + fail + ' fail, ' + R.length + ' total');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
