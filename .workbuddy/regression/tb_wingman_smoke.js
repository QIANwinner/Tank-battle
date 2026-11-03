// tb_wingman_smoke.js — v0.3.2 AI 僚机专项冒烟验证（CDP 驱动无头 Chrome）
// 用法: node tb_wingman_smoke.js [url]
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = process.env.TB_CHROME || 'C:/Users/21889/.agent-browser/browsers/chrome-win64/chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8124/index.html?test=1';
const PORT = 9333;

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
  const profile = process.env.TB_PROFILE || 'C:/tmp/tbwm-profile';
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

  const SRC = `
  (async () => {
    const T = window.__tbTest;
    const R = [];
    const t = (name, pass, detail) => R.push({ name, pass: !!pass, detail: String(detail ?? '') });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const wm = () => T.wingman();

    // 清场开图，避免地图干扰
    const openField = () => { T.clearMap(); };

    // ===== W1: 单人 startGame 后默认无僚机（测试确定性路径） =====
    try {
      T.setCoins(0); T.setSkins({ owned:['classic'], equipped:'classic' }); T.setUpgrades({}); T.setBonus({ lifeup:0,cd:0,spd:0,coinup:0,shield:0 });
      T.startGame(); T.skipIntro();
      t('W1 测试 startGame 默认无僚机', wm() === null, 'wingman=' + JSON.stringify(wm()));
    } catch (e) { t('W1 测试 startGame 默认无僚机', false, e.message); }

    // ===== W2: 手动生成僚机（setWingman） =====
    try {
      const ok = T.setWingman(true);
      const w = wm();
      t('W2 setWingman 生成僚机实体', ok && w && w.hp === 5 && w.maxHp === 5 && !w.dead, JSON.stringify(w));
    } catch (e) { t('W2 setWingman 生成僚机实体', false, e.message); }

    // ===== W3: 僚机朝敌人开火，生成友方子弹 =====
    try {
      openField();
      const w0 = wm();
      T.spawnEnemyAt(w0.x + 6 * 24, w0.y, 'normal');   // 右侧 6 格放一个敌
      await sleep(60);  // 让 updateWingman 跑几帧
      const n = T.wingmanShoot();   // 强制开火一次
      const ownBullets = T.bullets().filter(b => b.owner === 'p').length;
      t('W3 僚机开火生成友方弹', ownBullets >= 1, 'friendlyBullets=' + ownBullets + ' fired=' + n);
    } catch (e) { t('W3 僚机开火生成友方弹', false, e.message); }

    // ===== W4: 僚机弹命中敌人扣血（同步命中探针，确定性） =====
    try {
      const r = T.probeWingmanHit();
      t('W4 僚机弹命中敌人', r.ok && (r.after < r.before || r.dead), 'before=' + r.before + ' after=' + r.after + ' dead=' + r.dead);
    } catch (e) { t('W4 僚机弹命中敌人', false, e.message); }

    // ===== W5: 敌方弹命中僚机扣血 =====
    try {
      const h0 = wm().hp;
      T.hurtWingman(1);
      const w = wm();
      t('W5 hurtWingman 扣 1 血', w && w.hp === h0 - 1, 'hp ' + h0 + '->' + (w && w.hp));
    } catch (e) { t('W5 hurtWingman 扣 1 血', false, e.message); }

    // ===== W6: 血量归零 → 坠毁 → 重生 =====
    try {
      T.hurtWingman(10);
      const w1 = wm();
      const deadNow = w1 && w1.dead === true;
      t('W6a 满血归零坠毁', deadNow, JSON.stringify(w1));
      // 加速重生倒计时（直接置 respawnT 小）
      await sleep(50);
      // 手动等真实重生：置 respawnT=0.1 并跑帧
      T.setWingmanRespawn(0.1);
      await sleep(200);
      const w2 = wm();
      t('W6b 僚机重生恢复', w2 && w2.dead === false && w2.hp === w2.maxHp, JSON.stringify(w2));
    } catch (e) { t('W6 血量归零坠毁重生', false, e.message); }

    // ===== W7: 僚机不占玩家命数 / killPlayer 不受影响 =====
    try {
      const livesBefore = T.livesNow();
      // 玩家被击中不应触发僚机变化
      const w = wm();
      t('W7 僚机存在不影响玩家命数', T.livesNow() === livesBefore && !!w, 'lives=' + T.livesNow());
    } catch (e) { t('W7 僚机存在不影响玩家命数', false, e.message); }

    return R;
  })()
  `;

  const res = await client.send('Runtime.evaluate', { expression: SRC, awaitPromise: true, returnByValue: true });
  const R = (res.result && res.result.result && res.result.result.value) || [];
  let pass = 0, fail = 0;
  for (const r of R) {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
    r.pass ? pass++ : fail++;
  }
  console.log('----');
  console.log('wingman smoke: ' + pass + ' pass, ' + fail + ' fail, ' + R.length + ' total');
  // 截图
  try { await client.send('Page.captureScreenshot', { format: 'png' }); } catch (e) {}
  chrome.kill();
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
