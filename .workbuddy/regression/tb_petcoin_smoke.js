// tb_petcoin_smoke.js — v0.3.4 宠物币经济专项冒烟验证（CDP 驱动无头 Chrome）
// 用法: node tb_petcoin_smoke.js [url]
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = process.env.TB_CHROME || 'C:/Users/21889/.agent-browser/browsers/chrome-win64/chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8124/index.html?test=1';
const PORT = 9336;

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
  const profile = process.env.TB_PROFILE || 'C:/tmp/tbpetcoin-profile';
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

  // 重新导航并等待钩子（迁移补发测试用：localStorage 同 profile 持久）
  async function reload() {
    await client.send('Page.navigate', { url: URL });
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      const r = await client.send('Runtime.evaluate', { expression: '!!window.__tbTest', returnByValue: true });
      if (r.result && r.result.result && r.result.result.value === true) return true;
    }
    return false;
  }
  async function ev(expr) {
    const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  }

  const R = [];
  const t = (name, pass, detail) => R.push({ name, pass: !!pass, detail: String(detail ?? '') });

  // ===== C0: 全新档案 → schema v2，宠物币初始 0（空成就补发=0） =====
  try {
    const lv = await ev('window.__tbTest.lsVer()');
    const pc = await ev('window.__tbTest.petCoins()');
    t('C0 全新档案 lsVer=2 · 宠物币初始 0', lv === 2 && pc === 0, 'lsVer=' + lv + ' petCoins=' + pc);
  } catch (e) { t('C0 全新档案 lsVer=2 · 宠物币初始 0', false, e.message); }

  // ===== C1: 成就解锁发宠物币 · 金币档位映射（50→1🐾 · 300→3🐾 · 400→3🐾）+ 重复解锁不发 =====
  try {
    await ev('window.__tbTest.setAch([])');
    await ev('window.__tbTest.setPetCoins(0)');
    const r1 = await ev('window.__tbTest.grantAch("first")');     // reward 50  → 1🐾
    const p1 = await ev('window.__tbTest.petCoins()');
    await ev('window.__tbTest.grantAch("score5k")');              // reward 300 → 3🐾
    const p2 = await ev('window.__tbTest.petCoins()');
    await ev('window.__tbTest.grantAch("rich2")');                // reward 400 → 3🐾
    const p3 = await ev('window.__tbTest.petCoins()');
    await ev('window.__tbTest.grantAch("first")');                // 重复 → 不再发放
    const p4 = await ev('window.__tbTest.petCoins()');
    const tiersOk = await ev('window.__tbTest.achPetReward("first") + ":" + window.__tbTest.achPetReward("score5k") + ":" + window.__tbTest.achPetReward("rich2")');
    t('C1 成就发宠物币档位（1/3/3）+ 重复解锁不重发', p1 === 1 && p2 === 4 && p3 === 7 && p4 === 7 && tiersOk === '1:3:3',
      'p=' + p1 + ',' + p2 + ',' + p3 + ',' + p4 + ' tiers=' + tiersOk);
  } catch (e) { t('C1 成就发宠物币档位（1/3/3）+ 重复解锁不重发', false, e.message); }

  // ===== C2: 购买触发「初次饲主/全家福」+ 扣宠物币 =====
  try {
    await ev('window.__tbTest.setAch(["petmax"])');   // 预发 petmax，隔离满级奖励
    await ev('window.__tbTest.setPetOwn([])');
    await ev('window.__tbTest.setPetCoins(100)');
    await ev('window.__tbTest.buyPet("cat")');        // -4，触发 pet1 +2
    await ev('window.__tbTest.buyPet("turtle")');     // -6
    await ev('window.__tbTest.buyPet("bunny")');      // -10，触发 petall +5
    const pc = await ev('window.__tbTest.petCoins()');
    const ach = await ev('window.__tbTest.ach()');
    const st = await ev('window.__tbTest.petState()');
    const allOwned = st.owned.length === 3 && ['cat', 'turtle', 'bunny'].every(x => st.owned.includes(x));
    t('C2 购买扣🐾（100-20+2+5=87）+ pet1/petall 触发', pc === 87 && allOwned && ach.includes('pet1') && ach.includes('petall'),
      'petCoins=' + pc + ' owned=' + st.owned.join(','));
  } catch (e) { t('C2 购买扣🐾（100-20+2+5=87）+ pet1/petall 触发', false, e.message); }

  // ===== C3: 满级触发「满级萌宠」+ 升级扣宠物币 =====
  try {
    await ev('window.__tbTest.setAch([])');
    await ev('window.__tbTest.setPetOwn(["turtle"])');   // 钩子直接给拥有（不触发购买成就）
    await ev('window.__tbTest.setPet("turtle", 1)');
    await ev('window.__tbTest.setPetCoins(50)');
    await ev('window.__tbTest.upgradePet("turtle")');    // 1→2：-3🐾，未满级
    const mid = await ev('window.__tbTest.petCoins()');
    await ev('window.__tbTest.upgradePet("turtle")');    // 2→3：-6🐾 + petmax +3🐾
    const pc = await ev('window.__tbTest.petCoins()');
    const lv = await ev('window.__tbTest.petState().levels["turtle"]');
    const ach = await ev('window.__tbTest.ach()');
    t('C3 升级扣🐾（50-3=47 → -6+3=44）+ petmax 触发', mid === 47 && pc === 44 && lv === 3 && ach.includes('petmax'),
      'mid=' + mid + ' petCoins=' + pc + ' lv=' + lv);
  } catch (e) { t('C3 升级扣🐾（50-3=47 → -6+3=44）+ petmax 触发', false, e.message); }

  // ===== C4: 金币无法购买宠物（双币隔离）· 宠物币不足拒绝 =====
  try {
    await ev('window.__tbTest.setAch(["pet1", "petmax", "petall"])');
    await ev('window.__tbTest.setPetOwn([])');
    await ev('window.__tbTest.setPetCoins(0)');
    await ev('window.__tbTest.setCoins(99999)');
    await ev('window.__tbTest.buyPet("cat")');           // 宠物币 0 → 拒绝（金币再多也不行）
    const st1 = await ev('window.__tbTest.petState()');
    const c1 = await ev('window.__tbTest.coinsNow()');
    await ev('window.__tbTest.setPetCoins(2)');
    await ev('window.__tbTest.buyPet("cat")');           // 2🐾 < 4🐾 → 拒绝
    const st2 = await ev('window.__tbTest.petState()');
    const p2 = await ev('window.__tbTest.petCoins()');
    t('C4 金币无法买宠物 · 宠物币不足拒绝',
      !st1.owned.includes('cat') && c1 === 99999 && !st2.owned.includes('cat') && p2 === 2,
      'owned=' + st1.owned.join(',') + ' coins=' + c1 + ' petCoins=' + p2);
  } catch (e) { t('C4 金币无法买宠物 · 宠物币不足拒绝', false, e.message); }

  // ===== C5: 老档迁移补发（v1 + 已解锁成就 → 首载补发🐾） =====
  try {
    await ev('localStorage.clear()');
    await ev('window.__tbTest.setRawSave("tank-battle-ach", \'["first","rich"]\')');   // 50→1🐾 + 300→3🐾
    await ev('window.__tbTest.setRawSave("tank-battle-ver", "1")');
    const ok = await reload();
    const lv = await ev('window.__tbTest.lsVer()');
    const pc = await ev('window.__tbTest.petCoins()');
    t('C5 v1 老档迁移补发（first+rich → 4🐾 · lsVer=2）', ok && lv === 2 && pc === 4, 'ok=' + ok + ' lsVer=' + lv + ' petCoins=' + pc);
  } catch (e) { t('C5 v1 老档迁移补发（first+rich → 4🐾 · lsVer=2）', false, e.message); }

  // ===== C6: 补发幂等（再次加载不重复发放） =====
  try {
    const ok = await reload();
    const lv = await ev('window.__tbTest.lsVer()');
    const pc = await ev('window.__tbTest.petCoins()');
    t('C6 补发幂等（再载仍 4🐾）', ok && lv === 2 && pc === 4, 'ok=' + ok + ' lsVer=' + lv + ' petCoins=' + pc);
  } catch (e) { t('C6 补发幂等（再载仍 4🐾）', false, e.message); }

  // ===== C7: 宠物币持久化（写入 → 跨刷新恢复） =====
  try {
    await ev('window.__tbTest.setPetCoins(23)');
    const ok = await reload();
    const pc = await ev('window.__tbTest.petCoins()');
    t('C7 宠物币跨刷新持久化（23🐾）', ok && pc === 23, 'ok=' + ok + ' petCoins=' + pc);
  } catch (e) { t('C7 宠物币跨刷新持久化（23🐾）', false, e.message); }

  // ===== C8: 每日签到 +1🐾（当日幂等，重复领取不再发） =====
  try {
    await ev('window.__tbTest.signinReset()');
    await ev('window.__tbTest.setPetCoins(0)');
    const r1 = await ev('window.__tbTest.signinClaim()');
    const r2 = await ev('window.__tbTest.signinClaim()');   // 当日已签 → 早退
    t('C8 签到 +1🐾（streak=' + (r1 && r1.streak) + '）· 当日重复领取不重发', r1 && r1.petCoins === 1 && r2 && r2.petCoins === 1 && r2.streak === r1.streak,
      'r1=' + JSON.stringify(r1) + ' r2=' + JSON.stringify(r2));
  } catch (e) { t('C8 签到 +1🐾 · 当日重复领取不重发', false, e.message); }

  // ===== C9: 无尽模式每通过 10 波 +1🐾（11 波首次、21 波第二次；普通关不发） =====
  try {
    // 预发途中会解锁的里程碑/金库成就,隔离 unlockAch 奖励对计数的干扰(rich: 过关金币累计破 3000 时合法触发)
    await ev('window.__tbTest.setAch(["lv5", "milo20", "milo40", "endless10", "endless30", "endless50", "rich", "rich2"])');
    await ev('window.__tbTest.setEndless(true)');
    await ev('window.__tbTest.setPetCoins(0)');
    for (let i = 0; i < 10; i++) await ev('window.__tbTest.advance()');   // level 1→11
    const p1 = await ev('window.__tbTest.petCoins()');
    for (let i = 0; i < 9; i++) await ev('window.__tbTest.advance()');    // level 11→20(无里程碑)
    const p2 = await ev('window.__tbTest.petCoins()');
    await ev('window.__tbTest.advance()');                                // level 20→21 里程碑
    const p3 = await ev('window.__tbTest.petCoins()');
    await ev('window.__tbTest.setEndless(false)');
    await ev('window.__tbTest.advance()');                                // 普通关推进不发
    const p4 = await ev('window.__tbTest.petCoins()');
    const lv = await ev('window.__tbTest.endlessNow().level');
    t('C9 无尽 10 波里程碑 +1🐾（1→2→普通关不发）', p1 === 1 && p2 === 1 && p3 === 2 && p4 === 2 && lv === 22,
      'p=' + p1 + ',' + p2 + ',' + p3 + ',' + p4 + ' level=' + lv);
  } catch (e) { t('C9 无尽 10 波里程碑 +1🐾', false, e.message); }

  chrome.kill();

  let pass = 0, fail = 0;
  for (const r of R) {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
    r.pass ? pass++ : fail++;
  }
  console.log('----');
  console.log('petcoin smoke: ' + pass + ' pass, ' + fail + ' fail, ' + R.length + ' total');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
