// tb_pet_smoke.js — v0.3.2 宠物系统专项冒烟验证（CDP 驱动无头 Chrome）
// 用法: node tb_pet_smoke.js [url]
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = process.env.TB_CHROME || 'C:/Users/21889/.agent-browser/browsers/chrome-win64/chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8124/index.html?test=1';
const PORT = 9334;

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
  const profile = process.env.TB_PROFILE || 'C:/tmp/tbpet-profile';
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

    // ===== P0: 初始无宠物，所有被动加成 = 0 =====
    try {
      T.clearPet();
      T.setBonus({ lifeup:0,cd:0,spd:0,coinup:0,shield:0,revive:0,combo:0,bulletspd:0,pierce:0,supply:0,focus:0 });
      T.setUpgrades({}); T.setCoins(0);
      const p = T.pet();
      t('P0 默认无宠物 · 被动加成全 0', p === null && T.petBonus('coin') === 0 && T.petBonus('shield') === 0 && T.petBonus('combo') === 0, 'pet=' + JSON.stringify(p));
    } catch (e) { t('P0 默认无宠物 · 被动加成全 0', false, e.message); }

    // ===== P1: 宠物定义 3 只，被动类型正确 =====
    try {
      const defs = T.petDefs();
      const ok = defs.length === 4 && defs.some(d => d.id === 'cat' && d.passive === 'coin') && defs.some(d => d.id === 'turtle' && d.passive === 'shield') && defs.some(d => d.id === 'bunny' && d.passive === 'combo') && defs.some(d => d.id === 'pig' && d.passive === 'magnet');
      t('P1 宠物定义 4 只 · 被动类型正确', ok, JSON.stringify(defs.map(d => d.id + ':' + d.passive)));
    } catch (e) { t('P1 宠物定义 3 只 · 被动类型正确', false, e.message); }

    // ===== P2: setPet 装备招财猫 Lv1 → coin 加成 = 1 =====
    try {
      const ok = T.setPet('cat', 1);
      const p = T.pet();
      t('P2 装备招财猫 Lv1 → coin 加成 1', ok && p && p.id === 'cat' && p.level === 1 && T.petBonus('coin') === 1, JSON.stringify(p));
    } catch (e) { t('P2 装备招财猫 Lv1 → coin 加成 1', false, e.message); }

    // ===== P3: 金币获取受 coin 加成（+10%/级） =====
    try {
      T.setCoins(0);
      const g1 = T.addGold(100);            // coinup=0, fortune=0, pet coin=1 → 100*1.1=110
      T.setPet('cat', 2);
      T.setCoins(0);
      const g2 = T.addGold(100);            // pet coin=2 → 100*1.2=120
      const exact = g1 === 110 && g2 === 120;
      t('P3 金币加成 +10%/级（Lv1=110 · Lv2=120）', exact, 'g1=' + g1 + ' g2=' + g2);
    } catch (e) { t('P3 金币加成 +10%/级（Lv1=110 · Lv2=120）', false, e.message); }

    // ===== P4: 连击窗口受 combo 加成（+15%/级） =====
    try {
      T.setPet('bunny', 1);
      const t1 = T.comboWindowNow();   // focus=0, combo pet=1 → 5*1.15=5.75
      T.setPet('bunny', 2);
      const t2 = T.comboWindowNow();   // combo pet=2 → 5*1.3=6.5
      const exact = Math.abs(t1 - 5.75) < 0.01 && Math.abs(t2 - 6.5) < 0.01;
      t('P4 连击窗口 +15%/级（Lv1=5.75s · Lv2=6.5s）', exact, 't1=' + t1 + ' t2=' + t2);
    } catch (e) { t('P4 连击窗口 +15%/级（Lv1=5.75s · Lv2=6.5s）', false, e.message); }

    // ===== P5: 开局护盾受 shield 加成（+60帧/级） =====
    try {
      T.setPet('turtle', 2);
      T.setBonus({ lifeup:0,cd:0,spd:0,coinup:0,shield:0,revive:0,combo:0,bulletspd:0,pierce:0,supply:0,focus:0 });
      T.startGame(); T.skipIntro();
      const inv = T.playerInvNow();   // shield bonus=0, pet turtle=2 → 0 + 120 = 120
      const ok = inv === 120;
      t('P5 开局护盾 +60帧/级（Lv2=120帧）', ok, 'spawnInv=' + inv);
    } catch (e) { t('P5 开局护盾 +60帧/级（Lv2=120帧）', false, e.message); }

    // ===== P6: 宠物跟随实体生成（startGame 后 petFollow 存在） =====
    try {
      await sleep(80);
      const f = T.petFollowNow();
      const p = T.pet();
      t('P6 宠物跟随实体存在', p && f && isFinite(f.x) && isFinite(f.y), 'pet=' + (p && p.id) + ' follow=' + JSON.stringify(f));
    } catch (e) { t('P6 宠物跟随实体存在', false, e.message); }

    // ===== P7: 宠物购买/装备/升级经济闭环（v0.3.4 宠物币🐾：买4-升3-升6-满级3） =====
    try {
      T.setPetOwn([]);   // 干净重置，不受 P2-P5 setPet 污染
      T.setAch(['pet1', 'petmax', 'petall']);   // 预发宠物成就，隔离解锁奖励对余额的干扰
      T.setPetCoins(30);
      T.buyPet('cat');   // 4🐾
      const st1 = T.petState();
      const bought = st1.owned.includes('cat') && st1.equipped === 'cat' && T.petCoins() === 26;
      T.upgradePet('cat');   // 3🐾 → lv2
      const st2 = T.petState();
      const upg = st2.levels['cat'] === 2 && T.petCoins() === 23 && T.petBonus('coin') === 2;
      T.upgradePet('cat');   // 6🐾 → lv3
      const st3 = T.petState();
      const cap = st3.levels['cat'] === 3 && T.petCoins() === 17 && T.petBonus('coin') === 3;
      // 已满级再升级不扣费
      const cBefore = T.petCoins();
      T.upgradePet('cat');
      const noOver = T.petCoins() === cBefore;
      t('P7 购买/升级经济闭环（买4🐾-升3🐾-升6🐾-满级3）', bought && upg && cap && noOver, 'petCoins=' + T.petCoins() + ' lv=' + st3.levels['cat']);
    } catch (e) { t('P7 购买/升级经济闭环（买4🐾-升3🐾-升6🐾-满级3）', false, e.message); }

    // ===== P8: 重复购买不扣费 · 宠物币不足升级被拒 · 不影响命数 =====
    try {
      // 干净拥有 turtle（lv=2），验证重复购买不扣费 + 宠物币不足升级被拒
      T.setPetOwn(['turtle']);
      T.setPet('turtle', 2);
      T.setPetCoins(0);
      const c0 = T.petCoins();
      T.buyPet('turtle');          // 已拥有 → 早退，不扣费
      const dupNoCharge = T.petCoins() === c0;
      T.upgradePet('turtle');      // lv=2 → 需 6🐾，余额 0 → 拒绝
      const upgNoCharge = T.petCoins() === c0;
      const lvAfter = T.petState().levels['turtle'];
      const lives = T.livesNow();
      t('P8 重复购买不扣费 · 宠物币不足升级被拒', dupNoCharge && upgNoCharge && lvAfter === 2 && lives >= 0, 'petCoins=' + T.petCoins() + ' lv=' + lvAfter + ' lives=' + lives);
    } catch (e) { t('P8 重复购买不扣费 · 宠物币不足升级被拒', false, e.message); }

    // ===== P9: 宠物局内参战反应（fire/hit/kill 触发 + 衰减回 idle） =====
    try {
      // 确保战斗中且有跟随实体
      T.setPetOwn(['cat']); T.setPet('cat', 3); T.setBonus({ lifeup:0,cd:0,spd:0,coinup:0,shield:0,revive:0,combo:0,bulletspd:0,pierce:0,supply:0,focus:0 });
      T.startGame(); T.skipIntro();
      await sleep(60);
      const follow = T.petFollowNow();
      if (!follow) { t('P9 宠物局内参战反应', false, 'no petFollow'); }
      else {
        const f1 = T.petReactNow('fire'), s1 = T.petFxNow();
        const f2 = T.petReactNow('hit'),  s2 = T.petFxNow();
        const f3 = T.petReactNow('kill'), s3 = T.petFxNow();
        // 动画中段仍保持（kill 时长 0.55s，150ms 时应仍为 kill）—— 校验时长单位换算
        await sleep(150);
        const mid = T.petFxNow();
        // 衰减回 idle：等待 kill 时长(0.55s) + 余量
        await sleep(600);
        const s4 = T.petFxNow();
        t('P9 宠物局内参战反应（fire/hit/kill 触发 + 中段保持 + 衰减回 idle）',
          f1 === 'fire' && s1 === 'fire' && f2 === 'hit' && s2 === 'hit' && f3 === 'kill' && s3 === 'kill' && mid === 'kill' && s4 === 'idle',
          'fire=' + f1 + ' hit=' + f2 + ' kill=' + f3 + ' mid=' + mid + ' idle=' + s4);
      }
    } catch (e) { t('P9 宠物局内参战反应（fire/hit/kill 触发 + 中段保持 + 衰减回 idle）', false, e.message); }

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
  console.log('pet smoke: ' + pass + ' pass, ' + fail + ' fail, ' + R.length + ' total');
  // 截图
  try { await client.send('Page.captureScreenshot', { format: 'png' }); } catch (e) {}
  chrome.kill();
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
