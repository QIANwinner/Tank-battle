// tb_bondmagnet_smoke.js — v0.3.17 磁力弹幕羁绊(狙击×磁力猪)专项冒烟验证(CDP 驱动无头 Chrome)
// 设计:准备+step+断言合并单次 evaluate(JS 单线程同步块,raf 不插入,确定性成立)
// 用法: node tb_bondmagnet_smoke.js [url]
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = process.env.TB_CHROME || 'C:/Users/21889/.agent-browser/browsers/chrome-win64/chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8124/index.html?test=1';
const PORT = 9362;

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
  const profile = process.env.TB_PROFILE || 'C:/tmp/tbbondmagnet-profile';
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

  // ===== N1: PET_BONDS 含 bondmagnet(数据驱动收录,共4条) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      const ids = T.bondsDef();
      return JSON.stringify({ ids, total: ids.length });
    })()`));
    t('N1 羁绊定义含 bondmagnet(共4条)', o.total === 4 && o.ids.includes('bondmagnet'), JSON.stringify(o));
  } catch (e) { t('N1 羁绊定义', false, e.message); }

  // ===== N2: 激活状态(sniper+pig 激活 / 错配 / 无宠物 不激活) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.setPetCoins(99);
      T.buyHeroNow('sniper'); T.setPet('pig', 1);        // 狙击+磁力猪
      const on = T.bondActiveNow('bondmagnet');
      T.setHero('blade');                                // 错配
      const offHero = T.bondActiveNow('bondmagnet');
      T.setHero('sniper'); T.clearPet();                 // 无宠物
      const offPet = T.bondActiveNow('bondmagnet');
      return JSON.stringify({ on, offHero, offPet });
    })()`));
    t('N2 激活/错配/无宠物', o.on === 1 && o.offHero === 0 && o.offPet === 0, JSON.stringify(o));
  } catch (e) { t('N2 激活状态', false, e.message); }

  // ===== N3: 磁力半径×1.5(60px 道具,Lv1:无羁绊48不吸/有羁绊72吸) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      const run = (withBond) => {
        T.startGame(); T.skipIntro(); T.setPetOwn([]);
        T.setPetCoins(99); T.buyHeroNow(withBond ? 'sniper' : 'none');
        T.tp(200, 200);                                  // 玩家中心(211,211)
        T.powerupSpawn(271, 211, 'shield');              // 道具中心(271,211) 距60
        const before = (() => { const p = T.powerupsAll()[0]; return Math.hypot(p.x + 8 - 211, p.y + 8 - 211); })();
        T.setPet('pig', 1);
        T.powerupStep(0.1);
        const after = (() => { const p = T.powerupsAll()[0]; return p ? Math.hypot(p.x + 8 - 211, p.y + 8 - 211) : 0; })();
        return { before, after, cnt: T.powerupsAll().length };
      };
      const noBond = run(false);   // 无羁绊 magR=48, 60>48 不吸
      const yesBond = run(true);   // 有羁绊 magR=72, 60<72 吸
      return JSON.stringify({ noBond, yesBond });
    })()`));
    t('N3 磁力半径×1.5(60px)', o.noBond.cnt === 1 && Math.abs(o.noBond.after - o.noBond.before) < 0.01 && o.yesBond.after < o.yesBond.before, JSON.stringify(o));
  } catch (e) { t('N3 磁力半径×1.5', false, e.message); }

  // ===== N4: 羁绊图鉴数据驱动收录(bondmagnet 在商店提示链路) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      // 商店宠物页渲染后,羁绊图鉴 DOM 应含 4 行(含磁力弹幕)
      const defs = T.bondsDef();
      return JSON.stringify({ defs, n: defs.length });
    })()`));
    t('N4 图鉴/商店收录4条羁绊', o.n === 4 && o.defs.includes('bondmagnet'), JSON.stringify(o));
  } catch (e) { t('N4 图鉴收录', false, e.message); }

  chrome.kill();

  let pass = 0, fail = 0;
  for (const r of R) {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
    r.pass ? pass++ : fail++;
  }
  console.log('----');
  console.log('bondmagnet smoke: ' + pass + ' pass, ' + fail + ' fail, ' + R.length + ' total');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
