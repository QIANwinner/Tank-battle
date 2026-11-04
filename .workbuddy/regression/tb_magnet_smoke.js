// tb_magnet_smoke.js — v0.3.16 磁力猪(第4只宠物)磁力吸附专项冒烟验证(CDP 驱动无头 Chrome)
// 设计:准备+step+断言合并单次 evaluate(JS 单线程,evaluate 同步块内 raf 不插入,确定性成立)
// 用法: node tb_magnet_smoke.js [url]
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = process.env.TB_CHROME || 'C:/Users/21889/.agent-browser/browsers/chrome-win64/chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8124/index.html?test=1';
const PORT = 9361;

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
  const profile = process.env.TB_PROFILE || 'C:/tmp/tbmagnet-profile';
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

  // ===== M1: PET_DEF 含磁力猪定义(passive=magnet,price=14,maxLv=3) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      const defs = T.petDefs();
      const pig = defs.find(d => d.id === 'pig');
      return JSON.stringify({ total: defs.length, pig });
    })()`));
    t('M1 磁力猪定义 passive=magnet price=14', o.total === 4 && o.pig && o.pig.passive === 'magnet' && o.pig.price === 14 && o.pig.maxLv === 3, JSON.stringify(o));
  } catch (e) { t('M1 磁力猪定义', false, e.message); }

  // ===== M2: 磁力 Lv1 吸附 35px 道具(>24拾取,<48磁力) → 距离减小未拾取 =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.startGame(); T.skipIntro(); T.setPetOwn([]);
      T.tp(200, 200);                                   // 玩家中心 (211,211)
      T.powerupSpawn(246, 211, 'shield');               // 道具中心 (246,211) 距 35
      const d0 = (() => { const p = T.powerupsAll()[0]; return Math.hypot(p.x + 8 - 211, p.y + 8 - 211); })();
      T.setPet('pig', 1);                               // 磁力 Lv1, 半径48
      T.powerupStep(0.1);
      const d1 = (() => { const p = T.powerupsAll()[0]; return p ? Math.hypot(p.x + 8 - 211, p.y + 8 - 211) : 0; })();
      return JSON.stringify({ d0, d1, cnt: T.powerupsAll().length });
    })()`));
    t('M2 Lv1 吸附 35→减小(未拾取)', o.cnt === 1 && o.d1 < o.d0 && o.d1 > 24, JSON.stringify(o));
  } catch (e) { t('M2 Lv1 吸附', false, e.message); }

  // ===== M3: 无磁力对照 → 35px 道具不吸不拾取(距离不变) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.startGame(); T.skipIntro(); T.setPetOwn([]); T.clearPet();
      T.tp(200, 200);
      T.powerupSpawn(246, 211, 'shield');
      const d0 = (() => { const p = T.powerupsAll()[0]; return Math.hypot(p.x + 8 - 211, p.y + 8 - 211); })();
      T.powerupStep(0.1); T.powerupStep(0.1); T.powerupStep(0.1);
      const d1 = (() => { const p = T.powerupsAll()[0]; return p ? Math.hypot(p.x + 8 - 211, p.y + 8 - 211) : 0; })();
      return JSON.stringify({ d0, d1, cnt: T.powerupsAll().length });
    })()`));
    t('M3 无磁力 35px 静止不拾取', o.cnt === 1 && Math.abs(o.d1 - o.d0) < 0.01 && o.d1 > 24, JSON.stringify(o));
  } catch (e) { t('M3 无磁力对照', false, e.message); }

  // ===== M4: 磁力持续 → 最终吸到拾取(道具消失) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.startGame(); T.skipIntro(); T.setPetOwn([]);
      T.tp(200, 200);
      T.powerupSpawn(246, 211, 'shield');
      T.setPet('pig', 3);                               // 磁力 Lv3, 拉速160
      for (let i = 0; i < 5; i++) T.powerupStep(0.1);   // 持续拉近直至拾取
      return JSON.stringify({ cnt: T.powerupsAll().length });
    })()`));
    t('M4 磁力持续吸到拾取(道具消失)', o.cnt === 0, JSON.stringify(o));
  } catch (e) { t('M4 磁力最终拾取', false, e.message); }

  // ===== M5: 磁力半径等级差异(Lv1 不吸 80px;Lv3 吸 80px) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      const setup = (lv) => {
        T.startGame(); T.skipIntro(); T.setPetOwn([]);
        T.tp(200, 200);                                  // 中心(211,211)
        T.powerupSpawn(291, 211, 'shield');              // 道具中心(291,211) 距80
        const before = (() => { const p = T.powerupsAll()[0]; return Math.hypot(p.x + 8 - 211, p.y + 8 - 211); })();
        T.setPet('pig', lv);
        T.powerupStep(0.1);
        const after = (() => { const p = T.powerupsAll()[0]; return p ? Math.hypot(p.x + 8 - 211, p.y + 8 - 211) : 0; })();
        return { before, after, cnt: T.powerupsAll().length };
      };
      const lv1 = setup(1);   // 半径48,80>48 不吸
      const lv3 = setup(3);   // 半径96,80<96 吸
      return JSON.stringify({ lv1, lv3 });
    })()`));
    t('M5 半径差异 Lv1不吸80 / Lv3吸80', o.lv1.cnt === 1 && Math.abs(o.lv1.after - o.lv1.before) < 0.01 && o.lv3.after < o.lv3.before, JSON.stringify(o));
  } catch (e) { t('M5 半径等级差异', false, e.message); }

  // ===== M6: 购买磁力猪经济(足扣14🐾 / 不足拒绝) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.setPetOwn(['cat']); T.setPetCoins(30);          // 预置1只猫:买pig时不触发「初次饲主」成就
      const before = T.petCoins();
      T.buyPet('pig');                                  // 纯扣14
      const after = T.petCoins();
      const owned = T.petState().owned.includes('pig');
      T.setPetCoins(5); T.setPetOwn(['cat']);
      T.buyPet('pig');                                  // 不足拒绝
      const poor = T.petState().owned.includes('pig') === false;
      return JSON.stringify({ before, after, owned, poor });
    })()`));
    t('M6 购买经济 扣14 / 不足拒绝', o.after === o.before - 14 && o.owned && o.poor, JSON.stringify(o));
  } catch (e) { t('M6 购买经济', false, e.message); }

  // ===== M7: 宠物全家福成就描述动态化(含4只) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      const ids = T.achAllDefs();
      const desc = T.achDesc('petall');
      return JSON.stringify({ has: ids.includes('petall'), desc });
    })()`));
    t('M7 petall 成就描述动态化(含4只)', o.has && /4\s*只/.test(o.desc || ''), JSON.stringify(o));
  } catch (e) { t('M7 成就动态', false, e.message); }

  chrome.kill();

  let pass = 0, fail = 0;
  for (const r of R) {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
    r.pass ? pass++ : fail++;
  }
  console.log('----');
  console.log('magnet smoke: ' + pass + ' pass, ' + fail + ' fail, ' + R.length + ' total');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
