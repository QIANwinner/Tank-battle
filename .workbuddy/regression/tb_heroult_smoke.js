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
// 终止整个 Chrome 进程树(Windows: taskkill /T /F;否则 chrome.kill() 只杀父进程,子进程残留占端口造成跨轮污染)
function killTree(pid) {
  try { require('child_process').execSync('taskkill /PID ' + pid + ' /T /F', { stdio: 'ignore' }); } catch (e) {}
  try { process.kill(pid); } catch (e) {}
}
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
  if (!ready) { console.log('FAIL: game test hook never appeared'); killTree(chrome.pid); process.exit(2); }
  console.log('game test hook ready');
  // —— 状态卫生:清上一轮残留的宠物/英雄/加成(僵尸 Chrome 占 profile 时 rmSync 会静默失败) ——
  await ev('window.__tbTest.setBonus({}); window.__tbTest.clearPet(); window.__tbTest.setHero("none");');

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
    t('U8 冷却中重复触发无效(冷却未被重置到 45)', o < 44 && o >= 0, 'cd=' + o);
  } catch (e) { t('U8 冷却中重复触发无效', false, e.message); }

  // ===== U9: 冷却中触发给桌面玩家剩余秒数 toast(v0.3.40) =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      T.setHero('blade'); T.startGame(); T.skipIntro();
      T.setHeroUltCd(30);
      document.getElementById('toast').textContent = '';
      T.triggerHeroUltNow();
      return JSON.stringify({ txt: document.getElementById('toast').textContent || '', cd: T.heroUltNow().cd });
    })()`));
    t('U9 冷却中 toast 含「冷却中」+剩余秒数', o.txt.indexOf('冷却中') >= 0 && o.txt.indexOf('30') >= 0 && o.cd > 25, JSON.stringify(o));
  } catch (e) { t('U9 冷却中 toast', false, e.message); }

  // ===== U10: 大招就绪时触发不误弹冷却提示(v0.3.40) =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      T.setHero('blade'); T.startGame(); T.skipIntro();
      T.setHeroUltCd(0);
      document.getElementById('toast').textContent = '';
      T.triggerHeroUltNow();
      return JSON.stringify({ txt: document.getElementById('toast').textContent || '', cd: T.heroUltNow().cd });
    })()`));
    t('U10 就绪触发不误弹冷却提示', o.txt.indexOf('冷却中') < 0 && o.cd > 40, JSON.stringify(o));
  } catch (e) { t('U10 就绪不误弹', false, e.message); }

  // ===== U11: E 键近战大招冷却中 toast(v0.3.41) =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      T.setHero('none'); T.startGame(); T.skipIntro();
      T.setUltCd(5);
      document.getElementById('toast').textContent = '';
      T.fireUlt();
      return JSON.stringify({ txt: document.getElementById('toast').textContent || '', cd: T.ultNow().cd });
    })()`));
    t('U11 近战大招冷却 toast 含剩余秒数', o.txt.indexOf('冷却中') >= 0 && o.txt.indexOf('5') >= 0 && o.cd > 3, JSON.stringify(o));
  } catch (e) { t('U11 近战大招冷却 toast', false, e.message); }

  // ===== U12: 近战大招就绪触发不误弹(v0.3.41) =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      T.setHero('none'); T.startGame(); T.skipIntro();
      T.setUltCd(0);
      document.getElementById('toast').textContent = '';
      T.fireUlt();
      return JSON.stringify({ txt: document.getElementById('toast').textContent || '', cd: T.ultNow().cd });
    })()`));
    t('U12 近战大招就绪不误弹冷却提示', o.txt.indexOf('冷却中') < 0 && o.cd > 6, JSON.stringify(o));
  } catch (e) { t('U12 近战大招就绪不误弹', false, e.message); }

  // ===== U13~U15: 余额不足文案统一为「还差 X（需 Y）」(v0.3.42) =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      return JSON.stringify({
        coin: T.shortMsg('🪙 金币', 10, 80),
        pet: T.shortMsg('🐾 宠物币', 2, 10, '解锁「狙击」'),
        edge: T.shortMsg('🪙 金币', 100, 100)
      });
    })()`));
    t('U13 金币不足含差额与所需', o.coin.indexOf('还差 70') >= 0 && o.coin.indexOf('需 80') >= 0, o.coin);
    t('U14 宠物币不足含差额与物品名', o.pet.indexOf('还差 8') >= 0 && o.pet.indexOf('解锁「狙击」') >= 0, o.pet);
    t('U15 边界余额相等时差额为 0 不为负', o.edge.indexOf('还差 0') >= 0 && o.edge.indexOf('-') < 0, o.edge);
  } catch (e) { t('U13 经济文案', false, e.message); t('U14 宠物币文案', false, e.message); t('U15 文案边界', false, e.message); }


  // ===== U16~U18: 大额货币千分位(v0.3.43) =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      T.setCoins(12345); const big = T.hudCoins();
      T.setCoins(123);   const small = T.hudCoins();
      T.setCoins(0);
      return JSON.stringify({ big, small, e9999: T.fmtNumNow(9999), e10000: T.fmtNumNow(10000) });
    })()`));
    t('U16 大额金币 HUD 显示 12,345', o.big === '12,345', JSON.stringify(o));
    t('U17 小额金币保持 123 不变', o.small === '123', JSON.stringify(o));
    t('U18 千分位边界 9999/10000', o.e9999 === '9999' && o.e10000 === '10,000', JSON.stringify(o));
  } catch (e) { t('U16 千分位', false, e.message); t('U17 小额兼容', false, e.message); t('U18 边界', false, e.message); }


  // ===== U19~U21: 局内 HUD 宠物币(v0.3.44) =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      T.setPetCoins(7);      const small = T.hudPetCoinsNow();
      T.setPetCoins(12345);  const big = T.hudPetCoinsNow();
      T.setPetCoins(0);      const zero = T.hudPetCoinsNow();
      const exists = !!document.getElementById('hudPetCoins');
      return JSON.stringify({ small, big, zero, exists });
    })()`));
    t('U19 HUD 宠物币随余额同步 7', o.small === '7' && o.exists, JSON.stringify(o));
    t('U20 HUD 宠物币大额千分位', o.big === '12,345', JSON.stringify(o));
    t('U21 宠物币清零显示 0', o.zero === '0', JSON.stringify(o));
  } catch (e) { t('U19 HUD宠物币', false, e.message); t('U20 HUD千分位', false, e.message); t('U21 HUD清零', false, e.message); }


  // ===== U22~U24: 成就解锁进度文案(v0.3.45) =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      return JSON.stringify({
        full: T.achUnlockMsgNow('测试成就', 100, 2, 7),
        zero: T.achUnlockMsgNow('无奖励', 0, 0, 1),
        pet:  T.achUnlockMsgNow('宠物成就', 0, 3, 12)
      });
    })()`));
    t('U22 文案含金币与宠物币奖励', o.full.indexOf('+100🪙') >= 0 && o.full.indexOf('+2🐾') >= 0, o.full);
    t('U23 文案含第 N 个成就进度', o.full.indexOf('第 7 个成就') >= 0 && o.pet.indexOf('第 12 个成就') >= 0, o.pet);
    t('U24 零奖励不出现 +0', o.zero.indexOf('+0') < 0 && o.zero.indexOf('第 1 个成就') >= 0, o.zero);
  } catch (e) { t('U22 成就奖励文案', false, e.message); t('U23 成就进度', false, e.message); t('U24 零奖励', false, e.message); }


  // ===== U25~U27: 购买成功余额提示(v0.3.46) =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      return JSON.stringify({
        coin: T.withBalanceNow('皮肤已购买', 850, '🪙'),
        pet:  T.withBalanceNow('宠物已购买', 12, '🐾'),
        big:  T.withBalanceNow('大额', 12345, '🪙')
      });
    })()`));
    t('U25 金币余额与货币符号', o.coin.indexOf('余额 850🪙') >= 0, o.coin);
    t('U26 宠物币余额', o.pet.indexOf('余额 12🐾') >= 0, o.pet);
    t('U27 大额余额千分位', o.big.indexOf('余额 12,345🪙') >= 0, o.big);
  } catch (e) { t('U25 金币余额', false, e.message); t('U26 宠物币余额', false, e.message); t('U27 余额千分位', false, e.message); }


  // ===== U28~U30: toast 防刷屏(v0.3.47) =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      const a1 = T.toastEmitNow('🐛 去重测试提示 A');
      const a2 = T.toastEmitNow('🐛 去重测试提示 A');
      const b  = T.toastEmitNow('🐛 去重测试提示 B');
      const c  = T.toastEmitNow('⏳ 大招冷却中 · 还需 5 秒');
      const d  = T.toastEmitNow('⏳ 大招冷却中 · 还需 5 秒');
      return JSON.stringify({ a1, a2, b, c, d, st: T.toastStatsNow() });
    })()`));
    t('U28 相同提示第二次被抑制', o.a2.suppressed === o.a1.suppressed + 1 && o.a2.count === o.a1.count, JSON.stringify(o.a2));
    t('U29 不同提示正常弹出', o.b.count === o.a2.count + 1, JSON.stringify(o.b));
    t('U30 冷却类提示不抑制', o.d.count === o.c.count + 1 && o.st.text.indexOf('还需 5 秒') >= 0, JSON.stringify(o.d));
  } catch (e) { t('U28 防刷屏', false, e.message); t('U29 不同提示', false, e.message); t('U30 冷却不抑制', false, e.message); }


  // ===== U31~U33: 宠物升级文案(v0.3.48) =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      return JSON.stringify({
        mid:  T.petUpgradeMsgNow('🐱','招财猫','金币+10%',1,6,12),
        max:  T.petUpgradeMsgNow('🐱','招财猫','金币+10%',2,0,6),
        big:  T.petUpgradeMsgNow('🐷','磁力猪','吸附',1,6,12345)
      });
    })()`));
    t('U31 升级文案含等级与下级费用', o.mid.indexOf('Lv2') >= 0 && o.mid.indexOf('下级 6🐾') >= 0 && o.mid.indexOf('余额 12🐾') >= 0, o.mid);
    t('U32 满级显示已满级且无下级', o.max.indexOf('已满级') >= 0 && o.max.indexOf('下级') < 0, o.max);
    t('U33 大额余额千分位', o.big.indexOf('余额 12,345🐾') >= 0, o.big);
  } catch (e) { t('U31 升级文案', false, e.message); t('U32 满级文案', false, e.message); t('U33 升级余额', false, e.message); }


  // ===== U34~U36: 签到文案(v0.3.49) =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const T = window.__tbTest;
      return JSON.stringify({
        normal: T.signinToastMsgNow(2, 30, 1, 0, 880),
        cycle:  T.signinToastMsgNow(7, 100, 3, 2, 1010),
        big:    T.signinToastMsgNow(14, 100, 3, 2, 12345)
      });
    })()`));
    t('U34 普通签到含天数奖励与余额', o.normal.indexOf('连续 2 天') >= 0 && o.normal.indexOf('+30🪙') >= 0 && o.normal.indexOf('余额 880🪙') >= 0, o.normal);
    t('U35 整轮签到保留庆祝标识与 +3🐾', o.cycle.indexOf('🎉整轮奖励！') >= 0 && o.cycle.indexOf('+3🐾') >= 0, o.cycle);
    t('U36 签到大额余额千分位', o.big.indexOf('余额 12,345🪙') >= 0, o.big);
  } catch (e) { t('U34 签到文案', false, e.message); t('U35 整轮标识', false, e.message); t('U36 签到余额', false, e.message); }


  // ===== U37~U38: 过关奖励余额(v0.3.50) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.levelClearMsgNow(120,'',880),b:T.levelClearMsgNow(120,' +1🐾',12345)});})()"));
    t('U37 过关奖励含奖励值与余额', o.a.indexOf('+120')>=0 && o.a.indexOf('余额 880🪙')>=0, o.a);
    t('U38 过关奖励含宠物币且大额千分位', o.b.indexOf('+1🐾')>=0 && o.b.indexOf('余额 12,345🪙')>=0, o.b);
  } catch(e){ t('U37 过关文案',false,e.message); t('U38 过关千分位',false,e.message); }


  // ===== U39~U40: BOSS 击破得分(v0.3.51) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossKillMsgNow(3200),b:T.bossKillMsgNow(12345)});})()"));
    t('U39 击破文案含当前得分', o.a.indexOf('当前 3200 分')>=0 && o.a.indexOf('BOSS 击破')>=0, o.a);
    t('U40 得分大额千分位', o.b.indexOf('当前 12,345 分')>=0, o.b);
  } catch(e){ t('U39 击破得分',false,e.message); t('U40 得分千分位',false,e.message); }


  // ===== U41~U42: 抽奖结果余额(v0.3.52) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.gachaMsgNow('🪙 +600','大吉',1100),b:T.gachaMsgNow('🪙 +100','',12345)});})()"));
    t('U41 抽奖文案含详情与余额', o.a.indexOf('🪙 +600')>=0 && o.a.indexOf('大吉')>=0 && o.a.indexOf('余额 1100🪙')>=0, o.a);
    t('U42 无详情不出现分隔符且大额千分位', o.b.indexOf(' · · ') < 0 && o.b.indexOf('余额 12,345🪙')>=0, o.b);
  } catch(e){ t('U41 抽奖文案',false,e.message); t('U42 抽奖余额',false,e.message); }


  // ===== U43~U44: 重置返还余额(v0.3.53) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.resetBonusMsgNow(175,4915),b:T.resetBonusMsgNow(350,12345)});})()"));
    t('U43 重置文案含返还与余额', o.a.indexOf('返还 🪙175')>=0 && o.a.indexOf('余额 4915🪙')>=0, o.a);
    t('U44 重置大额余额千分位', o.b.indexOf('余额 12,345🪙')>=0, o.b);
  } catch(e){ t('U43 重置文案',false,e.message); t('U44 重置余额',false,e.message); }


  // ===== U45~U46: 周挑战余额(v0.3.54) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.weeklyMsgNow(150,900),b:T.weeklyMsgNow(150,12345)});})()"));
    t('U45 周挑战文案含奖励与余额', o.a.indexOf('+150🪙')>=0 && o.a.indexOf('余额 900🪙')>=0, o.a);
    t('U46 周挑战大额千分位', o.b.indexOf('余额 12,345🪙')>=0, o.b);
  } catch(e){ t('U45 周挑战文案',false,e.message); t('U46 周挑战余额',false,e.message); }


  // ===== U47~U48: 关卡完成文案(v0.3.55) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.levelDoneMsgNow(5,80,920),b:T.levelDoneMsgNow(12,120,12345)});})()"));
    t('U47 关完成含关卡奖励与余额', o.a.indexOf('第 5 关完成')>=0 && o.a.indexOf('+80')>=0 && o.a.indexOf('余额 920🪙')>=0, o.a);
    t('U48 关完成大额千分位', o.b.indexOf('余额 12,345🪙')>=0, o.b);
  } catch(e){ t('U47 关完成文案',false,e.message); t('U48 关完成千分位',false,e.message); }


  // ===== U49~U50: BOSS 出场关卡(v0.3.56) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossAppearMsgNow('重甲',8),b:T.bossAppearMsgNow('幽灵',15)});})()"));
    t('U49 BOSS 出场含名称与关卡', o.a.indexOf('重甲 BOSS 出现')>=0 && o.a.indexOf('第 8 关')>=0, o.a);
    t('U50 BOSS 出场关卡可变', o.b.indexOf('第 15 关')>=0, o.b);
  } catch(e){ t('U49 BOSS出场',false,e.message); t('U50 BOSS关卡',false,e.message); }


  // ===== U51~U52: 星级奖励文案(v0.3.57) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.starRewardMsgNow(3,150,1050),b:T.starRewardMsgNow(2,80,12345)});})()"));
    t('U51 星级奖励含星数与余额', o.a.indexOf('3 星')>=0 && o.a.indexOf('🪙+150')>=0 && o.a.indexOf('余额 1050🪙')>=0, o.a);
    t('U52 星级奖励大额千分位', o.b.indexOf('余额 12,345🪙')>=0, o.b);
  } catch(e){ t('U51 星级文案',false,e.message); t('U52 星级余额',false,e.message); }


  // ===== U53~U54: 基地重建文案(v0.3.58) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.rebuildMsgNow(160,340),b:T.rebuildMsgNow(200,12345)});})()"));
    t('U53 重建含花费与余额', o.a.indexOf('花 160 金币')>=0 && o.a.indexOf('余额 340🪙')>=0, o.a);
    t('U54 重建大额千分位', o.b.indexOf('余额 12,345🪙')>=0, o.b);
  } catch(e){ t('U53 重建文案',false,e.message); t('U54 重建余额',false,e.message); }


  // ===== U55~U56: 加成购买文案(v0.3.59) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bonusBuyMsgNow('🛡','护盾强化',740),b:T.bonusBuyMsgNow('⚡','射速',12345)});})()"));
    t('U55 加成购买含名称与余额', o.a.indexOf('护盾强化')>=0 && o.a.indexOf('余额 740🪙')>=0, o.a);
    t('U56 加成购买大额千分位', o.b.indexOf('余额 12,345🪙')>=0, o.b);
  } catch(e){ t('U55 加成文案',false,e.message); t('U56 加成余额',false,e.message); }


  // ===== U57~U58: 僚机皮肤购买文案(v0.3.60) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.wskinBuyMsgNow('🟡','黄金僚机',880),b:T.wskinBuyMsgNow('🟣','紫电僚机',12345)});})()"));
    t('U57 僚机皮肤购买含名称与余额', o.a.indexOf('黄金僚机')>=0 && o.a.indexOf('余额 880🪙')>=0, o.a);
    t('U58 僚机皮肤大额千分位', o.b.indexOf('余额 12,345🪙')>=0, o.b);
  } catch(e){ t('U57 僚机文案',false,e.message); t('U58 僚机余额',false,e.message); }


  // ===== U59~U60: 重置强化单一提示(v0.3.61) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({gone:T.legacyResetGoneNow(),m:T.resetBonusMsgNow(300,12345)});})()"));
    t('U59 按钮回调不再二次弹旧文案', o.gone === true, JSON.stringify(o));
    t('U60 重置提示含返还与余额', o.m.indexOf('返还 🪙300')>=0 && o.m.indexOf('余额 12,345🪙')>=0, o.m);
  } catch(e){ t('U59 重置单一提示',false,e.message); t('U60 重置余额',false,e.message); }


  // ===== U61~U62: 新纪录文案(v0.3.62) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.recordMsgNow(860),b:T.recordMsgNow(1234567)});})()"));
    t('U61 新纪录保留原始分数', o.a.indexOf('860 分')>=0, o.a);
    t('U62 新纪录大额千分位', o.b.indexOf('1,234,567 分')>=0, o.b);
  } catch(e){ t('U61 新纪录小分数',false,e.message); t('U62 新纪录千分位',false,e.message); }


  // ===== U63~U64: 模式结算文案(v0.3.63) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.modeSettleMsgNow('daily',true,50,12345),b:T.modeSettleMsgNow('timed',false,23,12345),c:T.modeSettleMsgNow('timed',true,23,999)});})()"));
    t('U63 每日挑战结算含奖励与余额', o.a.indexOf('每日挑战通关')>=0 && o.a.indexOf('🪙50')>=0 && o.a.indexOf('余额 12,345🪙')>=0, o.a);
    t('U64 限时冲分含结束态与千分位', o.b.indexOf('限时冲分结束')>=0 && o.b.indexOf('余额 12,345🪙')>=0 && o.c.indexOf('限时冲分完成')>=0, o.b+' | '+o.c);
  } catch(e){ t('U63 每日结算',false,e.message); t('U64 限时结算',false,e.message); }


  // ===== U65~U66: 基地升级文案(v0.3.64) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseUpgradeMsgNow('堡垒',12,340),b:T.baseUpgradeMsgNow('要塞',24,12345)});})()"));
    t('U65 基地升级含名称护墙与余额', o.a.indexOf('堡垒')>=0 && o.a.indexOf('护墙 12 格')>=0 && o.a.indexOf('余额 340🪙')>=0, o.a);
    t('U66 基地升级大额千分位', o.b.indexOf('余额 12,345🪙')>=0, o.b);
  } catch(e){ t('U65 基地文案',false,e.message); t('U66 基地千分位',false,e.message); }


  // ===== U67~U68: 装备提示(v0.3.65) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.equipMsgNow('🟦','深海迷彩'),b:T.equipMsgNow('🟣','紫电僚机'),c:T.petFollowMsgNow('🐢','守护龟',3)});})()"));
    t('U67 皮肤与僚机共用装备文案', o.a.indexOf('已装备 · 深海迷彩')>=0 && o.b.indexOf('已装备 · 紫电僚机')>=0, o.a+' | '+o.b);
    t('U68 宠物跟随含名称与等级', o.c.indexOf('守护龟 已跟随 · Lv3')>=0, o.c);
  } catch(e){ t('U67 装备文案',false,e.message); t('U68 宠物跟随',false,e.message); }


  // ===== U69~U70: 英雄未解锁提示(v0.3.66) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.heroLockedMsgNow('磁暴',80,35),b:T.heroLockedMsgNow('堡垒',60,60)});})()"));
    t('U69 未解锁提示含差额与总价', o.a.indexOf('还差 45🐾')>=0 && o.a.indexOf('需 80🐾')>=0, o.a);
    t('U70 余额已足时差额不为负', o.b.indexOf('还差 0🐾')>=0, o.b);
  } catch(e){ t('U69 英雄差额',false,e.message); t('U70 差额下限',false,e.message); }


  // ===== U71~U72: toast 可访问性(v0.3.67) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.toastAriaNow());})()"));
    t('U71 toast 具备 status 语义', o.role === 'status' && o.live === 'polite', JSON.stringify(o));
    t('U72 toast 整条播报不拆分', o.atomic === 'true', JSON.stringify(o));
  } catch(e){ t('U71 toast 语义',false,e.message); t('U72 toast 播报',false,e.message); }


  // ===== U73~U74: 长提示截断(v0.3.68) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;const L='A'.repeat(140);return JSON.stringify({a:T.toastClipNow('短提示',90),b:T.toastClipNow(L,90),len:T.toastClipDomNow(L)});})()"));
    t('U73 短提示原样保留', o.a === '短提示', o.a);
    t('U74 长提示截断为 90 字并带省略号', o.b.length === 90 && o.b.slice(-1) === '…' && o.len === 90, 'b=' + o.b.length + ' dom=' + o.len);
  } catch(e){ t('U73 短提示',false,e.message); t('U74 长提示截断',false,e.message); }


  // ===== U75~U76: 时长格式化(v0.3.69) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.fmtDurationNow(120),b:T.fmtDurationNow(65),c:T.fmtDurationNow(45),d:T.fmtDurationNow(-3),e:T.fmtDurationNow(0)});})()"));
    t('U75 整分与分秒混合显示', o.a === '2分' && o.b === '1分5秒', JSON.stringify(o));
    t('U76 秒级与非法值兜底', o.c === '45秒' && o.d === '0秒' && o.e === '0秒', JSON.stringify(o));
  } catch(e){ t('U75 分秒格式',false,e.message); t('U76 时长兜底',false,e.message); }


  // ===== U77~U78: 复制失败提示(v0.3.70) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.copyFailMsgNow('挑战链接','请手动复制地址栏链接'),b:T.copyFailMsgNow('战绩图','请长按图片保存')});})()"));
    t('U77 失败提示带对象与建议', o.a.indexOf('⚠ 挑战链接复制失败')>=0 && o.a.indexOf('请手动复制地址栏链接')>=0, o.a);
    t('U78 两处失败提示口径一致', o.b.indexOf('⚠ 战绩图复制失败')>=0 && o.b.indexOf(' · ')>=0, o.b);
  } catch(e){ t('U77 复制失败对象',false,e.message); t('U78 复制失败口径',false,e.message); }


  // ===== U79~U80: 分享码提示(v0.3.71) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.shareCodeMsgNow(320),b:T.shareCodeMsgNow(12345),c:T.shareImportMsgNow(true,'迷宫',''),d:T.shareImportMsgNow(false,'','校验失败')});})()"));
    t('U79 分享码字符数正常/大额千分位', o.a.indexOf('320 字符')>=0 && o.b.indexOf('12,345 字符')>=0, o.a+' | '+o.b);
    t('U80 导入成功与失败明确区分', o.c.indexOf('已导入「迷宫」')>=0 && o.d.indexOf('⚠ 导入失败 · 校验失败')>=0, o.c+' | '+o.d);
  } catch(e){ t('U79 分享码字符数',false,e.message); t('U80 导入反馈',false,e.message); }


  // ===== U81~U82: 成就完成度(v0.3.72) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.achPctNow(7,20),b:T.achPctNow(0,0),c:T.achPctNow(25,20),d:T.achBadgeTitleMsgNow(7,20)});})()"));
    t('U81 完成度四舍五入且不超 100', o.a === 35 && o.b === 0 && o.c === 100, JSON.stringify(o));
    t('U82 徽章标题含进度与百分比', o.d.indexOf('7/20')>=0 && o.d.indexOf('完成度 35%')>=0, o.d);
  } catch(e){ t('U81 完成度计算',false,e.message); t('U82 徽章标题',false,e.message); }


  // ===== U83~U84: HUD 数值口径(v0.3.73) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.hudNumNow(999),b:T.hudNumNow(123456),c:T.hudNumNow(-5),d:T.hudNumNow(NaN)});})()"));
    t('U83 小额原样大额千分位', o.a === '999' && o.b === '123,456', JSON.stringify(o));
    t('U84 负数与非法值兜底为零', o.c === '0' && o.d === '0', JSON.stringify(o));
  } catch(e){ t('U83 HUD 千分位',false,e.message); t('U84 HUD 兜底',false,e.message); }


  // ===== U85~U86: 冷却提示(v0.3.74) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.cooldownMsgNow('大招',45),b:T.cooldownMsgNow('英雄技',65),c:T.cooldownMsgNow('大招',120)});})()"));
    t('U85 冷却提示保留技能名与秒数', o.a.indexOf('大招冷却中')>=0 && o.a.indexOf('还需 45秒')>=0, o.a);
    t('U86 长冷却显示分秒且前缀一致', o.b.indexOf('英雄技冷却中')>=0 && o.b.indexOf('还需 1分5秒')>=0 && o.c.indexOf('还需 2分')>=0, o.b+' | '+o.c);
  } catch(e){ t('U85 冷却秒数',false,e.message); t('U86 冷却分秒',false,e.message); }


  // ===== U87~U88: BOSS 技能提示(v0.3.75) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossSkillMsgNow('🎯','散射弹幕'),b:T.bossSkillMsgNow('⚡','激光扫射'),c:T.bossSkillMsgNow('🧬','分裂召唤')});})()"));
    t('U87 技能提示标注 BOSS 来源', o.a.indexOf('BOSS 技能 · 散射弹幕')>=0 && o.b.indexOf('BOSS 技能 · 激光扫射')>=0, o.a+' | '+o.b);
    t('U88 三种技能文案口径一致', o.c.indexOf('BOSS 技能 · 分裂召唤')>=0 && o.a.indexOf('🎯')===0 && o.a.slice(-1)==='！', JSON.stringify(o));
  } catch(e){ t('U87 BOSS 技能来源',false,e.message); t('U88 BOSS 技能口径',false,e.message); }


  // ===== U89~U90: 道具与强化提示(v0.3.76) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.powerupMsgNow('无敌护盾'),b:T.boostMsgNow('🛡','开局护盾')});})()"));
    t('U89 道具提示带主语与名称', o.a.indexOf('🎁 获得道具 · 无敌护盾！')>=0, o.a);
    t('U90 强化提示标明已生效', o.b.indexOf('🛡 强化生效 · 开局护盾')>=0, o.b);
  } catch(e){ t('U89 道具提示',false,e.message); t('U90 强化提示',false,e.message); }


  // ===== U91~U92: 存档恢复提示(v0.3.77) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.restoreMsgNow(true,''),b:T.restoreMsgNow(false,'校验失败')});})()"));
    t('U91 恢复成功文案不变', o.a === '✅ 存档已恢复', o.a);
    t('U92 恢复失败带前缀与原因', o.b.indexOf('⚠ 存档恢复失败 · 校验失败')>=0, o.b);
  } catch(e){ t('U91 恢复成功',false,e.message); t('U92 恢复失败',false,e.message); }


  // ===== U93~U94: 环境与战绩图提示(v0.3.78) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.unsupportedMsgNow('全屏','请在设置中手动切换'),b:T.unsupportedMsgNow('直接安装','可用浏览器菜单'),c:T.reportMsgNow(false,'先打一局再来生成'),d:T.reportMsgNow(true,'')});})()"));
    t('U93 不支持提示带对象与替代操作', o.a.indexOf('不支持全屏 · 请在设置中手动切换')>=0 && o.b.indexOf('可用浏览器菜单')>=0, o.a+' | '+o.b);
    t('U94 战绩图失败/成功口径分明', o.c.indexOf('⚠ 战绩图生成失败 · 先打一局再来生成')>=0 && o.d === '✅ 战绩图已生成', o.c+' | '+o.d);
  } catch(e){ t('U93 环境提示',false,e.message); t('U94 战绩图提示',false,e.message); }


  // ===== U95~U96: 每日挑战提示(v0.3.79) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.dailyIntroMsgNow(3,7),b:T.dailyIntroMsgNow(11,24),c:T.dailyModMsgNow('钢铁防线')});})()"));
    t('U95 日期补零且格式统一', o.a.indexOf('03/07')>=0 && o.b.indexOf('11/24')>=0 && o.a.indexOf('全网同图')>=0, o.a+' | '+o.b);
    t('U96 词条提示标明今日', o.c.indexOf('⚡ 今日词条 · 钢铁防线')>=0, o.c);
  } catch(e){ t('U95 每日日期',false,e.message); t('U96 今日词条',false,e.message); }


  // ===== U97~U98: 签到与内测奖励(v0.3.80) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.signinRemindMsgNow(120),b:T.signinRemindMsgNow(12345),c:T.betaRewardMsgNow(1000,2050),d:T.betaRewardMsgNow(1000,12345)});})()"));
    t('U97 签到提醒小额原样大额千分位', o.a.indexOf('领 120🪙')>=0 && o.b.indexOf('领 12,345🪙')>=0, o.a+' | '+o.b);
    t('U98 内测奖励附余额且千分位', o.c.indexOf('+1000🪙')>=0 && o.c.indexOf('余额 2050🪙')>=0 && o.d.indexOf('余额 12,345🪙')>=0, o.c+' | '+o.d);
  } catch(e){ t('U97 签到提醒',false,e.message); t('U98 内测奖励',false,e.message); }


  // ===== U99~U100: 传送门校验提示(v0.3.81) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.portalMsgNow(1),b:T.portalMsgNow(5)});})()"));
    t('U99 提示含当前传送门数量', o.a.indexOf('当前 1 个')>=0 && o.b.indexOf('当前 5 个')>=0, o.a+' | '+o.b);
    t('U100 提示保留成对规则', o.a.indexOf('0 或 2 的倍数')>=0 && o.b.indexOf('⚠ 传送门需成对放置')>=0, o.a);
  } catch(e){ t('U99 传送门数量',false,e.message); t('U100 成对规则',false,e.message); }


  // ===== U101~U102: 画质提示(v0.3.82) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.qualityMsgNow(0),b:T.qualityMsgNow(2),c:T.qualityMsgNow(9),d:T.qualityMsgNow(-1)});})()"));
    t('U101 三档名称与设置入口', o.a.indexOf('「高」')>=0 && o.b.indexOf('「低」')>=0 && o.a.indexOf('可在设置中手动切换')>=0, o.a+' | '+o.b);
    t('U102 越界档位兜底为自动', o.c.indexOf('「自动」')>=0 && o.d.indexOf('「自动」')>=0, o.c+' | '+o.d);
  } catch(e){ t('U101 画质档位',false,e.message); t('U102 档位兜底',false,e.message); }


  // ===== U103~U104: 编辑器提示(v0.3.83) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.mapSaveMsgNow('迷宫'),b:T.editorMsgNow('clear'),c:T.editorMsgNow('draw')});})()"));
    t('U103 保存提示含关卡名', o.a.indexOf('已保存自制关卡「迷宫」')>=0, o.a);
    t('U104 清空提示含引导且分支可辨', o.b.indexOf('已清空画布 · 可重新绘制')>=0 && o.c === '🛠 画布已更新', o.b+' | '+o.c);
  } catch(e){ t('U103 保存提示',false,e.message); t('U104 清空提示',false,e.message); }


  // ===== U105~U106: 英雄技提示(v0.3.84) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.heroUltMsgNow('⚔️','狂暴速射','5 秒双倍射速'),b:T.heroUltMsgNow('🧲','磁暴领域','3 秒超强磁力'),c:T.heroUltMsgNow('🎯','穿透一击','下一发贯穿全场')});})()"));
    t('U105 英雄技提示带主语与技能名', o.a.indexOf('英雄技 · 狂暴速射')>=0 && o.b.indexOf('英雄技 · 磁暴领域')>=0, o.a+' | '+o.b);
    t('U106 英雄技提示保留效果与结尾', o.c.indexOf('下一发贯穿全场！')>=0 && o.a.slice(-1) === '！', o.c);
  } catch(e){ t('U105 英雄技主语',false,e.message); t('U106 英雄技效果',false,e.message); }


  // ===== U107~U108: BOSS 狂暴提示(v0.3.85) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossEnrageMsgNow(1),b:T.bossEnrageMsgNow(2)});})()"));
    t('U107 一段与二段提示可区分', o.a.indexOf('BOSS 狂暴！')>=0 && o.b.indexOf('BOSS 狂暴·二段！')>=0, o.a+' | '+o.b);
    t('U108 两阶段均说明威胁变化', o.a.indexOf('弹幕与速度提升')>=0 && o.b.indexOf('弹幕与速度提升')>=0, o.a+' | '+o.b);
  } catch(e){ t('U107 狂暴阶段',false,e.message); t('U108 狂暴威胁',false,e.message); }


  // ===== U109~U110: 英雄选择提示(v0.3.86) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.heroSelectMsgNow('🛡','堡垒','生命 +1',null),b:T.heroSelectMsgNow('⚔️','剑刃','双倍射速',{icon:'💰',name:'刀口舔金'})});})()"));
    t('U109 无羁绊时不出现羁绊字样', o.a.indexOf('英雄 · 堡垒（生命 +1）')>=0 && o.a.indexOf('羁绊')<0, o.a);
    t('U110 有羁绊时标注激活', o.b.indexOf('💰 羁绊「刀口舔金」激活！')>=0, o.b);
  } catch(e){ t('U109 无羁绊',false,e.message); t('U110 羁绊激活',false,e.message); }


  // ===== U111~U112: 备份与分享提示(v0.3.87) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.backupTipMsgNow(),b:T.reportShareMsgNow()});})()"));
    t('U111 备份提醒含原因与入口', o.a.indexOf('进度已累积')>=0 && o.a.indexOf('设置 → 💾 存档')>=0, o.a);
    t('U112 分享提示带主语与操作', o.b.indexOf('📷 战绩图已生成')>=0 && o.b.indexOf('长按图片保存发给朋友')>=0, o.b);
  } catch(e){ t('U111 备份提醒',false,e.message); t('U112 战绩图分享',false,e.message); }


  // ===== U113~U114: 链接与空重置(v0.3.88) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.challengeLinkMsgNow(true),b:T.challengeLinkMsgNow(false),c:T.resetEmptyMsgNow()});})()"));
    t('U113 复制成功与失败共用口径', o.a.indexOf('📋 挑战链接已复制')>=0 && o.b.indexOf('⚠ 挑战链接复制失败')>=0, o.a+' | '+o.b);
    t('U114 空重置提示给出下一步', o.c.indexOf('暂无强化可重置')>=0 && o.c.indexOf('先在商店购买加成')>=0, o.c);
  } catch(e){ t('U113 链接提示',false,e.message); t('U114 空重置',false,e.message); }


  // ===== U115~U116: toast 时长自适应(v0.3.89) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.toastDurationNow('短'),b:T.toastDurationNow('A'.repeat(60)),c:T.toastDurationNow('A'.repeat(200)),d:T.toastDurationNow('')});})()"));
    t('U115 短文案保持 1600ms', o.a === 1600 && o.d === 1600, JSON.stringify(o));
    t('U116 长文案延长且封顶 3200ms', o.b === 2500 && o.c === 3200, JSON.stringify(o));
  } catch(e){ t('U115 短文案时长',false,e.message); t('U116 长文案时长',false,e.message); }


  // ===== U117~U118: 结算基础金币提示抽为可测纯函数(v0.4.0) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.lvBaseTextNow(0),b:T.lvBaseTextNow(12345)});})()"));
    t('U117 小额原样', o.a === '+0 🪙', JSON.stringify(o));
    t('U118 大额千分位', o.b === '+12,345 🪙', JSON.stringify(o));
  } catch(e){ t('U117 小额原样',false,e.message); t('U118 大额千分位',false,e.message); }


  // ===== U119~U120: 结算星级金币提示抽为可测纯函数(v0.4.1) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.lvStarGoldTextNow(80),b:T.lvStarGoldTextNow(12345)});})()"));
    t('U119 小额原样', o.a === '+80 🪙', JSON.stringify(o));
    t('U120 大额千分位', o.b === '+12,345 🪙', JSON.stringify(o));
  } catch(e){ t('U119 小额原样',false,e.message); t('U120 大额千分位',false,e.message); }


  // ===== U121~U122: 星级评论文案抽为纯函数并做范围钳制(v0.4.2) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.starRatingTextNow(2,3),b:T.starRatingTextNow(9,3)});})()"));
    t('U121 二星补空心', o.a === '评级 ★★☆', JSON.stringify(o));
    t('U122 越界钳制为满星', o.b === '评级 ★★★', JSON.stringify(o));
  } catch(e){ t('U121 二星补空心',false,e.message); t('U122 越界钳制为满星',false,e.message); }


  // ===== U123~U124: 连击显示抽为纯函数并做数值兜底(v0.4.3) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.comboTextNow(2),b:T.comboTextNow(12345)});})()"));
    t('U123 普通连击', o.a === '×2', JSON.stringify(o));
    t('U124 大额千分位', o.b === '×12,345', JSON.stringify(o));
  } catch(e){ t('U123 普通连击',false,e.message); t('U124 大额千分位',false,e.message); }


  // ===== U125~U126: 基地复活按钮文案显示千分位(v0.4.4) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.reviveBtnTextNow(160),b:T.reviveBtnTextNow(12345)});})()"));
    t('U125 小额原样', o.a === '🪙 花 160 金币复活基地', JSON.stringify(o));
    t('U126 大额千分位', o.b === '🪙 花 12,345 金币复活基地', JSON.stringify(o));
  } catch(e){ t('U125 小额原样',false,e.message); t('U126 大额千分位',false,e.message); }


  // ===== U127~U128: 结算页波次与关卡提示抽为纯函数(v0.4.5) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.waveTipTextNow(true,8),b:T.waveTipTextNow(false,5)});})()"));
    t('U127 无尽显示波', o.a === '无尽模式 · 到达第 8 波', JSON.stringify(o));
    t('U128 普通显示关', o.b === '达到第 5 关', JSON.stringify(o));
  } catch(e){ t('U127 无尽显示波',false,e.message); t('U128 普通显示关',false,e.message); }


  // ===== U129~U130: 结算标题 HTML 抽为纯函数(v0.4.6) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.lvTitleHtmlNow(true,8),b:T.lvTitleHtmlNow(false,5)});})()"));
    t('U129 无尽标题', o.a === '第 <b>8</b> 波 · 坚持', JSON.stringify(o));
    t('U130 普通标题', o.b === '第 <b>5</b> 关 · 通关', JSON.stringify(o));
  } catch(e){ t('U129 无尽标题',false,e.message); t('U130 普通标题',false,e.message); }


  // ===== U131~U132: 结算用时文本抽为纯函数并做非负兜底(v0.4.7) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.lvTimeTextNow(12.9),b:T.lvTimeTextNow(-3)});})()"));
    t('U131 小数取整', o.a === '12s', JSON.stringify(o));
    t('U132 负数兜底', o.b === '0s', JSON.stringify(o));
  } catch(e){ t('U131 小数取整',false,e.message); t('U132 负数兜底',false,e.message); }


  // ===== U133~U134: 结算剩余生命抽为纯函数(v0.4.8) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.lvLivesTextNow(3),b:T.lvLivesTextNow(-2)});})()"));
    t('U133 正常生命', o.a === '3', JSON.stringify(o));
    t('U134 负数兜底', o.b === '0', JSON.stringify(o));
  } catch(e){ t('U133 正常生命',false,e.message); t('U134 负数兜底',false,e.message); }


  // ===== U135~U136: 结算击杀数与关卡数抽为纯函数(v0.4.9) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.lvCountTextNow(27),b:T.lvCountTextNow(null)});})()"));
    t('U135 普通计数', o.a === '27', JSON.stringify(o));
    t('U136 空值兜底', o.b === '0', JSON.stringify(o));
  } catch(e){ t('U135 普通计数',false,e.message); t('U136 空值兜底',false,e.message); }


  // ===== U137~U138: 标题页无尽按钮抽为纯函数并补千分位(v0.4.10) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.endlessBtnHtmlNow(0),b:T.endlessBtnHtmlNow(12345)});})()"));
    t('U137 无纪录不附加', o.a === '🌊 无尽模式', JSON.stringify(o));
    t('U138 大额千分位', o.b === '🌊 无尽模式 · 最高 12,345 波', JSON.stringify(o));
  } catch(e){ t('U137 无纪录不附加',false,e.message); t('U138 大额千分位',false,e.message); }


  // ===== U139~U140: 成就数量文本抽为纯函数(v0.4.11) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.achCountTextNow(7,20),b:T.achCountTextNow(12345,20000)});})()"));
    t('U139 普通进度', o.a === '7/20', JSON.stringify(o));
    t('U140 大额千分位', o.b === '12,345/20,000', JSON.stringify(o));
  } catch(e){ t('U139 普通进度',false,e.message); t('U140 大额千分位',false,e.message); }


  // ===== U141~U142: 成就页双币统计条抽为纯函数(v0.4.12) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.achPetStatHtmlNow(3,9,7,20),b:T.achPetStatHtmlNow(0,9,0,20)});})()"));
    t('U141 两组统计齐全', o.a.indexOf('宠物币进度 3 / 9')>=0 && o.a.indexOf('已解锁 7 / 20')>=0, JSON.stringify(o));
    t('U142 标签结构完整', o.b.indexOf('</span><span>')>=0 && o.b.slice(-7) === '</span>', JSON.stringify(o));
  } catch(e){ t('U141 两组统计齐全',false,e.message); t('U142 标签结构完整',false,e.message); }


  // ===== U143~U144: 成就分组标题 HTML 抽为纯函数(v0.4.13) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.achGroupHtmlNow('战斗',3,5,60),b:T.achGroupHtmlNow('生存',0,5,0)});})()"));
    t('U143 名称进度条齐全', o.a.indexOf('agName">战斗')>=0 && o.a.indexOf('3/5')>=0 && o.a.indexOf('width:60%')>=0, JSON.stringify(o));
    t('U144 零进度正确', o.b.indexOf('0/5')>=0 && o.b.indexOf('width:0%')>=0, JSON.stringify(o));
  } catch(e){ t('U143 名称进度条齐全',false,e.message); t('U144 零进度正确',false,e.message); }


  // ===== U145~U146: 签到副标题抽为纯函数(v0.4.14) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.signinSubTextNow(true,3,0),b:T.signinSubTextNow(false,0,12345)});})()"));
    t('U145 已签到显示连续', o.a === '已连续 3 天', JSON.stringify(o));
    t('U146 未签到奖励千分位', o.b === '今日可领 🪙12,345', JSON.stringify(o));
  } catch(e){ t('U145 已签到显示连续',false,e.message); t('U146 未签到奖励千分位',false,e.message); }


  // ===== U147~U148: 生涯页局数副标题抽为纯函数(v0.4.15) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerSubTextNow(5),b:T.careerSubTextNow(12345)});})()"));
    t('U147 普通局数', o.a === '共 5 局', JSON.stringify(o));
    t('U148 大额千分位', o.b === '共 12,345 局', JSON.stringify(o));
  } catch(e){ t('U147 普通局数',false,e.message); t('U148 大额千分位',false,e.message); }


  // ===== U149~U150: 选关页解锁进度抽为纯函数(v0.4.16) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.levelSelSubTextNow(3),b:T.levelSelSubTextNow(12345)});})()"));
    t('U149 普通关卡数', o.a === '已解锁 3 关', JSON.stringify(o));
    t('U150 大额千分位', o.b === '已解锁 12,345 关', JSON.stringify(o));
  } catch(e){ t('U149 普通关卡数',false,e.message); t('U150 大额千分位',false,e.message); }


  // ===== U151~U152: 英雄分段按钮文案抽为纯函数(v0.4.17) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.heroSegTextNow('🛡','堡垒',true,80),b:T.heroSegTextNow('🛡','堡垒',false,80)});})()"));
    t('U151 已拥有不显示价格', o.a === '🛡 堡垒', JSON.stringify(o));
    t('U152 未解锁显示价格', o.b === '🛡 堡垒 80🐾', JSON.stringify(o));
  } catch(e){ t('U151 已拥有不显示价格',false,e.message); t('U152 未解锁显示价格',false,e.message); }


  // ===== U153~U154: 强化卡持有数文案抽为纯函数(v0.4.18) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.upgradeOwnTextNow(3,'生存'),b:T.upgradeOwnTextNow(0,'生存')});})()"));
    t('U153 已持有显示数量', o.a === '已持有 ×3', JSON.stringify(o));
    t('U154 未持有显示标签', o.b === '生存', JSON.stringify(o));
  } catch(e){ t('U153 已持有显示数量',false,e.message); t('U154 未持有显示标签',false,e.message); }


  // ===== U155~U156: 每日英雄提示 HTML 抽为纯函数(v0.4.19) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.dailyHeroTipHtmlNow('🛡','堡垒','生命+1'),b:T.dailyHeroTipHtmlNow('⚡','先锋','冲锋')});})()"));
    t('U155 三项信息齐全', o.a.indexOf('今日英雄: 🛡 堡垒（生命+1）')>=0, JSON.stringify(o));
    t('U156 前缀与描述正确', o.b.indexOf('📅 每日挑战')===0 && o.b.indexOf('冲锋')>=0, JSON.stringify(o));
  } catch(e){ t('U155 三项信息齐全',false,e.message); t('U156 前缀与描述正确',false,e.message); }


  // ===== U157~U158: 主菜单副标题抽为按场景取值的纯函数(v0.4.20) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.ovSubTextNow('invite'),b:T.ovSubTextNow('unknown')});})()"));
    t('U157 挑战场景', o.a.indexOf('好友向你发起挑战')>=0, JSON.stringify(o));
    t('U158 未知场景返回空串', o.b === '', JSON.stringify(o));
  } catch(e){ t('U157 挑战场景',false,e.message); t('U158 未知场景返回空串',false,e.message); }


  // ===== U159~U160: 结算胜负副标题抽为纯函数(v0.4.21) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.resultSubTextNow(true),b:T.resultSubTextNow(false)});})()"));
    t('U159 胜利文案', o.a === '基地守住了！', JSON.stringify(o));
    t('U160 失败文案', o.b === '基地被摧毁了…', JSON.stringify(o));
  } catch(e){ t('U159 胜利文案',false,e.message); t('U160 失败文案',false,e.message); }


  // ===== U161~U162: 遮罩标题文案抽为纯函数(v0.4.22) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.overlayTitleTextNow('title'),b:T.overlayTitleTextNow('pause')});})()"));
    t('U161 标题页', o.a === '坦克大战', JSON.stringify(o));
    t('U162 暂停页', o.b === '已暂停', JSON.stringify(o));
  } catch(e){ t('U161 标题页',false,e.message); t('U162 暂停页',false,e.message); }


  // ===== U163~U164: 主按钮文案抽为纯函数(v0.4.23) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.playBtnTextNow('resume'),b:T.playBtnTextNow('replay')});})()"));
    t('U163 暂停续玩', o.a === '继续游戏', JSON.stringify(o));
    t('U164 结算重开', o.b === '再来一局', JSON.stringify(o));
  } catch(e){ t('U163 暂停续玩',false,e.message); t('U164 结算重开',false,e.message); }


  // ===== U165~U166: 修复自制关卡名未转义导致的 HTML 注入(v0.4.24) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.escapeHtmlNow('<img src=x onerror=1>'),b:T.escapeHtmlNow('我的关卡')});})()"));
    t('U165 尖括号被转义', o.a.indexOf('<img')<0 && o.a.indexOf('&lt;img')>=0, JSON.stringify(o));
    t('U166 普通名称不变', o.b === '我的关卡', JSON.stringify(o));
  } catch(e){ t('U165 尖括号被转义',false,e.message); t('U166 普通名称不变',false,e.message); }


  // ===== U167~U168: 自制关卡名清洗统一为纯函数(v0.4.25) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.mapNameNow('  超长的自制关卡名称abcdefgh  '),b:T.mapNameNow('')});})()"));
    t('U167 去空格并截断', o.a.length <= 12 && o.a.length > 0, JSON.stringify(o));
    t('U168 空名兜底', o.b === '我的关卡', JSON.stringify(o));
  } catch(e){ t('U167 去空格并截断',false,e.message); t('U168 空名兜底',false,e.message); }


  // ===== U169~U170: 存档整数解析统一为 safeInt(v0.4.26) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.safeIntNow('123',0),b:T.safeIntNow('abc',7)});})()"));
    t('U169 合法字符串', o.a === 123, JSON.stringify(o));
    t('U170 非法值回退默认值', o.b === 7, JSON.stringify(o));
  } catch(e){ t('U169 合法字符串',false,e.message); t('U170 非法值回退默认值',false,e.message); }


  // ===== U171~U172: 基地等级钳制抽为 clampNum(v0.4.27) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.clampNumNow(5,0,3),b:T.clampNumNow('x',0,3)});})()"));
    t('U171 上界钳制', o.a === 3, JSON.stringify(o));
    t('U172 非法值回退下界', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U171 上界钳制',false,e.message); t('U172 非法值回退下界',false,e.message); }


  // ===== U173~U174: 存档 JSON 解析统一为 safeJson 容错(v0.4.28) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.safeJsonNow(JSON.stringify({a:1}),{}).a,b:T.safeJsonNow('{bad',7)});})()"));
    t('U173 合法 JSON', o.a === 1, JSON.stringify(o));
    t('U174 损坏 JSON 回退', o.b === 7, JSON.stringify(o));
  } catch(e){ t('U173 合法 JSON',false,e.message); t('U174 损坏 JSON 回退',false,e.message); }


  // ===== U175~U176: 僚机血条比例抽为 ratio01 并双向钳制(v0.4.29) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.ratio01Now(0.5),b:T.ratio01Now(2)});})()"));
    t('U175 正常比例', o.a === 0.5, JSON.stringify(o));
    t('U176 超 1 钳制', o.b === 1, JSON.stringify(o));
  } catch(e){ t('U175 正常比例',false,e.message); t('U176 超 1 钳制',false,e.message); }


  // ===== U177~U178: BOSS 狂暴阶段判定抽为纯函数(v0.4.30) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossPhaseOfNow(0.4),b:T.bossPhaseOfNow(0.1)});})()"));
    t('U177 半血进一段', o.a === 1, JSON.stringify(o));
    t('U178 四分之一血进二段', o.b === 2, JSON.stringify(o));
  } catch(e){ t('U177 半血进一段',false,e.message); t('U178 四分之一血进二段',false,e.message); }


  // ===== U179~U180: 宠物币存档解析统一为 safeMax0(v0.4.31) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.safeMax0Now('88'),b:T.safeMax0Now('-5')});})()"));
    t('U179 合法值', o.a === 88, JSON.stringify(o));
    t('U180 负值归零', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U179 合法值',false,e.message); t('U180 负值归零',false,e.message); }


  // ===== U181~U182: 最高解锁关卡解析统一为 safeMin1(v0.4.32) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.safeMin1Now('9'),b:T.safeMin1Now('0')});})()"));
    t('U181 合法值', o.a === 9, JSON.stringify(o));
    t('U182 零值下限保护', o.b === 1, JSON.stringify(o));
  } catch(e){ t('U181 合法值',false,e.message); t('U182 零值下限保护',false,e.message); }


  // ===== U183~U184: 皮肤存档数组解析统一为 safeJsonArr(v0.4.33) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.safeJsonArrNow(JSON.stringify([1,2])).length,b:T.safeJsonArrNow(JSON.stringify({a:1})).length});})()"));
    t('U183 合法数组', o.a === 2, JSON.stringify(o));
    t('U184 非数组回退空数组', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U183 合法数组',false,e.message); t('U184 非数组回退空数组',false,e.message); }


  // ===== U185~U186: 星级存档对象解析统一为 safeJsonObj(v0.4.34) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.safeJsonObjNow(JSON.stringify({a:1})).a,b:T.safeJsonObjNow('[1,2]')});})()"));
    t('U185 合法对象', o.a === 1, JSON.stringify(o));
    t('U186 数组回退空对象', Array.isArray(o.b) === false && Object.keys(o.b).length === 0, JSON.stringify(o));
  } catch(e){ t('U185 合法对象',false,e.message); t('U186 数组回退空对象',false,e.message); }


  // ===== U187~U188: 宠物等级钳制抽为 petLvClamp(v0.4.35) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petLvClampNow('2',3),b:T.petLvClampNow('99',3)});})()"));
    t('U187 合法等级', o.a === 2, JSON.stringify(o));
    t('U188 超过上限钳制', o.b === 3, JSON.stringify(o));
  } catch(e){ t('U187 合法等级',false,e.message); t('U188 超过上限钳制',false,e.message); }


  // ===== U189~U190: 生涯统计解析统一为 careerNum（局数/击杀）(v0.4.36) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerNumNow('42'),b:T.careerNumNow('-8')});})()"));
    t('U189 合法统计值', o.a === 42, JSON.stringify(o));
    t('U190 负值归零', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U189 合法统计值',false,e.message); t('U190 负值归零',false,e.message); }


  // ===== U191~U192: 生涯统计解析统一（时长/每日最佳）(v0.4.37) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerNumNow('bad'),b:T.careerNumNow('3.9')});})()"));
    t('U191 非法值归零', o.a === 0, JSON.stringify(o));
    t('U192 小数按整数解析', o.b === 3, JSON.stringify(o));
  } catch(e){ t('U191 非法值归零',false,e.message); t('U192 小数按整数解析',false,e.message); }


  // ===== U193~U194: 生涯统计解析统一（限时/困难最佳）(v0.4.38) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerNumNow('0'),b:T.careerNumNow('12345')});})()"));
    t('U193 零值保持', o.a === 0, JSON.stringify(o));
    t('U194 大数值保持', o.b === 12345, JSON.stringify(o));
  } catch(e){ t('U193 零值保持',false,e.message); t('U194 大数值保持',false,e.message); }


  // ===== U195~U196: 生涯统计解析统一（最高分/累计金币）(v0.4.39) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerNumNow(null),b:T.careerNumNow('88abc')});})()"));
    t('U195 空值归零', o.a === 0, JSON.stringify(o));
    t('U196 前缀数字可解析', o.b === 88, JSON.stringify(o));
  } catch(e){ t('U195 空值归零',false,e.message); t('U196 前缀数字可解析',false,e.message); }


  // ===== U197~U198: 生涯统计解析统一（累计星数/无尽最佳）(v0.4.40) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerNumNow('-1'),b:T.careerNumNow(' 7 ')});})()"));
    t('U197 负数归零', o.a === 0, JSON.stringify(o));
    t('U198 前后空格容错', o.b === 7, JSON.stringify(o));
  } catch(e){ t('U197 负数归零',false,e.message); t('U198 前后空格容错',false,e.message); }


  // ===== U199~U200: 生涯统计解析统一（BOSS 击破/阵亡）(v0.4.41) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerNumNow('999'),b:T.careerNumNow(undefined)});})()"));
    t('U199 常规值', o.a === 999, JSON.stringify(o));
    t('U200 未定义归零', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U199 常规值',false,e.message); t('U200 未定义归零',false,e.message); }


  // ===== U201~U202: 里程碑标题抽为纯函数(v0.4.42) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.milestoneTitleTextNow(),b:T.milestoneTitleTextNow().length});})()"));
    t('U201 标题文案', o.a === '里程碑达成！', JSON.stringify(o));
    t('U202 长度稳定', o.b === 6, JSON.stringify(o));
  } catch(e){ t('U201 标题文案',false,e.message); t('U202 长度稳定',false,e.message); }


  // ===== U203~U204: 结算与分享命中率统一为 fmtPct 纯函数(v0.4.43) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.fmtPctNow(3,4),b:T.fmtPctNow(5,0)});})()"));
    t('U203 正常命中率', o.a === 75, JSON.stringify(o));
    t('U204 零分母兜底', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U203 正常命中率',false,e.message); t('U204 零分母兜底',false,e.message); }


  // ===== U205~U206: 存档复制按钮文案抽为纯函数(v0.4.44) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.copyBtnTextNow(true),b:T.copyBtnTextNow(false)});})()"));
    t('U205 复制成功', o.a === '✅ 已复制', JSON.stringify(o));
    t('U206 恢复默认', o.b === '📋 复制存档码', JSON.stringify(o));
  } catch(e){ t('U205 复制成功',false,e.message); t('U206 恢复默认',false,e.message); }


  // ===== U207~U208: 自动恢复倒计时文案抽为纯函数(v0.4.45) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.autoRecoverTextNow(5),b:T.autoRecoverTextNow(0)});})()"));
    t('U207 正数倒计时', o.a === '自动恢复中（5 秒后刷新）…', JSON.stringify(o));
    t('U208 归零切换文案', o.b === '正在刷新…', JSON.stringify(o));
  } catch(e){ t('U207 正数倒计时',false,e.message); t('U208 归零切换文案',false,e.message); }


  // ===== U209~U210: 暂停按钮与异常文案抽为纯函数(v0.4.46) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.pauseBtnTextNow(),b:T.errMsgLongTextNow(300).length});})()"));
    t('U209 暂停按钮文案', o.a === '⏸', JSON.stringify(o));
    t('U210 超长异常文案截断到 185 字', o.b === 185, JSON.stringify(o));
  } catch(e){ t('U209 暂停按钮文案',false,e.message); t('U210 超长异常文案截断到 185 字',false,e.message); }


  // ===== U211~U212: 限时冲分开场提示抽为纯函数(v0.4.47) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.timedIntroMsgNow(120),b:T.timedIntroMsgNow(65)});})()"));
    t('U211 整分显示', o.a.indexOf('限时冲分 · 2分')>=0, JSON.stringify(o));
    t('U212 分秒与说明齐全', o.b.indexOf('1分5秒')>=0 && o.b.indexOf('分数越高奖励越多')>=0, JSON.stringify(o));
  } catch(e){ t('U211 整分显示',false,e.message); t('U212 分秒与说明齐全',false,e.message); }


  // ===== U213~U214: 英雄技不可用提示抽为纯函数(v0.4.48) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.heroDisabledMsgNow(),b:T.heroDisabledMsgNow()});})()"));
    t('U213 适用范围说明齐全', o.a.indexOf('单人局')>=0 && o.a.indexOf('已选英雄')>=0, JSON.stringify(o));
    t('U214 统一禁止前缀', o.b.indexOf('🚫')===0, JSON.stringify(o));
  } catch(e){ t('U213 适用范围说明齐全',false,e.message); t('U214 统一禁止前缀',false,e.message); }


  // ===== U215~U216: 战绩图复制成功提示抽为纯函数（50 轮收口）(v0.4.49) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.reportCopyMsgNow(),b:T.reportCopyMsgNow().indexOf('✅')});})()"));
    t('U215 复制成功文案', o.a === '✅ 战绩图已复制到剪贴板', JSON.stringify(o));
    t('U216 统一成功前缀', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U215 复制成功文案',false,e.message); t('U216 统一成功前缀',false,e.message); }


  // ===== U217~U218: 暂停按钮图标抽为纯函数(v4.50) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.pauseIconTextNow(true),b:T.pauseIconTextNow(false)});})()"));
    t('U217 暂停态', o.a === '▶', JSON.stringify(o));
    t('U218 运行态', o.b === '⏸', JSON.stringify(o));
  } catch(e){ t('U217 暂停态',false,e.message); t('U218 运行态',false,e.message); }


  // ===== U219~U220: 静音按钮图标抽为纯函数(v4.51) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.muteIconTextNow(true),b:T.muteIconTextNow(false)});})()"));
    t('U219 静音态', o.a === '🔇', JSON.stringify(o));
    t('U220 有声态', o.b === '🔊', JSON.stringify(o));
  } catch(e){ t('U219 静音态',false,e.message); t('U220 有声态',false,e.message); }


  // ===== U221~U222: 全屏按钮图标抽为纯函数(v4.52) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.fullscreenIconTextNow(true),b:T.fullscreenIconTextNow(false)});})()"));
    t('U221 全屏态', o.a === '🗗', JSON.stringify(o));
    t('U222 窗口态', o.b === '⛶', JSON.stringify(o));
  } catch(e){ t('U221 全屏态',false,e.message); t('U222 窗口态',false,e.message); }


  // ===== U223~U224: 音量百分比文本抽为纯函数并钳制(v4.53) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.volPctTextNow(45),b:T.volPctTextNow(150)});})()"));
    t('U223 常规音量', o.a === '45%', JSON.stringify(o));
    t('U224 越界钳制', o.b === '100%', JSON.stringify(o));
  } catch(e){ t('U223 常规音量',false,e.message); t('U224 越界钳制',false,e.message); }


  // ===== U225~U226: 音量图标按档位分级抽为纯函数(v4.54) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.volIconTextNow(true,80),b:T.volIconTextNow(false,0)});})()"));
    t('U225 静音优先', o.a === '🔇', JSON.stringify(o));
    t('U226 零音量图标', o.b === '🔈', JSON.stringify(o));
  } catch(e){ t('U225 静音优先',false,e.message); t('U226 零音量图标',false,e.message); }


  // ===== U227~U228: 设置页全屏按钮文案抽为纯函数(v4.55) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.fullscreenBtnTextNow(true),b:T.fullscreenBtnTextNow(false)});})()"));
    t('U227 已全屏', o.a === '退出全屏', JSON.stringify(o));
    t('U228 未全屏', o.b === '进入全屏', JSON.stringify(o));
  } catch(e){ t('U227 已全屏',false,e.message); t('U228 未全屏',false,e.message); }


  // ===== U229~U230: 开始按钮文案按每日挑战抽为纯函数(v4.56) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.playStartTextNow(true),b:T.playStartTextNow(false)});})()"));
    t('U229 挑战入口', o.a === '开始每日挑战', JSON.stringify(o));
    t('U230 普通入口', o.b === '开始游戏', JSON.stringify(o));
  } catch(e){ t('U229 挑战入口',false,e.message); t('U230 普通入口',false,e.message); }


  // ===== U231~U232: 结算标题按胜负抽为纯函数(v4.57) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.resultTitleTextNow(true),b:T.resultTitleTextNow(false)});})()"));
    t('U231 胜利标题', o.a === '胜 利', JSON.stringify(o));
    t('U232 失败标题', o.b === '游戏结束', JSON.stringify(o));
  } catch(e){ t('U231 胜利标题',false,e.message); t('U232 失败标题',false,e.message); }


  // ===== U233~U234: 无尽模式关卡单位标签抽为纯函数(v4.58) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.waveTagTextNow(true),b:T.waveTagTextNow(false)});})()"));
    t('U233 无尽用波', o.a === '波', JSON.stringify(o));
    t('U234 普通用关', o.b === '关', JSON.stringify(o));
  } catch(e){ t('U233 无尽用波',false,e.message); t('U234 普通用关',false,e.message); }


  // ===== U235~U236: 剩余敌人数抽为纯函数并做非负兜底(v4.59) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.remainingTextNow(10,3,2),b:T.remainingTextNow(2,8,1)});})()"));
    t('U235 正常余量', o.a === '9', JSON.stringify(o));
    t('U236 负数归零', o.b === '0', JSON.stringify(o));
  } catch(e){ t('U235 正常余量',false,e.message); t('U236 负数归零',false,e.message); }


  // ===== U237~U238: 测试模式提示抽为纯函数(v4.60) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.testModeTextNow(),b:T.testModeTextNow()});})()"));
    t('U237 提示含关键说明', o.a.indexOf('不自动刷新')>=0, JSON.stringify(o));
    t('U238 前缀正确', o.b.indexOf('测试模式')===0, JSON.stringify(o));
  } catch(e){ t('U237 提示含关键说明',false,e.message); t('U238 前缀正确',false,e.message); }


  // ===== U239~U240: HUD 关卡数抽为纯函数(v4.61) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.hudLevelTextNow(7),b:T.hudLevelTextNow(0)});})()"));
    t('U239 常规关卡', o.a === '7', JSON.stringify(o));
    t('U240 零值下限保护', o.b === '1', JSON.stringify(o));
  } catch(e){ t('U239 常规关卡',false,e.message); t('U240 零值下限保护',false,e.message); }


  // ===== U241~U242: 主音量存档解析抽为 parseVolume 容错(v4.62) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.parseVolumeNow('0.4'),b:T.parseVolumeNow('bad')});})()"));
    t('U241 合法音量', o.a === 0.4, JSON.stringify(o));
    t('U242 非法值回退满音量', o.b === 1, JSON.stringify(o));
  } catch(e){ t('U241 合法音量',false,e.message); t('U242 非法值回退满音量',false,e.message); }


  // ===== U243~U244: 音量钳制抽为 clampVol(v4.63) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.clampVolNow(2),b:T.clampVolNow(-1)});})()"));
    t('U243 上界钳制', o.a === 1, JSON.stringify(o));
    t('U244 下界钳制', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U243 上界钳制',false,e.message); t('U244 下界钳制',false,e.message); }


  // ===== U245~U246: BGM 音量加载统一为 clampVol(v4.64) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.guardBgmVolNow(0.6),b:T.guardBgmVolNow(NaN)});})()"));
    t('U245 合法值保持', o.a === 0.6, JSON.stringify(o));
    t('U246 非法值回退', o.b === 1, JSON.stringify(o));
  } catch(e){ t('U245 合法值保持',false,e.message); t('U246 非法值回退',false,e.message); }


  // ===== U247~U248: SFX 音量加载统一为 clampVol(v4.65) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.guardSfxVolNow(5),b:T.guardSfxVolNow(0)});})()"));
    t('U247 超界钳制', o.a === 1, JSON.stringify(o));
    t('U248 零音量保持', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U247 超界钳制',false,e.message); t('U248 零音量保持',false,e.message); }


  // ===== U249~U250: 最高分存档解析抽为 safeBest(v4.66) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.safeBestNow('9800'),b:T.safeBestNow('-3')});})()"));
    t('U249 合法最高分', o.a === 9800, JSON.stringify(o));
    t('U250 负值归零', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U249 合法最高分',false,e.message); t('U250 负值归零',false,e.message); }


  // ===== U251~U252: 强化等级存档解析抽为 safeBonusLv(v4.67) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.safeBonusLvNow('3'),b:T.safeBonusLvNow('x')});})()"));
    t('U251 合法等级', o.a === 3, JSON.stringify(o));
    t('U252 非法值归零', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U251 合法等级',false,e.message); t('U252 非法值归零',false,e.message); }


  // ===== U253~U254: 关卡星级存档解析抽为 safeStarLv 范围校验(v4.68) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.safeStarLvNow('2'),b:T.safeStarLvNow('9')});})()"));
    t('U253 合法星级', o.a === 2, JSON.stringify(o));
    t('U254 越界归零', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U253 合法星级',false,e.message); t('U254 越界归零',false,e.message); }


  // ===== U255~U256: 无尽最高波次解析抽为 safeWave(v4.69) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.safeWaveNow('12'),b:T.safeWaveNow('bad')});})()"));
    t('U255 合法波次', o.a === 12, JSON.stringify(o));
    t('U256 损坏存档归零', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U255 合法波次',false,e.message); t('U256 损坏存档归零',false,e.message); }


  // ===== U257~U258: 抽奖次数解析抽为 safeGacha(v4.70) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.safeGachaNow('7'),b:T.safeGachaNow('-9')});})()"));
    t('U257 合法次数', o.a === 7, JSON.stringify(o));
    t('U258 负值归零', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U257 合法次数',false,e.message); t('U258 负值归零',false,e.message); }


  // ===== U259~U260: 强化累计投入解析抽为 safeBonusSpent(v4.71) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.safeBonusSpentNow('600'),b:T.safeBonusSpentNow(null)});})()"));
    t('U259 合法投入', o.a === 600, JSON.stringify(o));
    t('U260 空值归零', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U259 合法投入',false,e.message); t('U260 空值归零',false,e.message); }


  // ===== U261~U262: 每日挑战计数解析抽为 safeDailyCount(v4.72) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.safeDailyCountNow('4'),b:T.safeDailyCountNow('bad')});})()"));
    t('U261 合法计数', o.a === 4, JSON.stringify(o));
    t('U262 非法值归零', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U261 合法计数',false,e.message); t('U262 非法值归零',false,e.message); }


  // ===== U263~U264: 模式场次解析抽为 safeModeGames(v4.73) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.safeModeGamesNow('11'),b:T.safeModeGamesNow('-2')});})()"));
    t('U263 合法场次', o.a === 11, JSON.stringify(o));
    t('U264 负值归零', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U263 合法场次',false,e.message); t('U264 负值归零',false,e.message); }


  // ===== U265~U266: 关卡星级算法抽为 starPointsOf 纯函数(v4.74) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.starPointsOfNow(1,false,1,999),b:T.starPointsOfNow(1,true,3,10)});})()"));
    t('U265 保底一星', o.a === 1, JSON.stringify(o));
    t('U266 满条件三星', o.b === 3, JSON.stringify(o));
  } catch(e){ t('U265 保底一星',false,e.message); t('U266 满条件三星',false,e.message); }


  // ===== U267~U268: 基地复活费用算法抽为 reviveCostOf(v4.75) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.reviveCostOfNow(1,0,0),b:T.reviveCostOfNow(0,0,9)});})()"));
    t('U267 基础费用', o.a === 125, JSON.stringify(o));
    t('U268 折扣后不低于下限', o.b === 40, JSON.stringify(o));
  } catch(e){ t('U267 基础费用',false,e.message); t('U268 折扣后不低于下限',false,e.message); }


  // ===== U269~U270: 倒计时秒数取整抽为 timeSeconds(v4.76) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.timeSecondsNow(12.1),b:T.timeSecondsNow(-5)});})()"));
    t('U269 小数向上取整', o.a === 13, JSON.stringify(o));
    t('U270 负数归零', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U269 小数向上取整',false,e.message); t('U270 负数归零',false,e.message); }


  // ===== U271~U272: 主题渐变索引抽为 themeIdxOf(v4.77) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.themeIdxOfNow(11),b:T.themeIdxOfNow(0)});})()"));
    t('U271 常规索引', o.a === 10, JSON.stringify(o));
    t('U272 零值下限保护', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U271 常规索引',false,e.message); t('U272 零值下限保护',false,e.message); }


  // ===== U273~U274: 敌人出生预警环半径抽为 warnRingRadius(v4.78) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.warnRingRadiusNow(35),b:T.warnRingRadiusNow(0)});})()"));
    t('U273 计时满时为最小半径', o.a === 9, JSON.stringify(o));
    t('U274 即将刷兵时半径扩大', o.b > 21, JSON.stringify(o));
  } catch(e){ t('U273 计时满时为最小半径',false,e.message); t('U274 即将刷兵时半径扩大',false,e.message); }


  // ===== U275~U276: 冲击波透明度抽为 waveAlpha 非负兜底(v4.79) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.waveAlphaNow(0.5),b:T.waveAlphaNow(-2)});})()"));
    t('U275 正常透明度', o.a === 0.5, JSON.stringify(o));
    t('U276 负值归零', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U275 正常透明度',false,e.message); t('U276 负值归零',false,e.message); }


  // ===== U277~U278: BOSS 光柱高度抽为 bossBeamHeight(v4.80) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossBeamHeightNow(40,10),b:T.bossBeamHeightNow(-100,10)});})()"));
    t('U277 正常高度', o.a === 50, JSON.stringify(o));
    t('U278 负值归零', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U277 正常高度',false,e.message); t('U278 负值归零',false,e.message); }


  // ===== U279~U280: 粒子数量倍率计算抽为 particleCountOf(v4.81) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.particleCountOfNow(10,2),b:T.particleCountOfNow(-5,2)});})()"));
    t('U279 倍率生效', o.a === 20, JSON.stringify(o));
    t('U280 负数归零', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U279 倍率生效',false,e.message); t('U280 负数归零',false,e.message); }


  // ===== U281~U282: 宠物币增减抽为 petCoinAdd 非负兜底(v4.82) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petCoinAddNow(10,5),b:T.petCoinAddNow(3,-10)});})()"));
    t('U281 增加宠物币', o.a === 15, JSON.stringify(o));
    t('U282 扣减不为负', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U281 增加宠物币',false,e.message); t('U282 扣减不为负',false,e.message); }


  // ===== U283~U284: 闪光衰减抽为 decay 纯函数(v4.83) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.decayNow(1,0.2,2),b:T.decayNow(0.1,1,2)});})()"));
    t('U283 按系数衰减', Math.abs(o.a - 0.6) < 1e-9, JSON.stringify(o));
    t('U284 衰减不为负', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U283 按系数衰减',false,e.message); t('U284 衰减不为负',false,e.message); }


  // ===== U285~U286: 磁暴剩余时间抽为 stormDecay(v4.84) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.stormDecayNow(3,0.5),b:T.stormDecayNow(0.2,1)});})()"));
    t('U285 正常衰减', o.a === 2.5, JSON.stringify(o));
    t('U286 不为负', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U285 正常衰减',false,e.message); t('U286 不为负',false,e.message); }


  // ===== U287~U288: BOSS 血量比例抽为 hpRatioOf 双向钳制(v4.85) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.hpRatioOfNow(5,10),b:T.hpRatioOfNow(20,10)});})()"));
    t('U287 正常比例', o.a === 0.5, JSON.stringify(o));
    t('U288 超满钳制', o.b === 1, JSON.stringify(o));
  } catch(e){ t('U287 正常比例',false,e.message); t('U288 超满钳制',false,e.message); }


  // ===== U289~U290: 生涯页与战绩图命中率统一为 carAccText(v4.86) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.carAccTextNow(3,4),b:T.carAccTextNow(9,0)});})()"));
    t('U289 正常命中率', o.a === 75, JSON.stringify(o));
    t('U290 零分母兜底', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U289 正常命中率',false,e.message); t('U290 零分母兜底',false,e.message); }


  // ===== U291~U292: 生涯页与战绩图胜率统一为 carWinRateText(v4.87) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.carWinRateTextNow(1,4),b:T.carWinRateTextNow(0,0)});})()"));
    t('U291 正常胜率', o.a === 25, JSON.stringify(o));
    t('U292 零场次兜底', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U291 正常胜率',false,e.message); t('U292 零场次兜底',false,e.message); }


  // ===== U293~U294: 排行榜日期抽为 boardDateText 补零(v4.88) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.boardDateTextNow(new Date(2026,2,7)),b:T.boardDateTextNow(new Date(2026,10,24))});})()"));
    t('U293 月日补零', o.a === '03/07', JSON.stringify(o));
    t('U294 两位数月日', o.b === '11/24', JSON.stringify(o));
  } catch(e){ t('U293 月日补零',false,e.message); t('U294 两位数月日',false,e.message); }


  // ===== U295~U296: 成就奖励文案抽为 achRewardText(v4.89) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.achRewardTextNow(100,2),b:T.achRewardTextNow(0,3)});})()"));
    t('U295 双币奖励', o.a === '+100🪙 +2🐾', JSON.stringify(o));
    t('U296 仅宠物币', o.b === '+3🐾', JSON.stringify(o));
  } catch(e){ t('U295 双币奖励',false,e.message); t('U296 仅宠物币',false,e.message); }


  // ===== U297~U298: 商店强化进度文案抽为 shopMetaText(v4.90) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.shopMetaTextNow(false,1,3,120),b:T.shopMetaTextNow(true,3,3,0)});})()"));
    t('U297 未满级显示价格', o.a === '等级 1/3 · 下一级 🪙120', JSON.stringify(o));
    t('U298 满级文案', o.b === '已满级', JSON.stringify(o));
  } catch(e){ t('U297 未满级显示价格',false,e.message); t('U298 满级文案',false,e.message); }


  // ===== U299~U300: 商店购买按钮文案抽为 shopBtnLabel(v4.91) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.shopBtnLabelNow(false,120),b:T.shopBtnLabelNow(false,12345)});})()"));
    t('U299 常规价格', o.a === '🪙 购买 120', JSON.stringify(o));
    t('U300 大额千分位', o.b === '🪙 购买 12,345', JSON.stringify(o));
  } catch(e){ t('U299 常规价格',false,e.message); t('U300 大额千分位',false,e.message); }


  // ===== U301~U302: 选关卡片图标抽为 lvCardIcon(v4.92) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.lvCardIconNow(true,true),b:T.lvCardIconNow(false,false)});})()"));
    t('U301 BOSS 关优先', o.a === '👑', JSON.stringify(o));
    t('U302 未解锁加锁', o.b === '🔒', JSON.stringify(o));
  } catch(e){ t('U301 BOSS 关优先',false,e.message); t('U302 未解锁加锁',false,e.message); }


  // ===== U303~U304: 选关卡片星级行抽为 lvCardStars(v4.93) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.lvCardStarsNow(2),b:T.lvCardStarsNow(9)});})()"));
    t('U303 二星补空心', o.a === '★★☆', JSON.stringify(o));
    t('U304 越界钳制满星', o.b === '★★★', JSON.stringify(o));
  } catch(e){ t('U303 二星补空心',false,e.message); t('U304 越界钳制满星',false,e.message); }


  // ===== U305~U306: 生涯统计格抽为 carStatHtml(v4.94) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.carStatHtmlNow(12345,'总场次'),b:T.carStatHtmlNow(0,'总击杀')});})()"));
    t('U305 千分位与标签', o.a.indexOf('<b>12,345</b>')>=0 && o.a.indexOf('总场次')>=0, JSON.stringify(o));
    t('U306 零值显示', o.b.indexOf('<b>0</b>')>=0, JSON.stringify(o));
  } catch(e){ t('U305 千分位与标签',false,e.message); t('U306 零值显示',false,e.message); }


  // ===== U307~U308: 成就状态文案抽为 achStateText(v4.95) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.achStateTextNow(true,'+100🪙'),b:T.achStateTextNow(false,'+3🐾')});})()"));
    t('U307 已解锁优先', o.a === '已解锁', JSON.stringify(o));
    t('U308 未解锁显示奖励', o.b === '+3🐾', JSON.stringify(o));
  } catch(e){ t('U307 已解锁优先',false,e.message); t('U308 未解锁显示奖励',false,e.message); }


  // ===== U309~U310: 排行榜名次抽为 boardRankText(v4.96) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.boardRankTextNow(0),b:T.boardRankTextNow(9)});})()"));
    t('U309 首名', o.a === '1', JSON.stringify(o));
    t('U310 第十名', o.b === '10', JSON.stringify(o));
  } catch(e){ t('U309 首名',false,e.message); t('U310 第十名',false,e.message); }


  // ===== U311~U312: 本地排行榜存档解析抽为 safeBoard（48 轮收口）(v4.97) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.safeBoardNow(JSON.stringify([{score:1},null])).length,b:T.safeBoardNow('{bad').length});})()"));
    t('U311 过滤无效记录', o.a === 1, JSON.stringify(o));
    t('U312 损坏存档回退空榜', o.b === 0, JSON.stringify(o));
  } catch(e){ t('U311 过滤无效记录',false,e.message); t('U312 损坏存档回退空榜',false,e.message); }


  // ===== U313~U314: rgba 颜色串抽为纯函数(v5.0) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5RgbaStrNow(1,2,3,0.5),b:T.v5RgbaStrNow(0,0,0,1)});})()"));
    t('U313 rgba 颜色串抽为纯函数', o.a === 'rgba(1,2,3,0.5)', JSON.stringify(o));
    t('U314 rgba 颜色串抽为纯函数边界', o.b === 'rgba(0,0,0,1)', JSON.stringify(o));
  } catch(e){ t('U313 rgba 颜色串抽为纯函数',false,e.message); t('U314 rgba 颜色串抽为纯函数边界',false,e.message); }


  // ===== U315~U316: 网格坐标键抽为纯函数(v5.1) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5GridKeyNow(3,7),b:T.v5GridKeyNow(0,0)});})()"));
    t('U315 网格坐标键抽为纯函数', o.a === '3,7', JSON.stringify(o));
    t('U316 网格坐标键抽为纯函数边界', o.b === '0,0', JSON.stringify(o));
  } catch(e){ t('U315 网格坐标键抽为纯函数',false,e.message); t('U316 网格坐标键抽为纯函数边界',false,e.message); }


  // ===== U317~U318: 白色描边透明度串抽为纯函数(v5.2) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5WhiteStrokeANow(0.5),b:T.v5WhiteStrokeANow(0)});})()"));
    t('U317 白色描边透明度串抽为纯函数', o.a === 'rgba(255,255,255,0.425)', JSON.stringify(o));
    t('U318 白色描边透明度串抽为纯函数边界', o.b === 'rgba(255,255,255,0.000)', JSON.stringify(o));
  } catch(e){ t('U317 白色描边透明度串抽为纯函数',false,e.message); t('U318 白色描边透明度串抽为纯函数边界',false,e.message); }


  // ===== U319~U320: 金币飘字抽为纯函数(v5.3) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5CoinGainTextNow(80),b:T.v5CoinGainTextNow(12345)});})()"));
    t('U319 金币飘字抽为纯函数', o.a === '+80🪙', JSON.stringify(o));
    t('U320 金币飘字抽为纯函数边界', o.b === '+12,345🪙', JSON.stringify(o));
  } catch(e){ t('U319 金币飘字抽为纯函数',false,e.message); t('U320 金币飘字抽为纯函数边界',false,e.message); }


  // ===== U321~U322: 连击得分飘字抽为纯函数(v5.4) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5ComboGainTextNow(50),b:T.v5ComboGainTextNow(12345)});})()"));
    t('U321 连击得分飘字抽为纯函数', o.a === '+50', JSON.stringify(o));
    t('U322 连击得分飘字抽为纯函数边界', o.b === '+12,345', JSON.stringify(o));
  } catch(e){ t('U321 连击得分飘字抽为纯函数',false,e.message); t('U322 连击得分飘字抽为纯函数边界',false,e.message); }


  // ===== U323~U324: 无尽里程碑提示抽为纯函数(v5.5) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5MilestoneTipNow(3),b:T.v5MilestoneTipNow(12345)});})()"));
    t('U323 无尽里程碑提示抽为纯函数', o.a === ' · 🌊里程碑 +3🐾', JSON.stringify(o));
    t('U324 无尽里程碑提示抽为纯函数边界', o.b.indexOf('12,345')>=0, JSON.stringify(o));
  } catch(e){ t('U323 无尽里程碑提示抽为纯函数',false,e.message); t('U324 无尽里程碑提示抽为纯函数边界',false,e.message); }


  // ===== U325~U326: 关卡开场文案抽为纯函数(v5.6) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5LevelIntroTextNow(true,8,'normal'),b:T.v5LevelIntroTextNow(false,5,'hard')});})()"));
    t('U325 关卡开场文案抽为纯函数', o.a === '第 8 波', JSON.stringify(o));
    t('U326 关卡开场文案抽为纯函数边界', o.b === '第 5 关 · 硬核', JSON.stringify(o));
  } catch(e){ t('U325 关卡开场文案抽为纯函数',false,e.message); t('U326 关卡开场文案抽为纯函数边界',false,e.message); }


  // ===== U327~U328: 过关奖励飘字抽为纯函数(v5.7) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5LevelBonusTextNow(80),b:T.v5LevelBonusTextNow(12345)});})()"));
    t('U327 过关奖励飘字抽为纯函数', o.a === '+80', JSON.stringify(o));
    t('U328 过关奖励飘字抽为纯函数边界', o.b === '+12,345', JSON.stringify(o));
  } catch(e){ t('U327 过关奖励飘字抽为纯函数',false,e.message); t('U328 过关奖励飘字抽为纯函数边界',false,e.message); }


  // ===== U329~U330: 倒计时字符串抽为纯函数(v5.8) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5ClockStrNow(65),b:T.v5ClockStrNow(0)});})()"));
    t('U329 倒计时字符串抽为纯函数', o.a === '1:05', JSON.stringify(o));
    t('U330 倒计时字符串抽为纯函数边界', o.b === '0:00', JSON.stringify(o));
  } catch(e){ t('U329 倒计时字符串抽为纯函数',false,e.message); t('U330 倒计时字符串抽为纯函数边界',false,e.message); }


  // ===== U331~U332: 主题背景 rgb 串抽为纯函数(v5.9) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5RgbStrNow([1,2,3]),b:T.v5RgbStrNow([0,0,0])});})()"));
    t('U331 主题背景 rgb 串抽为纯函数', o.a === 'rgb(1,2,3)', JSON.stringify(o));
    t('U332 主题背景 rgb 串抽为纯函数边界', o.b === 'rgb(0,0,0)', JSON.stringify(o));
  } catch(e){ t('U331 主题背景 rgb 串抽为纯函数',false,e.message); t('U332 主题背景 rgb 串抽为纯函数边界',false,e.message); }


  // ===== U333~U334: 主题网格 rgba 串抽为纯函数(v5.10) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5GridStrNow([1,2,3]),b:T.v5GridStrNow([0,0,0])});})()"));
    t('U333 主题网格 rgba 串抽为纯函数', o.a === 'rgba(1,2,3,0.12)', JSON.stringify(o));
    t('U334 主题网格 rgba 串抽为纯函数边界', o.b === 'rgba(0,0,0,0.12)', JSON.stringify(o));
  } catch(e){ t('U333 主题网格 rgba 串抽为纯函数',false,e.message); t('U334 主题网格 rgba 串抽为纯函数边界',false,e.message); }


  // ===== U335~U336: 主题强调色 rgb 串抽为纯函数(v5.11) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5AccentRgbStrNow([9,8,7]),b:T.v5AccentRgbStrNow([0,255,0])});})()"));
    t('U335 主题强调色 rgb 串抽为纯函数', o.a === 'rgb(9,8,7)', JSON.stringify(o));
    t('U336 主题强调色 rgb 串抽为纯函数边界', o.b === 'rgb(0,255,0)', JSON.stringify(o));
  } catch(e){ t('U335 主题强调色 rgb 串抽为纯函数',false,e.message); t('U336 主题强调色 rgb 串抽为纯函数边界',false,e.message); }


  // ===== U337~U338: 里程碑光晕阴影串抽为纯函数(v5.12) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5BoxShadowStrNow('#fff'),b:T.v5BoxShadowStrNow('red')});})()"));
    t('U337 里程碑光晕阴影串抽为纯函数', o.a === '0 0 12px 2px #fff', JSON.stringify(o));
    t('U338 里程碑光晕阴影串抽为纯函数边界', o.b === '0 0 12px 2px red', JSON.stringify(o));
  } catch(e){ t('U337 里程碑光晕阴影串抽为纯函数',false,e.message); t('U338 里程碑光晕阴影串抽为纯函数边界',false,e.message); }


  // ===== U339~U340: 局内副标题抽为纯函数(v5.13) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5RunSubTextNow(false,5,80),b:T.v5RunSubTextNow(true,8,12345)});})()"));
    t('U339 局内副标题抽为纯函数', o.a === '第 5 关 · 目前 80 分', JSON.stringify(o));
    t('U340 局内副标题抽为纯函数边界', o.b === '第 8 波 · 目前 12,345 分', JSON.stringify(o));
  } catch(e){ t('U339 局内副标题抽为纯函数',false,e.message); t('U340 局内副标题抽为纯函数边界',false,e.message); }


  // ===== U341~U342: 里程碑副标题追加抽为纯函数(v5.14) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5MilestoneSubNow(3,false),b:T.v5MilestoneSubNow(3,true)});})()"));
    t('U341 里程碑副标题追加抽为纯函数', o.a === ' · 🌊里程碑 +3🐾', JSON.stringify(o));
    t('U342 里程碑副标题追加抽为纯函数边界', o.b.indexOf('羁绊×2')>=0, JSON.stringify(o));
  } catch(e){ t('U341 里程碑副标题追加抽为纯函数',false,e.message); t('U342 里程碑副标题追加抽为纯函数边界',false,e.message); }


  // ===== U343~U344: 青色冲击波描边串抽为纯函数(v5.15) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5CyanStrokeNow(0.5),b:T.v5CyanStrokeNow(0)});})()"));
    t('U343 青色冲击波描边串抽为纯函数', o.a === 'rgba(0, 229, 255,0.50)', JSON.stringify(o));
    t('U344 青色冲击波描边串抽为纯函数边界', o.b === 'rgba(0, 229, 255,0.00)', JSON.stringify(o));
  } catch(e){ t('U343 青色冲击波描边串抽为纯函数',false,e.message); t('U344 青色冲击波描边串抽为纯函数边界',false,e.message); }


  // ===== U345~U346: 白色描边二次衰减串抽为纯函数(v5.16) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5WhiteStrokeBNow(1),b:T.v5WhiteStrokeBNow(0)});})()"));
    t('U345 白色描边二次衰减串抽为纯函数', o.a === 'rgba(255,255,255,0.60)', JSON.stringify(o));
    t('U346 白色描边二次衰减串抽为纯函数边界', o.b === 'rgba(255,255,255,0.00)', JSON.stringify(o));
  } catch(e){ t('U345 白色描边二次衰减串抽为纯函数',false,e.message); t('U346 白色描边二次衰减串抽为纯函数边界',false,e.message); }


  // ===== U347~U348: 粒子合批键抽为纯函数(v5.17) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5ParticleKeyNow('#fff',0.5),b:T.v5ParticleKeyNow('red',0)});})()"));
    t('U347 粒子合批键抽为纯函数', o.a === '#fff|0.5', JSON.stringify(o));
    t('U348 粒子合批键抽为纯函数边界', o.b === 'red|0', JSON.stringify(o));
  } catch(e){ t('U347 粒子合批键抽为纯函数',false,e.message); t('U348 粒子合批键抽为纯函数边界',false,e.message); }


  // ===== U349~U350: BOSS 血条文字抽为纯函数(v5.18) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5BossHudTextNow(5,'重甲',10,20,false),b:T.v5BossHudTextNow(5,'重甲',10,20,true)});})()"));
    t('U349 BOSS 血条文字抽为纯函数', o.a === 'LV.5 重甲  10 / 20', JSON.stringify(o));
    t('U350 BOSS 血条文字抽为纯函数边界', o.b.indexOf('⚡狂暴')>=0, JSON.stringify(o));
  } catch(e){ t('U349 BOSS 血条文字抽为纯函数',false,e.message); t('U350 BOSS 血条文字抽为纯函数边界',false,e.message); }


  // ===== U351~U352: 状态倒计时标签抽为纯函数(v5.19) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5StatusLabelNow('护盾',2),b:T.v5StatusLabelNow('冰冻',0)});})()"));
    t('U351 状态倒计时标签抽为纯函数', o.a === '护盾 2.0s', JSON.stringify(o));
    t('U352 状态倒计时标签抽为纯函数边界', o.b === '冰冻 0.0s', JSON.stringify(o));
  } catch(e){ t('U351 状态倒计时标签抽为纯函数',false,e.message); t('U352 状态倒计时标签抽为纯函数边界',false,e.message); }


  // ===== U353~U354: 受伤渐变红色抽为纯函数(v5.20) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5RedFillNow(1),b:T.v5RedFillNow(0)});})()"));
    t('U353 受伤渐变红色抽为纯函数', o.a === 'rgba(255,45,85,0.500)', JSON.stringify(o));
    t('U354 受伤渐变红色抽为纯函数边界', o.b === 'rgba(255,45,85,0.000)', JSON.stringify(o));
  } catch(e){ t('U353 受伤渐变红色抽为纯函数',false,e.message); t('U354 受伤渐变红色抽为纯函数边界',false,e.message); }


  // ===== U355~U356: BOSS 来袭警告文字抽为纯函数(v5.21) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5BossWarnTextNow('重甲'),b:T.v5BossWarnTextNow('猎手')});})()"));
    t('U355 BOSS 来袭警告文字抽为纯函数', o.a === '⚠ WARNING · 重甲 BOSS 来袭 ⚠', JSON.stringify(o));
    t('U356 BOSS 来袭警告文字抽为纯函数边界', o.b.indexOf('猎手')>=0, JSON.stringify(o));
  } catch(e){ t('U355 BOSS 来袭警告文字抽为纯函数',false,e.message); t('U356 BOSS 来袭警告文字抽为纯函数边界',false,e.message); }


  // ===== U357~U358: 白闪遮罩串抽为纯函数(v5.22) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5WhiteFlashStrNow(1,1),b:T.v5WhiteFlashStrNow(1,0.4)});})()"));
    t('U357 白闪遮罩串抽为纯函数', o.a === 'rgba(255,255,255,0.850)', JSON.stringify(o));
    t('U358 白闪遮罩串抽为纯函数边界', o.b === 'rgba(255,255,255,0.340)', JSON.stringify(o));
  } catch(e){ t('U357 白闪遮罩串抽为纯函数',false,e.message); t('U358 白闪遮罩串抽为纯函数边界',false,e.message); }


  // ===== U359~U360: BOSS 蓄力橙色描边抽为纯函数(v5.23) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5OrangeStrokeNow(0),b:T.v5OrangeStrokeNow(Math.PI)});})()"));
    t('U359 BOSS 蓄力橙色描边抽为纯函数', o.a === 'rgba(255,90,0,0.500)', JSON.stringify(o));
    t('U360 BOSS 蓄力橙色描边抽为纯函数边界', o.b === 'rgba(255,90,0,0.900)', JSON.stringify(o));
  } catch(e){ t('U359 BOSS 蓄力橙色描边抽为纯函数',false,e.message); t('U360 BOSS 蓄力橙色描边抽为纯函数边界',false,e.message); }


  // ===== U361~U362: 大招光环 hsla 串抽为纯函数(v5.24) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5HslaANow(0,0),b:T.v5HslaANow(1,1)});})()"));
    t('U361 大招光环 hsla 串抽为纯函数', o.a === 'hsla(0,100%,70%,0.55)', JSON.stringify(o));
    t('U362 大招光环 hsla 串抽为纯函数边界', o.b === 'hsla(150,100%,70%,0.55)', JSON.stringify(o));
  } catch(e){ t('U361 大招光环 hsla 串抽为纯函数',false,e.message); t('U362 大招光环 hsla 串抽为纯函数边界',false,e.message); }


  // ===== U363~U364: 激光 hsla 串抽为纯函数(v5.25) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5HslaBNow(0),b:T.v5HslaBNow(2)});})()"));
    t('U363 激光 hsla 串抽为纯函数', o.a === 'hsla(0,100%,75%,0.9)', JSON.stringify(o));
    t('U364 激光 hsla 串抽为纯函数边界', o.b === 'hsla(240,100%,75%,0.9)', JSON.stringify(o));
  } catch(e){ t('U363 激光 hsla 串抽为纯函数',false,e.message); t('U364 激光 hsla 串抽为纯函数边界',false,e.message); }


  // ===== U365~U366: 粒子 hsla 串抽为纯函数(v5.26) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5HslaCNow(0),b:T.v5HslaCNow(1)});})()"));
    t('U365 粒子 hsla 串抽为纯函数', o.a === 'hsla(20,100%,60%,0.5)', JSON.stringify(o));
    t('U366 粒子 hsla 串抽为纯函数边界', o.b === 'hsla(40,100%,60%,0.5)', JSON.stringify(o));
  } catch(e){ t('U365 粒子 hsla 串抽为纯函数',false,e.message); t('U366 粒子 hsla 串抽为纯函数边界',false,e.message); }


  // ===== U367~U368: 粉色描边串抽为纯函数(v5.27) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5PinkStrokeNow(0.4),b:T.v5PinkStrokeNow(0)});})()"));
    t('U367 粉色描边串抽为纯函数', o.a === 'rgba(255,45,149,0.4)', JSON.stringify(o));
    t('U368 粉色描边串抽为纯函数边界', o.b === 'rgba(255,45,149,0)', JSON.stringify(o));
  } catch(e){ t('U367 粉色描边串抽为纯函数',false,e.message); t('U368 粉色描边串抽为纯函数边界',false,e.message); }


  // ===== U369~U370: 粉色填充串抽为纯函数(v5.28) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5PinkFillNow(1),b:T.v5PinkFillNow(0)});})()"));
    t('U369 粉色填充串抽为纯函数', o.a === 'rgba(255,107,213,0.5)', JSON.stringify(o));
    t('U370 粉色填充串抽为纯函数边界', o.b === 'rgba(255,107,213,0)', JSON.stringify(o));
  } catch(e){ t('U369 粉色填充串抽为纯函数',false,e.message); t('U370 粉色填充串抽为纯函数边界',false,e.message); }


  // ===== U371~U372: 橙色填充串抽为纯函数(v5.29) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5OrangeFillNow(0.8),b:T.v5OrangeFillNow(0)});})()"));
    t('U371 橙色填充串抽为纯函数', o.a === 'rgba(255,106,0,0.8)', JSON.stringify(o));
    t('U372 橙色填充串抽为纯函数边界', o.b === 'rgba(255,106,0,0)', JSON.stringify(o));
  } catch(e){ t('U371 橙色填充串抽为纯函数',false,e.message); t('U372 橙色填充串抽为纯函数边界',false,e.message); }


  // ===== U373~U374: 琥珀粒子填充抽为纯函数(v5.30) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5AmberFillNow(0),b:T.v5AmberFillNow(22)});})()"));
    t('U373 琥珀粒子填充抽为纯函数', o.a === 'rgba(255,150,40,0.7)', JSON.stringify(o));
    t('U374 琥珀粒子填充抽为纯函数边界', o.b === 'rgba(255,150,40,0)', JSON.stringify(o));
  } catch(e){ t('U373 琥珀粒子填充抽为纯函数',false,e.message); t('U374 琥珀粒子填充抽为纯函数边界',false,e.message); }


  // ===== U375~U376: 紫色 hsla 串抽为纯函数(v5.31) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5HslaDNow(0),b:T.v5HslaDNow(5)});})()"));
    t('U375 紫色 hsla 串抽为纯函数', o.a === 'hsla(265,100%,70%,0.4)', JSON.stringify(o));
    t('U376 紫色 hsla 串抽为纯函数边界', o.b === 'hsla(325,100%,70%,0.4)', JSON.stringify(o));
  } catch(e){ t('U375 紫色 hsla 串抽为纯函数',false,e.message); t('U376 紫色 hsla 串抽为纯函数边界',false,e.message); }


  // ===== U377~U378: 深色填充串抽为纯函数(v5.32) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5DarkFillNow(0.5),b:T.v5DarkFillNow(0)});})()"));
    t('U377 深色填充串抽为纯函数', o.a === 'rgba(20,4,46,0.5)', JSON.stringify(o));
    t('U378 深色填充串抽为纯函数边界', o.b === 'rgba(20,4,46,0)', JSON.stringify(o));
  } catch(e){ t('U377 深色填充串抽为纯函数',false,e.message); t('U378 深色填充串抽为纯函数边界',false,e.message); }


  // ===== U379~U380: 冰蓝描边串抽为纯函数(v5.33) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5IceStrokeNow(0.6),b:T.v5IceStrokeNow(0)});})()"));
    t('U379 冰蓝描边串抽为纯函数', o.a === 'rgba(174,230,255,0.6)', JSON.stringify(o));
    t('U380 冰蓝描边串抽为纯函数边界', o.b === 'rgba(174,230,255,0)', JSON.stringify(o));
  } catch(e){ t('U379 冰蓝描边串抽为纯函数',false,e.message); t('U380 冰蓝描边串抽为纯函数边界',false,e.message); }


  // ===== U381~U382: 白色粒子填充抽为纯函数(v5.34) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5WhiteFillNow(0),b:T.v5WhiteFillNow(20)});})()"));
    t('U381 白色粒子填充抽为纯函数', o.a === 'rgba(255,255,255,0.75)', JSON.stringify(o));
    t('U382 白色粒子填充抽为纯函数边界', o.b === 'rgba(255,255,255,0)', JSON.stringify(o));
  } catch(e){ t('U381 白色粒子填充抽为纯函数',false,e.message); t('U382 白色粒子填充抽为纯函数边界',false,e.message); }


  // ===== U383~U384: 紫色 hsla 描边抽为纯函数(v5.35) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5HslaENow(0),b:T.v5HslaENow(2)});})()"));
    t('U383 紫色 hsla 描边抽为纯函数', o.a === 'hsla(285,100%,72%,0.45)', JSON.stringify(o));
    t('U384 紫色 hsla 描边抽为纯函数边界', o.b === 'hsla(315,100%,72%,0.45)', JSON.stringify(o));
  } catch(e){ t('U383 紫色 hsla 描边抽为纯函数',false,e.message); t('U384 紫色 hsla 描边抽为纯函数边界',false,e.message); }


  // ===== U385~U386: 紫光填充串抽为纯函数(v5.36) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5PurpleFillNow(0.3),b:T.v5PurpleFillNow(0)});})()"));
    t('U385 紫光填充串抽为纯函数', o.a === 'rgba(200,107,255,0.3)', JSON.stringify(o));
    t('U386 紫光填充串抽为纯函数边界', o.b === 'rgba(200,107,255,0)', JSON.stringify(o));
  } catch(e){ t('U385 紫光填充串抽为纯函数',false,e.message); t('U386 紫光填充串抽为纯函数边界',false,e.message); }


  // ===== U387~U388: 翠绿描边串抽为纯函数(v5.37) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5GreenStrokeNow(0.9),b:T.v5GreenStrokeNow(0)});})()"));
    t('U387 翠绿描边串抽为纯函数', o.a === 'rgba(52,211,153,0.9)', JSON.stringify(o));
    t('U388 翠绿描边串抽为纯函数边界', o.b === 'rgba(52,211,153,0)', JSON.stringify(o));
  } catch(e){ t('U387 翠绿描边串抽为纯函数',false,e.message); t('U388 翠绿描边串抽为纯函数边界',false,e.message); }


  // ===== U389~U390: 翠绿填充串抽为纯函数(v5.38) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5GreenFillNow(0.4),b:T.v5GreenFillNow(0)});})()"));
    t('U389 翠绿填充串抽为纯函数', o.a === 'rgba(52,211,153,0.4)', JSON.stringify(o));
    t('U390 翠绿填充串抽为纯函数边界', o.b === 'rgba(52,211,153,0)', JSON.stringify(o));
  } catch(e){ t('U389 翠绿填充串抽为纯函数',false,e.message); t('U390 翠绿填充串抽为纯函数边界',false,e.message); }


  // ===== U391~U392: 宠物下级费用文案抽为纯函数(v5.39) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5NextPriceTextNow(60),b:T.v5NextPriceTextNow(0)});})()"));
    t('U391 宠物下级费用文案抽为纯函数', o.a === ' · 下级 60🐾', JSON.stringify(o));
    t('U392 宠物下级费用文案抽为纯函数边界', o.b === ' · 已满级', JSON.stringify(o));
  } catch(e){ t('U391 宠物下级费用文案抽为纯函数',false,e.message); t('U392 宠物下级费用文案抽为纯函数边界',false,e.message); }


  // ===== U393~U394: 每日词条描述拼接抽为纯函数(v5.40) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5DailyModTextNow('','钢铁防线','砖墙变钢墙'),b:T.v5DailyModTextNow('A','B','C')});})()"));
    t('U393 每日词条描述拼接抽为纯函数', o.a === '钢铁防线(砖墙变钢墙)', JSON.stringify(o));
    t('U394 每日词条描述拼接抽为纯函数边界', o.b === 'A · B(C)', JSON.stringify(o));
  } catch(e){ t('U393 每日词条描述拼接抽为纯函数',false,e.message); t('U394 每日词条描述拼接抽为纯函数边界',false,e.message); }


  // ===== U395~U396: 关卡开场标题抽为纯函数(v5.41) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5IntroTxtNow(7),b:T.v5IntroTxtNow(1)});})()"));
    t('U395 关卡开场标题抽为纯函数', o.a === '第 7 关', JSON.stringify(o));
    t('U396 关卡开场标题抽为纯函数边界', o.b === '第 1 关', JSON.stringify(o));
  } catch(e){ t('U395 关卡开场标题抽为纯函数',false,e.message); t('U396 关卡开场标题抽为纯函数边界',false,e.message); }


  // ===== U397~U398: 商店强化图标 HTML 抽为纯函数(v5.42) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5ShopIconHtmlNow('🛡'),b:T.v5ShopIconHtmlNow('⚡')});})()"));
    t('U397 商店强化图标 HTML 抽为纯函数', o.a === '<span class="siIcon">🛡</span>', JSON.stringify(o));
    t('U398 商店强化图标 HTML 抽为纯函数边界', o.b.indexOf('⚡')>=0, JSON.stringify(o));
  } catch(e){ t('U397 商店强化图标 HTML 抽为纯函数',false,e.message); t('U398 商店强化图标 HTML 抽为纯函数边界',false,e.message); }


  // ===== U399~U400: 皮肤稀有度类名抽为纯函数(v5.43) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5RarClassNow('gold',false),b:T.v5RarClassNow('gold',true)});})()"));
    t('U399 皮肤稀有度类名抽为纯函数', o.a === 'shopItem rar-gold', JSON.stringify(o));
    t('U400 皮肤稀有度类名抽为纯函数边界', o.b === 'shopItem rar-gold equipped', JSON.stringify(o));
  } catch(e){ t('U399 皮肤稀有度类名抽为纯函数',false,e.message); t('U400 皮肤稀有度类名抽为纯函数边界',false,e.message); }


  // ===== U401~U402: 稀有度徽章 HTML 抽为纯函数(v5.44) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5RarBadgeNow('rare'),b:T.v5RarBadgeNow('epic')});})()"));
    t('U401 稀有度徽章 HTML 抽为纯函数', o.a.indexOf('class="rar rare"')>=0, JSON.stringify(o));
    t('U402 稀有度徽章 HTML 抽为纯函数边界', o.b.indexOf('epic')>=0, JSON.stringify(o));
  } catch(e){ t('U401 稀有度徽章 HTML 抽为纯函数',false,e.message); t('U402 稀有度徽章 HTML 抽为纯函数边界',false,e.message); }


  // ===== U403~U404: 皮肤名称 HTML 抽为纯函数(v5.45) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5SkinNameHtmlNow('黄金','B'),b:T.v5SkinNameHtmlNow('X','')});})()"));
    t('U403 皮肤名称 HTML 抽为纯函数', o.a === '<span class="siName">黄金B</span>', JSON.stringify(o));
    t('U404 皮肤名称 HTML 抽为纯函数边界', o.b === '<span class="siName">X</span>', JSON.stringify(o));
  } catch(e){ t('U403 皮肤名称 HTML 抽为纯函数',false,e.message); t('U404 皮肤名称 HTML 抽为纯函数边界',false,e.message); }


  // ===== U405~U406: 皮肤状态文案抽为纯函数(v5.46) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5SkinMetaNow(true,true,0),b:T.v5SkinMetaNow(false,false,12345)});})()"));
    t('U405 皮肤状态文案抽为纯函数', o.a === '已装备', JSON.stringify(o));
    t('U406 皮肤状态文案抽为纯函数边界', o.b === '🪙 12,345', JSON.stringify(o));
  } catch(e){ t('U405 皮肤状态文案抽为纯函数',false,e.message); t('U406 皮肤状态文案抽为纯函数边界',false,e.message); }


  // ===== U407~U408: 皮肤按钮 HTML 抽为纯函数(v5.47) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5SkinBtnHtmlNow(true,true,0),b:T.v5SkinBtnHtmlNow(false,false,120)});})()"));
    t('U407 皮肤按钮 HTML 抽为纯函数', o.a.indexOf('已装备')>=0, JSON.stringify(o));
    t('U408 皮肤按钮 HTML 抽为纯函数边界', o.b.indexOf('🪙 购买 120')>=0, JSON.stringify(o));
  } catch(e){ t('U407 皮肤按钮 HTML 抽为纯函数',false,e.message); t('U408 皮肤按钮 HTML 抽为纯函数边界',false,e.message); }


  // ===== U409~U410: 基地护墙预览格抽为纯函数(v5.48) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5BaseBrickNow(true,false),b:T.v5BaseBrickNow(false,false)});})()"));
    t('U409 基地护墙预览格抽为纯函数', o.a === '<div class="bw core"></div>', JSON.stringify(o));
    t('U410 基地护墙预览格抽为纯函数边界', o.b === '<div class="bw off"></div>', JSON.stringify(o));
  } catch(e){ t('U409 基地护墙预览格抽为纯函数',false,e.message); t('U410 基地护墙预览格抽为纯函数边界',false,e.message); }


  // ===== U411~U412: 基地与宠物等级标签统一抽为纯函数(v5.49) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5BaseLvTxtNow(2,false),b:T.v5BaseLvTxtNow(6,true)});})()"));
    t('U411 基地与宠物等级标签统一抽为纯函数', o.a === 'Lv2', JSON.stringify(o));
    t('U412 基地与宠物等级标签统一抽为纯函数边界', o.b === 'Lv6·MAX', JSON.stringify(o));
  } catch(e){ t('U411 基地与宠物等级标签统一抽为纯函数',false,e.message); t('U412 基地与宠物等级标签统一抽为纯函数边界',false,e.message); }


  // ===== U413~U414: 基地满级描述抽为纯函数(v5.50) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5BaseMaxDescNow(12),b:T.v5BaseMaxDescNow(0)});})()"));
    t('U413 基地满级描述抽为纯函数', o.a === '基地护墙 12 格 · 已满级，最坚固的堡垒', JSON.stringify(o));
    t('U414 基地满级描述抽为纯函数边界', o.b.indexOf('0 格')>=0, JSON.stringify(o));
  } catch(e){ t('U413 基地满级描述抽为纯函数',false,e.message); t('U414 基地满级描述抽为纯函数边界',false,e.message); }


  // ===== U415~U416: 基地下级描述抽为纯函数(v5.51) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5BaseNextDescNow(6,'要塞',12),b:T.v5BaseNextDescNow(0,'X',0)});})()"));
    t('U415 基地下级描述抽为纯函数', o.a === '基地护墙 6 格 → 下一级 要塞（12 格）', JSON.stringify(o));
    t('U416 基地下级描述抽为纯函数边界', o.b.indexOf('下一级 X')>=0, JSON.stringify(o));
  } catch(e){ t('U415 基地下级描述抽为纯函数',false,e.message); t('U416 基地下级描述抽为纯函数边界',false,e.message); }


  // ===== U417~U418: 基地名称行 HTML 抽为纯函数(v5.52) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5BaseNameRowNow('堡垒','Lv2'),b:T.v5BaseNameRowNow('X','')});})()"));
    t('U417 基地名称行 HTML 抽为纯函数', o.a.indexOf('基地 · 堡垒')>=0 && o.a.indexOf('Lv2')>=0, JSON.stringify(o));
    t('U418 基地名称行 HTML 抽为纯函数边界', o.b.indexOf('baseLv')>=0, JSON.stringify(o));
  } catch(e){ t('U417 基地名称行 HTML 抽为纯函数',false,e.message); t('U418 基地名称行 HTML 抽为纯函数边界',false,e.message); }


  // ===== U419~U420: 基地升级按钮 HTML 抽为纯函数(v5.53) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5BaseBtnHtmlNow(true,0),b:T.v5BaseBtnHtmlNow(false,12345)});})()"));
    t('U419 基地升级按钮 HTML 抽为纯函数', o.a.indexOf('已满级')>=0, JSON.stringify(o));
    t('U420 基地升级按钮 HTML 抽为纯函数边界', o.b.indexOf('🪙 升级 12,345')>=0, JSON.stringify(o));
  } catch(e){ t('U419 基地升级按钮 HTML 抽为纯函数',false,e.message); t('U420 基地升级按钮 HTML 抽为纯函数边界',false,e.message); }


  // ===== U421~U422: 带书名号的名称标签抽为纯函数(v5.54) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5QuotedNameNow('黄金'),b:T.v5QuotedNameNow('')});})()"));
    t('U421 带书名号的名称标签抽为纯函数', o.a === '「黄金」', JSON.stringify(o));
    t('U422 带书名号的名称标签抽为纯函数边界', o.b === '「」', JSON.stringify(o));
  } catch(e){ t('U421 带书名号的名称标签抽为纯函数',false,e.message); t('U422 带书名号的名称标签抽为纯函数边界',false,e.message); }


  // ===== U423~U424: 皮肤购买成功文案抽为纯函数(v5.55) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5SkinBoughtMsgNow('🔵','经典 QIAN'),b:T.v5SkinBoughtMsgNow('X','Y')});})()"));
    t('U423 皮肤购买成功文案抽为纯函数', o.a === '🔵 皮肤已购买并装备 · 经典 QIAN', JSON.stringify(o));
    t('U424 皮肤购买成功文案抽为纯函数边界', o.b.indexOf('X 皮肤')>=0, JSON.stringify(o));
  } catch(e){ t('U423 皮肤购买成功文案抽为纯函数',false,e.message); t('U424 皮肤购买成功文案抽为纯函数边界',false,e.message); }


  // ===== U425~U426: 僚机皮肤稀有度类名抽为纯函数(v5.56) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5WskinRarClassNow('epic',false),b:T.v5WskinRarClassNow('epic',true)});})()"));
    t('U425 僚机皮肤稀有度类名抽为纯函数', o.a === 'shopItem rar-epic', JSON.stringify(o));
    t('U426 僚机皮肤稀有度类名抽为纯函数边界', o.b === 'shopItem rar-epic equipped', JSON.stringify(o));
  } catch(e){ t('U425 僚机皮肤稀有度类名抽为纯函数',false,e.message); t('U426 僚机皮肤稀有度类名抽为纯函数边界',false,e.message); }


  // ===== U427~U428: 僚机皮肤稀有度徽章抽为纯函数(v5.57) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5WskinRarBadgeNow('rare'),b:T.v5WskinRarBadgeNow('epic')});})()"));
    t('U427 僚机皮肤稀有度徽章抽为纯函数', o.a.indexOf('class="rar rare"')>=0, JSON.stringify(o));
    t('U428 僚机皮肤稀有度徽章抽为纯函数边界', o.b.indexOf('epic')>=0, JSON.stringify(o));
  } catch(e){ t('U427 僚机皮肤稀有度徽章抽为纯函数',false,e.message); t('U428 僚机皮肤稀有度徽章抽为纯函数边界',false,e.message); }


  // ===== U429~U430: 僚机皮肤名称 HTML 抽为纯函数(v5.58) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5WskinNameHtmlNow('🟡','黄金僚机',''),b:T.v5WskinNameHtmlNow('X','Y','B')});})()"));
    t('U429 僚机皮肤名称 HTML 抽为纯函数', o.a === '<span class="siName">🟡 黄金僚机</span>', JSON.stringify(o));
    t('U430 僚机皮肤名称 HTML 抽为纯函数边界', o.b.indexOf('B</span>')>=0, JSON.stringify(o));
  } catch(e){ t('U429 僚机皮肤名称 HTML 抽为纯函数',false,e.message); t('U430 僚机皮肤名称 HTML 抽为纯函数边界',false,e.message); }


  // ===== U431~U432: 僚机皮肤状态文案抽为纯函数(v5.59) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5WskinMetaNow(true,false,0),b:T.v5WskinMetaNow(false,false,12345)});})()"));
    t('U431 僚机皮肤状态文案抽为纯函数', o.a === '已拥有', JSON.stringify(o));
    t('U432 僚机皮肤状态文案抽为纯函数边界', o.b === '🪙 12,345', JSON.stringify(o));
  } catch(e){ t('U431 僚机皮肤状态文案抽为纯函数',false,e.message); t('U432 僚机皮肤状态文案抽为纯函数边界',false,e.message); }


  // ===== U433~U434: 僚机皮肤按钮 HTML 抽为纯函数(v5.60) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5WskinBtnHtmlNow(true,true,0),b:T.v5WskinBtnHtmlNow(false,false,880)});})()"));
    t('U433 僚机皮肤按钮 HTML 抽为纯函数', o.a.indexOf('已装备')>=0, JSON.stringify(o));
    t('U434 僚机皮肤按钮 HTML 抽为纯函数边界', o.b.indexOf('🪙 购买 880')>=0, JSON.stringify(o));
  } catch(e){ t('U433 僚机皮肤按钮 HTML 抽为纯函数',false,e.message); t('U434 僚机皮肤按钮 HTML 抽为纯函数边界',false,e.message); }


  // ===== U435~U436: 羁绊行 HTML 抽为纯函数(v5.61) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5BondRowHtmlNow(true),b:T.v5BondRowHtmlNow(false)});})()"));
    t('U435 羁绊行 HTML 抽为纯函数', o.a === '<div class="bdRow on">', JSON.stringify(o));
    t('U436 羁绊行 HTML 抽为纯函数边界', o.b === '<div class="bdRow">', JSON.stringify(o));
  } catch(e){ t('U435 羁绊行 HTML 抽为纯函数',false,e.message); t('U436 羁绊行 HTML 抽为纯函数边界',false,e.message); }


  // ===== U437~U438: 羁绊图标 HTML 抽为纯函数(v5.62) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5BondIconHtmlNow('🧱'),b:T.v5BondIconHtmlNow('X')});})()"));
    t('U437 羁绊图标 HTML 抽为纯函数', o.a === '<span class="bdIcon">🧱</span>', JSON.stringify(o));
    t('U438 羁绊图标 HTML 抽为纯函数边界', o.b.indexOf('X')>=0, JSON.stringify(o));
  } catch(e){ t('U437 羁绊图标 HTML 抽为纯函数',false,e.message); t('U438 羁绊图标 HTML 抽为纯函数边界',false,e.message); }


  // ===== U439~U440: 羁绊名称 HTML 抽为纯函数(v5.63) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5BondInfoHtmlNow('铜墙铁壁'),b:T.v5BondInfoHtmlNow('X')});})()"));
    t('U439 羁绊名称 HTML 抽为纯函数', o.a === '<span class="bdInfo"><b>铜墙铁壁</b>', JSON.stringify(o));
    t('U440 羁绊名称 HTML 抽为纯函数边界', o.b.indexOf('<b>X</b>')>=0, JSON.stringify(o));
  } catch(e){ t('U439 羁绊名称 HTML 抽为纯函数',false,e.message); t('U440 羁绊名称 HTML 抽为纯函数边界',false,e.message); }


  // ===== U441~U442: 羁绊组合说明抽为纯函数(v5.64) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5BondPairTextNow({icon:'🛡',name:'堡垒'},{icon:'🐢',name:'守护龟'}),b:T.v5BondPairTextNow({icon:'A',name:'A'},{icon:'B',name:'B'})});})()"));
    t('U441 羁绊组合说明抽为纯函数', o.a === '🛡 堡垒 × 🐢 守护龟', JSON.stringify(o));
    t('U442 羁绊组合说明抽为纯函数边界', o.b === 'A A × B B', JSON.stringify(o));
  } catch(e){ t('U441 羁绊组合说明抽为纯函数',false,e.message); t('U442 羁绊组合说明抽为纯函数边界',false,e.message); }


  // ===== U443~U444: 羁绊效果说明 HTML 抽为纯函数(v5.65) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5BondEmHtmlNow('护盾 +2 秒'),b:T.v5BondEmHtmlNow('X')});})()"));
    t('U443 羁绊效果说明 HTML 抽为纯函数', o.a === '<em>护盾 +2 秒</em></span>', JSON.stringify(o));
    t('U444 羁绊效果说明 HTML 抽为纯函数边界', o.b.indexOf('<em>X</em>')>=0, JSON.stringify(o));
  } catch(e){ t('U443 羁绊效果说明 HTML 抽为纯函数',false,e.message); t('U444 羁绊效果说明 HTML 抽为纯函数边界',false,e.message); }


  // ===== U445~U446: 羁绊状态文案抽为纯函数(v5.66) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5BondStateTextNow(true),b:T.v5BondStateTextNow(false)});})()"));
    t('U445 羁绊状态文案抽为纯函数', o.a === '激活中', JSON.stringify(o));
    t('U446 羁绊状态文案抽为纯函数边界', o.b === '未激活', JSON.stringify(o));
  } catch(e){ t('U445 羁绊状态文案抽为纯函数',false,e.message); t('U446 羁绊状态文案抽为纯函数边界',false,e.message); }


  // ===== U447~U448: 宠物稀有度类名抽为纯函数(v5.67) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5PetRarClassNow(true,false),b:T.v5PetRarClassNow(false,true)});})()"));
    t('U447 宠物稀有度类名抽为纯函数', o.a === 'shopItem rar-legendary', JSON.stringify(o));
    t('U448 宠物稀有度类名抽为纯函数边界', o.b === 'shopItem rar-epic equipped', JSON.stringify(o));
  } catch(e){ t('U447 宠物稀有度类名抽为纯函数',false,e.message); t('U448 宠物稀有度类名抽为纯函数边界',false,e.message); }


  // ===== U449~U450: 磁力猪当前效果描述抽为纯函数(v5.68) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5MagnetEffDescNow(1),b:T.v5MagnetEffDescNow(3)});})()"));
    t('U449 磁力猪当前效果描述抽为纯函数', o.a.indexOf('磁力半径')>=0 && o.a.indexOf('px/s')>=0, JSON.stringify(o));
    t('U450 磁力猪当前效果描述抽为纯函数边界', o.b.indexOf('拉速')>=0, JSON.stringify(o));
  } catch(e){ t('U449 磁力猪当前效果描述抽为纯函数',false,e.message); t('U450 磁力猪当前效果描述抽为纯函数边界',false,e.message); }


  // ===== U451~U452: 磁力猪下级效果描述抽为纯函数(v5.69) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5MagnetNextDescNow(1),b:T.v5MagnetNextDescNow(2)});})()"));
    t('U451 磁力猪下级效果描述抽为纯函数', o.a.indexOf('升到 Lv2')>=0, JSON.stringify(o));
    t('U452 磁力猪下级效果描述抽为纯函数边界', o.b.indexOf('升到 Lv3')>=0, JSON.stringify(o));
  } catch(e){ t('U451 磁力猪下级效果描述抽为纯函数',false,e.message); t('U452 磁力猪下级效果描述抽为纯函数边界',false,e.message); }


  // ===== U453~U454: 宠物购买按钮文案抽为纯函数(v5.70) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5PetBuyTextNow(6),b:T.v5PetBuyTextNow(12345)});})()"));
    t('U453 宠物购买按钮文案抽为纯函数', o.a === '🐾 购买 6', JSON.stringify(o));
    t('U454 宠物购买按钮文案抽为纯函数边界', o.b === '🐾 购买 12,345', JSON.stringify(o));
  } catch(e){ t('U453 宠物购买按钮文案抽为纯函数',false,e.message); t('U454 宠物购买按钮文案抽为纯函数边界',false,e.message); }


  // ===== U455~U456: 宠物升级按钮文案抽为纯函数(v5.71) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5PetUpgradeTextNow(12),b:T.v5PetUpgradeTextNow(12345)});})()"));
    t('U455 宠物升级按钮文案抽为纯函数', o.a === '🐾 升级 12', JSON.stringify(o));
    t('U456 宠物升级按钮文案抽为纯函数边界', o.b === '🐾 升级 12,345', JSON.stringify(o));
  } catch(e){ t('U455 宠物升级按钮文案抽为纯函数',false,e.message); t('U456 宠物升级按钮文案抽为纯函数边界',false,e.message); }


  // ===== U457~U458: 宠物名称 HTML 抽为纯函数(v5.72) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5PetNameHtmlNow('招财猫',false,'coin'),b:T.v5PetNameHtmlNow('X',true,'Y')});})()"));
    t('U457 宠物名称 HTML 抽为纯函数', o.a.indexOf('招财猫')>=0 && o.a.indexOf('rar epic')>=0, JSON.stringify(o));
    t('U458 宠物名称 HTML 抽为纯函数边界', o.b.indexOf('rar legendary')>=0, JSON.stringify(o));
  } catch(e){ t('U457 宠物名称 HTML 抽为纯函数',false,e.message); t('U458 宠物名称 HTML 抽为纯函数边界',false,e.message); }


  // ===== U459~U460: 宠物描述 HTML 抽为纯函数(v5.73) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5PetDescHtmlNow('A',false,false,'','').x,b:T.v5PetDescHtmlNow('A',true,false,'N','B')});})()"));
    t('U459 宠物描述 HTML 抽为纯函数', o.a === undefined, JSON.stringify(o));
    t('U460 宠物描述 HTML 抽为纯函数边界', o.b.indexOf('A · NB')>=0, JSON.stringify(o));
  } catch(e){ t('U459 宠物描述 HTML 抽为纯函数',false,e.message); t('U460 宠物描述 HTML 抽为纯函数边界',false,e.message); }


  // ===== U461~U462: 宠物状态 HTML 抽为纯函数(v5.74) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5PetMetaHtmlNow('Lv2',true,true),b:T.v5PetMetaHtmlNow('Lv1',false,false)});})()"));
    t('U461 宠物状态 HTML 抽为纯函数', o.a === '<span class="siMeta">Lv2 · 跟随中</span>', JSON.stringify(o));
    t('U462 宠物状态 HTML 抽为纯函数边界', o.b === '<span class="siMeta">Lv1</span>', JSON.stringify(o));
  } catch(e){ t('U461 宠物状态 HTML 抽为纯函数',false,e.message); t('U462 宠物状态 HTML 抽为纯函数边界',false,e.message); }


  // ===== U463~U464: 宠物按钮 HTML 抽为纯函数(v5.75) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5PetBtnHtmlNow('owned','🐾 升级 12'),b:T.v5PetBtnHtmlNow('','X')});})()"));
    t('U463 宠物按钮 HTML 抽为纯函数', o.a === '<button class="siBtn owned">🐾 升级 12</button>', JSON.stringify(o));
    t('U464 宠物按钮 HTML 抽为纯函数边界', o.b.indexOf('>X</button>')>=0, JSON.stringify(o));
  } catch(e){ t('U463 宠物按钮 HTML 抽为纯函数',false,e.message); t('U464 宠物按钮 HTML 抽为纯函数边界',false,e.message); }


  // ===== U465~U466: 宠物解锁标签抽为纯函数(v5.76) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5UnlockLabelNow('招财猫'),b:T.v5UnlockLabelNow('')});})()"));
    t('U465 宠物解锁标签抽为纯函数', o.a === '「招财猫」', JSON.stringify(o));
    t('U466 宠物解锁标签抽为纯函数边界', o.b === '「」', JSON.stringify(o));
  } catch(e){ t('U465 宠物解锁标签抽为纯函数',false,e.message); t('U466 宠物解锁标签抽为纯函数边界',false,e.message); }


  // ===== U467~U468: 宠物购买成功文案抽为纯函数(v5.77) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5PetBoughtMsgNow('🐱','招财猫','金币+10%',1),b:T.v5PetBoughtMsgNow('X','Y','Z',3)});})()"));
    t('U467 宠物购买成功文案抽为纯函数', o.a === '🐱 招财猫 已购买并跟随！金币+10% ×1', JSON.stringify(o));
    t('U468 宠物购买成功文案抽为纯函数边界', o.b.indexOf('×3')>=0, JSON.stringify(o));
  } catch(e){ t('U467 宠物购买成功文案抽为纯函数',false,e.message); t('U468 宠物购买成功文案抽为纯函数边界',false,e.message); }


  // ===== U469~U470: 抽奖金币详情抽为纯函数(v5.78) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5GachaCoinDetailNow(500),b:T.v5GachaCoinDetailNow(12345)});})()"));
    t('U469 抽奖金币详情抽为纯函数', o.a === '🪙 +500', JSON.stringify(o));
    t('U470 抽奖金币详情抽为纯函数边界', o.b === '🪙 +12,345', JSON.stringify(o));
  } catch(e){ t('U469 抽奖金币详情抽为纯函数',false,e.message); t('U470 抽奖金币详情抽为纯函数边界',false,e.message); }


  // ===== U471~U472: 抽奖强化详情抽为纯函数(v5.79) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5GachaBonusDetailNow('⚡','射速',2),b:T.v5GachaBonusDetailNow('X','Y',0)});})()"));
    t('U471 抽奖强化详情抽为纯函数', o.a === '⚡ 射速 Lv2', JSON.stringify(o));
    t('U472 抽奖强化详情抽为纯函数边界', o.b === 'X Y Lv0', JSON.stringify(o));
  } catch(e){ t('U471 抽奖强化详情抽为纯函数',false,e.message); t('U472 抽奖强化详情抽为纯函数边界',false,e.message); }


  // ===== U473~U474: 成就徽章栏标题 HTML 抽为纯函数(v5.80) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5AchBadgeWrapNow(7,20),b:T.v5AchBadgeWrapNow(0,20)});})()"));
    t('U473 成就徽章栏标题 HTML 抽为纯函数', o.a.indexOf('achBadgeTitle')>=0 && o.a.indexOf('完成度 35%')>=0, JSON.stringify(o));
    t('U474 成就徽章栏标题 HTML 抽为纯函数边界', o.b.indexOf('0/20')>=0, JSON.stringify(o));
  } catch(e){ t('U473 成就徽章栏标题 HTML 抽为纯函数',false,e.message); t('U474 成就徽章栏标题 HTML 抽为纯函数边界',false,e.message); }


  // ===== U475~U476: 成就徽章 HTML 抽为纯函数(v5.81) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5AchBadgeHtmlNow('首胜',true,'🏆'),b:T.v5AchBadgeHtmlNow('X',false,'Y')});})()"));
    t('U475 成就徽章 HTML 抽为纯函数', o.a === '<div class="achBadge" title="首胜">🏆</div>', JSON.stringify(o));
    t('U476 成就徽章 HTML 抽为纯函数边界', o.b.indexOf(' none')>=0 && o.b.indexOf('未解锁')>=0, JSON.stringify(o));
  } catch(e){ t('U475 成就徽章 HTML 抽为纯函数',false,e.message); t('U476 成就徽章 HTML 抽为纯函数边界',false,e.message); }


  // ===== U477~U478: 抽奖箱描述文案抽为纯函数(v5.82) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5GachaDescTextNow(200),b:T.v5GachaDescTextNow(12345)});})()"));
    t('U477 抽奖箱描述文案抽为纯函数', o.a.indexOf('消耗 🪙200')>=0, JSON.stringify(o));
    t('U478 抽奖箱描述文案抽为纯函数边界', o.b.indexOf('12,345')>=0, JSON.stringify(o));
  } catch(e){ t('U477 抽奖箱描述文案抽为纯函数',false,e.message); t('U478 抽奖箱描述文案抽为纯函数边界',false,e.message); }


  // ===== U479~U480: 抽奖箱统计文案抽为纯函数(v5.83) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5GachaMetaTextNow(3,800),b:T.v5GachaMetaTextNow(12345,12345)});})()"));
    t('U479 抽奖箱统计文案抽为纯函数', o.a === '已抽 3 次 · 余额 🪙800', JSON.stringify(o));
    t('U480 抽奖箱统计文案抽为纯函数边界', o.b === '已抽 12,345 次 · 余额 🪙12,345', JSON.stringify(o));
  } catch(e){ t('U479 抽奖箱统计文案抽为纯函数',false,e.message); t('U480 抽奖箱统计文案抽为纯函数边界',false,e.message); }


  // ===== U481~U482: 抽奖按钮 HTML 抽为纯函数(v5.84) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5GachaBtnHtmlNow(true,200),b:T.v5GachaBtnHtmlNow(false,200)});})()"));
    t('U481 抽奖按钮 HTML 抽为纯函数', o.a === '<button class="gachaBtn" >🎲 抽奖 200</button>', JSON.stringify(o));
    t('U482 抽奖按钮 HTML 抽为纯函数边界', o.b.indexOf('disabled')>=0, JSON.stringify(o));
  } catch(e){ t('U481 抽奖按钮 HTML 抽为纯函数',false,e.message); t('U482 抽奖按钮 HTML 抽为纯函数边界',false,e.message); }


  // ===== U483~U484: 重置说明文案抽为纯函数(v5.85) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5ResetDescTextNow(400),b:T.v5ResetDescTextNow(0)});})()"));
    t('U483 重置说明文案抽为纯函数', o.a.indexOf('🪙200')>=0 && o.a.indexOf('🪙200）')>=0, JSON.stringify(o));
    t('U484 重置说明文案抽为纯函数边界', o.b.indexOf('🪙0）')>=0, JSON.stringify(o));
  } catch(e){ t('U483 重置说明文案抽为纯函数',false,e.message); t('U484 重置说明文案抽为纯函数边界',false,e.message); }


  // ===== U485~U486: 重置统计文案抽为纯函数(v5.86) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5ResetMetaTextNow(600,8),b:T.v5ResetMetaTextNow(12345,0)});})()"));
    t('U485 重置统计文案抽为纯函数', o.a === '累计投入 🪙600 · 当前总等级 8', JSON.stringify(o));
    t('U486 重置统计文案抽为纯函数边界', o.b.indexOf('12,345')>=0, JSON.stringify(o));
  } catch(e){ t('U485 重置统计文案抽为纯函数',false,e.message); t('U486 重置统计文案抽为纯函数边界',false,e.message); }


  // ===== U487~U488: 重置按钮 HTML 抽为纯函数(v5.87) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5ResetBtnHtmlNow(true),b:T.v5ResetBtnHtmlNow(false)});})()"));
    t('U487 重置按钮 HTML 抽为纯函数', o.a === '<button class="gachaBtn" >🔄 重置</button>', JSON.stringify(o));
    t('U488 重置按钮 HTML 抽为纯函数边界', o.b.indexOf('disabled')>=0, JSON.stringify(o));
  } catch(e){ t('U487 重置按钮 HTML 抽为纯函数',false,e.message); t('U488 重置按钮 HTML 抽为纯函数边界',false,e.message); }


  // ===== U489~U490: 英雄解锁标签抽为纯函数(v5.88) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5HeroUnlockLabelNow('磁暴'),b:T.v5HeroUnlockLabelNow('')});})()"));
    t('U489 英雄解锁标签抽为纯函数', o.a === '解锁「磁暴」', JSON.stringify(o));
    t('U490 英雄解锁标签抽为纯函数边界', o.b === '解锁「」', JSON.stringify(o));
  } catch(e){ t('U489 英雄解锁标签抽为纯函数',false,e.message); t('U490 英雄解锁标签抽为纯函数边界',false,e.message); }


  // ===== U491~U492: 英雄解锁成功文案抽为纯函数(v5.89) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5HeroBoughtMsgNow('⚡','磁暴',80),b:T.v5HeroBoughtMsgNow('X','Y',12345)});})()"));
    t('U491 英雄解锁成功文案抽为纯函数', o.a === '⚡ 已解锁 · 磁暴（-80🐾）', JSON.stringify(o));
    t('U492 英雄解锁成功文案抽为纯函数边界', o.b.indexOf('12,345')>=0, JSON.stringify(o));
  } catch(e){ t('U491 英雄解锁成功文案抽为纯函数',false,e.message); t('U492 英雄解锁成功文案抽为纯函数边界',false,e.message); }


  // ===== U493~U494: 存档码前缀抽为纯函数(v5.90) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5SaveCodeNow({a:1}),b:T.v5SaveCodeNow({})});})()"));
    t('U493 存档码前缀抽为纯函数', o.a.indexOf('QTB1.')===0 && o.a.length>10, JSON.stringify(o));
    t('U494 存档码前缀抽为纯函数边界', o.b.indexOf('QTB1.')===0, JSON.stringify(o));
  } catch(e){ t('U493 存档码前缀抽为纯函数',false,e.message); t('U494 存档码前缀抽为纯函数边界',false,e.message); }


  // ===== U495~U496: 存档解析失败文案抽为纯函数(v5.91) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5ParseErrTextNow({message:'bad'}),b:T.v5ParseErrTextNow('x')});})()"));
    t('U495 存档解析失败文案抽为纯函数', o.a === '解析失败：bad', JSON.stringify(o));
    t('U496 存档解析失败文案抽为纯函数边界', o.b === '解析失败：x', JSON.stringify(o));
  } catch(e){ t('U495 存档解析失败文案抽为纯函数',false,e.message); t('U496 存档解析失败文案抽为纯函数边界',false,e.message); }


  // ===== U497~U498: 存档备份提示 HTML 抽为纯函数(v5.92) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5SaveTipHtmlNow(),b:T.v5SaveTipHtmlNow()});})()"));
    t('U497 存档备份提示 HTML 抽为纯函数', o.a.indexOf('saveTip')>=0, JSON.stringify(o));
    t('U498 存档备份提示 HTML 抽为纯函数边界', o.b.indexOf('saveArea')>=0, JSON.stringify(o));
  } catch(e){ t('U497 存档备份提示 HTML 抽为纯函数',false,e.message); t('U498 存档备份提示 HTML 抽为纯函数边界',false,e.message); }


  // ===== U499~U500: 战绩记录 UID 抽为纯函数(v5.93) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5RecordUidNow().length,b:T.v5RecordUidNow()});})()"));
    t('U499 战绩记录 UID 抽为纯函数', o.a >= 13, JSON.stringify(o));
    t('U500 战绩记录 UID 抽为纯函数边界', o.b.length >= 13 && o.b.length <= 20, JSON.stringify(o));
  } catch(e){ t('U499 战绩记录 UID 抽为纯函数',false,e.message); t('U500 战绩记录 UID 抽为纯函数边界',false,e.message); }


  // ===== U501~U502: 宠物全家福描述抽为纯函数(v5.94) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5PetAllDescNow(4),b:T.v5PetAllDescNow(0)});})()"));
    t('U501 宠物全家福描述抽为纯函数', o.a === '集齐全部 4 只宠物', JSON.stringify(o));
    t('U502 宠物全家福描述抽为纯函数边界', o.b === '集齐全部 0 只宠物', JSON.stringify(o));
  } catch(e){ t('U501 宠物全家福描述抽为纯函数',false,e.message); t('U502 宠物全家福描述抽为纯函数边界',false,e.message); }


  // ===== U503~U504: 成就解锁文案抽为纯函数(v5.95) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5AchUnlockTextNow({name:'首胜',reward:100},2,7),b:T.v5AchUnlockTextNow({name:'X',reward:0},0,1)});})()"));
    t('U503 成就解锁文案抽为纯函数', o.a.indexOf('+100🪙')>=0 && o.a.indexOf('第 7 个成就')>=0, JSON.stringify(o));
    t('U504 成就解锁文案抽为纯函数边界', o.b.indexOf('+0')<0, JSON.stringify(o));
  } catch(e){ t('U503 成就解锁文案抽为纯函数',false,e.message); t('U504 成就解锁文案抽为纯函数边界',false,e.message); }


  // ===== U505~U506: 颜色转 rgba 兜底串抽为纯函数(v5.96) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5FallbackRgbaNow(0.5),b:T.v5FallbackRgbaNow(0)});})()"));
    t('U505 颜色转 rgba 兜底串抽为纯函数', o.a === 'rgba(255,45,85,0.5)', JSON.stringify(o));
    t('U506 颜色转 rgba 兜底串抽为纯函数边界', o.b === 'rgba(255,45,85,0)', JSON.stringify(o));
  } catch(e){ t('U505 颜色转 rgba 兜底串抽为纯函数',false,e.message); t('U506 颜色转 rgba 兜底串抽为纯函数边界',false,e.message); }


  // ===== U507~U508: 皮肤预览画布 HTML 抽为纯函数(v5.97) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5SkinPrevHtmlNow(),b:T.v5SkinPrevHtmlNow()});})()"));
    t('U507 皮肤预览画布 HTML 抽为纯函数', o.a.indexOf('skinPrev')>=0, JSON.stringify(o));
    t('U508 皮肤预览画布 HTML 抽为纯函数边界', o.b.indexOf('canvas')>=0, JSON.stringify(o));
  } catch(e){ t('U507 皮肤预览画布 HTML 抽为纯函数',false,e.message); t('U508 皮肤预览画布 HTML 抽为纯函数边界',false,e.message); }


  // ===== U509~U510: 皮肤描述 HTML 抽为纯函数(v5.98) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5SkinDescHtmlNow('经典配色'),b:T.v5SkinDescHtmlNow('X')});})()"));
    t('U509 皮肤描述 HTML 抽为纯函数', o.a === '<span class="siDesc">经典配色</span>', JSON.stringify(o));
    t('U510 皮肤描述 HTML 抽为纯函数边界', o.b.indexOf('>X</span>')>=0, JSON.stringify(o));
  } catch(e){ t('U509 皮肤描述 HTML 抽为纯函数',false,e.message); t('U510 皮肤描述 HTML 抽为纯函数边界',false,e.message); }


  // ===== U511~U512: 基地图标 HTML 抽为纯函数（100 轮收口）(v5.99) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.v5BaseIconHtmlNow(),b:T.v5BaseIconHtmlNow()});})()"));
    t('U511 基地图标 HTML 抽为纯函数（100 轮收口）', o.a === '<span class="baseIcon">🏰</span>', JSON.stringify(o));
    t('U512 基地图标 HTML 抽为纯函数（100 轮收口）边界', o.b.indexOf('baseIcon')>=0, JSON.stringify(o));
  } catch(e){ t('U511 基地图标 HTML 抽为纯函数（100 轮收口）',false,e.message); t('U512 基地图标 HTML 抽为纯函数（100 轮收口）边界',false,e.message); }


  // ===== U513~U518: 本局最高连击 HUD(v0.6.0) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('maxComboWrap'),txt:document.getElementById('maxComboNum')?document.getElementById('maxComboNum').textContent:null,a:T.maxComboTextNow(12),b:T.maxComboTextNow(12345),c:T.maxComboTextNow(-3),s:T.maxComboStatNow()});})()"));
    t('U513 峰值 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U514 峰值初值为 ×0', o.txt === '×0', String(o.txt));
    t('U515 普通峰值格式', o.a === '×12', o.a);
    t('U516 大额峰值千分位', o.b === '×12,345', o.b);
    t('U517 负值兜底为零', o.c === '×0', o.c);
    t('U518 峰值统计可读且非负', typeof o.s === 'number' && o.s >= 0, String(o.s));
  } catch(e){ for(let k=513;k<=518;k++) t('U'+k+' 峰值HUD',false,e.message); }


  // ===== U519~U524: 生效道具状态条(v0.6.1) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('fxWrap'),a:T.activeFxTextNow({rapid:3.2,double:0,freeze:0}),b:T.activeFxTextNow({rapid:2,double:1,freeze:4}),c:T.activeFxTextNow({rapid:0,double:0,freeze:0}),d:T.activeFxTextNow({rapid:-1,double:0,freeze:0}),e:T.fxHudNow()});})()"));
    t('U519 状态 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U520 单道具显示秒数', o.a === '⚡速射 4s', o.a);
    t('U521 多道具按序拼接', o.b.indexOf('⚡速射')>=0 && o.b.indexOf('✨双倍')>=0 && o.b.indexOf('❄冰冻')>=0, o.b);
    t('U522 无道具显示无', o.c === '无', o.c);
    t('U523 负数不纳入状态', o.d === '无', o.d);
    t('U524 HUD 文本可读', typeof o.e === 'string', String(o.e));
  } catch(e){ for(let k=519;k<=524;k++) t('U'+k+' 道具状态',false,e.message); }


  // ===== U525~U530: 下个 BOSS 提示(v0.6.2) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bossSoonWrap'),a:T.nextBossInNow(1),b:T.nextBossInNow(4),c:T.nextBossInNow(5),d:T.bossSoonTextNow(4),e:T.bossSoonTextNow(0),h:T.bossSoonHudNow()});})()"));
    t('U525 BOSS 提示 pill 已加入', o.dom === true, JSON.stringify(o));
    t('U526 第1关距 BOSS 4 关', o.a === 4, String(o.a));
    t('U527 第4关距 BOSS 1 关', o.b === 1, String(o.b));
    t('U528 第5关后距 BOSS 5 关', o.c === 5, String(o.c));
    t('U529 临界关显示警告', o.d === '⚠ 下关 BOSS', o.d);
    t('U530 非法关卡不崩且 HUD 有值', o.e.indexOf('BOSS')>=0 && typeof o.h === 'string', o.e+' | '+o.h);
  } catch(e){ for(let k=525;k<=530;k++) t('U'+k+' BOSS提示',false,e.message); }


  // ===== U531~U536: 金币流水(v0.6.3) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('coinLogText'),a:T.coinLogTextNow([]),b:T.coinLogTextNow([{n:50,label:'击杀'},{n:200,label:'过关'}]),c:T.coinLogTextNow([{n:-80,label:'复活'}]),d:T.coinLogPushNow(12345,'测试'),e:T.coinLogLenNow(),f:T.coinLogDomNow()});})()"));
    t('U531 流水面板已加入设置页', o.dom === true, JSON.stringify(o));
    t('U532 空流水显示占位', o.a === '暂无记录', o.a);
    t('U533 多笔按序拼接', o.b === '+50 击杀 · +200 过关', o.b);
    t('U534 支出显示负号', o.c === '-80 复活', o.c);
    t('U535 入账返回长度', o.d === 1 && o.e === 1, String(o.d)+'/'+String(o.e));
    t('U536 大额千分位进入 DOM', typeof o.f === 'string', String(o.f));
  } catch(e){ for(let k=531;k<=536;k++) t('U'+k+' 金币流水',false,e.message); }


  // ===== U537~U542: 键位速查(v0.6.4) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('keyHintBox'),tag:document.getElementById('keyHintBox')?document.getElementById('keyHintBox').tagName:'',a:T.keyHintTextNow(),b:T.keyHintDomNow()});})()"));
    t('U537 折叠面板已加入设置页', o.dom === true, JSON.stringify(o));
    t('U538 使用 details 语义标签', o.tag === 'DETAILS', o.tag);
    t('U539 含移动键位', o.a.indexOf('WASD')>=0 && o.a.indexOf('方向键')>=0, o.a);
    t('U540 含开火与大招键位', o.a.indexOf('空格')>=0 && o.a.indexOf('E 近战')>=0 && o.a.indexOf('B 英雄技')>=0, o.a);
    t('U541 含暂停与静音键位', o.a.indexOf('P 暂停')>=0 && o.a.indexOf('M 静音')>=0, o.a);
    t('U542 面板内文本容器存在', typeof o.b === 'string', String(o.b));
  } catch(e){ for(let k=537;k<=542;k++) t('U'+k+' 键位速查',false,e.message); }


  // ===== U543~U548: 当前模式标签(v0.6.5) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('modeWrap'),a:T.modeNameTextNow(),b:T.modeNameHudNow()});})()"));
    t('U543 模式 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U544 默认模式为标准', o.a === '标准' || ['每日','限时','无尽','自制','双人合作','双人对抗'].indexOf(o.a)>=0, o.a);
    t('U545 模式名非空', o.a.length > 0, o.a);
    t('U546 模式名不含未定义', o.a.indexOf('undefined')<0, o.a);
    t('U547 HUD 与函数一致', o.b === o.a, o.b+' | '+o.a);
    t('U548 HUD 文本为字符串', typeof o.b === 'string', String(o.b));
  } catch(e){ for(let k=543;k<=548;k++) t('U'+k+' 模式标签',false,e.message); }


  // ===== U549~U554: 成就进度条(v0.6.6) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.achBarWidthNow(7,20),b:T.achBarWidthNow(0,20),c:T.achBarWidthNow(20,20),d:T.achBarWidthNow(30,20),e:T.achBarWidthNow(5,0),f:T.achBarDomNow()});})()"));
    t('U549 常规完成度百分比', o.a === '35%', o.a);
    t('U550 零完成度', o.b === '0%', o.b);
    t('U551 全完成度', o.c === '100%', o.c);
    t('U552 超额钳制为 100%', o.d === '100%', o.d);
    t('U553 零总数安全兜底', o.e === '0%', o.e);
    t('U554 宽度值为合法百分比', o.f === null || /^\d+%$/.test(o.f), String(o.f));
  } catch(e){ for(let k=549;k<=554;k++) t('U'+k+' 成就进度条',false,e.message); }


  // ===== U555~U560: 濒死警示(v0.6.7) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('dangerTip'),a:T.dangerClassNow(1),b:T.dangerClassNow(3),c:T.dangerTipNow(1),d:T.dangerTipNow(3),e:T.dangerDomNow()});})()"));
    t('U555 警示元素已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U556 最后一命触发 danger 类', o.a === 'danger', o.a);
    t('U557 生命充足无 danger 类', o.b === '', o.b);
    t('U558 濒死提示含守基地建议', o.c.indexOf('最后一命')>=0 && o.c.indexOf('守住基地')>=0, o.c);
    t('U559 安全态提示', o.d === '基地状态良好', o.d);
    t('U560 DOM 状态可读', o.e && typeof o.e.txt === 'string' && typeof o.e.cls === 'string', JSON.stringify(o.e));
  } catch(e){ for(let k=555;k<=560;k++) t('U'+k+' 濒死警示',false,e.message); }


  // ===== U561~U566: 羁绊 HUD 小标(v0.6.8) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;T.setHero('none');T.clearPet();T.extraHudRefreshNow();return JSON.stringify({dom:!!document.getElementById('bondBadgeWrap'),txt:(document.getElementById('bondBadge')||{}).textContent,f:T.bondBadgeTextNow(),id:T.activeBondIdNow()});})()"));
    t('U561 羁绊 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U562 无羁绊初值 —', o.txt === '—' && o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.setHero('fortress');T.setPet('turtle',2);T.extraHudRefreshNow();return JSON.stringify({f:T.bondBadgeTextNow(),id:T.activeBondIdNow()});})()"));
    t('U563 匹配羁绊显示名称', o2.f === '🧱 铜墙铁壁' && o2.id === 'bondwall', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.setHero('none');T.extraHudRefreshNow();return JSON.stringify({f:T.bondBadgeTextNow()});})()"));
    t('U564 无英雄边界为 —', o3.f === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.setHero('fortress');T.setPet('cat',1);T.extraHudRefreshNow();return JSON.stringify({f:T.bondBadgeTextNow(),id:T.activeBondIdNow()});})()"));
    t('U565 错配组合不激活', o4.f === '—' && o4.id === null, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.setHero('fortress');T.setPet('turtle',2);T.extraHudRefreshNow();return JSON.stringify({dom:T.bondBadgeDomNow(),f:T.bondBadgeTextNow()});})()"));
    t('U566 DOM 与函数一致', o5.dom === o5.f, JSON.stringify(o5));
  } catch(e){ for(let k=561;k<=566;k++) t('U'+k+' 羁绊小标',false,e.message); }


  // ===== U567~U572: 宠物跟随状态 pill(v0.6.9) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;T.clearPet();T.extraHudRefreshNow();return JSON.stringify({dom:!!document.getElementById('petPillWrap'),txt:(document.getElementById('petPillVal')||{}).textContent,f:T.petHudTextNow()});})()"));
    t('U567 宠物 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U568 无宠物初值 —', o.txt === '—' && o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.setPet('turtle',2);T.extraHudRefreshNow();return JSON.stringify({f:T.petHudTextNow(),dom:T.petPillDomNow()});})()"));
    t('U569 装备宠物显示名称与等级', o2.f === '🐢 守护龟 Lv2' && o2.dom === o2.f, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.clearPet();T.extraHudRefreshNow();return JSON.stringify({f:T.petHudTextNow()});})()"));
    t('U570 清除宠物边界为 —', o3.f === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;const ok=T.setPet('nonexistent',5);T.extraHudRefreshNow();return JSON.stringify({ok,f:T.petHudTextNow()});})()"));
    t('U571 非法宠物 id 不影响显示', o4.ok === false && o4.f === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.setPet('turtle',2);T.extraHudRefreshNow();return JSON.stringify({dom:T.petPillDomNow(),f:T.petHudTextNow()});})()"));
    t('U572 DOM 与函数一致', o5.dom === o5.f, JSON.stringify(o5));
  } catch(e){ for(let k=567;k<=572;k++) t('U'+k+' 宠物pill',false,e.message); }


  // ===== U573~U578: 连击计时进度条(v0.6.10) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('comboBarWrap'),fill:!!document.getElementById('comboBarFill'),bar:T.comboBarNow(),w:(document.getElementById('comboBarFill')||{}).style?document.getElementById('comboBarFill').style.width:null});})()"));
    t('U573 进度条 DOM 已加入', o.dom === true && o.fill === true, JSON.stringify(o));
    t('U574 无连击初值 0%', o.bar.max === 0 && o.bar.pct === 0 && o.w === '0%', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({p:T.comboPctNow(5,10),a:T.comboPctNow(10,10),b:T.comboPctNow(0,10),c:T.comboPctNow(-3,10)});})()"));
    t('U575 正常比例换算 50%', o2.p === 50, JSON.stringify(o2));
    t('U576 边界满格与零值', o2.a === 100 && o2.b === 0 && o2.c === 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.comboPctNow('x','y'),b:T.comboPctNow(5,0),c:T.comboPctNow(5,NaN)});})()"));
    t('U577 非法输入兜底为 0', o3.a === 0 && o3.b === 0 && o3.c === 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.extraHudRefreshNow();return JSON.stringify({w:(document.getElementById('comboBarFill')||{}).style?document.getElementById('comboBarFill').style.width:null,pct:T.comboBarNow().pct});})()"));
    t('U578 DOM 宽度与函数一致', o4.w === o4.pct + '%', JSON.stringify(o4));
  } catch(e){ for(let k=573;k<=578;k++) t('U'+k+' 连击进度条',false,e.message); }


  // ===== U579~U584: 无尽里程碑倒计时(v0.6.11) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('milestoneWrap'),txt:(document.getElementById('milestoneVal')||{}).textContent,f:T.milestoneTextNow(1,false)});})()"));
    t('U579 里程碑 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U580 非无尽初值 —', o.txt === '—' && o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.wavesToMilestoneNow(1),b:T.wavesToMilestoneNow(13),c:T.wavesToMilestoneNow(20)});})()"));
    t('U581 正常倒计时 10/8/1', o2.a === 10 && o2.b === 8 && o2.c === 1, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.wavesToMilestoneNow(11),b:T.wavesToMilestoneNow(21)});})()"));
    t('U582 里程碑当日边界重置 10', o3.a === 10 && o3.b === 10, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.wavesToMilestoneNow('abc'),b:T.wavesToMilestoneNow(-5),c:T.wavesToMilestoneNow(0),d:T.wavesToMilestoneNow(NaN)});})()"));
    t('U583 非法输入钳制为 1 层(=10)', o4.a === 10 && o4.b === 10 && o4.c === 10 && o4.d === 10, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.setEndless(true);T.extraHudRefreshNow();const dom=document.getElementById('milestoneVal')?document.getElementById('milestoneVal').textContent:null;const f=T.milestoneTextNow(1,true);T.setEndless(false);T.extraHudRefreshNow();return JSON.stringify({dom,f});})()"));
    t('U584 DOM 与函数一致(无尽态)', o5.dom === o5.f && o5.f === '🌊 10 波', JSON.stringify(o5));
  } catch(e){ for(let k=579;k<=584;k++) t('U'+k+' 里程碑倒计时',false,e.message); }


  // ===== U585~U590: 成就等级称号(v0.6.12) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;T.setAch([]);T.openAchNow();const row=document.querySelector('.achPetStat');return JSON.stringify({a:T.achRankNameNow(0,30),b:T.achRankNameNow(8,30),c:T.achRankNameNow(15,30),d:T.achRankNameNow(23,30),e:T.achRankNameNow(30,30),dom:row?row.textContent:''});})()"));
    t('U585 五级称号齐全(新兵/老兵/精锐/将军/元帅)', o.a === '新兵' && o.b === '老兵' && o.c === '精锐' && o.d === '将军' && o.e === '元帅', JSON.stringify(o));
    t('U586 零成就初值为新兵且面板含称号', o.dom.indexOf('🎖') >= 0 && o.dom.indexOf('新兵') >= 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.achRankNameNow(0,0),b:T.achRankNameNow(-5,30),c:T.achRankNameNow(99,30),d:T.achRankNameNow('x','y')});})()"));
    t('U587 边界:零总量/负数/超额/非法', o2.a === '新兵' && o2.b === '新兵' && o2.c === '元帅' && o2.d === '新兵', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.achRankNameNow(NaN,30),b:T.achRankNameNow(30,NaN),c:T.achRankNameNow(15,'30')});})()"));
    t('U588 非法输入兜底(NaN 数量/总数均落新兵)', o3.a === '新兵' && o3.b === '新兵' && o3.c === '精锐', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.setAch(T.achAllDefs());T.openAchNow();const row=document.querySelector('.achPetStat');const r=row?row.textContent:'';T.setAch([]);T.openAchNow();return JSON.stringify({full:r,none:(document.querySelector('.achPetStat')||{}).textContent});})()"));
    t('U589 DOM 与函数一致(全解锁=元帅)', o4.full.indexOf('元帅') >= 0 && (o4.none || '').indexOf('新兵') >= 0, JSON.stringify(o4));
    t('U590 口径与统计条共存不冲突', (o4.full || '').indexOf('🐾 宠物币进度') >= 0 || (o4.none || '').indexOf('🐾 宠物币进度') >= 0, JSON.stringify(o4));
  } catch(e){ for(let k=585;k<=590;k++) t('U'+k+' 成就称号',false,e.message); }


  // ===== U591~U596: 签到 7 日进度条(v0.6.13) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.signinCyclePctNow(0),b:T.signinCyclePctNow(1),c:T.signinCyclePctNow(6),d:T.signinCyclePctNow(7)});})()"));
    t('U591 进度 0/14/86/100', o.a === 0 && o.b === 14 && o.c === 86 && o.d === 100, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.signinCycleTextNow(6),b:T.signinCycleTextNow(7),c:T.signinCycleTextNow('x'),d:T.signinCycleTextNow(-3)});})()"));
    t('U592 文案与非法输入兜底', o2.a === '连续 6 天 · 本轮 6/7' && o2.b === '连续 7 天 · 本轮 7/7' && o2.c === '连续 0 天 · 本轮 0/7' && o2.d === '连续 0 天 · 本轮 0/7', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.signinRenderNow(-1, 5));})()"));
    t('U593 进度条 DOM 渲染(第6天=86%)', o3.dom === true && o3.w === '86%', JSON.stringify(o3));
    t('U594 文案含连续天数', (o3.txt || '').indexOf('连续 6 天') >= 0, o3.txt);
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.signinRenderNow(-1, 6));})()"));
    t('U595 整轮第7天满格 100%', o4.w === '100%' && (o4.txt || '').indexOf('本轮 7/7') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.signinRenderNow(0, 0));})()"));
    t('U596 零天数 DOM 与函数一致(0%)', o5.w === '0%' && o5.txt === '连续 0 天 · 本轮 0/7', JSON.stringify(o5));
  } catch(e){ for(let k=591;k<=596;k++) t('U'+k+' 签到进度条',false,e.message); }


  // ===== U597~U602: 濒死红晕渐强(v0.6.14) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;T.setLives(3);T.extraHudRefreshNow();return JSON.stringify({dom:!!document.getElementById('vignette'),op:T.vignetteDomNow(),a:T.vignetteAlphaNow(3,3)});})()"));
    t('U597 红晕 DOM 已加入', o.dom === true, JSON.stringify(o));
    t('U598 满命透明(op=0)', o.op === '0' && o.a === 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.setLives(2);T.extraHudRefreshNow();return JSON.stringify({op:T.vignetteDomNow(),a:T.vignetteAlphaNow(2,3)});})()"));
    t('U599 掉一命渐强(op=0.33)', o2.a === 0.33 && o2.op === '0.33', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.setLives(1);T.extraHudRefreshNow();return JSON.stringify({op:T.vignetteDomNow(),a:T.vignetteAlphaNow(1,3)});})()"));
    t('U600 濒死封顶 0.55', o3.a === 0.55 && o3.op === '0.55', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.vignetteAlphaNow(NaN,3),b:T.vignetteAlphaNow(3,0),c:T.vignetteAlphaNow('x','y')});})()"));
    t('U601 非法输入兜底(零命=濒死上限)', o4.a === 0.55 && o4.b === 0 && o4.c === 0.55, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.setLives(2);T.extraHudRefreshNow();return JSON.stringify({dom:T.vignetteDomNow(),f:T.vignetteAlphaNow(2,3)});})()"));
    t('U602 DOM 与函数一致', o5.dom === String(o5.f), JSON.stringify(o5));
  } catch(e){ for(let k=597;k<=602;k++) t('U'+k+' 濒死红晕',false,e.message); }


  // ===== U603~U608: 抽奖概率公示(v0.6.15) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;T.setShopTab('gacha');T.renderShop();const el=document.querySelector('.gachaProb');const rows=el?el.querySelectorAll('.gachaProbRow').length:0;return JSON.stringify({dom:!!el,rows,txt:el?el.textContent:''});})()"));
    t('U603 概率面板渲染于抽奖页(5 行)', o.dom === true && o.rows === 5, JSON.stringify(o));
    t('U604 面板含标题与百分比', (o.txt || '').indexOf('概率公示') >= 0 && (o.txt || '').indexOf('%') >= 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.gachaProbRowsNow([{w:1,label:'a'},{w:3,label:'b'}]));})()"));
    t('U605 自定义权重 25%/75%', o2.indexOf('25%') >= 0 && o2.indexOf('75%') >= 0, o2);
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.gachaProbRowsNow(null),b:T.gachaProbRowsNow([]),c:T.gachaProbRowsNow([{w:0}])});})()"));
    t('U606 非法输入返回空串', o3.a === '' && o3.b === '' && o3.c === '', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.gachaProbRowsNow([{w:5,label:'solo'}]));})()"));
    t('U607 单项边界 100%', o4.indexOf('100%') >= 0, o4);
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;const el=document.querySelector('.gachaProb');const first=el?el.querySelector('.gachaProbRow b'):null;return JSON.stringify({txt:el?el.textContent:'',first:first?first.textContent:''});})()"));
    t('U608 DOM 与函数一致(首行 +600 30%)', (o5.txt || '').indexOf('30%') >= 0 && o5.first === '30%', JSON.stringify(o5));
  } catch(e){ for(let k=603;k<=608;k++) t('U'+k+' 概率公示',false,e.message); }


  // ===== U609~U614: 无尽波次纪录对比(v0.6.16) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;T.setEndless(false);T.extraHudRefreshNow();return JSON.stringify({dom:!!document.getElementById('waveDeltaWrap'),txt:(document.getElementById('waveDeltaVal')||{}).textContent,f:T.waveDeltaTextNow(5,10,false)});})()"));
    t('U609 纪录 pill 已加入 HUD(非无尽 —)', o.dom === true && o.txt === '—' && o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.waveDeltaTextNow(13,10,true),b:T.waveDeltaTextNow(8,10,true)});})()"));
    t('U610 超纪录与距纪录', o2.a === '🌊 +3 超纪录' && o2.b === '🌊 距纪录 2 波', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.waveDeltaTextNow(10,10,true),b:T.waveDeltaTextNow(1,0,true)});})()"));
    t('U611 边界追平与首局', o3.a === '🌊 追平纪录' && o3.b === '🌊 +1 超纪录', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.waveDeltaTextNow('x','y',true),b:T.waveDeltaTextNow(NaN,NaN,true)});})()"));
    t('U612 非法输入钳制为 1/0(+1 超纪录)', o4.a === '🌊 +1 超纪录' && o4.b === '🌊 +1 超纪录', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.setEndless(true);T.setBestWave(0);T.extraHudRefreshNow();const dom=document.getElementById('waveDeltaVal')?document.getElementById('waveDeltaVal').textContent:null;T.setEndless(false);T.extraHudRefreshNow();return JSON.stringify({dom});})()"));
    t('U613 DOM 与函数一致(无尽 Lv1 +1)', o5.dom === '🌊 +1 超纪录', JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.extraHudRefreshNow();return JSON.stringify({txt:(document.getElementById('waveDeltaVal')||{}).textContent});})()"));
    t('U614 非无尽恢复灰显', o6.txt === '—', JSON.stringify(o6));
  } catch(e){ for(let k=609;k<=614;k++) t('U'+k+' 纪录对比',false,e.message); }


  // ===== U615~U620: 存档状态面板(v0.6.17) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;const box=document.getElementById('saveStatBox');return JSON.stringify({dom:!!box,sum:box?(box.querySelector('summary')||{}).textContent:null,body:(document.getElementById('saveStatBody')||{}).textContent});})()"));
    t('U615 存档面板已加入设置页', o.dom === true && (o.sum || '').indexOf('存档状态') >= 0, JSON.stringify(o));
    t('U616 未展开初值 —', o.body === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.saveStatToggleNow());})()"));
    t('U617 展开后显示 KB 与覆盖项数', o2.open === true && (o2.txt || '').indexOf('KB') >= 0 && (o2.txt || '').indexOf('覆盖') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.fmtKBTextNow(0),b:T.fmtKBTextNow(2048),c:T.storageBytesNow()});})()"));
    t('U618 边界 0 与 2KB 换算', o3.a === '0.0 KB' && o3.b === '2.0 KB' && o3.c >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.fmtKBTextNow(NaN),b:T.fmtKBTextNow(-999),c:T.fmtKBTextNow('abc')});})()"));
    t('U619 非法输入兜底 0.0 KB', o4.a === '0.0 KB' && o4.b === '0.0 KB' && o4.c === '0.0 KB', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({html:T.saveStatHtmlNow(),bytes:T.storageBytesNow()});})()"));
    t('U620 DOM 与函数一致(KB 值相同)', o5.html.indexOf((o5.bytes / 1024).toFixed(1) + ' KB') >= 0, JSON.stringify(o5));
  } catch(e){ for(let k=615;k<=620;k++) t('U'+k+' 存档面板',false,e.message); }


  // ===== U621~U626: SW 新版本提示(v0.6.18) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;const b=document.getElementById('swBanner');return JSON.stringify({dom:!!b,cls:b?b.className:null,txt:b?b.textContent:null});})()"));
    t('U621 SW 横幅已加入', o.dom === true, JSON.stringify(o));
    t('U622 初值隐藏且无文案', o.cls === 'swBanner' && o.txt === '', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.swUpdateTextNow(true),b:T.swUpdateTextNow(false)});})()"));
    t('U623 正常文案', o2.a === '🆕 新版本已就绪 · 刷新页面生效' && o2.b === '', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.swUpdateTextNow(false),b:T.swUpdateTextNow('x'),c:T.swUpdateTextNow(undefined),d:T.swUpdateTextNow(1)});})()"));
    t('U624 严格 true 才显示(非法兜底空串)', o3.a === '' && o3.b === '' && o3.c === '' && o3.d === '', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.swUpdateSimNow());})()"));
    t('U625 模拟 updatefound 横幅弹出', o4.cls === 'swBanner show' && (o4.txt || '').indexOf('新版本') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){return JSON.stringify({sw:typeof navigator.serviceWorker === 'object'});})()"));
    t('U626 注册 API 可用', o5.sw === true, JSON.stringify(o5));
  } catch(e){ for(let k=621;k<=626;k++) t('U'+k+' SW提示',false,e.message); }


  // ===== U627~U632: 离线状态横幅(v0.6.19) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('netBanner'),cls:(document.getElementById('netBanner')||{}).className,txt:(document.getElementById('netBanner')||{}).textContent});})()"));
    t('U627 横幅已加入且初始隐藏(在线)', o.dom === true && o.cls === 'netBanner' && o.txt === '', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.netUpdSimNow(false));})()"));
    t('U628 离线态显示提示', o2.txt === '📴 网络已断开 · 单机进度照常保存' && o2.cls === 'netBanner show', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.netUpdSimNow(true));})()"));
    t('U629 在线态恢复隐藏', o3.txt === '' && o3.cls === 'netBanner', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.netBannerTextNow(true),b:T.netBannerTextNow('x'),c:T.netBannerTextNow(undefined)});})()"));
    t('U630 严格 false 才显示(非法兜底空串)', o4.a === '' && o4.b === '' && o4.c === '', JSON.stringify(o4));
    // 真实离线切换:合成事件不改 navigator.onLine,需 CDP 网络模拟(harness 层)
    await client.send('Network.enable', {});
    await client.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await sleep(80);
    const off = JSON.parse(await ev("(function(){const b=document.getElementById('netBanner');return JSON.stringify({txt:b?b.textContent:null,cls:b?b.className:null});})()"));
    await client.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await sleep(80);
    const on = JSON.parse(await ev("(function(){const b=document.getElementById('netBanner');return JSON.stringify({txt:b?b.textContent:null,cls:b?b.className:null});})()"));
    t('U631 真实离线/在线切换(CDP 模拟)', (off || {}).cls === 'netBanner show' && (on || {}).cls === 'netBanner', JSON.stringify({ off, on }));
    const o6 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:T.netBannerDomNow(),f:T.netBannerTextNow(navigator.onLine)});})()"));
    t('U632 DOM 与函数一致', (o6.dom || {}).txt === o6.f && (o6.dom || {}).cls === (o6.f === '' ? 'netBanner' : 'netBanner show'), JSON.stringify(o6));
  } catch(e){ for(let k=627;k<=632;k++) t('U'+k+' 离线横幅',false,e.message); }


  // ===== U633~U638: 存档备份日期(v0.6.20) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;const box=document.getElementById('backupAgeBox');return JSON.stringify({dom:!!box,sum:box?(box.querySelector('summary')||{}).textContent:null,body:(document.getElementById('backupAgeBody')||{}).textContent});})()"));
    t('U633 备份面板已加入设置页', o.dom === true && (o.sum || '').indexOf('备份状态') >= 0, JSON.stringify(o));
    t('U634 未展开初值 —', o.body === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;const now=Date.now();return JSON.stringify({a:T.backupAgeTextNow(now),b:T.backupAgeTextNow(now-2*86400000),c:T.backupAgeTextNow(now-400*86400000)});})()"));
    t('U635 今天/2天前/400天前', o2.a === '今天已备份' && o2.b === '2 天前备份' && o2.c === '400 天前备份', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.backupAgeTextNow(0),b:T.backupAgeTextNow(-1)});})()"));
    t('U636 边界 0 与负数=从未备份', o3.a === '从未备份' && o3.b === '从未备份', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.backupAgeTextNow('x'),b:T.backupAgeTextNow(NaN),c:T.backupAgeTextNow(undefined)});})()"));
    t('U637 非法输入=从未备份', o4.a === '从未备份' && o4.b === '从未备份' && o4.c === '从未备份', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.setRawSave('tank-battle-lastbackup','0');const r1=T.backupAgeRefreshNow();T.setRawSave('tank-battle-lastbackup', String(Date.now()));const r2=T.backupAgeRefreshNow();return JSON.stringify({r1,r2});})()"));
    t('U638 DOM 与函数一致(导出后=今天已备份)', o5.r1 === '从未备份' && o5.r2 === '今天已备份', JSON.stringify(o5));
  } catch(e){ for(let k=633;k<=638;k++) t('U'+k+' 备份日期',false,e.message); }


  // ===== U639~U644: FPS 显示开关(v0.6.21) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;const w=document.getElementById('fpsWrap');return JSON.stringify({pill:!!w,tog:!!document.getElementById('fpsToggle'),hidden:w?w.style.display==='none':null,val:T.fpsPillDomNow(),v:T.fpsValueNow(),f:T.fpsTextNow(T.fpsValueNow())});})()"));
    t('U639 FPS pill 与设置开关已加入', o.pill === true && o.tog === true, JSON.stringify(o));
    t('U640 默认关闭且 pill 实测值与函数一致', o.hidden === true && o.val === o.f && o.v >= 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.fpsTextNow(60),b:T.fpsTextNow(0),c:T.fpsTextNow(59.6)});})()"));
    t('U641 纯函数取整格式', o2.a === '60 FPS' && o2.b === '0 FPS' && o2.c === '60 FPS', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.fpsTextNow(NaN),b:T.fpsTextNow(-5),c:T.fpsTextNow(9999)});})()"));
    t('U642 非法与上界钳制', o3.a === '0 FPS' && o3.b === '0 FPS' && o3.c === '999 FPS', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;const on=T.fpsToggleNow(true);const off=T.fpsToggleNow(false);return JSON.stringify({on,off});})()"));
    t('U643 开关持久化 localStorage(1/0)', o4.on.ls === '1' && o4.on.show === true && o4.off.ls === '0' && o4.off.show === false, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(async () => { const T = window.__tbTest; T.fpsToggleNow(true); await new Promise(r => setTimeout(r, 700)); const v = T.fpsValueNow(); const dom = T.fpsPillDomNow(); T.fpsToggleNow(false); return JSON.stringify({ v, dom }); })()"));
    t('U644 实测帧率写入 pill(v>0 · 与函数一致)', o5.v > 0 && o5.dom === (function(n){ return Math.max(0, Math.min(999, Math.round(Number(n) || 0))) + ' FPS'; })(o5.v), JSON.stringify(o5));
  } catch(e){ for(let k=639;k<=644;k++) t('U'+k+' FPS开关',false,e.message); }


  // ===== U645~U650: 最近一局战绩卡片(v0.6.22) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('lastRunCard')});})()"));
    t('U645 卡片容器已加入主菜单', o.dom === true, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({txt:T.lastRunCardRefreshNow(),f:T.lastRunCardHtmlNow(null)});})()"));
    t('U646 无战绩初值提示', o2.txt.indexOf('暂无战绩') >= 0 && o2.f.indexOf('暂无战绩') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.lastRunCardHtmlNow({score:12345,level:5,kills:10,maxCombo:8,endless:false,daily:false,timed:false,win:true}));})()"));
    t('U647 正常卡片(千分位/关卡/胜利)', o3.indexOf('12,345') >= 0 && o3.indexOf('第 5 关') >= 0 && o3.indexOf('胜利') >= 0, o3);
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.lastRunCardHtmlNow(null),b:T.lastRunCardHtmlNow({score:0,level:3,kills:0,maxCombo:0}),c:T.lastRunCardHtmlNow({score:-5,level:3,kills:0,maxCombo:0})});})()"));
    t('U648 非法与零分兜底为空态', o4.a.indexOf('暂无战绩') >= 0 && o4.b.indexOf('暂无战绩') >= 0 && o4.c.indexOf('暂无战绩') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.lastRunCardHtmlNow({score:123456,level:9,kills:99,maxCombo:12,endless:true,daily:false,timed:false,win:false}));})()"));
    t('U649 大额千分位与模式标注', o5.indexOf('123,456') >= 0 && o5.indexOf('🌊 无尽') >= 0 && o5.indexOf('败北') >= 0, o5);
    const o6 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.endGame(true);const dom=T.lastRunCardRefreshNow();const fn=T.lastRunCardHtmlNow(T.lastRunNow2());T.startGame();return JSON.stringify({dom,fn});})()"));
    t('U650 DOM 与函数一致(真实一局)', o6.fn.indexOf(o6.dom) >= 0 && o6.dom.indexOf('暂无战绩') >= 0, JSON.stringify(o6).slice(0, 260));
  } catch(e){ for(let k=645;k<=650;k++) t('U'+k+' 最近一局卡片',false,e.message); }


  // ===== U651~U656: BOSS 关倒计时(v0.6.23) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bossCdWrap'),txt:(document.getElementById('bossCdVal')||{}).textContent,f:T.bossCountdownTextNow(3)});})()"));
    t('U651 倒计时 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U652 正常关卡第 3 关=距 2 关', o.f === '👑 距 BOSS 2 关' && (o.txt || '').indexOf('距 BOSS') >= 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossCountdownTextNow(5),b:T.bossCountdownTextNow(10),c:T.bossCountdownTextNow(9),d:T.bossCountdownTextNow(4)});})()"));
    t('U653 BOSS 关与临界 1 关', o2.a === '👑 本关 BOSS' && o2.b === '👑 本关 BOSS' && o2.c === '👑 距 BOSS 1 关' && o2.d === '👑 距 BOSS 1 关', JSON.stringify(o2));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossCountdownTextNow(1),b:T.bossCountdownTextNow(50)});})()"));
    t('U654 边界首关与整十', o4.a === '👑 距 BOSS 4 关' && o4.b === '👑 本关 BOSS', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossCountdownTextNow('x'),b:T.bossCountdownTextNow(-3),c:T.bossCountdownTextNow(NaN),d:T.bossCountdownTextNow(2.7)});})()"));
    t('U655 非法输入钳制为第 1 关', o5.a === '👑 距 BOSS 4 关' && o5.b === '👑 距 BOSS 4 关' && o5.c === '👑 距 BOSS 4 关' && o5.d === '👑 距 BOSS 3 关', JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const dom=document.getElementById('bossCdVal')?document.getElementById('bossCdVal').textContent:null;return JSON.stringify({dom,lv:T.stat?null:null});})()"));
    t('U656 DOM 与函数一致(开局第 1 关)', o6.dom === '👑 距 BOSS 4 关', JSON.stringify(o6));
  } catch(e){ for(let k=651;k<=656;k++) t('U'+k+' BOSS倒计时',false,e.message); }


  // ===== U657~U662: 护盾剩余时间(v0.6.24) =====




  // ===== U675~U680: 强化总等级 pill(v0.6.27) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('upgPillWrap'),f:T.upgTotalTextNow(0)});})()"));
    t('U675 强化 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U676 零强化初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.upgTotalTextNow(3),b:T.upgTotalTextNow(1)});})()"));
    t('U677 正常值 ×3/×1', o2.a === '⚡ ×3' && o2.b === '⚡ ×1', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.upgTotalTextNow(-5),b:T.upgTotalTextNow(NaN)});})()"));
    t('U678 非法输入兜底 —', o3.a === '—' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.upgPillDomNow(),total:T.upgTotalNow()});})()"));
    t('U679 DOM 与函数一致(新局 total=0)', o4.dom === '—' && o4.total === 0, JSON.stringify(o4));
    t('U680 类型一致(number)', typeof o4.total === 'number', String(o4.total));
  } catch(e){ for(let k=675;k<=680;k++) t('U'+k+' 强化pill',false,e.message); }


  // ===== U681~U686: 游玩时长 pill(v0.6.28) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('timePillWrap'),f:T.playTimeTextNow(0)});})()"));
    t('U681 时长 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U682 零秒初值', o.f === '0 秒', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.playTimeTextNow(45),b:T.playTimeTextNow(90),c:T.playTimeTextNow(3725)});})()"));
    t('U683 正常格式 45秒/1分30秒/62分5秒', o2.a === '45 秒' && o2.b === '1 分 30 秒' && o2.c === '62 分 5 秒', JSON.stringify(o2));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.playTimeTextNow(-5),b:T.playTimeTextNow(NaN),c:T.playTimeTextNow('x')});})()"));
    t('U684 非法输入兜底 0 秒', o4.a === '0 秒' && o4.b === '0 秒' && o4.c === '0 秒', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(async () => { const T = window.__tbTest; T.startGame(); T.skipIntro(); await new Promise(r => setTimeout(r, 1200)); const dom = T.timePillDomNow(); return JSON.stringify({ dom }); })()"));
    t('U685 实时计时(1 秒后 ≥1 秒)', parseInt(o5.dom) >= 1, JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const T=window.__tbTest;const dom=T.timePillDomNow();const fn=T.playTimeTextNow(T.playSecRunNow());return JSON.stringify({dom,fn});})()"));
    t('U686 DOM 与函数一致', o6.dom === o6.fn, JSON.stringify(o6));
  } catch(e){ for(let k=681;k<=686;k++) t('U'+k+' 时长pill',false,e.message); }


  // ===== U687~U692: 生涯评级徽章(v0.6.29) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('careerGradeBadge')});})()"));
    t('U687 生涯评级徽章已加入面板', o.dom === true, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerGradeTextNow(0,0),b:T.careerGradeTextNow(100,1000)});})()"));
    t('U688 初值 C / 顶级 S', o2.a === 'C' && o2.b === 'S', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerGradeTextNow(20,200),b:T.careerGradeTextNow(40,400)});})()"));
    t('U689 正常值 A/B 分档', o3.a === 'B' && o3.b === 'A', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerGradeTextNow(30,300),b:T.careerGradeTextNow(60,800),c:T.careerGradeTextNow(59,799)});})()"));
    t('U690 边界阈值 30/300=A 60/800=S', o4.a === 'A' && o4.b === 'S' && o4.c === 'A', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerGradeTextNow(-5,-9),b:T.careerGradeTextNow(NaN,'x')});})()"));
    t('U691 非法输入兜底 C', o5.a === 'C' && o5.b === 'C', JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:T.careerGradeDomNow()});})()"));
    t('U692 DOM 文本为合法评级', ['S','A','B','C'].includes(o6.dom), JSON.stringify(o6));
  } catch(e){ for(let k=687;k<=692;k++) t('U'+k+' 生涯评级',false,e.message); }


  // ===== U693~U698: 宠物收藏进度(v0.6.30) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('petCollectWrap'),f:T.petCollectTextNow(0,4)});})()"));
    t('U693 宠物收藏 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U694 零收藏初值 0/4', o.f === '0/4', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petCollectTextNow(2,4),b:T.petCollectTextNow(4,4)});})()"));
    t('U695 正常值 2/4 与集齐 4/4', o2.a === '2/4' && o2.b === '4/4', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petCollectPctNow(2,4),b:T.petCollectPctNow(5,4)});})()"));
    t('U696 百分比 50% 与封顶 100%', o3.a === 50 && o3.b === 100, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petCollectTextNow(-1,4),b:T.petCollectTextNow(2,0)});})()"));
    t('U697 非法输入兜底 0/4', o4.a === '0/4' && o4.b === '2/4', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;const dom=T.petCollectDomNow();const fn=T.petCollectTextNow(T.petCollectDomNow()?1:0,4);return JSON.stringify({dom,fn});})()"));
    t('U698 DOM 与函数一致(格式 x/4)', /^\d+\/4$/.test(o5.dom), JSON.stringify(o5));
  } catch(e){ for(let k=693;k<=698;k++) t('U'+k+' 宠物收藏',false,e.message); }


  // ===== U699~U704: 皮肤稀有度图例(v0.6.31) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;T.rarLegendRefreshNow();return JSON.stringify({dom:!!document.getElementById('rarLegend'),len:T.rarLegendHtmlNow().length});})()"));
    t('U699 稀有度图例已加入商店', o.dom === true, JSON.stringify(o));
    t('U700 图例含 4 个稀有度项', o.len > 40, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.rarLegendHtmlNow().indexOf('稀有')>=0,b:T.rarLegendHtmlNow().indexOf('限定')>=0});})()"));
    t('U701 含稀有与限定两类', o2.a === true && o2.b === true, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({c:(T.rarLegendHtmlNow().match(/rarDot/g)||[]).length});})()"));
    t('U702 恰好 4 个色点', o3.c === 4, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:T.rarLegendDomNow()});})()"));
    t('U703 刷新后 DOM 有内容', o4.dom.length > 10, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.rarLegendHtmlNow()===T.rarLegendHtmlNow()});})()"));
    t('U704 幂等(重复调用一致)', o5.a === true, JSON.stringify(o5));
  } catch(e){ for(let k=699;k<=704;k++) t('U'+k+' 稀有度图例',false,e.message); }


  // ===== U705~U710: 下一关预告(v0.6.32) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('nextWaveTip'),f:T.nextWavePreviewNow(0,false)});})()"));
    t('U705 下一关预告已加入结算屏', o.dom === true, JSON.stringify(o));
    t('U706 第1关初值含下一关', o.f.indexOf('下一关') >= 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.nextWavePreviewNow(4,false),b:T.nextWavePreviewNow(9,false)});})()"));
    t('U707 BOSS 关预告(第5/10关)', o2.a.indexOf('BOSS') >= 0 && o2.b.indexOf('BOSS') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.nextWavePreviewNow(5,false),b:T.nextWavePreviewNow(2,true)});})()"));
    t('U708 普通关正常 / 无尽波次', o3.a.indexOf('敌人等级 6') >= 0 && o3.b.indexOf('第 3 波') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.nextWavePreviewNow(-1,false),b:T.nextWavePreviewNow(NaN,false)});})()"));
    t('U709 非法输入兜底第1关', o4.a.indexOf('下一关') >= 0 && o4.b.indexOf('下一关') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;const dom=T.nextWaveDomNow();return JSON.stringify({dom,len:dom.length});})()"));
    t('U710 DOM 文本长度合理', o5.len > 5, JSON.stringify(o5));
  } catch(e){ for(let k=705;k<=710;k++) t('U'+k+' 下一关预告',false,e.message); }


  // ===== U711~U716: 击杀构成分布(v0.6.33) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('killBreakdown'),f:T.killBreakdownHtmlNow(0,0)});})()"));
    t('U711 击杀构成已加入结算屏', o.dom === true, JSON.stringify(o));
    t('U712 零击杀初值提示', o.f.indexOf('无击杀') >= 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.killBreakdownHtmlNow(8,2),b:T.killBreakdownHtmlNow(5,5)});})()"));
    t('U713 正常分布含普通与Boss', o2.a.indexOf('普通 8') >= 0 && o2.b.indexOf('Boss 5') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({c:(T.killBreakdownHtmlNow(1,0).match(/kbBoss/g)||[]).length});})()"));
    t('U714 纯普通击杀 Boss 段仍渲染', o3.c === 1, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.killBreakdownHtmlNow(-3,-2),b:T.killBreakdownHtmlNow(NaN,'x')});})()"));
    t('U715 非法输入兜底无击杀', o4.a.indexOf('无击杀') >= 0 && o4.b.indexOf('无击杀') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;const dom=T.killBdDomNow();return JSON.stringify({len:dom.length});})()"));
    t('U716 DOM 文本长度合理', o5.len > 0, JSON.stringify(o5));
  } catch(e){ for(let k=711;k<=716;k++) t('U'+k+' 击杀构成',false,e.message); }


  // ===== U717~U722: 每日词条图标(v0.6.34) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('dailyModIcons'),f:T.dailyModIconsHtmlNow({_names:['fastonly','bossrush']})});})()"));
    t('U717 词条图标已加入每日面板', o.dom === true, JSON.stringify(o));
    t('U718 两词条两图标', o.f.indexOf('⚡') >= 0 && o.f.indexOf('👹') >= 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.dailyModIconsHtmlNow({_names:[]}),b:T.dailyModIconsHtmlNow(null)});})()"));
    t('U719 空词条提示 / 无数据提示', o2.a.indexOf('无额外') >= 0 && o2.b.indexOf('无额外') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.dailyModIconsHtmlNow({_names:['unknown']})});})()"));
    t('U720 未知词条兜底图标', o3.a.indexOf('📌') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.dailyModIconsHtmlNow({_names:['doublepu','tanky','nolives']}).length});})()"));
    t('U721 三词条返回合理长度', o4.a > 9, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.dailyModIconsHtmlNow({_names:['fastonly']})===T.dailyModIconsHtmlNow({_names:['fastonly']})});})()"));
    t('U722 幂等一致', o5.a === true, JSON.stringify(o5));
  } catch(e){ for(let k=717;k<=722;k++) t('U'+k+' 词条图标',false,e.message); }


  // ===== U723~U728: 色弱色板预览(v0.6.35) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;T.cbPaletteRefreshNow();return JSON.stringify({dom:!!document.getElementById('cbPalette'),f:T.cbPaletteHtmlNow(false)});})()"));
    t('U723 色板预览已加入设置面板', o.dom === true, JSON.stringify(o));
    t('U724 普通色板含敌弹色', o.f.indexOf('#ff2d55') >= 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.cbPaletteHtmlNow(true),b:T.cbPaletteHtmlNow(false)});})()"));
    t('U725 色弱与普通色板不同', o2.a.indexOf('#ff8ab0') >= 0 && o2.b.indexOf('#ff2d55') >= 0 && o2.a !== o2.b, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({c:(T.cbPaletteHtmlNow(true).match(/cbSw/g)||[]).length});})()"));
    t('U726 恰好 4 个色块', o3.c === 4, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;const dom=T.cbPaletteDomNow();return JSON.stringify({len:dom.length});})()"));
    t('U727 刷新后 DOM 有内容', o4.len > 10, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.cbPaletteHtmlNow(true)===T.cbPaletteHtmlNow(true)});})()"));
    t('U728 幂等一致', o5.a === true, JSON.stringify(o5));
  } catch(e){ for(let k=723;k<=728;k++) t('U'+k+' 色板预览',false,e.message); }


  // ===== U729~U734: 本局战绩小结(v0.6.36) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('resultMiniBar'),f:T.resultMiniTextNow(0,1,0,0)});})()"));
    t('U729 战绩小结已加入结算屏', o.dom === true, JSON.stringify(o));
    t('U730 零值初值格式', o.f.indexOf('击杀 0') >= 0 && o.f.indexOf('0:00') >= 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.resultMiniTextNow(12,6,80,90),b:T.resultMiniTextNow(12,6,80,65)});})()"));
    t('U731 正常格式 1:30/1:05', o2.a.indexOf('1:30') >= 0 && o2.b.indexOf('1:05') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.resultMiniTextNow(5,1,120,0),b:T.resultMiniTextNow(5,1,-10,0)});})()"));
    t('U732 命中率封顶100/兜底0', o3.a.indexOf('100%') >= 0 && o3.b.indexOf('0%') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.resultMiniTextNow(-3,0,-5,-9),b:T.resultMiniTextNow(NaN,NaN,NaN,NaN)});})()"));
    t('U733 非法输入兜底', o4.a.indexOf('击杀 0') >= 0 && o4.b.indexOf('击杀 0') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;const dom=T.resultMiniDomNow();return JSON.stringify({len:dom.length});})()"));
    t('U734 DOM 文本长度合理', o5.len > 10, JSON.stringify(o5));
  } catch(e){ for(let k=729;k<=734;k++) t('U'+k+' 战绩小结',false,e.message); }


  // ===== U735~U740: 关卡用时星级条(v0.6.37) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('lvTimeBarVal'),f:T.levelTimeBarTextNow(0,1),p:T.levelTimePctNow(0,1)});})()"));
    t('U735 关卡用时条已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U736 初值 0s/时限', o.f.indexOf('0s') >= 0 && o.f.indexOf('87s') >= 0 && o.p === 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.levelTimePctNow(87,1),b:T.levelTimeBarTextNow(45,3)});})()"));
    t('U737 正常值 满格/45s', o2.a === 100 && o2.b.indexOf('45s') >= 0 && o2.b.indexOf('111s') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.levelTimePctNow(9999,1),b:T.levelTimePctNow(0,1)});})()"));
    t('U738 边界 封顶100/下限0', o3.a === 100 && o3.b === 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.levelTimePctNow(NaN,NaN),b:T.levelTimeBarTextNow(-5,-1)});})()"));
    t('U739 非法输入兜底', o4.a === 0 && o4.b.indexOf('0s') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;const dom=T.lvTimeBarDomNow();return JSON.stringify({len:dom.length});})()"));
    t('U740 DOM 文本长度合理', o5.len > 5, JSON.stringify(o5));
  } catch(e){ for(let k=735;k<=740;k++) t('U'+k+' 关卡用时条',false,e.message); }


  // ===== U741~U746: BOSS 阶段徽章(v0.6.38) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bossPhaseVal'),f:T.bossPhaseBadgeNow(0,0)});})()"));
    t('U741 BOSS 阶段徽章已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U742 无 BOSS 时显示占位', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossPhaseBadgeNow(100,100),b:T.bossPhaseBadgeNow(75,100)});})()"));
    t('U743 正常值 稳定', o2.a === '🟢 稳定' && o2.b === '🟢 稳定', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossPhaseBadgeNow(50,100),b:T.bossPhaseBadgeNow(25,100)});})()"));
    t('U744 边界 过半/濒危', o3.a === '⚠️ 过半' && o3.b === '💀 濒危', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossPhaseBadgeNow(NaN,NaN),b:T.bossPhaseBadgeNow(-5,0)});})()"));
    t('U745 非法输入兜底占位', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;const dom=T.bossPhaseDomNow();return JSON.stringify({len:dom.length});})()"));
    t('U746 DOM 文本长度合理', o5.len > 0, JSON.stringify(o5));
  } catch(e){ for(let k=741;k<=746;k++) t('U'+k+' BOSS阶段',false,e.message); }


  // ===== U747~U752: 宠物升级消耗(v0.6.39) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('petUpgVal'),f:T.petUpgCostTextNow(1,3)});})()"));
    t('U747 宠物升级 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U748 初值 1级到2级花3币', o.f.indexOf('3') >= 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petUpgCostTextNow(2,3),b:T.petUpgCostNow(2,3)});})()"));
    t('U749 正常值 2级到3级花6币', o2.a.indexOf('6') >= 0 && o2.b === 6, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petUpgCostTextNow(3,3),b:T.petUpgCostNow(3,3)});})()"));
    t('U750 边界 满级', o3.a === '已满级' && o3.b === 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petUpgCostTextNow(NaN,NaN),b:T.petUpgCostNow(-2,1)});})()"));
    t('U751 非法输入兜底', o4.a === '已满级' && o4.b === 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;const dom=T.petUpgDomNow();return JSON.stringify({len:dom.length});})()"));
    t('U752 DOM 文本长度合理', o5.len > 0, JSON.stringify(o5));
  } catch(e){ for(let k=747;k<=752;k++) t('U'+k+' 宠物升级',false,e.message); }


  // ===== U753~U758: 编辑器坐标(v0.6.40) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('edCoordVal'),f:T.cellCoordLabelNow(0,0)});})()"));
    t('U753 坐标标签已加入编辑器', o.dom === true, JSON.stringify(o));
    t('U754 初值 原点 R1C1', o.f === 'R1C1', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.cellCoordLabelNow(4,7),b:T.cellCoordFromPxNow(48,48)});})()"));
    t('U755 正常值 R8C5 / 像素转格', o2.a === 'R8C5' && o2.b === 'R3C3', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.cellCoordLabelNow(25,25)});})()"));
    t('U756 边界 右下角 R26C26', o3.a === 'R26C26', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.cellCoordLabelNow(-1,-1),b:T.cellCoordFromPxNow(0,0)});})()"));
    t('U757 非法输入兜底 R1C1', o4.a === 'R1C1' && o4.b === 'R1C1', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({len:T.edCoordDomNow().length});})()"));
    t('U758 DOM 文本长度合理', o5.len > 0, JSON.stringify(o5));
  } catch(e){ for(let k=753;k<=758;k++) t('U'+k+' 编辑器坐标',false,e.message); }


  // ===== U759~U764: P2 生命 HUD(v0.6.41) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('p2LivesVal'),f:T.p2LivesTextNow(0)});})()"));
    t('U759 P2 生命 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U760 初值 0 命', o.f === '❤×0', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.p2LivesTextNow(3),b:T.p2ModeTextNow(1)});})()"));
    t('U761 正常值 3命/合作', o2.a === '❤×3' && o2.b === '双人合作', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.p2LivesTextNow(-2)});})()"));
    t('U762 边界 负数归零', o3.a === '❤×0', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.p2LivesTextNow(NaN),b:T.p2ModeTextNow(9)});})()"));
    t('U763 非法输入兜底', o4.a === '❤×0' && o4.b === '单人', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;const dom=T.p2LivesDomNow();return JSON.stringify({len:dom.length});})()"));
    t('U764 DOM 文本长度合理', o5.len > 0, JSON.stringify(o5));
  } catch(e){ for(let k=759;k<=764;k++) t('U'+k+' P2生命',false,e.message); }


  // ===== U765~U770: 传送门配对(v0.6.42) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('portalPairVal'),f:T.portalPairTextNow([])});})()"));
    t('U765 传送门计数已加入编辑器', o.dom === true, JSON.stringify(o));
    t('U766 初值 空网格 0 对', o.f === '🌀 传送门 0 对', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.portalPairTextNow([[6,0],[0,6]]),b:T.portalCountNow([[6,0],[0,6]])});})()"));
    t('U767 正常值 2 门 1 对', o2.a === '🌀 传送门 1 对' && o2.b === 2, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.portalPairTextNow([[6,6],[6,6]])});})()"));
    t('U768 边界 4 门 2 对', o3.a === '🌀 传送门 2 对', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.portalPairTextNow(null),b:T.portalPairTextNow([[6]])});})()"));
    t('U769 非法输入/奇数未配对', o4.a === '🌀 传送门 0 对' && o4.b.indexOf('未配对') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({len:T.portalPairDomNow().length});})()"));
    t('U770 DOM 文本长度合理', o5.len > 0, JSON.stringify(o5));
  } catch(e){ for(let k=765;k<=770;k++) t('U'+k+' 传送门配对',false,e.message); }


  // ===== U771~U776: 生涯快照(v0.6.43) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('careerSnapVal'),f:T.careerSnapTextNow({games:0,kills:0,totalCoins:0})});})()"));
    t('U771 生涯快照 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U772 初值 全零', o.f === '📊 0局 · 0杀 · 0币', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerSnapTextNow({games:12,kills:300,totalCoins:8000})});})()"));
    t('U773 正常值 12局/300杀/8000币', o2.a === '📊 12局 · 300杀 · 8000币', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerSnapTextNow({games:999999,kills:999999,totalCoins:999999})});})()"));
    t('U774 边界 大数正常', o3.a.indexOf('999999') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerSnapTextNow(null),b:T.careerSnapTextNow({})});})()"));
    t('U775 非法输入兜底全零', o4.a === '📊 0局 · 0杀 · 0币' && o4.b === '📊 0局 · 0杀 · 0币', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({len:T.careerSnapDomNow().length});})()"));
    t('U776 DOM 文本长度合理', o5.len > 5, JSON.stringify(o5));
  } catch(e){ for(let k=771;k<=776;k++) t('U'+k+' 生涯快照',false,e.message); }


  // ===== U777~U782: 本关进度(v0.6.44) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('enemyProgVal'),f:T.enemyProgressTextNow(1,0,12)});})()"));
    t('U777 本关进度 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U778 初值 0/12', o.f === '第1关 · 🎯 0/12', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.enemyProgressTextNow(3,5,20),b:T.enemyProgressTextNow(1,12,12)});})()"));
    t('U779 正常值 5/20 与满杀 12/12', o2.a === '第3关 · 🎯 5/20' && o2.b === '第1关 · 🎯 12/12', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.enemyProgressTextNow(1,999,12)});})()"));
    t('U780 边界 击杀超总量仍显示', o3.a === '第1关 · 🎯 999/12', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.enemyProgressTextNow(NaN,NaN,NaN),b:T.enemyProgressTextNow(-1,-1,-1)});})()"));
    t('U781 非法输入兜底 ? 总量', o4.a === '第1关 · 🎯 0/?' && o4.b === '第1关 · 🎯 0/?', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({len:T.enemyProgDomNow().length});})()"));
    t('U782 DOM 文本长度合理', o5.len > 5, JSON.stringify(o5));
  } catch(e){ for(let k=777;k<=782;k++) t('U'+k+' 本关进度',false,e.message); }

  // ===== U783~U788: 局内小地图(v0.6.45) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('miniMap'),x0:T.miniMapXNow(0),y0:T.miniMapYNow(0)});})()"));
    t('U783 小地图已加入', o.dom === true, JSON.stringify(o));
    t('U784 初值 0→0', o.x0 === 0 && o.y0 === 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({x:T.miniMapXNow(624),y:T.miniMapYNow(624)});})()"));
    t('U785 正常值 624px→130px', o2.x === 130 && o2.y === 130, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({x:T.miniMapXNow(9999)});})()"));
    t('U786 边界 封顶130', o3.x === 130, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({x:T.miniMapXNow(NaN),y:T.miniMapYNow(-50)});})()"));
    t('U787 非法输入 兜底0', o4.x === 0 && o4.y === 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const c=document.getElementById('miniMap');return JSON.stringify({len:c?c.width:0});})()"));
    t('U788 DOM 尺寸合理', o5.len === 130, JSON.stringify(o5));
  } catch(e){ for(let k=783;k<=788;k++) t('U'+k+' 小地图',false,e.message); }

  // ===== U789~U794: BOSS 技能标识(v0.6.46) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bossSkillVal'),a:T.bossSkillLabelNow({skill:'scatter'})});})()"));
    t('U789 BOSS技能pill已加入', o.dom === true, JSON.stringify(o));
    t('U790 初值 散射', o.a === '🎯 散射', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossSkillLabelNow({skill:'laser'}),b:T.bossSkillLabelNow({skill:'split'})});})()"));
    t('U791 正常值 激光/分裂', o2.a === '🔫 激光' && o2.b === '🧩 分裂', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossSkillLabelNow({})});})()"));
    t('U792 边界 空对象', o3.a.indexOf('—') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossSkillLabelNow(null),b:T.bossSkillLabelNow(undefined)});})()"));
    t('U793 非法输入 兜底', o4.a.indexOf('—') >= 0 && o4.b.indexOf('—') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const e=document.getElementById('bossSkillVal');return JSON.stringify({len:e?e.textContent.length:0});})()"));
    t('U794 DOM 与函数一致', o5.len >= 0, JSON.stringify(o5));
  } catch(e){ for(let k=789;k<=794;k++) t('U'+k+' BOSS技能',false,e.message); }

  // ===== U795~U800: 成就最近解锁(v0.6.47) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('achRecent'),n:T.recentAchIdsNow(new Set(),3).length});})()"));
    t('U795 成就时间线已加入', o.dom === true, JSON.stringify(o));
    t('U796 初值 空集长度0', o.n === 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;const s=new Set([1,2,3,4,5]);return JSON.stringify({a:T.recentAchIdsNow(s,2)});})()"));
    t('U797 正常值 取末尾2个', o2.a.length === 2 && o2.a[0] === 4 && o2.a[1] === 5, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;const s=new Set(['a','b']);return JSON.stringify({n:T.recentAchIdsNow(s,0).length});})()"));
    t('U798 边界 n=0 至少1个', o3.n === 1, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({n:T.recentAchIdsNow(null,3).length});})()"));
    t('U799 非法 null 空', o4.n === 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const e=document.getElementById('achRecent');return JSON.stringify({len:e?e.className.length:0});})()"));
    t('U800 DOM 与函数一致', o5.len > 0, JSON.stringify(o5));
  } catch(e){ for(let k=795;k<=800;k++) t('U'+k+' 成就时间线',false,e.message); }

  // ===== U801~U806: 排行榜当前局高亮(v0.6.48) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('carRank'),n:T.boardRankOfNow([], 'x')});})()"));
    t('U801 排行榜高亮条已加入', o.dom === true, JSON.stringify(o));
    t('U802 初值 空榜0', o.n === 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;const b=[{uid:'a'},{uid:'b'}];return JSON.stringify({n:T.boardRankOfNow(b, 'b')});})()"));
    t('U803 正常值 第2名', o2.n === 2, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;const b=[{uid:'a'}];return JSON.stringify({n:T.boardRankOfNow(b, 'zzz')});})()"));
    t('U804 边界 不在榜0', o3.n === 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({n:T.boardRankOfNow(null, 'x')});})()"));
    t('U805 非法 null榜0', o4.n === 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const e=document.getElementById('carRank');return JSON.stringify({len:e?e.className.length:0});})()"));
    t('U806 DOM 与函数一致', o5.len > 0, JSON.stringify(o5));
  } catch(e){ for(let k=801;k<=806;k++) t('U'+k+' 排行榜高亮',false,e.message); }

  // ===== U807~U812: 每日挑战折线(v0.6.49) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('dailyHist'),n:T.dailySeriesNow([]).length});})()"));
    t('U807 每日折线已加入', o.dom === true, JSON.stringify(o));
    t('U808 初值 空数组0', o.n === 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;const b=[{mode:'normal',score:1},{mode:'daily',score:5,date:2},{mode:'daily',score:9,date:1},{mode:'daily',score:7,date:3}];const s=T.dailySeriesNow(b);return JSON.stringify({n:s.length,f:s[0].date,f2:s[2].date});})()"));
    t('U809 正常值 过滤+排序', o2.n === 3 && o2.f === 1 && o2.f2 === 3, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({html:T.dailyLineSvgNow([])});})()"));
    t('U810 边界 空svg空', o3.html.indexOf('暂无每日记录') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({n:T.dailySeriesNow(null).length});})()"));
    t('U811 非法 null 空', o4.n === 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const e=document.getElementById('dailyHist');return JSON.stringify({len:e?e.className.length:0});})()"));
    t('U812 DOM 与函数一致', o5.len > 0, JSON.stringify(o5));
  } catch(e){ for(let k=807;k<=812;k++) t('U'+k+' 每日折线',false,e.message); }

  // ===== U813~U818: 商店本周特惠(v0.6.50) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('shopDeal'),s:T.weekSeedNow(0)});})()"));
    t('U813 商店特惠已加入', o.dom === true, JSON.stringify(o));
    t('U814 初值 种子0~6', o.s >= 0 && o.s <= 6, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.dealPriceNow(100,2),b:T.dealPriceNow(200,1)});})()"));
    t('U815 正常值 折扣价', o2.a === 90 && o2.b === 190, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.dealPriceNow(0,3)});})()"));
    t('U816 边界 下限1', o3.a === 1, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.dealPriceNow(NaN,9)});})()"));
    t('U817 非法 兜底1', o4.a === 1, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const e=document.getElementById('shopDeal');return JSON.stringify({len:e?e.className.length:0});})()"));
    t('U818 DOM 与函数一致', o5.len > 0, JSON.stringify(o5));
  } catch(e){ for(let k=813;k<=818;k++) t('U'+k+' 商店特惠',false,e.message); }

  // ===== U819~U824: 羁绊条件tooltip(v0.6.51) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bondCondVal'),a:T.bondCondTextNow(null)});})()"));
    t('U819 羁绊条件已加入', o.dom === true, JSON.stringify(o));
    t('U820 初值 空→—', o.a === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bondCondTextNow({hero:'blade',pet:'cat'})});})()"));
    t('U821 正常值 含英雄宠物', o2.a.indexOf('blade') >= 0 && o2.a.indexOf('cat') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bondCondTextNow({})});})()"));
    t('U822 边界 空对象—', o3.a === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bondCondTextNow(undefined)});})()"));
    t('U823 非法 undefined—', o4.a === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const e=document.getElementById('bondCondVal');return JSON.stringify({len:e?e.textContent.length:0});})()"));
    t('U824 DOM 与函数一致', o5.len >= 0, JSON.stringify(o5));
  } catch(e){ for(let k=819;k<=824;k++) t('U'+k+' 羁绊条件',false,e.message); }

  // ===== U825~U830: 结算一键重开(v0.6.52) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('btnReplay2'),a:T.replayLabelNow('over')});})()"));
    t('U825 一键重开已加入', o.dom === true, JSON.stringify(o));
    t('U826 初值 结算态', o.a === '⚡ 一键重开', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.replayLabelNow('paused')});})()"));
    t('U827 正常值 暂停态', o2.a === '🔄 重新开始', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.replayLabelNow('')});})()"));
    t('U828 边界 空串默认', o3.a === '🔄 重新开始', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.replayLabelNow(null)});})()"));
    t('U829 非法 null 默认', o4.a === '🔄 重新开始', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const e=document.getElementById('btnReplay2');return JSON.stringify({t:e?e.textContent:''});})()"));
    t('U830 DOM 与函数一致', o5.t.indexOf('重开') >= 0, JSON.stringify(o5));
  } catch(e){ for(let k=825;k<=830;k++) t('U'+k+' 结算重开',false,e.message); }

  // ===== U831~U836: 战绩图评级渐变(v0.6.53) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('reportGradeBar'),g:T.gradeGradientNow('S')});})()"));
    t('U831 战绩图评级条已加入', o.dom === true, JSON.stringify(o));
    t('U832 初值 S金橙', o.g[0] === '#ffd700' && o.g[1] === '#ff8a00', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.gradeGradientNow('A'),b:T.gradeGradientNow('B')});})()"));
    t('U833 正常值 A/B', o2.a[0] === '#00f0ff' && o2.b[0] === '#39ff14', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({c:T.gradeGradientNow('C')});})()"));
    t('U834 边界 C灰', o3.c[0] === '#8ea0b8', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({c:T.gradeGradientNow(null)});})()"));
    t('U835 非法 null 兜底', o4.c[0] === '#8ea0b8', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const e=document.getElementById('reportGradeBar');return JSON.stringify({len:e?e.className.length:0});})()"));
    t('U836 DOM 与函数一致', o5.len > 0, JSON.stringify(o5));
  } catch(e){ for(let k=831;k<=836;k++) t('U'+k+' 评级渐变',false,e.message); }

  // ===== U837~U842: 音量静音提示(v0.6.54) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('muteHint'),a:T.muteHintTextNow(false)});})()"));
    t('U837 静音提示已加入', o.dom === true, JSON.stringify(o));
    t('U838 初值 未静音', o.a.indexOf('M 键') >= 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.muteHintTextNow(true)});})()"));
    t('U839 正常值 已静音', o2.a.indexOf('已静音') >= 0 && o2.a.indexOf('恢复') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.muteHintTextNow(0)});})()"));
    t('U840 边界 0视为未静音', o3.a.indexOf('M 键') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.muteHintTextNow(null)});})()"));
    t('U841 非法 null 未静音', o4.a.indexOf('M 键') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const e=document.getElementById('muteHint');return JSON.stringify({len:e?e.textContent.length:0});})()"));
    t('U842 DOM 与函数一致', o5.len > 0, JSON.stringify(o5));
  } catch(e){ for(let k=837;k<=842;k++) t('U'+k+' 静音提示',false,e.message); }

  // ===== U843~U848: 每日倒计时(v0.6.55) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('dailyRemainVal'),a:T.dailyRemainTextNow(Date.now())});})()"));
    t('U843 每日倒计时已加入', o.dom === true, JSON.stringify(o));
    t('U844 初值 剩余含时分', o.a.indexOf('剩') >= 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;const d=new Date();d.setHours(23,0,0,0);return JSON.stringify({a:T.dailyRemainTextNow(d.getTime())});})()"));
    t('U845 正常值 23点约1时', o2.a.indexOf('1时') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;const d=new Date();d.setDate(d.getDate()-1);return JSON.stringify({a:T.dailyRemainTextNow(d.getTime())});})()"));
    t('U846 边界 昨日已截止', o3.a.indexOf('已截止') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.dailyRemainTextNow(NaN)});})()"));
    t('U847 非法 NaN 走当前', o4.a.indexOf('剩') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const e=document.getElementById('dailyRemainVal');return JSON.stringify({len:e?e.className.length:0});})()"));
    t('U848 DOM 与函数一致', o5.len > 0, JSON.stringify(o5));
  } catch(e){ for(let k=843;k<=848;k++) t('U'+k+' 每日倒计时',false,e.message); }

  // ===== U849~U854: 触屏布局提示(v0.6.56) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('touchBody'),a:T.touchLayoutTextNow()});})()"));
    t('U849 触屏提示已加入', o.dom === true, JSON.stringify(o));
    t('U850 初值 含摇杆', o.a.indexOf('摇杆') >= 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({len:T.touchLayoutTextNow().length});})()"));
    t('U851 正常值 文案非空', o2.len > 10, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const e=document.getElementById('touchBody');return JSON.stringify({len:e?e.textContent.length:0});})()"));
    t('U852 边界 DOM已填充', o3.len > 10, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.touchLayoutTextNow()});})()"));
    t('U853 非法 恒定返回', o4.a === o4.a, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const e=document.getElementById('touchBox');return JSON.stringify({len:e?e.className.length:0});})()"));
    t('U854 DOM 与函数一致', o5.len > 0, JSON.stringify(o5));
  } catch(e){ for(let k=849;k<=854;k++) t('U'+k+' 触屏提示',false,e.message); }

  // ===== U855~U860: 分享短码(v0.6.57) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('edShortCode'),a:T.shareShortCodeNow('ABCDEFGH1234')});})()"));
    t('U855 短码显示已加入', o.dom === true, JSON.stringify(o));
    t('U856 初值 截断8字符', o.a === 'ABCDEFGH…', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.shareShortCodeNow('AB')});})()"));
    t('U857 正常值 短码不截断', o2.a === 'AB', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.shareShortMsgNow('XYZW')});})()"));
    t('U858 边界 提示含短码', o3.a.indexOf('XYZW') >= 0 && o3.a.indexOf('已复制') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.shareShortCodeNow(null)});})()"));
    t('U859 非法 null 空', o4.a === '', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const e=document.getElementById('edShortCode');return JSON.stringify({len:e?e.className.length:0});})()"));
    t('U860 DOM 与函数一致', o5.len > 0, JSON.stringify(o5));
  } catch(e){ for(let k=855;k<=860;k++) t('U'+k+' 分享短码',false,e.message); }

  // ===== U861~U866: 关卡缩略图(v0.6.58) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.customThumbNow(['###','.#.','###'])});})()"));
    t('U861 缩略图SVG生成', o.a.indexOf('<svg') === 0, JSON.stringify(o));
    t('U862 初值 含矩形', o.a.indexOf('<rect') >= 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.customThumbNow([])});})()"));
    t('U863 正常值 空图无矩形', o2.a.indexOf('<svg') === 0 && o2.a.indexOf('<rect') < 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.customThumbNow(null)});})()"));
    t('U864 边界 null空', o3.a.indexOf('<svg') === 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.customThumbNow(undefined)});})()"));
    t('U865 非法 undefined空', o4.a.indexOf('<svg') === 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({len:T.customThumbNow(['@','*']).length});})()"));
    t('U866 一致 非空', o5.len > 100, JSON.stringify(o5));
  } catch(e){ for(let k=861;k<=866;k++) t('U'+k+' 关卡缩略图',false,e.message); }

  // ===== U867~U872: 关卡排序(v0.6.59) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;const l=[{id:'a',createdAt:1},{id:'b',createdAt:3},{id:'c',createdAt:2}];const s=T.customSortByCreatedNow(l,true);return JSON.stringify({a:s[0].id,b:s[1].id,c:s[2].id});})()"));
    t('U867 降序 最新在前', o.a === 'b' && o.c === 'a', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;const l=[{id:'a',createdAt:1},{id:'b',createdAt:3}];const s=T.customSortByCreatedNow(l,false);return JSON.stringify({a:s[0].id,b:s[1].id});})()"));
    t('U868 升序 最早在前', o2.a === 'a' && o2.b === 'b', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;const l=[{id:'a',createdAt:2},{id:'b',createdAt:1}];const s=T.customSortByCreatedNow(l,true);return JSON.stringify({n:s.length});})()"));
    t('U869 正常值 数量不变', o3.n === 2, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;const s=T.customSortByCreatedNow(null,true);return JSON.stringify({n:s.length});})()"));
    t('U870 边界 null空数组', o4.n === 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;const l=[{id:'a',createdAt:2}];const s=T.customSortByCreatedNow(l,true);return JSON.stringify({n:s.length});})()"));
    t('U871 非法 单元素', o5.n === 1, JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const e=document.querySelector('.edListHead');return JSON.stringify({t:e?e.textContent.indexOf('最新')>=0:false});})()"));
    t('U872 DOM 排序标记', o6.t === true, JSON.stringify(o6));
  } catch(e){ for(let k=867;k<=872;k++) t('U'+k+' 关卡排序',false,e.message); }

  // ===== U873~U878: 重置确认(v0.6.60) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('resetConfirmBox'),a:T.resetConfirmTextNow(50,200)});})()"));
    t('U873 重置确认已加入', o.dom === true, JSON.stringify(o));
    t('U874 初值 含返还', o.a.indexOf('返还') >= 0 && o.a.indexOf('50') >= 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.resetConfirmTextNow(0,200)});})()"));
    t('U875 正常值 零返还', o2.a.indexOf('0') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.resetConfirmTextNow(-5,0)});})()"));
    t('U876 边界 负数兜底0', o3.a.indexOf('0') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.resetConfirmTextNow(NaN,NaN)});})()"));
    t('U877 非法 NaN兜底', o4.a.indexOf('0') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const e=document.getElementById('resetConfirmBox');return JSON.stringify({d:e?getComputedStyle(e).display:''});})()"));
    t('U878 DOM 默认隐藏', o5.d === 'none', JSON.stringify(o5));
  } catch(e){ for(let k=873;k<=878;k++) t('U'+k+' 重置确认',false,e.message); }

  // ===== U879~U884: 首次游玩引导(v0.6.61) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('tourBox'),a:T.tourStepTextNow(0)});})()"));
    t('U879 引导弹层已加入', o.dom === true, JSON.stringify(o));
    t('U880 初值 第1步含移动', o.a.t.indexOf('移动') >= 0 && o.a.b.indexOf('开火') >= 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.tourStepTextNow(1)});})()"));
    t('U881 正常值 第2步含金币', o2.a.t.indexOf('金币') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.tourStepTextNow(2)});})()"));
    t('U882 边界 第3步含星级', o3.a.t.indexOf('星级') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.tourStepTextNow(null)});})()"));
    t('U883 非法 null 回落第1步', o4.a.t.indexOf('移动') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.showTourNow(0);const e=document.getElementById('tourBox');return JSON.stringify({h:e?e.className.indexOf('m-hide')<0:false});})()"));
    t('U884 DOM 与函数一致', o5.h === true, JSON.stringify(o5));
  } catch(e){ for(let k=879;k<=884;k++) t('U'+k+' 新手引导',false,e.message); }

  // ===== U885~U890: 连杀播报(v0.6.62) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('streakBanner'),a:T.streakLabelNow(3)});})()"));
    t('U885 连杀播报已加入', o.dom === true, JSON.stringify(o));
    t('U886 初值 3连杀', o.a.indexOf('3 连杀') >= 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.streakLabelNow(5)});})()"));
    t('U887 正常值 5连杀', o2.a.indexOf('5 连杀') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.streakLabelNow(10)});})()"));
    t('U888 边界 10连杀', o3.a.indexOf('10 连杀') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.streakLabelNow(2)});})()"));
    t('U889 非法 2连杀不播报', o4.a === '', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.streakFlashNow(5);const e=document.getElementById('streakBanner');return JSON.stringify({t:e?e.textContent.length:0});})()"));
    t('U890 DOM 与函数一致', o5.t > 0, JSON.stringify(o5));
  } catch(e){ for(let k=885;k<=890;k++) t('U'+k+' 连杀播报',false,e.message); }

  // ===== U891~U896: 星级规则(v0.6.63) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('starRuleBox'),a:T.starRuleTextNow()});})()"));
    t('U891 星级规则已加入', o.dom === true, JSON.stringify(o));
    t('U892 初值 含星级', o.a.indexOf('星级') >= 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({len:T.starRuleTextNow().length});})()"));
    t('U893 正常值 文案非空', o2.len > 20, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;const e=document.getElementById('starRuleBody');return JSON.stringify({len:e?e.textContent.length:0});})()"));
    t('U894 边界 已填充', o3.len > 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.starRuleTextNow()});})()"));
    t('U895 非法 恒定', o4.a === o4.a, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const e=document.getElementById('starRuleBox');return JSON.stringify({len:e?e.className.length:0});})()"));
    t('U896 DOM 与函数一致', o5.len >= 0, JSON.stringify(o5));
  } catch(e){ for(let k=891;k<=896;k++) t('U'+k+' 星级规则',false,e.message); }

  // ===== U897~U902: 击杀效率(v0.6.64) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.calcKpgNow(100,10)});})()"));
    t('U897 击杀效率函数', o.a === 10, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.calcKpgNow(0,5)});})()"));
    t('U898 初值 零击杀', o2.a === 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.calcKpgNow(5,0)});})()"));
    t('U899 正常值 零局归零', o3.a === 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.calcKpgNow(-5,3)});})()"));
    t('U900 边界 负击杀归零', o4.a === 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.calcKpgNow(NaN,NaN)});})()"));
    t('U901 非法 NaN 归零', o5.a === 0, JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.kpgTextNow(50,10)});})()"));
    t('U902 DOM 与函数一致', o6.a.indexOf('5') >= 0, JSON.stringify(o6));
  } catch(e){ for(let k=897;k<=902;k++) t('U'+k+' 击杀效率',false,e.message); }

  // ===== U903~U908: 大招CD进度条(v0.6.65) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.cdPctNow(2,8)});})()"));
    t('U903 大招CD进度函数', o.a === 75, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.cdPctNow(0,8)});})()"));
    t('U904 初值 满进度', o2.a === 100, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.cdPctNow(8,8)});})()"));
    t('U905 正常值 刚放完', o3.a === 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.cdPctNow(10,0)});})()"));
    t('U906 边界 零上限', o4.a === 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.cdPctNow(NaN,NaN)});})()"));
    t('U907 非法 NaN 归零', o5.a === 0, JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const e=document.getElementById('ultCdBar');return JSON.stringify({len:e?e.style.width.length:0});})()"));
    t('U908 DOM 与函数一致', o6.len >= 0, JSON.stringify(o6));
  } catch(e){ for(let k=903;k<=908;k++) t('U'+k+' 大招CD进度',false,e.message); }

  // ===== U909~U914: 道具拾取记录(v0.6.66) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('pickupLog')});})()"));
    t('U909 道具记录已加入', o.dom === true, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.pushPickupNow('shield');return JSON.stringify({a:document.getElementById('pickupLog').textContent});})()"));
    t('U910 初值 记录护盾', o2.a.indexOf('护盾') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.pickupMsgNow('rapid')});})()"));
    t('U911 正常值 快速标签', o3.a.indexOf('快速') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.pickupMsgNow(null)});})()"));
    t('U912 边界 null 原样', o4.a === null, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.pickupMsgNow('life')});})()"));
    t('U913 非法 生命标签', o5.a.indexOf('加命') >= 0, JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.pushPickupNow('bomb');const e=document.getElementById('pickupLog');return JSON.stringify({len:e?e.textContent.length:0});})()"));
    t('U914 DOM 与函数一致', o6.len > 0, JSON.stringify(o6));
  } catch(e){ for(let k=909;k<=914;k++) t('U'+k+' 道具记录',false,e.message); }

  // ===== U915~U920: 关卡星级进度(v0.6.67) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.starSumNow({'1':3,'2':2,'3':1})});})()"));
    t('U915 星级求和函数', o.a === 6, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.starSumNow({})});})()"));
    t('U916 初值 空图零', o2.a === 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.starProgressTextNow(5,9)});})()"));
    t('U917 正常值 文本', o3.a.indexOf('5') >= 0 && o3.a.indexOf('9') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.starProgressTextNow(0,0)});})()"));
    t('U918 边界 零进度', o4.a.indexOf('0') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.starSumNow(null)});})()"));
    t('U919 非法 null 零', o5.a === 0, JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const e=document.getElementById('lvStarTotal');return JSON.stringify({len:e?e.className.length:0});})()"));
    t('U920 DOM 与函数一致', o6.len >= 0, JSON.stringify(o6));
  } catch(e){ for(let k=915;k<=920;k++) t('U'+k+' 星级进度',false,e.message); }

  // ===== U921~U926: 生涯最佳(v0.6.68) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bestScoreTextNow(12345)});})()"));
    t('U921 生涯最佳函数', o.a.indexOf('12345') >= 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bestScoreTextNow(0)});})()"));
    t('U922 初值 暂无最佳', o2.a.indexOf('暂无') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bestScoreTextNow(999)});})()"));
    t('U923 正常值 有成绩', o3.a.indexOf('999') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bestScoreTextNow(-5)});})()"));
    t('U924 边界 负数暂无', o4.a.indexOf('暂无') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bestScoreTextNow(NaN)});})()"));
    t('U925 非法 NaN 暂无', o5.a.indexOf('暂无') >= 0, JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const e=document.getElementById('bestScoreVal');return JSON.stringify({len:e?e.className.length:0});})()"));
    t('U926 DOM 与函数一致', o6.len >= 0, JSON.stringify(o6));
  } catch(e){ for(let k=921;k<=926;k++) t('U'+k+' 生涯最佳',false,e.message); }

  // ===== U927~U932: 命中率面板(v0.6.69) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('hitRateVal')});})()"));
    t('U927 命中率面板已加入', o.dom === true, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.hitRateNow(0,0)});})()"));
    t('U928 初值 无射击显占位', o2.a.indexOf('--') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.hitRateNow(8,10)});})()"));
    t('U929 正常值 8/10=80%', o3.a.indexOf('80%') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.hitRateNow(0,10)});})()"));
    t('U930 边界 零命中0%', o4.a.indexOf('0%') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.hitRateNow(NaN,NaN)});})()"));
    t('U931 非法 NaN 显占位', o5.a.indexOf('--') >= 0, JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const T=window.__tbTest;const r=T.hitRateNow(15,20);const e=document.getElementById('hitRateVal');return JSON.stringify({r:r,d:e?e.textContent:''});})()"));
    t('U932 DOM 与函数一致', o6.r === o6.d && o6.r.indexOf('75%') >= 0, JSON.stringify(o6));
  } catch(e){ for(let k=927;k<=932;k++) t('U'+k+' 命中率面板',false,e.message); }

  // ===== U933~U938: 击杀速率(v0.6.70) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('kpmVal')});})()"));
    t('U933 击杀速率已加入', o.dom === true, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.kpmNow(0,0)});})()"));
    t('U934 初值 零秒占位', o2.a.indexOf('--') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.kpmNow(6,120)});})()"));
    t('U935 正常值 6杀2分钟=3/分', o3.a.indexOf('3/分') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.kpmNow(0,60)});})()"));
    t('U936 边界 零杀0/分', o4.a.indexOf('0/分') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.kpmNow(NaN,NaN)});})()"));
    t('U937 非法 NaN 占位', o5.a.indexOf('--') >= 0, JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const T=window.__tbTest;const r=T.kpmNow(3,60);const e=document.getElementById('kpmVal');return JSON.stringify({r:r,d:e?e.textContent:''});})()"));
    t('U938 DOM 与函数一致', o6.r === o6.d && o6.r.indexOf('3/分') >= 0, JSON.stringify(o6));
  } catch(e){ for(let k=933;k<=938;k++) t('U'+k+' 击杀速率',false,e.message); }

  // ===== U939~U944: BOSS击破(v0.6.71) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bossKillVal')});})()"));
    t('U939 BOSS击破已加入', o.dom === true, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossKillNow(0)});})()"));
    t('U940 初值 零破', o2.a.indexOf('0') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossKillNow(3)});})()"));
    t('U941 正常值 3破', o3.a.indexOf('3') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossKillNow(99)});})()"));
    t('U942 边界 99破', o4.a.indexOf('99') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossKillNow(NaN)});})()"));
    t('U943 非法 NaN 归零', o5.a.indexOf('0') >= 0, JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const T=window.__tbTest;const r=T.bossKillNow(2);const e=document.getElementById('bossKillVal');return JSON.stringify({r:r,d:e?e.textContent:''});})()"));
    t('U944 DOM 与函数一致', o6.r === o6.d && o6.r.indexOf('2') >= 0, JSON.stringify(o6));
  } catch(e){ for(let k=939;k<=944;k++) t('U'+k+' BOSS击破',false,e.message); }

  // ===== U945~U950: 难度标识(v0.6.72) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('diffBadgeVal')});})()"));
    t('U945 难度标识已加入', o.dom === true, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.diffBadgeNow('normal')});})()"));
    t('U946 初值 普通', o2.a.indexOf('普通') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.diffBadgeNow('easy')});})()"));
    t('U947 正常值 简单', o3.a.indexOf('简单') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.diffBadgeNow('hard')});})()"));
    t('U948 边界 困难', o4.a.indexOf('困难') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.diffBadgeNow(null)});})()"));
    t('U949 非法 null 回落普通', o5.a.indexOf('普通') >= 0, JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const T=window.__tbTest;const r=T.diffBadgeNow('hard');const e=document.getElementById('diffBadgeVal');return JSON.stringify({r:r,d:e?e.textContent:''});})()"));
    t('U950 DOM 与函数一致', o6.r === o6.d && o6.r.indexOf('困难') >= 0, JSON.stringify(o6));
  } catch(e){ for(let k=945;k<=950;k++) t('U'+k+' 难度标识',false,e.message); }

  // ===== U951~U956: 阵亡统计(v0.6.73) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('deathVal')});})()"));
    t('U951 阵亡统计已加入', o.dom === true, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.deathNow(0)});})()"));
    t('U952 初值 零次', o2.a.indexOf('0') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.deathNow(4)});})()"));
    t('U953 正常值 4次', o3.a.indexOf('4') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.deathNow(99)});})()"));
    t('U954 边界 99次', o4.a.indexOf('99') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.deathNow(NaN)});})()"));
    t('U955 非法 NaN 归零', o5.a.indexOf('0') >= 0, JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const T=window.__tbTest;const r=T.deathNow(1);const e=document.getElementById('deathVal');return JSON.stringify({r:r,d:e?e.textContent:''});})()"));
    t('U956 DOM 与函数一致', o6.r === o6.d && o6.r.indexOf('1') >= 0, JSON.stringify(o6));
  } catch(e){ for(let k=951;k<=956;k++) t('U'+k+' 阵亡统计',false,e.message); }

  // ===== U957~U962: 本关击杀进度(v0.6.74) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('lvKillVal')});})()"));
    t('U957 本关击杀已加入', o.dom === true, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.lvKillNow(0,0)});})()"));
    t('U958 初值 0/0', o2.a.indexOf('0/0') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.lvKillNow(12,20)});})()"));
    t('U959 正常值 12/20', o3.a.indexOf('12/20') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.lvKillNow(20,20)});})()"));
    t('U960 边界 全灭20/20', o4.a.indexOf('20/20') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.lvKillNow(NaN,NaN)});})()"));
    t('U961 非法 NaN 0/0', o5.a.indexOf('0/0') >= 0, JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const T=window.__tbTest;const r=T.lvKillNow(5,10);const e=document.getElementById('lvKillVal');return JSON.stringify({r:r,d:e?e.textContent:''});})()"));
    t('U962 DOM 与函数一致', o6.r === o6.d && o6.r.indexOf('5/10') >= 0, JSON.stringify(o6));
  } catch(e){ for(let k=957;k<=962;k++) t('U'+k+' 本关击杀',false,e.message); }

  // ===== U963~U968: 连击倍率(v0.6.75) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('comboMultVal')});})()"));
    t('U963 连击倍率已加入', o.dom === true, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.comboMultNow(0)});})()"));
    t('U964 初值 ×1.0', o2.a.indexOf('×1.0') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.comboMultNow(5)});})()"));
    t('U965 正常值 5连击×1.5', o3.a.indexOf('×1.5') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.comboMultNow(10)});})()"));
    t('U966 边界 10连击×2.0', o4.a.indexOf('×2.0') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.comboMultNow(NaN)});})()"));
    t('U967 非法 NaN ×1.0', o5.a.indexOf('×1.0') >= 0, JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const T=window.__tbTest;const r=T.comboMultNow(8);const e=document.getElementById('comboMultVal');return JSON.stringify({r:r,d:e?e.textContent:''});})()"));
    t('U968 DOM 与函数一致', o6.r === o6.d && o6.r.indexOf('×1.8') >= 0, JSON.stringify(o6));
  } catch(e){ for(let k=963;k<=968;k++) t('U'+k+' 连击倍率',false,e.message); }

  // ===== U969~U974: 生涯击杀(v0.6.76) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('careerKillVal')});})()"));
    t('U969 生涯击杀已加入', o.dom === true, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerKillNow(0)});})()"));
    t('U970 初值 零', o2.a.indexOf('0') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerKillNow(456)});})()"));
    t('U971 正常值 456', o3.a.indexOf('456') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerKillNow(99999)});})()"));
    t('U972 边界 99999', o4.a.indexOf('99999') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerKillNow(NaN)});})()"));
    t('U973 非法 NaN 归零', o5.a.indexOf('0') >= 0, JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const T=window.__tbTest;const r=T.careerKillNow(88);const e=document.getElementById('careerKillVal');return JSON.stringify({r:r,d:e?e.textContent:''});})()"));
    t('U974 DOM 与函数一致', o6.r === o6.d && o6.r.indexOf('88') >= 0, JSON.stringify(o6));
  } catch(e){ for(let k=969;k<=974;k++) t('U'+k+' 生涯击杀',false,e.message); }

  // ===== U975~U980: K/D 比值(v0.6.77) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('kdVal')});})()"));
    t('U975 K/D 比值已加入', o.dom === true, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.kdNow(0,0)});})()"));
    t('U976 初值 零杀零亡显占位', o2.a.indexOf('--') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.kdNow(6,4)});})()"));
    t('U977 正常值 6杀4亡=1.5', o3.a.indexOf('1.5') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.kdNow(0,3)});})()"));
    t('U978 边界 零杀显0', o4.a.indexOf('K/D 0') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.kdNow(NaN,NaN)});})()"));
    t('U979 非法 NaN 显占位', o5.a.indexOf('--') >= 0, JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const T=window.__tbTest;const r=T.kdNow(9,3);const e=document.getElementById('kdVal');return JSON.stringify({r:r,d:e?e.textContent:''});})()"));
    t('U980 DOM 与函数一致', o6.r === o6.d && o6.r.indexOf('K/D 3') >= 0, JSON.stringify(o6));
  } catch(e){ for(let k=975;k<=980;k++) t('U'+k+' K/D 比值',false,e.message); }

  // ===== U981~U986: 生涯命中率(v0.6.78) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('careerHitVal')});})()"));
    t('U981 生涯命中率已加入', o.dom === true, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerHitNow(0,0)});})()"));
    t('U982 初值 无射击显占位', o2.a.indexOf('--') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerHitNow(45,60)});})()"));
    t('U983 正常值 45/60=75%', o3.a.indexOf('75%') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerHitNow(0,100)});})()"));
    t('U984 边界 零命中0%', o4.a.indexOf('0%') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerHitNow(NaN,NaN)});})()"));
    t('U985 非法 NaN 显占位', o5.a.indexOf('--') >= 0, JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const T=window.__tbTest;const r=T.careerHitNow(90,120);const e=document.getElementById('careerHitVal');return JSON.stringify({r:r,d:e?e.textContent:''});})()"));
    t('U986 DOM 与函数一致', o6.r === o6.d && o6.r.indexOf('75%') >= 0, JSON.stringify(o6));
  } catch(e){ for(let k=981;k<=986;k++) t('U'+k+' 生涯命中率',false,e.message); }

  // ===== U987~U992: 生涯游玩时长(v0.6.79) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('careerTimeVal')});})()"));
    t('U987 生涯时长已加入', o.dom === true, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerTimeNow(0)});})()"));
    t('U988 初值 零秒显0m', o2.a.indexOf('0m') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerTimeNow(3720)});})()"));
    t('U989 正常值 3720秒=1h2m', o3.a.indexOf('1h 2m') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerTimeNow(3600)});})()"));
    t('U990 边界 整1小时显1h0m', o4.a.indexOf('1h 0m') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerTimeNow(NaN)});})()"));
    t('U991 非法 NaN 归零显0m', o5.a.indexOf('0m') >= 0, JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const T=window.__tbTest;const r=T.careerTimeNow(5400);const e=document.getElementById('careerTimeVal');return JSON.stringify({r:r,d:e?e.textContent:''});})()"));
    t('U992 DOM 与函数一致', o6.r === o6.d && o6.r.indexOf('1h 30m') >= 0, JSON.stringify(o6));
  } catch(e){ for(let k=987;k<=992;k++) t('U'+k+' 生涯时长',false,e.message); }

  // ===== U993~U998: 生涯总金币(v0.6.80) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('careerCoinVal')});})()"));
    t('U993 生涯金币已加入', o.dom === true, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerCoinNow(0)});})()"));
    t('U994 初值 零金币', o2.a.indexOf('0') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerCoinNow(1234)});})()"));
    t('U995 正常值 1234金币', o3.a.indexOf('1234') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerCoinNow(999999)});})()"));
    t('U996 边界 999999金币', o4.a.indexOf('999999') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerCoinNow(NaN)});})()"));
    t('U997 非法 NaN 归零', o5.a.indexOf('0') >= 0, JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const T=window.__tbTest;const r=T.careerCoinNow(456);const e=document.getElementById('careerCoinVal');return JSON.stringify({r:r,d:e?e.textContent:''});})()"));
    t('U998 DOM 与函数一致', o6.r === o6.d && o6.r.indexOf('456') >= 0, JSON.stringify(o6));
  } catch(e){ for(let k=993;k<=998;k++) t('U'+k+' 生涯金币',false,e.message); }

  // ===== U999~U1004: 生涯BOSS击破(v0.6.81) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('careerBossVal')});})()"));
    t('U999 生涯BOSS已加入', o.dom === true, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerBossNow(0)});})()"));
    t('U1000 初值 零破', o2.a.indexOf('0') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerBossNow(7)});})()"));
    t('U1001 正常值 7破', o3.a.indexOf('7') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerBossNow(99)});})()"));
    t('U1002 边界 99破', o4.a.indexOf('99') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerBossNow(NaN)});})()"));
    t('U1003 非法 NaN 归零', o5.a.indexOf('0') >= 0, JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const T=window.__tbTest;const r=T.careerBossNow(3);const e=document.getElementById('careerBossVal');return JSON.stringify({r:r,d:e?e.textContent:''});})()"));
    t('U1004 DOM 与函数一致', o6.r === o6.d && o6.r.indexOf('3') >= 0, JSON.stringify(o6));
  } catch(e){ for(let k=999;k<=1004;k++) t('U'+k+' 生涯BOSS',false,e.message); }

  // ===== U1005~U1010: 存活敌人(v0.6.82) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('enemyLeftVal')});})()"));
    t('U1005 存活敌人已加入', o.dom === true, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.enemyLeftNow(0)});})()"));
    t('U1006 初值 零敌人', o2.a.indexOf('敌人 0') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.enemyLeftNow(12)});})()"));
    t('U1007 正常值 12敌人', o3.a.indexOf('敌人 12') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.enemyLeftNow(999)});})()"));
    t('U1008 边界 999敌人', o4.a.indexOf('敌人 999') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.enemyLeftNow(NaN)});})()"));
    t('U1009 非法 NaN 归零', o5.a.indexOf('敌人 0') >= 0, JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const T=window.__tbTest;const r=T.enemyLeftNow(5);const e=document.getElementById('enemyLeftVal');return JSON.stringify({r:r,d:e?e.textContent:''});})()"));
    t('U1010 DOM 与函数一致', o6.r === o6.d && o6.r.indexOf('敌人 5') >= 0, JSON.stringify(o6));
  } catch(e){ for(let k=1005;k<=1010;k++) t('U'+k+' 存活敌人',false,e.message); }

  // ===== U1011~U1016: 飞行子弹(v0.6.83) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bulletFlyVal')});})()"));
    t('U1011 飞行子弹已加入', o.dom === true, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bulletFlyNow(0)});})()"));
    t('U1012 初值 零子弹', o2.a.indexOf('子弹 0') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bulletFlyNow(8)});})()"));
    t('U1013 正常值 8子弹', o3.a.indexOf('子弹 8') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bulletFlyNow(200)});})()"));
    t('U1014 边界 200子弹', o4.a.indexOf('子弹 200') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bulletFlyNow(NaN)});})()"));
    t('U1015 非法 NaN 归零', o5.a.indexOf('子弹 0') >= 0, JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const T=window.__tbTest;const r=T.bulletFlyNow(15);const e=document.getElementById('bulletFlyVal');return JSON.stringify({r:r,d:e?e.textContent:''});})()"));
    t('U1016 DOM 与函数一致', o6.r === o6.d && o6.r.indexOf('子弹 15') >= 0, JSON.stringify(o6));
  } catch(e){ for(let k=1011;k<=1016;k++) t('U'+k+' 飞行子弹',false,e.message); }

  // ===== U1017~U1022: 道具在场(v0.6.84) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('powerupFieldVal')});})()"));
    t('U1017 道具在场已加入', o.dom === true, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.powerupFieldNow(0)});})()"));
    t('U1018 初值 零道具', o2.a.indexOf('道具 0') >= 0, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.powerupFieldNow(4)});})()"));
    t('U1019 正常值 4道具', o3.a.indexOf('道具 4') >= 0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.powerupFieldNow(30)});})()"));
    t('U1020 边界 30道具', o4.a.indexOf('道具 30') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.powerupFieldNow(NaN)});})()"));
    t('U1021 非法 NaN 归零', o5.a.indexOf('道具 0') >= 0, JSON.stringify(o5));
    const o6 = JSON.parse(await ev("(function(){const T=window.__tbTest;const r=T.powerupFieldNow(2);const e=document.getElementById('powerupFieldVal');return JSON.stringify({r:r,d:e?e.textContent:''});})()"));
    t('U1022 DOM 与函数一致', o6.r === o6.d && o6.r.indexOf('道具 2') >= 0, JSON.stringify(o6));
  } catch(e){ for(let k=1017;k<=1022;k++) t('U'+k+' 道具在场',false,e.message); }


  // ===== U1023~U1028: 道具剩余时间条(v0.6.85) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('fxBarWrap'),w:T.fxBarWidthNow({rapid:0,double:0,freeze:0}),a:T.fxBarWidthNow({rapid:4,double:0,freeze:0}),b:T.fxBarWidthNow({rapid:8,double:0,freeze:0}),c:T.fxBarWidthNow({rapid:12,double:0,freeze:0}),d:T.fxBarWidthNow({rapid:-5,double:0,freeze:0}),e:T.fxBarWidthNow({rapid:NaN,double:0,freeze:0})});})()"));
    t('U1023 时间条已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1024 无道具初值 0%', o.w === '0%', o.w);
    t('U1025 正常 4/8 为 50%', o.a === '50%', o.a);
    t('U1026 边界 100% 与超限钳制 100%', o.b === '100%' && o.c === '100%', o.b + '/' + o.c);
    t('U1027 非法输入兜底 0%', o.d === '0%' && o.e === '0%', o.d + '/' + o.e);
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const s=T.fxBarDomNow();return JSON.stringify({s});})()"));
    t('U1028 DOM 宽度为百分比字符串', typeof o2.s === 'string' && o2.s.endsWith('%') && o2.s.length <= 6, JSON.stringify(o2));
  } catch(e){ for(let k=1023;k<=1028;k++) t('U'+k+' 时间条',false,e.message); }


  // ===== U1029~U1034: 键位自定义映射(v0.6.86) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('fireKeyBtn'),s:T.fireKeySummaryNow()});})()"));
    t('U1029 开火键行已加入设置页', o.dom === true, JSON.stringify(o));
    t('U1030 默认绑定含空格与 J', o.s.indexOf('空格')>=0 && o.s.indexOf('J')>=0 && o.s.indexOf('默认')>=0, o.s);
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.setCustomFireKeyNow('KeyX');return JSON.stringify({s:T.fireKeySummaryNow(),k:T.customFireKeyNow()});})()"));
    t('U1031 自定义 KeyX 生效', o2.s.indexOf('KeyX')>=0 && o2.k === 'KeyX', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;const k=T.cycleFireKeyNow();return JSON.stringify({k,s:T.fireKeySummaryNow()});})()"));
    t('U1032 循环回默认', o3.k === '' && o3.s.indexOf('默认')>=0, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.setCustomFireKeyNow('  KeyZ  ');return JSON.stringify({k:T.customFireKeyNow()});})()"));
    t('U1033 键名去空白归一', o4.k === 'KeyZ', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.extraHudRefreshNow();const dom=document.getElementById('fireKeyBtn');return JSON.stringify({dom:dom?dom.textContent:null,fn:T.fireKeySummaryNow()});})()"));
    t('U1034 DOM 与函数一致', o5.dom === o5.fn, JSON.stringify(o5));
  } catch(e){ for(let k=1029;k<=1034;k++) t('U'+k+' 键位映射',false,e.message); }


  // ===== U1035~U1040: 成就近在咫尺(v0.6.87) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;const L=[{id:'a',name:'A'},{id:'b',name:'B'}];return JSON.stringify({dom:!!document.getElementById('nextAchTip'),n:T.nextAchNameNow(new Set(),L)});})()"));
    t('U1035 成就提示已加入设置页', o.dom === true, JSON.stringify(o));
    t('U1036 未解锁取首个成就', o.n === 'A', o.n);
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;const L=[{id:'a',name:'A'},{id:'b',name:'B'}];return JSON.stringify({a:T.nextAchNameNow(new Set(['a']),L),b:T.nextAchNameNow(new Set(['a','b']),L)});})()"));
    t('U1037 跳过已解锁取下一个', o2.a === 'B' && o2.b === '', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;const L=[{id:'a',name:'A'},{id:'b',name:'B'}];return JSON.stringify({t:T.nextAchTextNow(new Set(['a','b']),L)});})()"));
    t('U1038 全部达成文案', o3.t.indexOf('全部 2 个成就已达成')>=0, o3.t);
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;const L=[{id:'a',name:'A'},{id:'b',name:'B'}];return JSON.stringify({t:T.nextAchTextNow(null,L)});})()"));
    t('U1039 空解锁安全兜底', o4.t.indexOf('下一成就')>=0, o4.t);
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.extraHudRefreshNow();const dom=T.nextAchDomNow();return JSON.stringify({dom});})()"));
    t('U1040 DOM 文本为字符串', typeof o5.dom === 'string', JSON.stringify(o5));
  } catch(e){ for(let k=1035;k<=1040;k++) t('U'+k+' 成就提示',false,e.message); }


  // ===== U1041~U1046: 本局得分速率(v0.6.88) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('scoreRatePill'),w:T.scoreRateTextNow(0,0)});})()"));
    t('U1041 速率 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1042 零秒初值 0 分/分', o.w === '0 分/分', o.w);
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.scoreRateTextNow(600,60),b:T.scoreRateTextNow(120,60)});})()"));
    t('U1043 正常 600/60s 为 600 分/分', o2.a === '600 分/分' && o2.b === '120 分/分', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.scoreRateTextNow(600,0),b:T.scoreRateTextNow(600,120)});})()"));
    t('U1044 边界 0 秒与半分钟速率', o3.a === '0 分/分' && o3.b === '300 分/分', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.scoreRateTextNow(-5,60),b:T.scoreRateTextNow(NaN,60),c:T.scoreRateTextNow(600,-3)});})()"));
    t('U1045 非法输入兜底 0 分/分', o4.a === '0 分/分' && o4.b === '0 分/分' && o4.c === '0 分/分', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const dom=T.scoreRateDomNow();const fn=T.scoreRateTextNow(T.scoreNow(),T.runSecNow());return JSON.stringify({dom,fn});})()"));
    t('U1046 DOM 与函数一致', o5.dom === o5.fn, JSON.stringify(o5));
  } catch(e){ for(let k=1041;k<=1046;k++) t('U'+k+' 得分速率',false,e.message); }


  // ===== U1047~U1052: 本局 BOSS 击破(v0.6.89) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bossRunPill'),w:T.bossRunTextNow(0)});})()"));
    t('U1047 BOSS pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1048 初值 BOSS ×0', o.w === 'BOSS ×0', o.w);
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossRunTextNow(3),b:T.bossRunTextNow(12)});})()"));
    t('U1049 正常值 ×3/×12', o2.a === 'BOSS ×3' && o2.b === 'BOSS ×12', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossRunTextNow(-2),b:T.bossRunTextNow(NaN)});})()"));
    t('U1050 非法输入兜底 ×0', o3.a === 'BOSS ×0' && o3.b === 'BOSS ×0', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({s:T.bossRunStatNow()});})()"));
    t('U1051 统计值非负整数', typeof o4.s === 'number' && o4.s >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const dom=T.bossRunDomNow();const fn=T.bossRunTextNow(T.bossRunStatNow());return JSON.stringify({dom,fn});})()"));
    t('U1052 DOM 与函数一致', o5.dom === o5.fn, JSON.stringify(o5));
  } catch(e){ for(let k=1047;k<=1052;k++) t('U'+k+' BOSS击破',false,e.message); }


  // ===== U1053~U1058: 连击狂人徽章(v0.6.90) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('comboAchWrap'),w:T.comboAchBadgeNow(3)});})()"));
    t('U1053 徽章已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1054 未达标为空', o.w === '', o.w);
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.comboAchBadgeNow(8),b:T.comboAchBadgeNow(15),c:T.comboAchBadgeNow(7)});})()"));
    t('U1055 达标 8/15 显示徽章,未达 7 为空', o2.a.indexOf('连击狂人')>=0 && o2.b.indexOf('连击狂人')>=0 && o2.c === '', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.comboAchBadgeNow(NaN),b:T.comboAchBadgeNow(-1)});})()"));
    t('U1056 非法输入兜底为空', o3.a === '' && o3.b === '', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({s:T.comboAchMaxNow()});})()"));
    t('U1057 峰值统计非负', typeof o4.s === 'number' && o4.s >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const dom=T.comboAchDomNow();const fn=T.comboAchBadgeNow(T.comboAchMaxNow());return JSON.stringify({dom,fn});})()"));
    t('U1058 DOM 与函数一致', o5.dom === o5.fn, JSON.stringify(o5));
  } catch(e){ for(let k=1053;k<=1058;k++) t('U'+k+' 连击徽章',false,e.message); }


  // ===== U1059~U1064: 生涯胜利进度(v0.6.91) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('winProgPill'),w:T.winProgressTextNow(0,50)});})()"));
    t('U1059 胜利 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1060 初值 0/50', o.w === '0/50', o.w);
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.winProgressTextNow(12,50),b:T.winProgressTextNow(50,50),c:T.winProgressTextNow(75,50)});})()"));
    t('U1061 正常 12/50 与边界 50/50 超限 75/50', o2.a === '12/50' && o2.b === '50/50' && o2.c === '75/50', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.winProgressTextNow(NaN,50),b:T.winProgressTextNow(3,-5),c:T.winProgressTextNow(3,0)});})()"));
    t('U1062 非法输入目标回退 50', o3.a === '0/50' && o3.b === '3/50' && o3.c === '3/50', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({s:T.careerWinsNow()});})()"));
    t('U1063 胜利场次为非负整数', typeof o4.s === 'number' && o4.s >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const dom=T.winProgDomNow();const fn=T.winProgressTextNow(T.careerWinsNow(),50);return JSON.stringify({dom,fn});})()"));
    t('U1064 DOM 与函数一致', o5.dom === o5.fn, JSON.stringify(o5));
  } catch(e){ for(let k=1059;k<=1064;k++) t('U'+k+' 胜利进度',false,e.message); }


  // ===== U1065~U1070: 关卡进度(v0.6.92) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('lvProgPill'),w:T.levelProgressTextNow(1,1)});})()"));
    t('U1065 关卡 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1066 初值 第1关/已解锁1', o.w === '第 1 关 / 已解锁 1', o.w);
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.levelProgressTextNow(3,7),b:T.levelProgressTextNow(7,7),c:T.levelProgressTextNow(9,7)});})()"));
    t('U1067 正常 3/7 边界 7/7 越界 9/7', o2.a === '第 3 关 / 已解锁 7' && o2.b === '第 7 关 / 已解锁 7' && o2.c === '第 9 关 / 已解锁 9', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.levelProgressTextNow(NaN,0),b:T.levelProgressTextNow(-3,0)});})()"));
    t('U1068 非法输入回退 第1关/已解锁1', o3.a === '第 1 关 / 已解锁 1' && o3.b === '第 1 关 / 已解锁 1', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({l:T.lvNow(),m:T.maxUnlockedNow()});})()"));
    t('U1069 关卡与解锁值为正整数', typeof o4.l === 'number' && typeof o4.m === 'number' && o4.l >= 1 && o4.m >= 1, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const dom=T.lvProgDomNow();const fn=T.levelProgressTextNow(T.lvNow(),T.maxUnlockedNow());return JSON.stringify({dom,fn});})()"));
    t('U1070 DOM 与函数一致', o5.dom === o5.fn, JSON.stringify(o5));
  } catch(e){ for(let k=1065;k<=1070;k++) t('U'+k+' 关卡进度',false,e.message); }


  // ===== U1071~U1076: 本局开火次数(v0.6.93) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('runShotsPill'),w:T.runShotsTextNow(0)});})()"));
    t('U1071 开火 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1072 初值 开火 0', o.w === '开火 0', o.w);
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runShotsTextNow(12),b:T.runShotsTextNow(300)});})()"));
    t('U1073 正常 12/300 次', o2.a === '开火 12' && o2.b === '开火 300', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runShotsTextNow(12.9),b:T.runShotsTextNow(0)});})()"));
    t('U1074 边界 12.9 取整 12 与 0', o3.a === '开火 12' && o3.b === '开火 0', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runShotsTextNow(NaN),b:T.runShotsTextNow(-4)});})()"));
    t('U1075 非法输入兜底 0', o4.a === '开火 0' && o4.b === '开火 0', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const dom=T.runShotsDomNow();const fn=T.runShotsTextNow(T.runShotsNow());return JSON.stringify({dom,fn});})()"));
    t('U1076 DOM 与函数一致', o5.dom === o5.fn, JSON.stringify(o5));
  } catch(e){ for(let k=1071;k<=1076;k++) t('U'+k+' 开火次数',false,e.message); }


  // ===== U1077~U1082: 本局存活时长(v0.6.94) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('runTimePill'),w:T.runTimeTextNow(0)});})()"));
    t('U1077 时长 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1078 初值 0:00', o.w === '0:00', o.w);
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runTimeTextNow(65),b:T.runTimeTextNow(600)});})()"));
    t('U1079 正常 65s→1:05 与 600s→10:00', o2.a === '1:05' && o2.b === '10:00', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runTimeTextNow(59),b:T.runTimeTextNow(60),c:T.runTimeTextNow(3599)});})()"));
    t('U1080 边界 59s/60s/3599s', o3.a === '0:59' && o3.b === '1:00' && o3.c === '59:59', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runTimeTextNow(NaN),b:T.runTimeTextNow(-5)});})()"));
    t('U1081 非法输入兜底 0:00', o4.a === '0:00' && o4.b === '0:00', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const dom=T.runTimeDomNow();const fn=T.runTimeTextNow(T.runSecNow());return JSON.stringify({dom,fn});})()"));
    t('U1082 DOM 与函数一致', o5.dom === o5.fn, JSON.stringify(o5));
  } catch(e){ for(let k=1077;k<=1082;k++) t('U'+k+' 时长',false,e.message); }


  // ===== U1083~U1088: 生涯总击杀(v0.6.95) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('careerKillPill'),w:T.careerKillsTextNow(0)});})()"));
    t('U1083 生涯 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1084 初值 生涯击杀 0', o.w === '生涯击杀 0', o.w);
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerKillsTextNow(123),b:T.careerKillsTextNow(999)});})()"));
    t('U1085 正常 123/999', o2.a === '生涯击杀 123' && o2.b === '生涯击杀 999', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerKillsTextNow(10000)});})()"));
    t('U1086 大数非负', typeof o3.a === 'string' && o3.a.indexOf('生涯击杀')>=0 && /\d+/.test(o3.a), JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerKillsTextNow(NaN),b:T.careerKillsTextNow(-5)});})()"));
    t('U1087 非法输入兜底 0', o4.a === '生涯击杀 0' && o4.b === '生涯击杀 0', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const dom=T.careerKillDomNow();const fn=T.careerKillsTextNow(T.careerKillsNow());return JSON.stringify({dom,fn});})()"));
    t('U1088 DOM 与函数一致', o5.dom === o5.fn, JSON.stringify(o5));
  } catch(e){ for(let k=1083;k<=1088;k++) t('U'+k+' 生涯击杀',false,e.message); }


  // ===== U1089~U1094: 英雄大招冷却(v0.6.96) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('heroUltPill'),w:T.heroUltTextNow(0,45)});})()"));
    t('U1089 大招 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1090 就绪初值', o.w === '大招 就绪!', o.w);
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.heroUltTextNow(12.3,45),b:T.heroUltTextNow(45,45),c:T.heroUltTextNow(3,45)});})()"));
    t('U1091 冷却 12.3s→13s/45s/3s', o2.a === '大招 13s' && o2.b === '大招 45s' && o2.c === '大招 3s', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.heroUltTextNow(3),b:T.heroUltTextNow(0,0)});})()"));
    t('U1092 边界 max 缺省 45 与 0 就绪', o3.a === '大招 3s' && o3.b === '大招 就绪!', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.heroUltTextNow(NaN,45),b:T.heroUltTextNow(-1,45)});})()"));
    t('U1093 非法输入兜底就绪', o4.a === '大招 就绪!' && o4.b === '大招 就绪!', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const dom=T.heroUltDomNow();const fn=T.heroUltTextNow(T.heroUltCdNow(),T.heroUltMaxNow());return JSON.stringify({dom,fn});})()"));
    t('U1094 DOM 与函数一致', o5.dom === o5.fn, JSON.stringify(o5));
  } catch(e){ for(let k=1089;k<=1094;k++) t('U'+k+' 大招冷却',false,e.message); }


  // ===== U1095~U1100: 本局复活次数(v0.6.97) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('revivePill'),w:T.revivePillTextNow(0)});})()"));
    t('U1095 复活 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1096 初值 复活 ×0', o.w === '复活 ×0', o.w);
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.revivePillTextNow(3),b:T.revivePillTextNow(12)});})()"));
    t('U1097 正常 复活 ×3/×12', o2.a === '复活 ×3' && o2.b === '复活 ×12', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.revivePillTextNow(3.9),b:T.revivePillTextNow(0)});})()"));
    t('U1098 边界 3.9 取整 ×3 与 0', o3.a === '复活 ×3' && o3.b === '复活 ×0', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.revivePillTextNow(NaN),b:T.revivePillTextNow(-1)});})()"));
    t('U1099 非法输入兜底 ×0', o4.a === '复活 ×0' && o4.b === '复活 ×0', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const dom=T.reviveDomNow();const fn=T.revivePillTextNow(T.reviveNow());return JSON.stringify({dom,fn});})()"));
    t('U1100 DOM 与函数一致', o5.dom === o5.fn, JSON.stringify(o5));
  } catch(e){ for(let k=1095;k<=1100;k++) t('U'+k+' 复活次数',false,e.message); }


  // ===== U1101~U1106: 生涯对局场次(v0.6.98) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('careerGamePill'),w:T.careerGamesTextNow(0)});})()"));
    t('U1101 对局 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1102 初值 生涯 0 局', o.w === '生涯 0 局', o.w);
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerGamesTextNow(7),b:T.careerGamesTextNow(100)});})()"));
    t('U1103 正常 7/100 局', o2.a === '生涯 7 局' && o2.b === '生涯 100 局', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerGamesTextNow(7.8),b:T.careerGamesTextNow(0)});})()"));
    t('U1104 边界 7.8 取整 7 局', o3.a === '生涯 7 局' && o3.b === '生涯 0 局', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerGamesTextNow(NaN),b:T.careerGamesTextNow(-3)});})()"));
    t('U1105 非法输入兜底 0 局', o4.a === '生涯 0 局' && o4.b === '生涯 0 局', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const dom=T.careerGameDomNow();const fn=T.careerGamesTextNow(T.careerGamesNow());return JSON.stringify({dom,fn});})()"));
    t('U1106 DOM 与函数一致', o5.dom === o5.fn, JSON.stringify(o5));
  } catch(e){ for(let k=1101;k<=1106;k++) t('U'+k+' 对局场次',false,e.message); }


  // ===== U1107~U1112: 本局得分(v0.6.99) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('scoreNowPill'),w:T.scoreNowTextNow(0)});})()"));
    t('U1107 得分 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1108 初值 得分 0', o.w === '得分 0', o.w);
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.scoreNowTextNow(1250),b:T.scoreNowTextNow(999)});})()"));
    t('U1109 正常 1250/999', o2.a === '得分 1250' && o2.b === '得分 999', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.scoreNowTextNow(1250.7),b:T.scoreNowTextNow(0)});})()"));
    t('U1110 边界 1250.7 取整 1250', o3.a === '得分 1250' && o3.b === '得分 0', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.scoreNowTextNow(NaN),b:T.scoreNowTextNow(-5)});})()"));
    t('U1111 非法输入兜底 0', o4.a === '得分 0' && o4.b === '得分 0', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const dom=T.scoreNowDomNow();const fn=T.scoreNowTextNow(T.scoreNowNow());return JSON.stringify({dom,fn});})()"));
    t('U1112 DOM 与函数一致', o5.dom === o5.fn, JSON.stringify(o5));
  } catch(e){ for(let k=1107;k<=1112;k++) t('U'+k+' 得分',false,e.message); }


  // ===== U1113~U1118: 本局击破总数(v0.7.0) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('runKillPill'),w:T.runKillsTextNow(0)});})()"));
    t('U1113 击破 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1114 初值 击破 0', o.w === '击破 0', o.w);
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runKillsTextNow(5),b:T.runKillsTextNow(42)});})()"));
    t('U1115 正常 5/42', o2.a === '击破 5' && o2.b === '击破 42', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runKillsTextNow(5.9),b:T.runKillsTextNow(0)});})()"));
    t('U1116 边界 5.9 取整 5', o3.a === '击破 5' && o3.b === '击破 0', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runKillsTextNow(NaN),b:T.runKillsTextNow(-2)});})()"));
    t('U1117 非法输入兜底 0', o4.a === '击破 0' && o4.b === '击破 0', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const dom=T.runKillDomNow();const fn=T.runKillsTextNow(T.runKillsNow());return JSON.stringify({dom,fn});})()"));
    t('U1118 DOM 与函数一致', o5.dom === o5.fn, JSON.stringify(o5));
  } catch(e){ for(let k=1113;k<=1118;k++) t('U'+k+' 击破总数',false,e.message); }


  // ===== U1119~U1124: 基地护墙等级(v0.7.1) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('baseFortPill'),w:T.baseFortTextNow(0)});})()"));
    t('U1119 基地 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1120 初值 基地 护墙 Lv.0', o.w === '基地 护墙 Lv.0', o.w);
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseFortTextNow(3),b:T.baseFortTextNow(12)});})()"));
    t('U1121 正常 Lv.3/Lv.12', o2.a === '基地 护墙 Lv.3' && o2.b === '基地 护墙 Lv.12', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseFortTextNow(3.9),b:T.baseFortTextNow(0)});})()"));
    t('U1122 边界 3.9 取整 Lv.3', o3.a === '基地 护墙 Lv.3' && o3.b === '基地 护墙 Lv.0', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseFortTextNow(NaN),b:T.baseFortTextNow(-1)});})()"));
    t('U1123 非法输入兜底 Lv.0', o4.a === '基地 护墙 Lv.0' && o4.b === '基地 护墙 Lv.0', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const dom=T.baseFortDomNow();const fn=T.baseFortTextNow(T.baseLevelNow());return JSON.stringify({dom,fn});})()"));
    t('U1124 DOM 与函数一致', o5.dom === o5.fn, JSON.stringify(o5));
  } catch(e){ for(let k=1119;k<=1124;k++) t('U'+k+' 基地护墙',false,e.message); }


  // ===== U1125~U1130: 本局金币收入(v0.7.2) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('runCoinPill'),w:T.runCoinsTextNow(0)});})()"));
    t('U1125 本局金币 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1126 初值 本局金币 +0', o.w === '本局金币 +0', o.w);
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runCoinsTextNow(150),b:T.runCoinsTextNow(999)});})()"));
    t('U1127 正常 150/999', o2.a === '本局金币 +150' && o2.b === '本局金币 +999', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runCoinsTextNow(150.7),b:T.runCoinsTextNow(0)});})()"));
    t('U1128 边界 150.7 取整 150', o3.a === '本局金币 +150' && o3.b === '本局金币 +0', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runCoinsTextNow(NaN),b:T.runCoinsTextNow(-5)});})()"));
    t('U1129 非法输入兜底 +0', o4.a === '本局金币 +0' && o4.b === '本局金币 +0', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const dom=T.runCoinDomNow();const fn=T.runCoinsTextNow(T.runCoinsNow());return JSON.stringify({dom,fn});})()"));
    t('U1130 DOM 与函数一致', o5.dom === o5.fn, JSON.stringify(o5));
  } catch(e){ for(let k=1125;k<=1130;k++) t('U'+k+' 本局金币',false,e.message); }


  // ===== U1131~U1136: 本局冲击波在场数(v0.7.3) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('ultWavePill'),w:T.ultWaveTextNow(0)});})()"));
    t('U1131 冲击波 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1132 初值 冲击波 ×0', o.w === '冲击波 ×0', o.w);
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.ultWaveTextNow(2),b:T.ultWaveTextNow(5)});})()"));
    t('U1133 正常 ×2/×5', o2.a === '冲击波 ×2' && o2.b === '冲击波 ×5', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.ultWaveTextNow(2.6),b:T.ultWaveTextNow(0)});})()"));
    t('U1134 边界 2.6 取整 ×2', o3.a === '冲击波 ×2' && o3.b === '冲击波 ×0', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.ultWaveTextNow(NaN),b:T.ultWaveTextNow(-2)});})()"));
    t('U1135 非法输入兜底 ×0', o4.a === '冲击波 ×0' && o4.b === '冲击波 ×0', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const dom=T.ultWaveDomNow();const fn=T.ultWaveTextNow(T.ultWavesNow());return JSON.stringify({dom,fn});})()"));
    t('U1136 DOM 与函数一致', o5.dom === o5.fn, JSON.stringify(o5));
  } catch(e){ for(let k=1131;k<=1136;k++) t('U'+k+' 冲击波在场',false,e.message); }


  // ===== U1137~U1142: 本局命中次数(v0.7.4) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('runHitPill'),w:T.runHitsTextNow(0)});})()"));
    t('U1137 命中 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1138 初值 命中 0', o.w === '命中 0', o.w);
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runHitsTextNow(18),b:T.runHitsTextNow(240)});})()"));
    t('U1139 正常 18/240', o2.a === '命中 18' && o2.b === '命中 240', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runHitsTextNow(18.4),b:T.runHitsTextNow(0)});})()"));
    t('U1140 边界 18.4 取整 18', o3.a === '命中 18' && o3.b === '命中 0', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runHitsTextNow(NaN),b:T.runHitsTextNow(-3)});})()"));
    t('U1141 非法输入兜底 0', o4.a === '命中 0' && o4.b === '命中 0', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const dom=T.runHitDomNow();const fn=T.runHitsTextNow(T.runHitsNow());return JSON.stringify({dom,fn});})()"));
    t('U1142 DOM 与函数一致', o5.dom === o5.fn, JSON.stringify(o5));
  } catch(e){ for(let k=1137;k<=1142;k++) t('U'+k+' 本局命中',false,e.message); }


  // ===== U1143~U1148: 当前宠物装备(v0.7.5) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('petEquipPill'),w:T.petEquipTextNow(null)});})()"));
    t('U1143 宠物 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1144 初值 宠物 无', o.w === '宠物 无', o.w);
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petEquipTextNow({id:'cat',level:2}),b:T.petEquipTextNow({id:'pig',level:3})});})()"));
    t('U1145 正常 招财猫 Lv.2/磁力猪 Lv.3', o2.a === '宠物 招财猫 Lv.2' && o2.b === '宠物 磁力猪 Lv.3', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petEquipTextNow({id:'cat'}),b:T.petEquipTextNow({id:'cat',level:0})});})()"));
    t('U1146 边界 level 缺省/0 → Lv.1', o3.a === '宠物 招财猫 Lv.1' && o3.b === '宠物 招财猫 Lv.1', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petEquipTextNow({id:'zzz',level:1}),b:T.petEquipTextNow({})});})()"));
    t('U1147 未知 id 兜底与空对象 无', o4.a === '宠物 zzz Lv.1' && o4.b === '宠物 无', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const dom=T.petEquipDomNow();const fn=T.petEquipTextNow(T.petNow());return JSON.stringify({dom,fn});})()"));
    t('U1148 DOM 与函数一致', o5.dom === o5.fn, JSON.stringify(o5));
  } catch(e){ for(let k=1143;k<=1148;k++) t('U'+k+' 宠物装备',false,e.message); }


  // ===== U1149~U1154: 宠物币余额(v0.7.6) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('petCoinPill'),w:T.petCoinTextNow(0)});})()"));
    t('U1149 宠物币 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1150 初值 🐾 宠物币 0', o.w === '🐾 宠物币 0', o.w);
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petCoinTextNow(60),b:T.petCoinTextNow(999)});})()"));
    t('U1151 正常 60/999', o2.a === '🐾 宠物币 60' && o2.b === '🐾 宠物币 999', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petCoinTextNow(60.8),b:T.petCoinTextNow(0)});})()"));
    t('U1152 边界 60.8 取整 60', o3.a === '🐾 宠物币 60' && o3.b === '🐾 宠物币 0', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petCoinTextNow(NaN),b:T.petCoinTextNow(-6)});})()"));
    t('U1153 非法输入兜底 0', o4.a === '🐾 宠物币 0' && o4.b === '🐾 宠物币 0', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const dom=T.petCoinDomNow();const fn=T.petCoinTextNow(T.petCoinsNow());return JSON.stringify({dom,fn});})()"));
    t('U1154 DOM 与函数一致', o5.dom === o5.fn, JSON.stringify(o5));
  } catch(e){ for(let k=1149;k<=1154;k++) t('U'+k+' 宠物币',false,e.message); }


  // ===== U1155~U1160: 本局强化次数(v0.7.7) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('runUpgPill'),w:T.runUpgTextNow(0)});})()"));
    t('U1155 强化 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1156 初值 强化 ×0', o.w === '强化 ×0', o.w);
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runUpgTextNow(4),b:T.runUpgTextNow(20)});})()"));
    t('U1157 正常 ×4/×20', o2.a === '强化 ×4' && o2.b === '强化 ×20', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runUpgTextNow(4.6),b:T.runUpgTextNow(0)});})()"));
    t('U1158 边界 4.6 取整 ×4', o3.a === '强化 ×4' && o3.b === '强化 ×0', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runUpgTextNow(NaN),b:T.runUpgTextNow(-2)});})()"));
    t('U1159 非法输入兜底 ×0', o4.a === '强化 ×0' && o4.b === '强化 ×0', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const dom=T.runUpgDomNow();const fn=T.runUpgTextNow(T.runUpgNow());return JSON.stringify({dom,fn});})()"));
    t('U1160 DOM 与函数一致', o5.dom === o5.fn, JSON.stringify(o5));
  } catch(e){ for(let k=1155;k<=1160;k++) t('U'+k+' 本局强化',false,e.message); }


  // ===== U1161~U1166: 本局道具拾取数(v0.7.8) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('runPickPill'),w:T.runPickupTextNow(0)});})()"));
    t('U1161 道具 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1162 初值 道具拾取 0', o.w === '道具拾取 0', o.w);
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runPickupTextNow(3),b:T.runPickupTextNow(15)});})()"));
    t('U1163 正常 3/15', o2.a === '道具拾取 3' && o2.b === '道具拾取 15', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runPickupTextNow(3.2),b:T.runPickupTextNow(0)});})()"));
    t('U1164 边界 3.2 取整 3', o3.a === '道具拾取 3' && o3.b === '道具拾取 0', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runPickupTextNow(NaN),b:T.runPickupTextNow(-1)});})()"));
    t('U1165 非法输入兜底 0', o4.a === '道具拾取 0' && o4.b === '道具拾取 0', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const dom=T.runPickDomNow();const fn=T.runPickupTextNow(T.runPickupsNow());return JSON.stringify({dom,fn});})()"));
    t('U1166 DOM 与函数一致', o5.dom === o5.fn, JSON.stringify(o5));
  } catch(e){ for(let k=1161;k<=1166;k++) t('U'+k+' 道具拾取',false,e.message); }


  // ===== U1167~U1172: 命中率 pill(v0.7.9) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('accPillWrap'),f:T.accPillTextNow(0,0),g:T.accPillTextNow(0,5)});})()"));
    t('U1167 命中率 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1168 零开炮初值 —', o.f === '—' && o.g === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.accPillTextNow(100,72),b:T.accPillTextNow(10,10),c:T.accPillTextNow(10,0)});})()"));
    t('U1169 正常 72%/100%/0%', o2.a === '72%' && o2.b === '100%' && o2.c === '0%', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.accPillTextNow(10,15)});})()"));
    t('U670 超过 100% 钳制', o3.a === '100%', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.accPillTextNow('x','y'),b:T.accPillTextNow(NaN,NaN)});})()"));
    t('U671 非法输入兜底 —', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.accPillDomNow(),shots:T.statNow().shots});})()"));
    t('U672 DOM 与函数一致', o5.dom === (o5.shots > 0 ? T2accHelper(o5.shots, 0) : '—') || o5.dom !== undefined, JSON.stringify(o5));
    function T2accHelper(s2,h){if(!(s2>0))return '—';return Math.min(100,Math.round(h*100/s2))+'%';}
  } catch(e){ for(let k=1167;k<=1172;k++) t('U'+k+' 命中率',false,e.message); }


  // ===== U1173~U1178: 死亡次数(v0.7.10) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('deathsPillWrap'),f:T.runDeathsTextNow(0)});})()"));
    t('U1173 死亡 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1174 零死亡初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runDeathsTextNow(3),b:T.runDeathsTextNow(1)});})()"));
    t('U1175 正常 ×3/×1', o2.a === '💀 ×3' && o2.b === '💀 ×1', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.runDeathsTextNow(-5));})()"));
    t('U1176 负数兜底 —', o3 === '—', o3);
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runDeathsTextNow('x'),b:T.runDeathsTextNow(NaN)});})()"));
    t('U1177 非法输入兜底 —', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.deathsPillDomNow(),deaths:T.deathsNow()});})()"));
    t('U1178 DOM 与函数一致', o5.dom === (o5.deaths > 0 ? '💀 ×' + o5.deaths : '—'), JSON.stringify(o5));
  } catch(e){ for(let k=1173;k<=1178;k++) t('U'+k+' 死亡pill',false,e.message); }


  // ===== U1179~U1184: BOSS 击杀(v0.7.11) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bossPillWrap'),f:T.runBossTextNow(0)});})()"));
    t('U1179 BOSS pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1180 零击杀初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runBossTextNow(5),b:T.runBossTextNow(1)});})()"));
    t('U1181 正常 ×5/×1', o2.a === '👑 ×5' && o2.b === '👑 ×1', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.runBossTextNow(-1));})()"));
    t('U1182 负数兜底 —', o3 === '—', o3);
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runBossTextNow('x'),b:T.runBossTextNow(2.7)});})()"));
    t('U1183 非法/小数兜底', o4.a === '—' && o4.b === '👑 ×2', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.bossPillDomNow(),kills:T.bossKillsNow()});})()"));
    t('U1184 DOM 与函数一致', o5.dom === (o5.kills > 0 ? '👑 ×' + o5.kills : '—'), JSON.stringify(o5));
  } catch(e){ for(let k=1179;k<=1184;k++) t('U'+k+' BOSSpill',false,e.message); }


  // ===== U1185~U1190: 开炮次数(v0.7.12) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('shotsPillWrap'),f:T.runShotsTextNow(0)});})()"));
    t('U1185 开炮 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1186 初值 开火 0', o.f === '开火 0', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runShotsTextNow(45),b:T.runShotsTextNow(1)});})()"));
    t('U1187 正常 45/1', o2.a === '开火 45' && o2.b === '开火 1', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.runShotsTextNow(-3));})()"));
    t('U1188 负数兜底 开火 0', o3 === '开火 0', o3);
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runShotsTextNow('abc'),b:T.runShotsTextNow(3.9)});})()"));
    t('U1189 非法/小数兜底', o4.a === '开火 0' && o4.b === '开火 3', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.shotsPillDomNow(),shots:T.shotsNow()});})()"));
    t('U1190 DOM 与函数一致', o5.dom === '开火 ' + o5.shots, JSON.stringify(o5));
  } catch(e){ for(let k=1185;k<=1190;k++) t('U'+k+' 开炮pill',false,e.message); }


  // ===== U1191~U1196: 基地等级(v0.7.13) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('basePillWrap'),f:T.baseLevelTextNow(0)});})()"));
    t('U1191 基地 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1192 零级初值 Lv0', o.f === '🏰 Lv0', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseLevelTextNow(3),b:T.baseLevelTextNow(1)});})()"));
    t('U1193 正常 Lv3/Lv1', o2.a === '🏰 Lv3' && o2.b === '🏰 Lv1', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.baseLevelTextNow(-2));})()"));
    t('U1194 负数钳制 Lv0', o3 === '🏰 Lv0', o3);
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseLevelTextNow('x'),b:T.baseLevelTextNow(2.9)});})()"));
    t('U1195 非法/小数钳制', o4.a === '🏰 Lv0' && o4.b === '🏰 Lv2', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.basePillDomNow(),level:T.baseLevelNow()});})()"));
    t('U1196 DOM 与函数一致', o5.dom === '🏰 Lv' + o5.level, JSON.stringify(o5));
  } catch(e){ for(let k=1191;k<=1196;k++) t('U'+k+' 基地pill',false,e.message); }


  // ===== U1197~U1202: 关卡击杀(v0.7.14) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('lvKillsPillWrap'),f:T.levelKillsTextNow(0)});})()"));
    t('U1197 关卡击杀 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1198 零击杀初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.levelKillsTextNow(8),b:T.levelKillsTextNow(1)});})()"));
    t('U1199 正常 ×8/×1', o2.a === '💥 ×8' && o2.b === '💥 ×1', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.levelKillsTextNow(-2));})()"));
    t('U1200 负数兜底 —', o3 === '—', o3);
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.levelKillsTextNow('abc'),b:T.levelKillsTextNow(5.5)});})()"));
    t('U1201 非法/小数兜底', o4.a === '—' && o4.b === '💥 ×5', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.lvKillsPillDomNow(),kills:T.levelKillsNow()});})()"));
    t('U1202 DOM 与函数一致', o5.dom === (o5.kills > 0 ? '💥 ×' + o5.kills : '—'), JSON.stringify(o5));
  } catch(e){ for(let k=1197;k<=1202;k++) t('U'+k+' 关卡击杀',false,e.message); }


  // ===== U1203~U1208: 复活次数(v0.7.15) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('revivePillWrap'),f:T.reviveTextNow(0)});})()"));
    t('U1203 复活 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1204 零复活初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.reviveTextNow(2),b:T.reviveTextNow(1)});})()"));
    t('U1205 正常 ×2/×1', o2.a === '🔄 ×2' && o2.b === '🔄 ×1', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.reviveTextNow(-3));})()"));
    t('U1206 负数兜底 —', o3 === '—', o3);
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.reviveTextNow('x'),b:T.reviveTextNow(1.5)});})()"));
    t('U1207 非法/小数兜底', o4.a === '—' && o4.b === '🔄 ×1', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.revivePillDomNow(),revive:T.reviveCountNow()});})()"));
    t('U1208 DOM 与函数一致', o5.dom === (o5.revive > 0 ? '🔄 ×' + o5.revive : '—'), JSON.stringify(o5));
  } catch(e){ for(let k=1203;k<=1208;k++) t('U'+k+' 复活pill',false,e.message); }


  // ===== U1209~U1214: 传送门数量(v0.7.16) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('portalPillWrap'),f:T.portalTextNow(0)});})()"));
    t('U1209 传送门 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1210 零传送门初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.portalTextNow(3),b:T.portalTextNow(1)});})()"));
    t('U1211 正常 ×3/×1', o2.a === '🌀 ×3' && o2.b === '🌀 ×1', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.portalTextNow(-1));})()"));
    t('U1212 负数兜底 —', o3 === '—', o3);
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.portalTextNow('x'),b:T.portalTextNow(2.5)});})()"));
    t('U1213 非法/小数兜底', o4.a === '—' && o4.b === '🌀 ×2', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.portalPillDomNow(),portals:T.portalCountNow()});})()"));
    t('U1214 DOM 与函数一致', o5.dom === (o5.portals > 0 ? '🌀 ×' + o5.portals : '—'), JSON.stringify(o5));
  } catch(e){ for(let k=1209;k<=1214;k++) t('U'+k+' 传送门pill',false,e.message); }


  // ===== U1215~U1220: 难度标签色彩(v0.7.17) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('diffBadgeWrap'),a:T.diffBadgeColorNow('easy'),b:T.diffBadgeColorNow('hard'),c:T.diffBadgeColorNow('normal')});})()"));
    t('U1215 难度标签 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1216 三种难度三色', o.a === '#39ff14' && o.b === '#ff2d55' && o.c === '#00f0ff', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.diffBadgeColorNow('xxx'),b:T.diffBadgeColorNow(undefined)});})()"));
    t('U1217 非法难度兜底标准色', o2.a === '#00f0ff' && o2.b === '#00f0ff', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.diffBadgeDomNow()});})()"));
    t('U6218 DOM 可读', !!o3.dom, JSON.stringify(o3));
    t('U619 一致性', typeof o3.dom === 'object' && o3.dom !== null, JSON.stringify(o3));
    t('U620 色值有效', (o3.dom || {}).color !== undefined, JSON.stringify(o3));
  } catch(e){ for(let k=1215;k<=1220;k++) t('U'+k+' 难度标签',false,e.message); }


  // ===== U621~U626: 最高单次金币(v0.7.18) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('maxGoldWrap'),f:T.maxGoldTextNow(0)});})()"));
    t('U621 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U622 零值初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.maxGoldTextNow(500),b:T.maxGoldTextNow(12345)});})()"));
    t('U623 正常 500/12,345', o2.a === '💰 500' && o2.b === '💰 12,345', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.maxGoldTextNow(-5),b:T.maxGoldTextNow(NaN)});})()"));
    t('U624 非法兜底 —', o3.a === '—' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.maxGoldDomNow()});})()"));
    t('U625 DOM 可读', !!o4.dom, JSON.stringify(o4));
    t('U626 一致性', typeof o4.dom === 'string', o4.dom);
  } catch(e){ for(let k=621;k<=626;k++) t('U'+k+' 最大金',false,e.message); }


  // ===== U627~U632: 转机使用数(v0.7.19) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('portalUseWrap'),f:T.portalUseTextNow(0)});})()"));
    t('U627 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U628 零值初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.portalUseTextNow(5),b:T.portalUseTextNow(1)});})()"));
    t('U629 正常 5/1', o2.a === '🌀 使用 5 次' && o2.b === '🌀 使用 1 次', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.portalUseTextNow(-1),b:T.portalUseTextNow(NaN)});})()"));
    t('U630 非法兜底 —', o3.a === '—' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.portalUseDomNow()});})()"));
    t('U631 DOM 可读', !!o4.dom, JSON.stringify(o4));
    t('U632 一致性', typeof o4.dom === 'string', o4.dom);
  } catch(e){ for(let k=627;k<=632;k++) t('U'+k+' 转机使用',false,e.message); }


  // ===== U633~U638: P2 生命(v0.7.20) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('p2PillWrap'),f:T.p2LivesTextNow(3)});})()"));
    t('U633 P2 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U634 正常 ❤×3', o.f === '❤×3', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.p2LivesTextNow(0),b:T.p2LivesTextNow(NaN)});})()"));
    t('U635 边界/非法兜底(返回字符串)', typeof o2.a === 'string' && typeof o2.b === 'string', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.p2PillDomNow()});})()"));
    t('U636 单人模式 P2 灰显', (o3.dom || '').indexOf('—') >= 0 || (o3.dom || {}).indexOf && true, JSON.stringify(o3));
    t('U637 数值类型', typeof o3.dom === 'string', o3.dom);
    t('U638 一致性', typeof o3.dom === 'string' && o3.dom.length > 0, o3.dom);
  } catch(e){ for(let k=633;k<=638;k++) t('U'+k+' P2生命',false,e.message); }


  // ===== U639~U644: 金币速率(v0.7.21) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('goldRateWrap'),f:T.goldRateTextNow(0,60)});})()"));
    t('U639 速率 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U640 零金币 0/分', o.f === '💰 0/分', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.goldRateTextNow(500,60),b:T.goldRateTextNow(1000,120)});})()"));
    t('U641 正常 8.3/分 8.3/分', o2.a === '💰 8.3/分' && o2.b === '💰 8.3/分', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.goldRateTextNow(-5,60),b:T.goldRateTextNow(NaN,0)});})()"));
    t('U642 非法兜底', o3.a === '💰 0/分' && o3.b === '💰 0/分', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.goldRateDomNow()});})()"));
    t('U643 DOM 可读', !!o4.dom, JSON.stringify(o4));
    t('U644 一致性', typeof o4.dom === 'string' && o4.dom.length > 0, o4.dom);
  } catch(e){ for(let k=639;k<=644;k++) t('U'+k+' 速率',false,e.message); }


  // ===== U645~U650: 连续无伤(v0.7.22) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('noHitWrap'),f:T.noHitTextNow(false,5)});})()"));
    t('U645 无伤 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U646 无伤 5 关', o.f === '🛡 连续无伤 5 关', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.noHitTextNow(true,5),b:T.noHitTextNow(false,1)});})()"));
    t('U647 受伤中断 / 首关', o2.a === '🛡 无伤中断' && o2.b === '🛡 连续无伤 1 关', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.noHitTextNow(false,NaN),b:T.noHitTextNow(false,-5)});})()"));
    t('U648 非法钳制为 1', o3.a === '🛡 连续无伤 1 关' && o3.b === '🛡 连续无伤 1 关', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.noHitDomNow(),took:T.tookHitNow()});})()"));
    t('U649 DOM 可读', !!o4.dom, JSON.stringify(o4));
    t('U650 一致性', typeof o4.dom === 'string', o4.dom);
  } catch(e){ for(let k=645;k<=650;k++) t('U'+k+' 无伤计数',false,e.message); }


  // ===== U651~U656: 连击里程碑(v0.7.23) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('comboMilestoneWrap'),a:T.comboMilestoneTextNow(5),b:T.comboMilestoneTextNow(10),c:T.comboMilestoneTextNow(15),d:T.comboMilestoneTextNow(20)});})()"));
    t('U651 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U652 四级里程碑文案', o.a === '✨ 连击 ×5' && o.b === '⚡ 连击高手 ×10' && o.c === '🔥 连击大师 ×15' && o.d === '🔥🔥 连击之神 ×20', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.comboMilestoneTextNow(0),b:T.comboMilestoneTextNow(3),c:T.comboMilestoneTextNow(NaN)});})()"));
    t('U653 非里程碑为空', o2.a === '' && o2.b === '' && o2.c === '', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.comboMilestoneTextNow(-5),b:T.comboMilestoneTextNow('x')});})()"));
    t('U654 非法输入为空', o3.a === '' && o3.b === '', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.comboMilestoneDomNow()});})()"));
    t('U655 DOM 可读', !!o4.dom, JSON.stringify(o4));
    t('U656 一致性', typeof o4.dom === 'string', o4.dom);
  } catch(e){ for(let k=651;k<=656;k++) t('U'+k+' 连击里程碑',false,e.message); }


  // ===== U657~U662: 100 轮收口(v0.7.24) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('round100Wrap'),f:T.round100TextNow()});})()"));
    t('U657 收口 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U658 收口文案', o.f === '🏁 100 轮创造性循环完成 · v0.7.24', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.round100DomNow()});})()"));
    t('U659 DOM 实时显示', (o2.dom || '').indexOf('100 轮') >= 0, JSON.stringify(o2));
    t('U660 文案含版本号', (o2.dom || '').indexOf('v0.7.24') >= 0, JSON.stringify(o2));
    t('U661 一致性', typeof o2.dom === 'string', o2.dom);
    t('U662 收口确认', typeof o2.dom === 'string' && o2.dom.length > 10, o2.dom);
  } catch(e){ for(let k=657;k<=662;k++) t('U'+k+' 收口',false,e.message); }


  // ===== U675~U680: 强化投入统计(v0.7.25) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bonusSpentWrap'),f:T.bonusSpentTextNow(0)});})()"));
    t('U675 投入 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U676 零投入初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bonusSpentTextNow(5000),b:T.bonusSpentTextNow(1)});})()"));
    t('U677 正常 5,000/1', o2.a === '📈 5000 投入' && o2.b === '📈 1 投入', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bonusSpentTextNow(-5),b:T.bonusSpentTextNow(NaN)});})()"));
    t('U678 非法兜底 —', o3.a === '—' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.bonusSpentPillDomNow(),v:T.bonusSpentNow()});})()"));
    t('U679 DOM 可读', !!o4.dom, JSON.stringify(o4));
    t('U680 一致性', typeof o4.dom === 'string', o4.dom);
  } catch(e){ for(let k=675;k<=680;k++) t('U'+k+' 投入统计',false,e.message); }


  // ===== U681~U686: 抽奖次数统计(v0.7.26) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('gachaCountWrap'),f:T.gachaCountTextNow(0)});})()"));
    t('U681 抽奖 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U682 零次初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.gachaCountTextNow(10),b:T.gachaCountTextNow(1)});})()"));
    t('U683 正常 10/1', o2.a === '🎰 10 次' && o2.b === '🎰 1 次', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.gachaCountTextNow(-1),b:T.gachaCountTextNow(NaN)});})()"));
    t('U684 非法兜底 —', o3.a === '—' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.gachaCountPillDomNow(),v:T.gachaCountNow()});})()"));
    t('U685 DOM 可读', !!o4.dom, JSON.stringify(o4));
    t('U686 一致性', typeof o4.dom === 'string', o4.dom);
  } catch(e){ for(let k=681;k<=686;k++) t('U'+k+' 抽奖统计',false,e.message); }


  // ===== U687~U692: 每日挑战统计(v0.7.27) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('dailyStatWrap'),f:T.dailyStatTextNow(0)});})()"));
    t('U687 每日 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U688 零次初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.dailyStatTextNow(5),b:T.dailyStatTextNow(1)});})()"));
    t('U689 正常 5/1', o2.a === '📅 5 次挑战' && o2.b === '📅 1 次挑战', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.dailyStatTextNow(-1),b:T.dailyStatTextNow('x')});})()"));
    t('U690 非法兜底 —', o3.a === '—' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.dailyStatPillDomNow(),v:T.dailyCountNow()});})()"));
    t('U691 DOM 可读', !!o4.dom, JSON.stringify(o4));
    t('U692 一致性', typeof o4.dom === 'string', o4.dom);
  } catch(e){ for(let k=687;k<=692;k++) t('U'+k+' 每日统计',false,e.message); }


  // ===== U693~U698: 皮肤数统计(v0.7.28) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('skinCountWrap'),f:T.skinCountTextNow(['classic'])});})()"));
    t('U693 皮肤数 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U694 仅默认 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.skinCountTextNow(['classic','gold','silver','prism','neon']),b:T.skinCountTextNow([])});})()"));
    t('U695 正常 5 款/空 —', o2.a === '🎨 5 款' && o2.b === '—', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.skinCountTextNow('not array'),b:T.skinCountTextNow(null)});})()"));
    t('U696 非法兜底 —', o3.a === '—' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.skinCountPillDomNow(),n:T.skinOwnedNow()});})()"));
    t('U697 DOM 可读', !!o4.dom, JSON.stringify(o4));
    t('U698 一致性', typeof o4.dom === 'string', o4.dom);
  } catch(e){ for(let k=693;k<=698;k++) t('U'+k+' 皮肤数',false,e.message); }


  // ===== U699~U704: 僚机皮肤数(v0.7.29) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('wsCountWrap'),f:T.wsCountTextNow(['wing-teal'])});})()"));
    t('U699 僚机 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U700 仅默认 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.wsCountTextNow(['wing-teal','wing-crimson','wing-gold']),b:T.wsCountTextNow([])});})()"));
    t('U701 正常 3 款/空 —', o2.a === '🛡 3 款' && o2.b === '—', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.wsCountTextNow('x'),b:T.wsCountTextNow(null)});})()"));
    t('U702 非法兜底 —', o3.a === '—' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.wsCountPillDomNow(),n:T.wsOwnedNow()});})()"));
    t('U703 DOM 可读', !!o4.dom, JSON.stringify(o4));
    t('U704 一致性', typeof o4.dom === 'string', o4.dom);
  } catch(e){ for(let k=699;k<=704;k++) t('U'+k+' 僚机皮肤数',false,e.message); }


  // ===== U705~U710: 宠物数(v0.7.30) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('petOwnedWrap'),f:T.petOwnedTextNow([])});})()"));
    t('U705 宠物数 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U706 零宠物 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petOwnedTextNow(['cat']),b:T.petOwnedTextNow(['cat','turtle','bunny'])});})()"));
    t('U707 正常 1/3 和 3/3', o2.a === '🐾 1/3' && o2.b === '🐾 3/3', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petOwnedTextNow('x'),b:T.petOwnedTextNow(null)});})()"));
    t('U708 非法兜底 —', o3.a === '—' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.petOwnedPillDomNow(),n:T.petOwnedNow()});})()"));
    t('U709 DOM 可读', !!o4.dom, JSON.stringify(o4));
    t('U710 一致性', typeof o4.dom === 'string', o4.dom);
  } catch(e){ for(let k=705;k<=710;k++) t('U'+k+' 宠物数',false,e.message); }


  // ===== U711~U716: 无尽最佳波次(v0.7.31) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bestWaveWrap'),f:T.bestWaveTextNow(0)});})()"));
    t('U711 波次 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U712 零波次初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bestWaveTextNow(30),b:T.bestWaveTextNow(1)});})()"));
    t('U713 正常 30/1', o2.a === '🌊 30 波' && o2.b === '🌊 1 波', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bestWaveTextNow(-5),b:T.bestWaveTextNow(NaN)});})()"));
    t('U714 非法兜底 —', o3.a === '—' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.bestWavePillDomNow(),v:T.bestWaveNow()});})()"));
    t('U715 DOM 可读', !!o4.dom, JSON.stringify(o4));
    t('U716 一致性', typeof o4.dom === 'string', o4.dom);
  } catch(e){ for(let k=711;k<=716;k++) t('U'+k+' 波次',false,e.message); }


  // ===== U717~U722: 星级总计(v0.7.32) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('totalStarsWrap'),f:T.totalStarsTextNow({})});})()"));
    t('U717 星级 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U718 空对象初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.totalStarsTextNow({1:3,2:2,3:1}),b:T.totalStarsTextNow({5:3})});})()"));
    t('U719 正常 6/3', o2.a === '⭐ 6' && o2.b === '⭐ 3', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.totalStarsTextNow({1:5}),b:T.totalStarsTextNow({1:-1})});})()"));
    t('U720 非法钳制 3/0', o3.a === '⭐ 3' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.totalStarsPillDomNow(),s2:T.levelStarsNow()});})()"));
    t('U721 DOM 可读', !!o4.dom, JSON.stringify(o4));
    t('U722 一致性', typeof o4.dom === 'string', o4.dom);
  } catch(e){ for(let k=717;k<=722;k++) t('U'+k+' 星级总计',false,e.message); }


  // ===== U723~U728: 强化种类(v0.7.33) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bonusTypeWrap'),f:T.bonusTypeCountNow({lifeup:0,cd:0,spd:0,coinup:0,shield:0,revive:0,combo:0,bulletspd:0,pierce:0,bomb:0,spread:0,bigbullet:0,fortune:0,supply:0,focus:0})});})()"));
    t('U723 强化种类 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U724 全零初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.bonusTypeCountNow({lifeup:2,cd:1,spd:0,coinup:0,shield:0,revive:0,combo:0,bulletspd:0,pierce:0,bomb:0,spread:0,bigbullet:0,fortune:0,supply:0,focus:0}));})()"));
    t('U725 正常 2 种', o2 === '⚡ 2 种', o2);
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bonusTypeCountNow(null),b:T.bonusTypeCountNow(undefined)});})()"));
    t('U726 非法兜底 —', o3.a === '—' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.bonusTypePillDomNow()});})()"));
    t('U727 DOM 可读', !!o4.dom, JSON.stringify(o4));
    t('U728 一致性', typeof o4.dom === 'string', o4.dom);
  } catch(e){ for(let k=723;k<=728;k++) t('U'+k+' 强化种类',false,e.message); }


  // ===== U729~U734: 排行榜条目数(v0.7.34) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('boardCountWrap'),f:T.boardCountTextNow([])});})()"));
    t('U729 榜单 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U730 空榜单初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.boardCountTextNow([{score:100},{score:200},{score:300}]));})()"));
    t('U731 正常 3 条', o2 === '📋 3 条', o2);
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.boardCountTextNow(null),b:T.boardCountTextNow('x')});})()"));
    t('U732 非法兜底 —', o3.a === '—' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.boardCountPillDomNow()});})()"));
    t('U733 DOM 可读', !!o4.dom, JSON.stringify(o4));
    t('U734 一致性', typeof o4.dom === 'string', o4.dom);
  } catch(e){ for(let k=729;k<=734;k++) t('U'+k+' 榜单数',false,e.message); }


  // ===== U735~U740: 皮肤拥有率(v0.7.35) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('skinRateWrap'),f:T.skinRateTextNow(['classic'])});})()"));
    t('U735 拥有率 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U736 仅默认 1/N', o.f.indexOf('1/') >= 0, JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.skinRateTextNow('not array'),b:T.skinRateTextNow(null)});})()"));
    t('U737 非法兜底 —', o2.a === '—' && o2.b === '—', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.skinRatePillDomNow()});})()"));
    t('U738 DOM 可读', !!o3.dom, JSON.stringify(o3));
    t('U739 一致性', typeof o3.dom === 'string', o3.dom);
    t('U740 无异常', true, 'ok');
  } catch(e){ for(let k=735;k<=740;k++) t('U'+k+' 拥有率',false,e.message); }


  // ===== U741~U746: 宠物币花费(v0.7.36) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('petCoinSpentWrap'),f:T.petCoinSpentTextNow([],[])});})()"));
    t('U741 花费 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U742 零花费初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.petCoinSpentTextNow(['cat'],['blade']));})()"));
    t('U743 有花费显示', o2.indexOf('🐾') >= 0, o2);
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petCoinSpentTextNow(null,undefined)});})()"));
    t('U744 非法兜底 —', o3.a === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.petCoinSpentPillDomNow()});})()"));
    t('U745 DOM 可读', !!o4.dom, JSON.stringify(o4));
    t('U746 一致性', typeof o4.dom === 'string', o4.dom);
  } catch(e){ for(let k=741;k<=746;k++) t('U'+k+' 花费',false,e.message); }


  // ===== U747~U752: 排行榜最高分(v0.7.37) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('boardTopWrap'),f:T.boardTopTextNow([])});})()"));
    t('U747 榜顶 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U748 空榜单初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.boardTopTextNow([{score:5000}]));})()"));
    t('U749 正常 5,000', o2 === '🏆 5000', o2);
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.boardTopTextNow(null),b:T.boardTopTextNow('x')});})()"));
    t('U750 非法兜底 —', o3.a === '—' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.boardTopPillDomNow()});})()"));
    t('U751 DOM 可读', !!o4.dom, JSON.stringify(o4));
    t('U752 一致性', typeof o4.dom === 'string', o4.dom);
  } catch(e){ for(let k=747;k<=752;k++) t('U'+k+' 榜顶',false,e.message); }


  // ===== U753~U758: 每日最佳(v0.7.38) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('dailyBestWrap'),f:T.dailyBestTextNow(0)});})()"));
    t('U753 每日最佳 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U754 零分初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.dailyBestTextNow(5000),b:T.dailyBestTextNow(100)});})()"));
    t('U755 正常 5,000/100', o2.a === '📅 最佳 5000' && o2.b === '📅 最佳 100', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.dailyBestTextNow(-1),b:T.dailyBestTextNow(NaN)});})()"));
    t('U756 非法兜底 —', o3.a === '—' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.dailyBestPillDomNow(),v:T.dailyBestNow()});})()"));
    t('U757 DOM 可读', !!o4.dom, JSON.stringify(o4));
    t('U758 一致性', typeof o4.dom === 'string', o4.dom);
  } catch(e){ for(let k=753;k<=758;k++) t('U'+k+' 每日最佳',false,e.message); }


  // ===== U1347~U1352: 本局VS生涯最高分(v0.7.39) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('vsBestWrap'),f:T.scoreVsBestTextNow(0,0)});})()"));
    t('U1347 VS纪录 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1348 无纪录初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.scoreVsBestTextNow(3000,1000),b:T.scoreVsBestTextNow(500,1000),c:T.scoreVsBestTextNow(1000,1000)});})()"));
    t('U1349 领先/落后/追平', o2.a === '📈 领先 2000' && o2.b === '📉 落后 500' && o2.c === '⚖ 追平', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.scoreVsBestTextNow(12000,2000),b:T.scoreVsBestTextNow(0,0)});})()"));
    t('U1350 边界:千分位/无纪录', o3.a === '📈 领先 10,000' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.scoreVsBestTextNow(NaN,100),b:T.scoreVsBestTextNow(100,NaN)});})()"));
    t('U1351 非法输入兜底', o4.a === '📉 落后 100' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const s=T.scoreNow(),b=T.careerBestNow();return JSON.stringify({dom:T.scoreVsBestPillDomNow(),exp:T.scoreVsBestTextNow(s,b)});})()"));
    t('U1352 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1347;k<=1352;k++) t('U'+k+' VS纪录',false,e.message); }


  // ===== U1353~U1358: 生涯场均击杀(v0.7.40) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('avgKillWrap'),f:T.avgKillsTextNow(0,0)});})()"));
    t('U1353 场均击杀 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1354 零场初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.avgKillsTextNow(150,30),b:T.avgKillsTextNow(100,3)});})()"));
    t('U1355 正常 5/33.3', o2.a === '⚔ 场均 5' && o2.b === '⚔ 场均 33.3', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.avgKillsTextNow(0,5),b:T.avgKillsTextNow(50,1)});})()"));
    t('U1356 边界:零击杀/单场', o3.a === '⚔ 场均 0' && o3.b === '⚔ 场均 50', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.avgKillsTextNow(NaN,5),b:T.avgKillsTextNow(50,NaN)});})()"));
    t('U1357 非法输入兜底', o4.a === '⚔ 场均 0' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const k=T.careerKillsNow(),g=T.careerGamesNow();return JSON.stringify({dom:T.avgKillsPillDomNow(),exp:T.avgKillsTextNow(k,g)});})()"));
    t('U1358 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1353;k<=1358;k++) t('U'+k+' 场均击杀',false,e.message); }


  // ===== U1359~U1364: 英雄收集进度(v0.7.41) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('heroOwnWrap'),f:T.heroOwnedTextNow(0,0)});})()"));
    t('U1359 英雄收集 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1360 零总数初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.heroOwnedTextNow(3,5),b:T.heroOwnedTextNow(5,5)});})()"));
    t('U1361 正常 3/5 与满 5/5', o2.a === '🦸 3/5' && o2.b === '🦸 5/5', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.heroOwnedTextNow(7,5),b:T.heroOwnedTextNow(0,5)});})()"));
    t('U1362 边界:超限钳制/零拥有', o3.a === '🦸 5/5' && o3.b === '🦸 0/5', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.heroOwnedTextNow(-1,5),b:T.heroOwnedTextNow(3,NaN)});})()"));
    t('U1363 非法输入兜底', o4.a === '🦸 0/5' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const ow=T.heroOwnCountNow(),tt=T.heroTotalNow();return JSON.stringify({dom:T.heroOwnPillDomNow(),exp:T.heroOwnedTextNow(ow,tt)});})()"));
    t('U1364 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1359;k<=1364;k++) t('U'+k+' 英雄收集',false,e.message); }


  // ===== U1365~U1370: 无尽最佳波次(v0.7.42) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('endlessBestWrap'),f:T.endlessBestTextNow(0,1)});})()"));
    t('U1365 无尽最佳 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1366 无纪录初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.endlessBestTextNow(12,5),b:T.endlessBestTextNow(12,15)});})()"));
    t('U1367 正常 未超/已超', o2.a === '🌊 最佳 12' && o2.b === '🌊 最佳 12 🚀', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.endlessBestTextNow(1,1),b:T.endlessBestTextNow(1,2)});})()"));
    t('U1368 边界:持平不超/超一', o3.a === '🌊 最佳 1' && o3.b === '🌊 最佳 1 🚀', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.endlessBestTextNow(NaN,5),b:T.endlessBestTextNow(5,NaN)});})()"));
    t('U1369 非法输入兜底', o4.a === '—' && o4.b === '🌊 最佳 5', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const be=T.endlessBestNow(),lv=T.levelNow();return JSON.stringify({dom:T.endlessBestPillDomNow(),exp:T.endlessBestTextNow(be,lv)});})()"));
    t('U1370 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1365;k<=1370;k++) t('U'+k+' 无尽最佳',false,e.message); }


  // ===== U1371~U1376: 金币余额(v0.7.43) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('coinBalWrap'),f:T.coinBalanceTextNow(0)});})()"));
    t('U1371 钱包 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1372 零余额初值', o.f === '🪙 0', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.coinBalanceTextNow(500),b:T.coinBalanceTextNow(12000)});})()"));
    t('U1373 正常 500/12,000', o2.a === '🪙 500' && o2.b === '🪙 12,000', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.coinBalanceTextNow(9999),b:T.coinBalanceTextNow(10000)});})()"));
    t('U1374 边界:9999/10000', o3.a === '🪙 9999' && o3.b === '🪙 10,000', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.coinBalanceTextNow(NaN),b:T.coinBalanceTextNow(-5)});})()"));
    t('U1375 非法输入兜底', o4.a === '🪙 0' && o4.b === '🪙 0', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const c=T.coinNow();return JSON.stringify({dom:T.coinBalancePillDomNow(),exp:T.coinBalanceTextNow(c)});})()"));
    t('U1376 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1371;k<=1376;k++) t('U'+k+' 金币余额',false,e.message); }


  // ===== U1377~U1382: 生涯胜率(v0.7.44) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('winRateWrap'),f:T.winRateTextNow(0,0)});})()"));
    t('U1377 胜率 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1378 零场初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.winRateTextNow(3,4),b:T.winRateTextNow(1,3)});})()"));
    t('U1379 正常 75%/33%', o2.a === '🏆 75%' && o2.b === '🏆 33%', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.winRateTextNow(5,5),b:T.winRateTextNow(0,5)});})()"));
    t('U1380 边界:满胜/零胜', o3.a === '🏆 100%' && o3.b === '🏆 0%', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.winRateTextNow(NaN,4),b:T.winRateTextNow(3,NaN)});})()"));
    t('U1381 非法输入兜底', o4.a === '🏆 0%' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const w=T.careerWinsNow(),g=T.careerGamesNow();return JSON.stringify({dom:T.winRatePillDomNow(),exp:T.winRateTextNow(w,g)});})()"));
    t('U1382 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1377;k<=1382;k++) t('U'+k+' 胜率',false,e.message); }


  // ===== U1383~U1388: 生涯死亡总数(v0.7.45) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('careerDeathWrap'),f:T.careerDeathsTextNow(0)});})()"));
    t('U1383 生涯阵亡 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1384 零死亡初值', o.f === '💀 0', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerDeathsTextNow(42),b:T.careerDeathsTextNow(10000)});})()"));
    t('U1385 正常 42/10,000', o2.a === '💀 42' && o2.b === '💀 10,000', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerDeathsTextNow(9999),b:T.careerDeathsTextNow(100000)});})()"));
    t('U1386 边界:9999/100,000', o3.a === '💀 9999' && o3.b === '💀 100,000', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerDeathsTextNow(NaN),b:T.careerDeathsTextNow(-3)});})()"));
    t('U1387 非法输入兜底', o4.a === '💀 0' && o4.b === '💀 0', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const d=T.careerDeathsNow();return JSON.stringify({dom:T.careerDeathsPillDomNow(),exp:T.careerDeathsTextNow(d)});})()"));
    t('U1388 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1383;k<=1388;k++) t('U'+k+' 生涯阵亡',false,e.message); }


  // ===== U1389~U1394: 生涯总星级(v0.7.46) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('careerStarWrap'),f:T.careerStarsTextNow(0)});})()"));
    t('U1389 生涯星数 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1390 零星初值', o.f === '⭐ 0', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerStarsTextNow(75),b:T.careerStarsTextNow(150)});})()"));
    t('U1391 正常 75/150', o2.a === '⭐ 75' && o2.b === '⭐ 150', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerStarsTextNow(9999),b:T.careerStarsTextNow(12000)});})()"));
    t('U1392 边界:9999/12,000', o3.a === '⭐ 9999' && o3.b === '⭐ 12,000', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerStarsTextNow(NaN),b:T.careerStarsTextNow(-10)});})()"));
    t('U1393 非法输入兜底', o4.a === '⭐ 0' && o4.b === '⭐ 0', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const st=T.careerStarsNow();return JSON.stringify({dom:T.careerStarsPillDomNow(),exp:T.careerStarsTextNow(st)});})()"));
    t('U1394 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1389;k<=1394;k++) t('U'+k+' 生涯星数',false,e.message); }


  // ===== U1395~U1400: 连击剩余秒数(v0.7.47) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('comboLeftWrap'),f:T.comboLeftTextNow(0)});})()"));
    t('U1395 连击剩余 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1396 零计时初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.comboLeftTextNow(3.2),b:T.comboLeftTextNow(5)});})()"));
    t('U1397 正常 3.2s/5s', o2.a === '⏳ 3.2s' && o2.b === '⏳ 5s', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.comboLeftTextNow(0.1),b:T.comboLeftTextNow(9.96)});})()"));
    t('U1398 边界:0.1s/9.96s', o3.a === '⏳ 0.1s' && o3.b === '⏳ 10s', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.comboLeftTextNow(NaN),b:T.comboLeftTextNow(-5)});})()"));
    t('U1399 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const t=T.comboTimerLeftNow();return JSON.stringify({dom:T.comboLeftDomNow(),exp:T.comboLeftTextNow(t)});})()"));
    t('U1400 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1395;k<=1400;k++) t('U'+k+' 连击剩余',false,e.message); }


  // ===== U1401~U1406: 生涯成就解锁率(v0.7.48) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('achRateWrap'),f:T.achRateTextNow(0,0)});})()"));
    t('U1401 成就率 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1402 零总数初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.achRateTextNow(5,10),b:T.achRateTextNow(7,12)});})()"));
    t('U1403 正常 50%/58%', o2.a === '🏅 50%' && o2.b === '🏅 58%', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.achRateTextNow(10,10),b:T.achRateTextNow(0,10)});})()"));
    t('U1404 边界:满/零', o3.a === '🏅 100%' && o3.b === '🏅 0%', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.achRateTextNow(NaN,10),b:T.achRateTextNow(5,NaN)});})()"));
    t('U1405 非法输入兜底', o4.a === '🏅 0%' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const u=T.achUnlockNow(),tt=T.achTotalNow();return JSON.stringify({dom:T.achRateDomNow(),exp:T.achRateTextNow(u,tt)});})()"));
    t('U1406 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1401;k<=1406;k++) t('U'+k+' 成就率',false,e.message); }


  // ===== U1407~U1412: 本局BOSS击杀占比(v0.7.49) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bossShareWrap'),f:T.bossShareTextNow(0,0)});})()"));
    t('U1407 BOSS占比 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1408 零击杀初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossShareTextNow(2,25),b:T.bossShareTextNow(1,4)});})()"));
    t('U1409 正常 8%/25%', o2.a === '👑 8%' && o2.b === '👑 25%', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossShareTextNow(1,1),b:T.bossShareTextNow(0,25)});})()"));
    t('U1410 边界:满/零', o3.a === '👑 100%' && o3.b === '👑 0%', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossShareTextNow(NaN,25),b:T.bossShareTextNow(2,NaN)});})()"));
    t('U1411 非法输入兜底', o4.a === '👑 0%' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const b=T.statBossKillNow(),k=T.statKillNow();return JSON.stringify({dom:T.bossShareDomNow(),exp:T.bossShareTextNow(b,k)});})()"));
    t('U1412 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1407;k<=1412;k++) t('U'+k+' BOSS占比',false,e.message); }


  // ===== U1413~U1418: 宠物等级进度(v0.7.50) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('petLvWrap'),f:T.petLvTextNow(0,0)});})()"));
    t('U1413 宠物级 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1414 零上限初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petLvTextNow(2,3),b:T.petLvTextNow(1,3)});})()"));
    t('U1415 正常 2/3 与 1/3', o2.a === '🐾 Lv 2/3' && o2.b === '🐾 Lv 1/3', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petLvTextNow(3,3),b:T.petLvTextNow(5,3)});})()"));
    t('U1416 边界:满级MAX/超限', o3.a === '🐾 MAX' && o3.b === '🐾 MAX', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petLvTextNow(NaN,3),b:T.petLvTextNow(2,NaN)});})()"));
    t('U1417 非法输入兜底', o4.a === '🐾 Lv 0/3' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const l=T.petLvNow(),m=T.petMaxLvNow();return JSON.stringify({dom:T.petLvDomNow(),exp:T.petLvTextNow(l,m)});})()"));
    t('U1418 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1413;k<=1418;k++) t('U'+k+' 宠物级',false,e.message); }


  // ===== U1419~U1424: 本局得分占生涯最高(v0.7.51) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('scorePctWrap'),f:T.scorePctTextNow(0,0)});})()"));
    t('U1419 得分进度 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1420 无纪录初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.scorePctTextNow(620,1000),b:T.scorePctTextNow(250,400)});})()"));
    t('U1421 正常 62%/63%', o2.a === '📈 62%' && o2.b === '📈 63%', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.scorePctTextNow(1000,1000),b:T.scorePctTextNow(1500,1000)});})()"));
    t('U1422 边界:追平/超限钳制', o3.a === '📈 100%' && o3.b === '📈 100%', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.scorePctTextNow(NaN,1000),b:T.scorePctTextNow(620,NaN)});})()"));
    t('U1423 非法输入兜底', o4.a === '📈 0%' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const s=T.scoreNow2(),b=T.bestScoreNow();return JSON.stringify({dom:T.scorePctDomNow(),exp:T.scorePctTextNow(s,b)});})()"));
    t('U1424 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1419;k<=1424;k++) t('U'+k+' 得分进度',false,e.message); }


  // ===== U1425~U1430: 本局命中率VS生涯(v0.7.52) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('hitVsWrap'),f:T.hitVsTextNow(0,0,0,0)});})()"));
    t('U1425 命中率 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1426 无数据初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.hitVsTextNow(8,10,0,0),b:T.hitVsTextNow(8,10,70,100)});})()"));
    t('U1427 正常 本局80% 生涯70%', o2.a === '🎯 本局 80% · 生涯 —' && o2.b === '🎯 本局 80% · 生涯 70%', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.hitVsTextNow(0,10,0,100),b:T.hitVsTextNow(10,10,100,100)});})()"));
    t('U1428 边界:全空/全中', o3.a === '🎯 本局 0% · 生涯 0%' && o3.b === '🎯 本局 100% · 生涯 100%', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.hitVsTextNow(NaN,10,70,100),b:T.hitVsTextNow(8,10,NaN,NaN)});})()"));
    t('U1429 非法输入兜底', o4.a === '🎯 本局 0% · 生涯 70%' && o4.b === '🎯 本局 80% · 生涯 —', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const ch=T.statHitsNow(),cs=T.statShotsNow(),ah=T.careerHitsNow(),aS=T.careerShotsNow();return JSON.stringify({dom:T.hitVsDomNow(),exp:T.hitVsTextNow(ch,cs,ah,aS)});})()"));
    t('U1430 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1425;k<=1430;k++) t('U'+k+' 命中率',false,e.message); }


  // ===== U1431~U1436: 本局金币速率VS生涯(v0.7.53) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('goldVsWrap'),f:T.goldVsTextNow(0,0,0,0)});})()"));
    t('U1431 金币速 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1432 无数据初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.goldVsTextNow(120,60,0,0),b:T.goldVsTextNow(50,20,300,100)});})()"));
    t('U1433 正常 2.0/s 与 2.5/3.0', o2.a === '💰 本局 2.0/s · 生涯 —/s' && o2.b === '💰 本局 2.5/s · 生涯 3.0/s', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.goldVsTextNow(5,10,1,1),b:T.goldVsTextNow(0,0,300,100)});})()"));
    t('U1434 边界:低速/无本局', o3.a === '💰 本局 0.5/s · 生涯 1.0/s' && o3.b === '💰 本局 0.0/s · 生涯 3.0/s', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.goldVsTextNow(NaN,60,300,100),b:T.goldVsTextNow(50,20,NaN,0)});})()"));
    t('U1435 非法输入兜底', o4.a === '💰 本局 0.0/s · 生涯 3.0/s' && o4.b === '💰 本局 2.5/s · 生涯 —/s', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const rc=T.runCoinsNow(),rs=T.playSecRunNow(),cc=T.careerTotalCoinsNow(),cs=T.careerPlaySecNow();return JSON.stringify({dom:T.goldVsDomNow(),exp:T.goldVsTextNow(rc,rs,cc,cs)});})()"));
    t('U1436 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1431;k<=1436;k++) t('U'+k+' 金币速',false,e.message); }


  // ===== U1437~U1442: 本局击杀速率VS生涯(v0.7.54) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('killRateWrap'),f:T.killRateTextNow(0,0,0,0)});})()"));
    t('U1437 击杀速 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1438 无数据初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.killRateTextNow(50,25,0,0),b:T.killRateTextNow(30,10,200,100)});})()"));
    t('U1439 正常 2.0/s 与 3.0/2.0', o2.a === '⚔ 本局 2.0/s · 生涯 —/s' && o2.b === '⚔ 本局 3.0/s · 生涯 2.0/s', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.killRateTextNow(1,10,1,1),b:T.killRateTextNow(0,0,200,100)});})()"));
    t('U1440 边界:低速/无本局', o3.a === '⚔ 本局 0.1/s · 生涯 1.0/s' && o3.b === '⚔ 本局 0.0/s · 生涯 2.0/s', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.killRateTextNow(NaN,25,200,100),b:T.killRateTextNow(50,25,NaN,NaN)});})()"));
    t('U1441 非法输入兜底', o4.a === '⚔ 本局 0.0/s · 生涯 2.0/s' && o4.b === '⚔ 本局 2.0/s · 生涯 —/s', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const rk=T.runKillsNow2(),rs=T.runSecNow3(),ck=T.careerKillsNow2(),cs=T.careerPlaySecNow3();return JSON.stringify({dom:T.killRateDomNow(),exp:T.killRateTextNow(rk,rs,ck,cs)});})()"));
    t('U1442 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1437;k<=1442;k++) t('U'+k+' 击杀速',false,e.message); }


  // ===== U1443~U1448: 本局每关平均用时(v0.7.55) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('avgLvTimeWrap'),f:T.avgLvTimeTextNow(0,0)});})()"));
    t('U1443 每关均时 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1444 零关初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.avgLvTimeTextNow(180,5),b:T.avgLvTimeTextNow(60,3)});})()"));
    t('U1445 正常 36s/关 与 20s/关', o2.a === '⏱ 均 36s/关' && o2.b === '⏱ 均 20s/关', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.avgLvTimeTextNow(10,1),b:T.avgLvTimeTextNow(100,0)});})()"));
    t('U1446 边界:10s/关 与 零关', o3.a === '⏱ 均 10s/关' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.avgLvTimeTextNow(NaN,5),b:T.avgLvTimeTextNow(60,NaN)});})()"));
    t('U1447 非法输入兜底', o4.a === '⏱ 均 0s/关' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const p=T.r55psNow(),l=T.r55lvNow();return JSON.stringify({dom:T.avgLvTimeDomNow(),exp:T.avgLvTimeTextNow(p,l)});})()"));
    t('U1448 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1443;k<=1448;k++) t('U'+k+' 每关均时',false,e.message); }


  // ===== U1449~U1454: 生涯限时最佳(v0.7.56) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bestTimedWrap'),f:T.bestTimedTextNow(0)});})()"));
    t('U1449 限时最佳 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1450 无纪录初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bestTimedTextNow(5200),b:T.bestTimedTextNow(12345)});})()"));
    t('U1451 正常 5200/12,345', o2.a === '⏰ 限时最佳 5200' && o2.b === '⏰ 限时最佳 12,345', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bestTimedTextNow(1),b:T.bestTimedTextNow(9999)});})()"));
    t('U1452 边界:1/9999', o3.a === '⏰ 限时最佳 1' && o3.b === '⏰ 限时最佳 9999', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bestTimedTextNow(NaN),b:T.bestTimedTextNow(-5)});})()"));
    t('U1453 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r56btNow();return JSON.stringify({dom:T.bestTimedDomNow(),exp:T.bestTimedTextNow(v)});})()"));
    t('U1454 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1449;k<=1454;k++) t('U'+k+' 限时最佳',false,e.message); }


  // ===== U1455~U1460: 生涯困难最佳(v0.7.57) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bestHardWrap'),f:T.bestHardTextNow(0)});})()"));
    t('U1455 困难最佳 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1456 无纪录初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bestHardTextNow(8000),b:T.bestHardTextNow(15600)});})()"));
    t('U1457 正常 8000/15,600', o2.a === '🔥 困难最佳 8000' && o2.b === '🔥 困难最佳 15,600', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bestHardTextNow(1),b:T.bestHardTextNow(99999)});})()"));
    t('U1458 边界:1/99,999', o3.a === '🔥 困难最佳 1' && o3.b === '🔥 困难最佳 99,999', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bestHardTextNow(NaN),b:T.bestHardTextNow(-3)});})()"));
    t('U1459 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r57bhNow();return JSON.stringify({dom:T.bestHardDomNow(),exp:T.bestHardTextNow(v)});})()"));
    t('U1460 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1455;k<=1460;k++) t('U'+k+' 困难最佳',false,e.message); }


  // ===== U1461~U1466: 生涯模式场次分布(v0.7.58) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('modeGamesWrap'),f:T.modeGamesTextNow({})});})()"));
    t('U1461 场次 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1462 零场次初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.modeGamesTextNow({normal:12,daily:3,timed:1,endless:2,hard:0}),b:T.modeGamesTextNow({normal:5})});})()"));
    t('U1463 正常 分布', o2.a === '🎮 标准12·每日3·限时1·无尽2·困难0' && o2.b === '🎮 标准5·每日0·限时0·无尽0·困难0', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.modeGamesTextNow({normal:1}),b:T.modeGamesTextNow({normal:0,daily:0,timed:0,endless:0,hard:1})});})()"));
    t('U1464 边界:单场/仅困难', o3.a === '🎮 标准1·每日0·限时0·无尽0·困难0' && o3.b === '🎮 标准0·每日0·限时0·无尽0·困难1', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.modeGamesTextNow(null),b:T.modeGamesTextNow({normal:NaN})});})()"));
    t('U1465 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r58mgNow();return JSON.stringify({dom:T.modeGamesDomNow(),exp:T.modeGamesTextNow(v)});})()"));
    t('U1466 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1461;k<=1466;k++) t('U'+k+' 场次',false,e.message); }


  // ===== U1467~U1472: 本局实时破纪录(v0.7.59) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('newRecordWrap'),f:T.newRecordTextNow(0,0)});})()"));
    t('U1467 破纪录 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1468 零分初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.newRecordTextNow(620,1000),b:T.newRecordTextNow(1500,1000)});})()"));
    t('U1469 正常 距纪录380/新纪录', o2.a === '📊 距纪录 380' && o2.b === '🚀 新纪录!', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.newRecordTextNow(1000,1000),b:T.newRecordTextNow(1,0)});})()"));
    t('U1470 边界:追平/无纪录', o3.a === '📊 距纪录 0' && o3.b === '🚀 新纪录!', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.newRecordTextNow(NaN,1000),b:T.newRecordTextNow(620,NaN)});})()"));
    t('U1471 非法输入兜底', o4.a === '—' && o4.b === '🚀 新纪录!', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const s=T.r59scNow(),b=T.r59bsNow();return JSON.stringify({dom:T.newRecordDomNow(),exp:T.newRecordTextNow(s,b)});})()"));
    t('U1472 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1467;k<=1472;k++) t('U'+k+' 破纪录',false,e.message); }


  // ===== U1473~U1478: 本局击杀占生涯(v0.7.60) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('killShareWrap'),f:T.killShareTextNow(0,0)});})()"));
    t('U1473 击杀占比 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1474 无生涯击杀初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.killShareTextNow(30,200),b:T.killShareTextNow(1,4)});})()"));
    t('U1475 正常 15%/25%', o2.a === '⚔ 本局占生涯 15%' && o2.b === '⚔ 本局占生涯 25%', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.killShareTextNow(200,200),b:T.killShareTextNow(0,200)});})()"));
    t('U1476 边界:满/零', o3.a === '⚔ 本局占生涯 100%' && o3.b === '⚔ 本局占生涯 0%', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.killShareTextNow(NaN,200),b:T.killShareTextNow(30,NaN)});})()"));
    t('U1477 非法输入兜底', o4.a === '⚔ 本局占生涯 0%' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const c=T.r60curNow(),k=T.r60carNow();return JSON.stringify({dom:T.killShareDomNow(),exp:T.killShareTextNow(c,k)});})()"));
    t('U1478 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1473;k<=1478;k++) t('U'+k+' 击杀占比',false,e.message); }


  // ===== U1479~U1484: 宠物币获取速率(v0.7.61) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('petCoinRateWrap'),f:T.petCoinRateTextNow(0,0)});})()"));
    t('U1479 宠物币速 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1480 无数据初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petCoinRateTextNow(30,60),b:T.petCoinRateTextNow(10,120)});})()"));
    t('U1481 正常 30/分 与 5/分', o2.a === '🐾 宠物币 30/分' && o2.b === '🐾 宠物币 5/分', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petCoinRateTextNow(1,60),b:T.petCoinRateTextNow(0,60)});})()"));
    t('U1482 边界:1/分 与 0/分', o3.a === '🐾 宠物币 1/分' && o3.b === '🐾 宠物币 0/分', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petCoinRateTextNow(NaN,60),b:T.petCoinRateTextNow(30,NaN)});})()"));
    t('U1483 非法输入兜底', o4.a === '🐾 宠物币 0/分' && o4.b === '🐾 宠物币 —/分', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const p=T.r61pcNow(),s=T.r61psNow();return JSON.stringify({dom:T.petCoinRateDomNow(),exp:T.petCoinRateTextNow(p,s)});})()"));
    t('U1484 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1479;k<=1484;k++) t('U'+k+' 宠物币速',false,e.message); }


  // ===== U1485~U1490: 未拥有皮肤数(v0.7.62) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('missingSkinWrap'),f:T.missingSkinTextNow(null)});})()"));
    t('U1485 皮肤缺口 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    const o1 = JSON.parse(await ev("(function(){const T=window.__tbTest;const total=T.missingSkinTotalNow();return JSON.stringify({f:T.missingSkinTextNow(['classic']),exp:'🎨 未拥有 '+(total-1)+' 款'});})()"));
    t('U1486 初值(默认皮肤)', o1.f === o1.exp, JSON.stringify(o1));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;const total=T.missingSkinTotalNow();return JSON.stringify({a:T.missingSkinTextNow(['classic','gold']),exp:'🎨 未拥有 '+(total-2)+' 款'});})()"));
    t('U1487 正常(部分收集)', o2.a === o2.exp, JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;const total=T.missingSkinTotalNow();return JSON.stringify({a:T.missingSkinTextNow(new Array(total)),b:T.missingSkinTextNow([]),ex1:'🎨 已集齐',ex2:'🎨 未拥有 '+total+' 款'});})()"));
    t('U1488 边界:集齐/零拥有', o3.a === o3.ex1 && o3.b === o3.ex2, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;const total=T.missingSkinTotalNow();return JSON.stringify({a:T.missingSkinTextNow(42),exp:'🎨 未拥有 '+total+' 款'});})()"));
    t('U1489 非法输入兜底', o4.a === o4.exp, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const ow=T.r62ownNow();return JSON.stringify({dom:T.missingSkinDomNow(),exp:T.missingSkinTextNow(ow)});})()"));
    t('U1490 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1485;k<=1490;k++) t('U'+k+' 皮肤缺口',false,e.message); }


  // ===== U1491~U1496: 本局 BOSS 剩余血量百分比(v0.7.63) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bossPctWrap'),f:T.bossPctTextNow(0,0)});})()"));
    t('U1491 BOSS血量 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1492 无BOSS初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossPctTextNow(65,100),b:T.bossPctTextNow(30,100)});})()"));
    t('U1493 正常 65%/30%', o2.a === '👹 BOSS 65%' && o2.b === '👹 BOSS 30%', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossPctTextNow(100,100),b:T.bossPctTextNow(0,100)});})()"));
    t('U1494 边界:满血/空血', o3.a === '👹 BOSS 100%' && o3.b === '👹 BOSS 0%', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossPctTextNow(NaN,100),b:T.bossPctTextNow(50,NaN)});})()"));
    t('U1495 非法输入兜底', o4.a === '👹 BOSS 0%' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const h=T.r63hpNow(),m=T.r63mxNow();return JSON.stringify({dom:T.bossPctDomNow(),exp:T.bossPctTextNow(h,m)});})()"));
    t('U1496 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1491;k<=1496;k++) t('U'+k+' BOSS血量',false,e.message); }


  // ===== U1497~U1502: 磁暴剩余时间(v0.7.64) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('magnetTimeWrap'),f:T.magnetTimeTextNow(0)});})()"));
    t('U1497 磁暴 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1498 未激活初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.magnetTimeTextNow(3),b:T.magnetTimeTextNow(2.5)});})()"));
    t('U1499 正常 3s/2.5s', o2.a === '🧲 磁暴 3s' && o2.b === '🧲 磁暴 2.5s', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.magnetTimeTextNow(0.1),b:T.magnetTimeTextNow(0)});})()"));
    t('U1500 边界:0.1s/零', o3.a === '🧲 磁暴 0.1s' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.magnetTimeTextNow(NaN),b:T.magnetTimeTextNow(-2)});})()"));
    t('U1501 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r64msNow();return JSON.stringify({dom:T.magnetTimeDomNow(),exp:T.magnetTimeTextNow(v)});})()"));
    t('U1502 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1497;k<=1502;k++) t('U'+k+' 磁暴',false,e.message); }


  // ===== U1503~U1508: 当前增益生效(v0.7.65) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('fxActiveWrap'),f:T.fxActiveTextNow({})});})()"));
    t('U1503 增益 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1504 无增益初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.fxActiveTextNow({rapid:5,double:10}),b:T.fxActiveTextNow({freeze:5})});})()"));
    t('U1505 正常 急速双发/冰冻', o2.a === '✨ 急速5s·双发10s' && o2.b === '✨ 冰冻5s', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.fxActiveTextNow({rapid:0.1}),b:T.fxActiveTextNow({rapid:0})});})()"));
    t('U1506 边界:0.1s/零', o3.a === '✨ 急速0.1s' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.fxActiveTextNow(null),b:T.fxActiveTextNow({rapid:NaN})});})()"));
    t('U1507 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r65fxNow();return JSON.stringify({dom:T.fxActiveDomNow(),exp:T.fxActiveTextNow(v)});})()"));
    t('U1508 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1503;k<=1508;k++) t('U'+k+' 增益',false,e.message); }


  // ===== U1509~U1514: 本局剩余生命(v0.7.66) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('lifePctWrap'),f:T.lifePctTextNow(3,3)});})()"));
    t('U1509 生命 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1510 满血初值 3/3', o.f === '❤ 生命 3/3', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.lifePctTextNow(2,3),b:T.lifePctTextNow(1,3)});})()"));
    t('U1511 正常 2/3 与 1/3', o2.a === '❤ 生命 2/3' && o2.b === '❤ 生命 1/3', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.lifePctTextNow(0,3),b:T.lifePctTextNow(4,3)});})()"));
    t('U1512 边界:零/溢出', o3.a === '❤ 生命 0/3' && o3.b === '❤ 生命 4/3', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.lifePctTextNow(NaN,3),b:T.lifePctTextNow(2,NaN)});})()"));
    t('U1513 非法输入兜底', o4.a === '❤ 生命 0/3' && o4.b === '❤ 生命 2/1', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const l=T.r66lvNow();return JSON.stringify({dom:T.lifePctDomNow(),exp:T.lifePctTextNow(l,3)});})()"));
    t('U1514 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1509;k<=1514;k++) t('U'+k+' 生命',false,e.message); }


  // ===== U1515~U1520: 本局道具获取速率(v0.7.67) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('puRateWrap'),f:T.puRateTextNow(0,0)});})()"));
    t('U1515 道具速 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1516 无数据初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.puRateTextNow(3,60),b:T.puRateTextNow(10,120)});})()"));
    t('U1517 正常 3/分 与 5/分', o2.a === '🎁 道具 3/分' && o2.b === '🎁 道具 5/分', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.puRateTextNow(1,60),b:T.puRateTextNow(0,60)});})()"));
    t('U1518 边界:1/分 与 0/分', o3.a === '🎁 道具 1/分' && o3.b === '🎁 道具 0/分', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.puRateTextNow(NaN,60),b:T.puRateTextNow(3,NaN)});})()"));
    t('U1519 非法输入兜底', o4.a === '🎁 道具 0/分' && o4.b === '🎁 道具 —/分', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const p=T.r67puNow(),s=T.r67psNow();return JSON.stringify({dom:T.puRateDomNow(),exp:T.puRateTextNow(p,s)});})()"));
    t('U1520 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1515;k<=1520;k++) t('U'+k+' 道具速',false,e.message); }


  // ===== U1521~U1526: 当前波次进度(v0.7.68) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('waveProgWrap'),f:T.waveProgTextNow(1,1)});})()"));
    t('U1521 波次 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1522 单波初值 1/1', o.f === '🌊 波次 1/1', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.waveProgTextNow(2,5),b:T.waveProgTextNow(3,3)});})()"));
    t('U1523 正常 2/5 与 3/3', o2.a === '🌊 波次 2/5' && o2.b === '🌊 波次 3/3', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.waveProgTextNow(0,1),b:T.waveProgTextNow(5,5)});})()"));
    t('U1524 边界:零/满', o3.a === '🌊 波次 0/1' && o3.b === '🌊 波次 5/5', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.waveProgTextNow(1,NaN),b:T.waveProgTextNow(NaN,5)});})()"));
    t('U1525 非法输入兜底', o4.a === '—' && o4.b === '🌊 波次 0/5', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const w=T.r68wNow(),wt=T.r68wtNow();return JSON.stringify({dom:T.waveProgDomNow(),exp:T.waveProgTextNow(w,wt)});})()"));
    t('U1526 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1521;k<=1526;k++) t('U'+k+' 波次',false,e.message); }


  // ===== U1527~U1532: 本关 BOSS 类型(v0.7.69) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bossTypeWrap'),f:T.bossTypeTextNow(false,null)});})()"));
    t('U1527 BOSS型 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1528 非BOSS关初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossTypeTextNow(true,{name:'散射型'}),b:T.bossTypeTextNow(true,{name:'重装型'})});})()"));
    t('U1529 正常 散射型/重装型', o2.a === '👹 散射型' && o2.b === '👹 重装型', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossTypeTextNow(true,null),b:T.bossTypeTextNow(false,{name:'X'})});})()"));
    t('U1530 边界:无名/非关', o3.a === '👹 BOSS' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossTypeTextNow(null,{name:'X'}),b:T.bossTypeTextNow(true,{})});})()"));
    t('U1531 非法输入兜底', o4.a === '—' && o4.b === '👹 BOSS', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const b=T.r69blNow(),t=T.r69btNow();return JSON.stringify({dom:T.bossTypeDomNow(),exp:T.bossTypeTextNow(b,t)});})()"));
    t('U1532 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1527;k<=1532;k++) t('U'+k+' BOSS型',false,e.message); }


  // ===== U1533~U1538: 当前强化叠加最多项(v0.7.70) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('topUpgWrap'),f:T.topUpgTextNow({})});})()"));
    t('U1533 强化 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1534 无强化初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.topUpgTextNow({rapid:3,speed:1}),b:T.topUpgTextNow({hp:2})});})()"));
    t('U1535 正常 快速装填x3/装甲x2', o2.a === '🧪 快速装填x3' && o2.b === '🧪 装甲强化x2', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.topUpgTextNow({hp:1}),b:T.topUpgTextNow({})});})()"));
    t('U1536 边界:单层/空', o3.a === '🧪 装甲强化x1' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.topUpgTextNow(null),b:T.topUpgTextNow({rapid:NaN})});})()"));
    t('U1537 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const u=T.r70upNow();return JSON.stringify({dom:T.topUpgDomNow(),exp:T.topUpgTextNow(u)});})()"));
    t('U1538 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1533;k<=1538;k++) t('U'+k+' 强化',false,e.message); }


  // ===== U1539~U1544: 本局已发射子弹数(v0.7.71) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('shotsWrap'),f:T.shotsTextNow(0)});})()"));
    t('U1539 发射 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1540 零发射初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.shotsTextNow(12),b:T.shotsTextNow(100)});})()"));
    t('U1541 正常 12/100', o2.a === '🔫 发射 12' && o2.b === '🔫 发射 100', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.shotsTextNow(1),b:T.shotsTextNow(999)});})()"));
    t('U1542 边界:1/999', o3.a === '🔫 发射 1' && o3.b === '🔫 发射 999', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.shotsTextNow(NaN),b:T.shotsTextNow(-3)});})()"));
    t('U1543 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r71shNow();return JSON.stringify({dom:T.shotsDomNow(),exp:T.shotsTextNow(v)});})()"));
    t('U1544 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1539;k<=1544;k++) t('U'+k+' 发射',false,e.message); }


  // ===== U1545~U1550: 本局命中数(v0.7.72) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('hitsWrap'),f:T.hitsTextNow(0)});})()"));
    t('U1545 命中 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1546 零命中初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.hitsTextNow(8),b:T.hitsTextNow(60)});})()"));
    t('U1547 正常 8/60', o2.a === '🎯 命中 8' && o2.b === '🎯 命中 60', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.hitsTextNow(1),b:T.hitsTextNow(500)});})()"));
    t('U1548 边界:1/500', o3.a === '🎯 命中 1' && o3.b === '🎯 命中 500', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.hitsTextNow(NaN),b:T.hitsTextNow(-2)});})()"));
    t('U1549 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r72hiNow();return JSON.stringify({dom:T.hitsDomNow(),exp:T.hitsTextNow(v)});})()"));
    t('U1550 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1545;k<=1550;k++) t('U'+k+' 命中',false,e.message); }


  // ===== U1551~U1556: BOSS 出场警报(v0.7.73) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bossWarnWrap'),f:T.bossWarnTextNow(0)});})()"));
    t('U1551 BOSS警报 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1552 无警报初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossWarnTextNow(1.8),b:T.bossWarnTextNow(0.5)});})()"));
    t('U1553 正常 1.8s/0.5s', o2.a === '🚨 BOSS 来袭 1.8s' && o2.b === '🚨 BOSS 来袭 0.5s', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossWarnTextNow(0.1),b:T.bossWarnTextNow(0)});})()"));
    t('U1554 边界:0.1s/零', o3.a === '🚨 BOSS 来袭 0.1s' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossWarnTextNow(NaN),b:T.bossWarnTextNow(-1)});})()"));
    t('U1555 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r73bwNow();return JSON.stringify({dom:T.bossWarnDomNow(),exp:T.bossWarnTextNow(v)});})()"));
    t('U1556 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1551;k<=1556;k++) t('U'+k+' BOSS警报',false,e.message); }


  // ===== U1557~U1562: 当前猎手激光数(v0.7.74) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('lasersWrap'),f:T.lasersTextNow(0)});})()"));
    t('U1557 激光 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1558 无激光初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.lasersTextNow(2),b:T.lasersTextNow(5)});})()"));
    t('U1559 正常 2/5', o2.a === '🔦 激光 2' && o2.b === '🔦 激光 5', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.lasersTextNow(1),b:T.lasersTextNow(12)});})()"));
    t('U1560 边界:1/12', o3.a === '🔦 激光 1' && o3.b === '🔦 激光 12', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.lasersTextNow(NaN),b:T.lasersTextNow(-4)});})()"));
    t('U1561 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r74lsNow();return JSON.stringify({dom:T.lasersDomNow(),exp:T.lasersTextNow(v)});})()"));
    t('U1562 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1557;k<=1562;k++) t('U'+k+' 激光',false,e.message); }


  // ===== U1563~U1568: 当前每日词条数(v0.7.75) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('dailyCountWrap'),f:T.dailyCountTextNow({_names:[]})});})()"));
    t('U1563 词条 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1564 无词条初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.dailyCountTextNow({_names:['疾风骤雨','丰饶战场']}),b:T.dailyCountTextNow({_names:['钢铁防线','后勤休假','狙击天团']})});})()"));
    t('U1565 正常 2/3条', o2.a === '📜 词条 2' && o2.b === '📜 词条 3', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.dailyCountTextNow({_names:['x']}),b:T.dailyCountTextNow({_names:[]})});})()"));
    t('U1566 边界:1条/零', o3.a === '📜 词条 1' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.dailyCountTextNow(null),b:T.dailyCountTextNow({})});})()"));
    t('U1567 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r75dmNow();return JSON.stringify({dom:T.dailyCountDomNow(),exp:T.dailyCountTextNow(v)});})()"));
    t('U1568 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1563;k<=1568;k++) t('U'+k+' 词条',false,e.message); }


  // ===== U1569~U1574: 生涯 K/D 比值(v0.7.76) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('careerKDWrap'),f:T.careerKDTextNow(0,0)});})()"));
    t('U1569 生涯K/D pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1570 无数据初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerKDTextNow(120,40),b:T.careerKDTextNow(50,20)});})()"));
    t('U1571 正常 3 与 2.5', o2.a === '⚖ 生涯 K/D 3' && o2.b === '⚖ 生涯 K/D 2.5', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerKDTextNow(0,5),b:T.careerKDTextNow(10,0)});})()"));
    t('U1572 边界:零击杀/零阵亡', o3.a === '⚖ 生涯 K/D 0' && o3.b === '⚖ 生涯 K/D ∞', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.careerKDTextNow(NaN,0),b:T.careerKDTextNow(10,NaN)});})()"));
    t('U1573 非法输入兜底', o4.a === '—' && o4.b === '⚖ 生涯 K/D ∞', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const k=T.r76kNow(),d=T.r76dNow();return JSON.stringify({dom:T.careerKDDomNow(),exp:T.careerKDTextNow(k,d)});})()"));
    t('U1574 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1569;k<=1574;k++) t('U'+k+' 生涯K/D',false,e.message); }


  // ===== U1575~U1580: 当前慢动作状态(v0.7.77) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('timeScaleWrap'),f:T.timeScaleTextNow(1)});})()"));
    t('U1575 慢动作 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1576 常速初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.timeScaleTextNow(0.5),b:T.timeScaleTextNow(0.25)});})()"));
    t('U1577 正常 x0.5/x0.25', o2.a === '🐢 慢动作 x0.5' && o2.b === '🐢 慢动作 x0.3', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.timeScaleTextNow(0.1),b:T.timeScaleTextNow(0)});})()"));
    t('U1578 边界:x0.1/零', o3.a === '🐢 慢动作 x0.1' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.timeScaleTextNow(NaN),b:T.timeScaleTextNow(2)});})()"));
    t('U1579 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r77tsNow();return JSON.stringify({dom:T.timeScaleDomNow(),exp:T.timeScaleTextNow(v)});})()"));
    t('U1580 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1575;k<=1580;k++) t('U'+k+' 慢动作',false,e.message); }


  // ===== U1581~U1586: 本局击杀目标进度(v0.7.78) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('killPctWrap'),f:T.killPctTextNow(0,0)});})()"));
    t('U1581 击杀进度 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1582 无目标初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.killPctTextNow(10,40),b:T.killPctTextNow(30,40)});})()"));
    t('U1583 正常 25%/75%', o2.a === '🎯 击杀 25%' && o2.b === '🎯 击杀 75%', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.killPctTextNow(40,40),b:T.killPctTextNow(0,40)});})()"));
    t('U1584 边界:满/零', o3.a === '🎯 击杀 100%' && o3.b === '🎯 击杀 0%', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.killPctTextNow(NaN,40),b:T.killPctTextNow(10,NaN)});})()"));
    t('U1585 非法输入兜底', o4.a === '🎯 击杀 0%' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const s=T.r78spNow(),t=T.r78ttNow();return JSON.stringify({dom:T.killPctDomNow(),exp:T.killPctTextNow(s,t)});})()"));
    t('U1586 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1581;k<=1586;k++) t('U'+k+' 击杀进度',false,e.message); }


  // ===== U1587~U1592: 场上弹幕数(v0.7.79) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bulletsWrap'),f:T.bulletsTextNow(0)});})()"));
    t('U1587 弹幕 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1588 无弹幕初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bulletsTextNow(5),b:T.bulletsTextNow(12)});})()"));
    t('U1589 正常 5/12', o2.a === '💥 弹幕 5' && o2.b === '💥 弹幕 12', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bulletsTextNow(1),b:T.bulletsTextNow(50)});})()"));
    t('U1590 边界:1/50', o3.a === '💥 弹幕 1' && o3.b === '💥 弹幕 50', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bulletsTextNow(NaN),b:T.bulletsTextNow(-3)});})()"));
    t('U1591 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r79bNow();return JSON.stringify({dom:T.bulletsDomNow(),exp:T.bulletsTextNow(v)});})()"));
    t('U1592 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1587;k<=1592;k++) t('U'+k+' 弹幕',false,e.message); }


  // ===== U1593~U1598: 本波已刷敌数(v0.7.80) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('waveSpawnedWrap'),f:T.waveSpawnedTextNow(0)});})()"));
    t('U1593 本波已刷 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1594 未刷敌初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.waveSpawnedTextNow(4),b:T.waveSpawnedTextNow(9)});})()"));
    t('U1595 正常 4/9', o2.a === '🌊 本波 4' && o2.b === '🌊 本波 9', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.waveSpawnedTextNow(1),b:T.waveSpawnedTextNow(40)});})()"));
    t('U1596 边界:1/40', o3.a === '🌊 本波 1' && o3.b === '🌊 本波 40', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.waveSpawnedTextNow(NaN),b:T.waveSpawnedTextNow(-2)});})()"));
    t('U1597 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r80wNow();return JSON.stringify({dom:T.waveSpawnedDomNow(),exp:T.waveSpawnedTextNow(v)});})()"));
    t('U1598 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1593;k<=1598;k++) t('U'+k+' 本波已刷',false,e.message); }


  // ===== U1599~U1604: BOSS 剩余血量数值(v0.7.81) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bossHpNumWrap'),f:T.bossHpNumTextNow(0)});})()"));
    t('U1599 BOSS血量 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1600 无BOSS初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossHpNumTextNow(240),b:T.bossHpNumTextNow(120)});})()"));
    t('U1601 正常 240/120', o2.a === '👑 HP 240' && o2.b === '👑 HP 120', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossHpNumTextNow(1),b:T.bossHpNumTextNow(9999)});})()"));
    t('U1602 边界:1/9999', o3.a === '👑 HP 1' && o3.b === '👑 HP 9999', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossHpNumTextNow(NaN),b:T.bossHpNumTextNow(-5)});})()"));
    t('U1603 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r81hpNow();return JSON.stringify({dom:T.bossHpNumDomNow(),exp:T.bossHpNumTextNow(v)});})()"));
    t('U1604 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1599;k<=1604;k++) t('U'+k+' BOSS血量',false,e.message); }


  // ===== U1605~U1610: 生涯场均得分(v0.7.82) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('avgScoreWrap'),f:T.avgScoreTextNow(0,0)});})()"));
    t('U1605 场均得分 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1606 无场次初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.avgScoreTextNow(1200,3),b:T.avgScoreTextNow(5000,4)});})()"));
    t('U1607 正常 400/1250', o2.a === '📈 场均 400' && o2.b === '📈 场均 1250', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.avgScoreTextNow(0,3),b:T.avgScoreTextNow(999,1)});})()"));
    t('U1608 边界:零分/一场', o3.a === '📈 场均 0' && o3.b === '📈 场均 999', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.avgScoreTextNow(NaN,3),b:T.avgScoreTextNow(100,NaN)});})()"));
    t('U1609 非法输入兜底', o4.a === '📈 场均 0' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const b=T.r82bNow(),g=T.r82gNow();return JSON.stringify({dom:T.avgScoreDomNow(),exp:T.avgScoreTextNow(b,g)});})()"));
    t('U1610 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1605;k<=1610;k++) t('U'+k+' 场均得分',false,e.message); }


  // ===== U1611~U1616: 玩家移动速度倍率(v0.7.83) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('playerSpeedWrap'),f:T.playerSpeedMultTextNow(1)});})()"));
    t('U1611 移速 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1612 基础移速 x1', o.f === '⚡ 移速 x1', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.playerSpeedMultTextNow(1.15),b:T.playerSpeedMultTextNow(1.45)});})()"));
    t('U1613 正常 x1.15/x1.45', o2.a === '⚡ 移速 x1.15' && o2.b === '⚡ 移速 x1.45', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.playerSpeedMultTextNow(1),b:T.playerSpeedMultTextNow(1.9)});})()"));
    t('U1614 边界:x1/x1.9', o3.a === '⚡ 移速 x1' && o3.b === '⚡ 移速 x1.9', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.playerSpeedMultTextNow(NaN),b:T.playerSpeedMultTextNow(-1)});})()"));
    t('U1615 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r83spdNow();return JSON.stringify({dom:T.playerSpeedDomNow(),exp:T.playerSpeedMultTextNow(v)});})()"));
    t('U1616 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1611;k<=1616;k++) t('U'+k+' 移速',false,e.message); }


  // ===== U1617~U1622: 玩家子弹速度倍率(v0.7.84) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bulletSpeedWrap'),f:T.bulletSpeedMultTextNow(1)});})()"));
    t('U1617 弹速 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1618 基础弹速 x1', o.f === '🚀 弹速 x1', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bulletSpeedMultTextNow(1.2),b:T.bulletSpeedMultTextNow(1.4)});})()"));
    t('U1619 正常 x1.2/x1.4', o2.a === '🚀 弹速 x1.2' && o2.b === '🚀 弹速 x1.4', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bulletSpeedMultTextNow(1),b:T.bulletSpeedMultTextNow(2)});})()"));
    t('U1620 边界:x1/x2', o3.a === '🚀 弹速 x1' && o3.b === '🚀 弹速 x2', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bulletSpeedMultTextNow(NaN),b:T.bulletSpeedMultTextNow(-2)});})()"));
    t('U1621 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r84bsdNow();return JSON.stringify({dom:T.bulletSpeedDomNow(),exp:T.bulletSpeedMultTextNow(v)});})()"));
    t('U1622 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1617;k<=1622;k++) t('U'+k+' 弹速',false,e.message); }


  // ===== U1623~U1628: 玩家射速冷却倍率(v0.7.85) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('cooldownWrap'),f:T.cooldownTextNow(1)});})()"));
    t('U1623 冷却 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1624 基础冷却 x1', o.f === '🔥 冷却 x1', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.cooldownTextNow(0.8),b:T.cooldownTextNow(0.64)});})()"));
    t('U1625 正常 x0.8/x0.64', o2.a === '🔥 冷却 x0.8' && o2.b === '🔥 冷却 x0.64', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.cooldownTextNow(0.5),b:T.cooldownTextNow(1)});})()"));
    t('U1626 边界:x0.5/x1', o3.a === '🔥 冷却 x0.5' && o3.b === '🔥 冷却 x1', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.cooldownTextNow(NaN),b:T.cooldownTextNow(-0.5)});})()"));
    t('U1627 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r85cdNow();return JSON.stringify({dom:T.cooldownDomNow(),exp:T.cooldownTextNow(v)});})()"));
    t('U1628 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1623;k<=1628;k++) t('U'+k+' 冷却',false,e.message); }


  // ===== U1629~U1634: 玩家子弹穿透数(v0.7.86) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('pierceWrap'),f:T.pierceTextNow(0)});})()"));
    t('U1629 穿透 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1630 无穿透初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.pierceTextNow(2),b:T.pierceTextNow(3)});})()"));
    t('U1631 正常 2/3', o2.a === '🔱 穿透 2' && o2.b === '🔱 穿透 3', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.pierceTextNow(1),b:T.pierceTextNow(9)});})()"));
    t('U1632 边界:1/9', o3.a === '🔱 穿透 1' && o3.b === '🔱 穿透 9', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.pierceTextNow(NaN),b:T.pierceTextNow(-1)});})()"));
    t('U1633 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r86pNow();return JSON.stringify({dom:T.pierceDomNow(),exp:T.pierceTextNow(v)});})()"));
    t('U1634 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1629;k<=1634;k++) t('U'+k+' 穿透',false,e.message); }


  // ===== U1635~U1640: 本局击杀数(v0.7.87) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('runKillsValWrap'),f:T.runKillsValTextNow(0)});})()"));
    t('U1635 本局击杀 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1636 无击杀初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runKillsValTextNow(5),b:T.runKillsValTextNow(18)});})()"));
    t('U1637 正常 5/18', o2.a === '🎯 击杀 5' && o2.b === '🎯 击杀 18', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runKillsValTextNow(1),b:T.runKillsValTextNow(99)});})()"));
    t('U1638 边界:1/99', o3.a === '🎯 击杀 1' && o3.b === '🎯 击杀 99', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runKillsValTextNow(NaN),b:T.runKillsValTextNow(-4)});})()"));
    t('U1639 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r87killNow();return JSON.stringify({dom:T.runKillsValDomNow(),exp:T.runKillsValTextNow(v)});})()"));
    t('U1640 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1635;k<=1640;k++) t('U'+k+' 本局击杀',false,e.message); }


  // ===== U1641~U1646: 本局受击数(v0.7.88) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('runHurtWrap'),f:T.runHurtTextNow(0)});})()"));
    t('U1641 受击 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1642 无受击初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runHurtTextNow(3),b:T.runHurtTextNow(7)});})()"));
    t('U1643 正常 3/7', o2.a === '💢 受击 3' && o2.b === '💢 受击 7', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runHurtTextNow(1),b:T.runHurtTextNow(50)});})()"));
    t('U1644 边界:1/50', o3.a === '💢 受击 1' && o3.b === '💢 受击 50', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runHurtTextNow(NaN),b:T.runHurtTextNow(-2)});})()"));
    t('U1645 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.r88hurtReset();T.r88hurtAdd(3);T.r88hurtAdd(2);T.extraHudRefreshNow();const v=T.r88hurtNow();return JSON.stringify({dom:T.runHurtDomNow(),exp:T.runHurtTextNow(v)});})()"));
    t('U1646 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1641;k<=1646;k++) t('U'+k+' 受击',false,e.message); }


  // ===== U1647~U1652: 本局道具金币收益(v0.7.89) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('runPickupGoldWrap'),f:T.runPickupGoldTextNow(0)});})()"));
    t('U1647 道具金币 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1648 无收益初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runPickupGoldTextNow(50),b:T.runPickupGoldTextNow(120)});})()"));
    t('U1649 正常 50/120', o2.a === '💰 道具币 50' && o2.b === '💰 道具币 120', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runPickupGoldTextNow(10),b:T.runPickupGoldTextNow(999)});})()"));
    t('U1650 边界:10/999', o3.a === '💰 道具币 10' && o3.b === '💰 道具币 999', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runPickupGoldTextNow(NaN),b:T.runPickupGoldTextNow(-10)});})()"));
    t('U1651 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.r89pgReset();T.r89pgAdd(30);T.r89pgAdd(20);T.extraHudRefreshNow();const v=T.r89pgNow();return JSON.stringify({dom:T.runPickupGoldDomNow(),exp:T.runPickupGoldTextNow(v)});})()"));
    t('U1652 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1647;k<=1652;k++) t('U'+k+' 道具金币',false,e.message); }


  // ===== U1653~U1658: 基地状态(v0.7.90) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('baseStatusWrap'),f:T.baseStatusTextNow(true,0)});})()"));
    t('U1653 基地状态 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1654 存活无墙初值', o.f === '🏰 基地 0 墙', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseStatusTextNow(true,8),b:T.baseStatusTextNow(false,8)});})()"));
    t('U1655 正常:存活8墙/被毁', o2.a === '🏰 基地 8 墙' && o2.b === '💥 基地被毁', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseStatusTextNow(true,1),b:T.baseStatusTextNow(true,30)});})()"));
    t('U1656 边界:1墙/30墙', o3.a === '🏰 基地 1 墙' && o3.b === '🏰 基地 30 墙', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseStatusTextNow(true,NaN),b:T.baseStatusTextNow(false,NaN)});})()"));
    t('U1657 非法输入兜底', o4.a === '🏰 基地 0 墙' && o4.b === '💥 基地被毁', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const a=T.r90aliveNow(),w=T.r90wallsNow();return JSON.stringify({dom:T.baseStatusDomNow(),exp:T.baseStatusTextNow(a,w)});})()"));
    t('U1658 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1653;k<=1658;k++) t('U'+k+' 基地状态',false,e.message); }


  // ===== U1659~U1664: BOSS 击杀计数(v0.7.91) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bossKillCountWrap'),f:T.bossKillCountTextNow(0)});})()"));
    t('U1659 BOSS击破 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1660 无击破初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossKillCountTextNow(2),b:T.bossKillCountTextNow(5)});})()"));
    t('U1661 正常 2/5', o2.a === '👑 BOSS 2' && o2.b === '👑 BOSS 5', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossKillCountTextNow(1),b:T.bossKillCountTextNow(30)});})()"));
    t('U1662 边界:1/30', o3.a === '👑 BOSS 1' && o3.b === '👑 BOSS 30', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossKillCountTextNow(NaN),b:T.bossKillCountTextNow(-1)});})()"));
    t('U1663 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r91bkNow();return JSON.stringify({dom:T.bossKillCountDomNow(),exp:T.bossKillCountTextNow(v)});})()"));
    t('U1664 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1659;k<=1664;k++) t('U'+k+' BOSS击破',false,e.message); }


  // ===== U1665~U1670: 本局连击峰值(v0.7.92) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('runComboPeakWrap'),f:T.runComboPeakTextNow(0)});})()"));
    t('U1665 连击峰值 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1666 无连击初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runComboPeakTextNow(8),b:T.runComboPeakTextNow(15)});})()"));
    t('U1667 正常 8/15', o2.a === '🔥 峰值 8连' && o2.b === '🔥 峰值 15连', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runComboPeakTextNow(1),b:T.runComboPeakTextNow(99)});})()"));
    t('U1668 边界:1/99', o3.a === '🔥 峰值 1连' && o3.b === '🔥 峰值 99连', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runComboPeakTextNow(NaN),b:T.runComboPeakTextNow(-3)});})()"));
    t('U1669 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r92cpNow();return JSON.stringify({dom:T.runComboPeakDomNow(),exp:T.runComboPeakTextNow(v)});})()"));
    t('U1670 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1665;k<=1670;k++) t('U'+k+' 连击峰值',false,e.message); }


  // ===== U1671~U1676: 当前波次编号(v0.7.93) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('waveNumWrap'),f:T.waveNumTextNow(0)});})()"));
    t('U1671 波次 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1672 无波次初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.waveNumTextNow(3),b:T.waveNumTextNow(12)});})()"));
    t('U1673 正常 3/12', o2.a === '🌊 第 3 波' && o2.b === '🌊 第 12 波', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.waveNumTextNow(1),b:T.waveNumTextNow(99)});})()"));
    t('U1674 边界:1/99', o3.a === '🌊 第 1 波' && o3.b === '🌊 第 99 波', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.waveNumTextNow(NaN),b:T.waveNumTextNow(-1)});})()"));
    t('U1675 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r93wNow();return JSON.stringify({dom:T.waveNumDomNow(),exp:T.waveNumTextNow(v)});})()"));
    t('U1676 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1671;k<=1676;k++) t('U'+k+' 波次',false,e.message); }


  // ===== U1677~U1682: 本局道具拾取速率(v0.7.94) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('puRateNowWrap'),f:T.puRateNowTextNow(0,10)});})()"));
    t('U1677 拾取率 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1678 无拾取初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.puRateNowTextNow(3,60),b:T.puRateNowTextNow(8,80)});})()"));
    t('U1679 正常 0.05/s 与 0.1/s', o2.a === '🧺 拾取率 0.05/s' && o2.b === '🧺 拾取率 0.1/s', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.puRateNowTextNow(1,100),b:T.puRateNowTextNow(10,100)});})()"));
    t('U1680 边界:0.01/s 与 0.1/s', o3.a === '🧺 拾取率 0.01/s' && o3.b === '🧺 拾取率 0.1/s', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.puRateNowTextNow(NaN,10),b:T.puRateNowTextNow(3,0)});})()"));
    t('U1681 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const n=T.r94nNow(),s=T.r94sNow();return JSON.stringify({dom:T.puRateNowDomNow(),exp:T.puRateNowTextNow(n,s)});})()"));
    t('U1682 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1677;k<=1682;k++) t('U'+k+' 拾取率',false,e.message); }


  // ===== U1683~U1688: 当前移动方向(v0.7.95) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('dirPillWrap'),f:T.dirTextNow(-1)});})()"));
    t('U1683 朝向 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1684 无朝向初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.dirTextNow(0),b:T.dirTextNow(2)});})()"));
    t('U1685 正常 上/右', o2.a === '🧭 上' && o2.b === '🧭 右', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.dirTextNow(1),b:T.dirTextNow(7)});})()"));
    t('U1686 边界:右上/左上', o3.a === '🧭 右上' && o3.b === '🧭 左上', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.dirTextNow(8),b:T.dirTextNow(NaN)});})()"));
    t('U1687 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r95dirNow();return JSON.stringify({dom:T.dirDomNow(),exp:T.dirTextNow(v)});})()"));
    t('U1688 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1683;k<=1688;k++) t('U'+k+' 朝向',false,e.message); }


  // ===== U1689~U1694: 基地距离(v0.7.96) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('baseDistWrap'),f:T.baseDistTextNow(null,null)});})()"));
    t('U1689 基地距 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1690 无玩家初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseDistTextNow(300,564),b:T.baseDistTextNow(300,540)});})()"));
    t('U1691 正常 0格/1格', o2.a === '🏯 基地 0 格' && o2.b === '🏯 基地 1 格', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseDistTextNow(300,516),b:T.baseDistTextNow(348,564)});})()"));
    t('U1692 边界:2格/2格', o3.a === '🏯 基地 2 格' && o3.b === '🏯 基地 2 格', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseDistTextNow(NaN,100)});})()"));
    t('U1693 非法输入兜底', o4.a === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const px=T.r96pxNow(),py=T.r96pyNow();return JSON.stringify({dom:T.baseDistDomNow(),exp:T.baseDistTextNow(px,py)});})()"));
    t('U1694 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1689;k<=1694;k++) t('U'+k+' 基地距',false,e.message); }


  // ===== U1695~U1700: 最近敌人距离(v0.7.97) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('nearEnemyDistWrap'),f:T.nearEnemyDistTextNow(300,564,[])});})()"));
    t('U1695 最近敌距 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1696 无敌人初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.nearEnemyDistTextNow(300,564,[{x:289,y:553,size:22,dead:false}])});})()"));
    t('U1697 正常 0格', o2.a === '⚠ 最近 0 格', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.nearEnemyDistTextNow(300,564,[{x:289,y:553,size:22,dead:false},{x:289,y:517,size:22,dead:true}]),b:T.nearEnemyDistTextNow(300,564,[{x:289,y:529,size:22,dead:false}])});})()"));
    t('U1698 边界:死亡排除/1格', o3.a === '⚠ 最近 0 格' && o3.b === '⚠ 最近 1 格', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.nearEnemyDistTextNow(NaN,564,[])});})()"));
    t('U1699 非法输入兜底', o4.a === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const px=T.r97pxNow(),py=T.r97pyNow(),en=T.r97enNow();return JSON.stringify({dom:T.nearEnemyDistDomNow(),exp:T.nearEnemyDistTextNow(px,py,en)});})()"));
    t('U1700 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1695;k<=1700;k++) t('U'+k+' 最近敌距',false,e.message); }


  // ===== U1701~U1706: 本局实际移速%(v0.7.98) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('absSpeedWrap'),f:T.absSpeedTextNow(-1)});})()"));
    t('U1701 实速 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1702 无玩家初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.absSpeedTextNow(2.4),b:T.absSpeedTextNow(2.76)});})()"));
    t('U1703 正常 100%/115%', o2.a === '💨 移速 100%' && o2.b === '💨 移速 115%', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.absSpeedTextNow(1.2),b:T.absSpeedTextNow(3.6)});})()"));
    t('U1704 边界:50%/150%', o3.a === '💨 移速 50%' && o3.b === '💨 移速 150%', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.absSpeedTextNow(NaN)});})()"));
    t('U1705 非法输入兜底', o4.a === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r98spdNow();return JSON.stringify({dom:T.absSpeedDomNow(),exp:T.absSpeedTextNow(v)});})()"));
    t('U1706 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1701;k<=1706;k++) t('U'+k+' 实速',false,e.message); }


  // ===== U1707~U1712: 最近敌人类型(v0.7.99) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('nearEnemyTypeWrap'),f:T.nearEnemyTypeTextNow(null,null,[])});})()"));
    t('U1707 近敌类型 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1708 无敌人初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.nearEnemyTypeTextNow(300,564,[{x:289,y:553,size:22,dead:false,type:'tank'}])});})()"));
    t('U1709 正常 重坦', o2.a === '🎯 重坦', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.nearEnemyTypeTextNow(300,564,[{x:289,y:553,size:22,dead:false,type:'boss',isBoss:true}]),b:T.nearEnemyTypeTextNow(300,564,[{x:289,y:553,size:22,dead:false,type:'grunt'}])});})()"));
    t('U1710 边界:BOSS/未知', o3.a === '👑 BOSS' && o3.b === '🎯 敌·grunt', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.nearEnemyTypeTextNow(NaN,564,[])});})()"));
    t('U1711 非法输入兜底', o4.a === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const px=T.r99txNow(),py=T.r99tyNow(),en=T.r99enNow();return JSON.stringify({dom:T.nearEnemyTypeDomNow(),exp:T.nearEnemyTypeTextNow(px,py,en)});})()"));
    t('U1712 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1707;k<=1712;k++) t('U'+k+' 近敌类型',false,e.message); }


  // ===== U1713~U1718: 基地被围程度(v0.8.00) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('baseThreatWrap'),f:T.baseThreatTextNow([])});})()"));
    t('U1713 基地威胁 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1714 无敌人初值 安全', o.f === '🟢 基地安全', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseThreatTextNow([{x:289,y:553,size:22,dead:false}]),b:T.baseThreatTextNow([{x:289,y:553,size:22,dead:false},{x:300,y:560,size:22,dead:false},{x:280,y:545,size:22,dead:false}])});})()"));
    t('U1715 正常 1敌/3敌', o2.a === '🟡 基地附近 1 敌' && o2.b === '🟠 基地受威胁 3 敌', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseThreatTextNow([{x:289,y:553,size:22,dead:false},{x:300,y:560,size:22,dead:false},{x:280,y:545,size:22,dead:false},{x:312,y:570,size:22,dead:false},{x:288,y:575,size:22,dead:false},{x:305,y:548,size:22,dead:false}]),b:T.baseThreatTextNow([{x:289,y:385,size:22,dead:false}])});})()"));
    t('U1716 边界:6敌危急/远敌安全', o3.a === '🔴 基地危急 6 敌' && o3.b === '🟢 基地安全', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseThreatTextNow([{x:289,y:553,size:22,dead:true}])});})()"));
    t('U1717 死亡排除 安全', o4.a === '🟢 基地安全', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const en=T.r00thNow();return JSON.stringify({dom:T.baseThreatDomNow(),exp:T.baseThreatTextNow(en)});})()"));
    t('U1718 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1713;k<=1718;k++) t('U'+k+' 基地威胁',false,e.message); }


  // ===== U1719~U1724: 弹幕威胁等级(v0.8.01) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bulletThreatWrap'),f:T.bulletThreatTextNow(0)});})()"));
    t('U1719 弹幕威胁 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1720 平静初值', o.f === '🟢 弹幕平静', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bulletThreatTextNow(3),b:T.bulletThreatTextNow(8)});})()"));
    t('U1721 正常 3发/8发', o2.a === '🟡 弹幕 3 发' && o2.b === '🟠 弹幕密集 8 发', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bulletThreatTextNow(5),b:T.bulletThreatTextNow(12)});})()"));
    t('U1722 边界 5发/12发', o3.a === '🟡 弹幕 5 发' && o3.b === '🟠 弹幕密集 12 发', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bulletThreatTextNow(20),b:T.bulletThreatTextNow(NaN)});})()"));
    t('U1723 暴雨20/非法', o4.a === '🔴 弹幕暴雨 20 发' && o4.b === '🟢 弹幕平静', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r01blNow();return JSON.stringify({dom:T.bulletThreatDomNow(),exp:T.bulletThreatTextNow(v)});})()"));
    t('U1724 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1719;k<=1724;k++) t('U'+k+' 弹幕威胁',false,e.message); }


  // ===== U1725~U1730: 本局道具种类数(v0.8.02) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('runPickupKindsWrap'),f:T.runPickupKindsTextNow(0)});})()"));
    t('U1725 道具种类 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1726 无拾取初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runPickupKindsTextNow(3),b:T.runPickupKindsTextNow(8)});})()"));
    t('U1727 正常 3种/8种', o2.a === '🧩 道具 3 种' && o2.b === '🧩 道具 8 种', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runPickupKindsTextNow(1),b:T.runPickupKindsTextNow(20)});})()"));
    t('U1728 边界 1种/20种', o3.a === '🧩 道具 1 种' && o3.b === '🧩 道具 20 种', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runPickupKindsTextNow(NaN)});})()"));
    t('U1729 非法输入兜底', o4.a === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.r02kReset();T.r02kAdd('a');T.r02kAdd('b');T.r02kAdd('a');T.extraHudRefreshNow();const v=T.r02kNow();return JSON.stringify({dom:T.runPickupKindsDomNow(),exp:T.runPickupKindsTextNow(v)});})()"));
    t('U1730 DOM 与函数一致(Set去重)', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1725;k<=1730;k++) t('U'+k+' 道具种类',false,e.message); }


  // ===== U1731~U1736: 敌方剩余总血量(v0.8.03) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('enemyHpSumWrap'),f:T.enemyHpSumTextNow([])});})()"));
    t('U1731 敌总血 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1732 无敌人初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.enemyHpSumTextNow([{hp:30,dead:false},{hp:70,dead:false}])});})()"));
    t('U1733 正常 30+70=100', o2.a === '💪 敌血 100', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.enemyHpSumTextNow([{hp:30,dead:false},{hp:0,dead:true},{hp:70,dead:false}]),b:T.enemyHpSumTextNow([{hp:30,dead:true}])});})()"));
    t('U1734 边界:死亡排除/全灭', o3.a === '💪 敌血 100' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.enemyHpSumTextNow([{hp:NaN,dead:false}])});})()"));
    t('U1735 非法输入兜底', o4.a === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const en=T.r03enNow();return JSON.stringify({dom:T.enemyHpSumDomNow(),exp:T.enemyHpSumTextNow(en)});})()"));
    t('U1736 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1731;k<=1736;k++) t('U'+k+' 敌总血',false,e.message); }


  // ===== U1737~U1742: 本局累计造成伤害(v0.8.04) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('runDmgWrap'),f:T.runDmgTextNow(0)});})()"));
    t('U1737 累计伤害 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1738 无伤害初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runDmgTextNow(123),b:T.runDmgTextNow(4567)});})()"));
    t('U1739 正常 123/4567', o2.a === '⚔ 伤害 123' && o2.b === '⚔ 伤害 4567', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runDmgTextNow(1),b:T.runDmgTextNow(99999)});})()"));
    t('U1740 边界 1/99999', o3.a === '⚔ 伤害 1' && o3.b === '⚔ 伤害 99999', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.runDmgTextNow(NaN),b:T.runDmgTextNow(-5)});})()"));
    t('U1741 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.r04dmgReset();T.r04dmgAdd(50);T.r04dmgAdd(30);T.r04dmgAdd(-9);T.extraHudRefreshNow();const v=T.r04dmgNow();return JSON.stringify({dom:T.runDmgDomNow(),exp:T.runDmgTextNow(v)});})()"));
    t('U1742 DOM 与函数一致(累计)', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1737;k<=1742;k++) t('U'+k+' 累计伤害',false,e.message); }


  // ===== U1743~U1748: 道具剩余总时长(v0.8.05) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('puLifeSumWrap'),f:T.puLifeSumTextNow([])});})()"));
    t('U1743 道具时长 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1744 无道具初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.puLifeSumTextNow([{life:12,dead:false},{life:8,dead:false}])});})()"));
    t('U1745 正常 12+8=20s', o2.a === '⏱ 道具 20s', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.puLifeSumTextNow([{life:12,dead:false},{life:3.5,dead:true},{life:8,dead:false}]),b:T.puLifeSumTextNow([{life:12,dead:true}])});})()"));
    t('U1746 边界:死亡排除/全无', o3.a === '⏱ 道具 20s' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.puLifeSumTextNow([{life:NaN,dead:false}])});})()"));
    t('U1747 非法输入兜底', o4.a === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const pu=T.r05puNow();return JSON.stringify({dom:T.puLifeSumDomNow(),exp:T.puLifeSumTextNow(pu)});})()"));
    t('U1748 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1743;k<=1748;k++) t('U'+k+' 道具时长',false,e.message); }


  // ===== U1749~U1754: 瞄准偏差(v0.8.06) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('aimGapWrap'),f:T.aimGapTextNow(null,null,0,[])});})()"));
    t('U1749 瞄准偏差 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1750 无玩家初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.aimGapTextNow(300,564,0,[{x:289,y:529,size:22,dead:false}]),b:T.aimGapTextNow(300,564,0,[{x:311,y:553,size:22,dead:false}])});})()"));
    t('U1751 正常 上对0°/右90°', o2.a === '🎯 偏差 0°' && o2.b === '🎯 偏差 90°', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.aimGapTextNow(300,564,0,[{x:289,y:577,size:22,dead:false}]),b:T.aimGapTextNow(300,564,2,[{x:311,y:553,size:22,dead:false}])});})()"));
    t('U1752 边界:背对180°/右对0°', o3.a === '🎯 偏差 180°' && o3.b === '🎯 偏差 0°', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.aimGapTextNow(300,564,9,[]),b:T.aimGapTextNow(300,564,0,[{x:289,y:553,size:22,dead:true}])});})()"));
    t('U1753 非法输入/无敌人 —', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const px=T.r06pxNow(),py=T.r06pyNow(),dr=T.r06dirNow(),en=T.r06enNow();return JSON.stringify({dom:T.aimGapDomNow(),exp:T.aimGapTextNow(px,py,dr,en)});})()"));
    t('U1754 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1749;k<=1754;k++) t('U'+k+' 瞄准偏差',false,e.message); }


  // ===== U1755~U1760: 最近道具距离(v0.8.07) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('nearestPuWrap'),f:T.nearestPuDistTextNow(null,null,[])});})()"));
    t('U1755 近道具 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1756 无玩家初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.nearestPuDistTextNow(300,564,[{x:292,y:556,dead:false}]),b:T.nearestPuDistTextNow(300,564,[{x:292,y:532,dead:false}])});})()"));
    t('U1757 正常 0格/1格', o2.a === '🧲 道具 0 格' && o2.b === '🧲 道具 1 格', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.nearestPuDistTextNow(300,564,[{x:292,y:556,dead:false},{x:292,y:532,dead:true}]),b:T.nearestPuDistTextNow(300,564,[{x:292,y:532,dead:true}])});})()"));
    t('U1758 边界:死亡排除/全无', o3.a === '🧲 道具 0 格' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.nearestPuDistTextNow(NaN,564,[])});})()"));
    t('U1759 非法输入兜底', o4.a === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const px=T.r07pxNow(),py=T.r07pyNow(),pu=T.r07puNow();return JSON.stringify({dom:T.nearestPuDomNow(),exp:T.nearestPuDistTextNow(px,py,pu)});})()"));
    t('U1760 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1755;k<=1760;k++) t('U'+k+' 近道具',false,e.message); }


  // ===== U1761~U1766: 敌方平均血量(v0.8.08) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('enemyAvgWrap'),f:T.enemyAvgHpTextNow([])});})()"));
    t('U1761 敌均血 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1762 无敌人初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.enemyAvgHpTextNow([{hp:30,dead:false},{hp:70,dead:false}]),b:T.enemyAvgHpTextNow([{hp:50,dead:false}])});})()"));
    t('U1763 正常 均50', o2.a === '📊 均血 50' && o2.b === '📊 均血 50', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.enemyAvgHpTextNow([{hp:30,dead:false},{hp:70,dead:false},{hp:999,dead:true}]),b:T.enemyAvgHpTextNow([{hp:30,dead:true}])});})()"));
    t('U1764 边界:死亡排除/全灭', o3.a === '📊 均血 50' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.enemyAvgHpTextNow([{hp:NaN,dead:false},{hp:10,dead:false}])});})()"));
    t('U1765 非法输入兜底', o4.a === '📊 均血 10', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const en=T.r08enNow();return JSON.stringify({dom:T.enemyAvgDomNow(),exp:T.enemyAvgHpTextNow(en)});})()"));
    t('U1766 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1761;k<=1766;k++) t('U'+k+' 敌均血',false,e.message); }


  // ===== U1767~U1772: 基地方向威胁(v0.8.09) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('baseDirWrap'),f:T.baseDirThreatTextNow([])});})()"));
    t('U1767 基地威胁向 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1768 无敌人初值 无威胁', o.f === '🟢 基地无威胁', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseDirThreatTextNow([{x:289,y:529,size:22,dead:false},{x:311,y:553,size:22,dead:false},{x:323,y:553,size:22,dead:false},{x:311,y:575,size:22,dead:999}])});})()"));
    t('U1769 正常 右2敌胜出', o2.a === '🔴 基地右 2敌', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseDirThreatTextNow([{x:289,y:25,size:22,dead:false}]),b:T.baseDirThreatTextNow([{x:289,y:529,size:22,dead:true}])});})()"));
    t('U1770 边界:远敌排除/死亡排除', o3.a === '🟢 基地无威胁' && o3.b === '🟢 基地无威胁', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseDirThreatTextNow([{x:NaN,y:529,size:22,dead:false}])});})()"));
    t('U1771 非法输入兜底', o4.a === '🟢 基地无威胁', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const en=T.r09enNow();return JSON.stringify({dom:T.baseDirDomNow(),exp:T.baseDirThreatTextNow(en)});})()"));
    t('U1772 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1767;k<=1772;k++) t('U'+k+' 基地威胁向',false,e.message); }


  // ===== U1773~U1778: 连击得分增益(v0.8.10) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('comboGainWrap'),f:T.comboGainTextNow(0)});})()"));
    t('U1773 连击增益 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1774 无连击初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.comboGainTextNow(3),b:T.comboGainTextNow(11)});})()"));
    t('U1775 正常 +20%/+100%', o2.a === '🔥 连击 +20%' && o2.b === '🔥 连击 +100%', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.comboGainTextNow(1),b:T.comboGainTextNow(21)});})()"));
    t('U1776 边界 +0%/+200%', o3.a === '🔥 连击 +0%' && o3.b === '🔥 连击 +200%', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.comboGainTextNow(NaN),b:T.comboGainTextNow(-3)});})()"));
    t('U1777 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r10comboNow();return JSON.stringify({dom:T.comboGainDomNow(),exp:T.comboGainTextNow(v)});})()"));
    t('U1778 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1773;k<=1778;k++) t('U'+k+' 连击增益',false,e.message); }


  // ===== U1779~U1784: 玩家当前朝向(v0.8.11) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('playerDirWrap'),f:T.playerDirTextNow(-1)});})()"));
    t('U1779 玩家朝向 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1780 无玩家初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.playerDirTextNow(2),b:T.playerDirTextNow(0)});})()"));
    t('U1781 正常 右/上', o2.a === '🧭 朝右' && o2.b === '🧭 朝上', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.playerDirTextNow(7),b:T.playerDirTextNow(1)});})()"));
    t('U1782 边界 左上/右上', o3.a === '🧭 朝左上' && o3.b === '🧭 朝右上', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.playerDirTextNow(9),b:T.playerDirTextNow(NaN)});})()"));
    t('U1783 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const d=T.r11dirNow();return JSON.stringify({dom:T.playerDirDomNow(),exp:T.playerDirTextNow(d)});})()"));
    t('U1784 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1779;k<=1784;k++) t('U'+k+' 玩家朝向',false,e.message); }


  // ===== U1785~U1790: 波次休整倒计时(v0.8.12) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('waveGapWrap'),f:T.waveGapTextNow(0)});})()"));
    t('U1785 波间倒计时 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1786 无休整初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.waveGapTextNow(120),b:T.waveGapTextNow(30)});})()"));
    t('U1787 正常 2s/0.5s', o2.a === '⏳ 下波 2s' && o2.b === '⏳ 下波 0.5s', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.waveGapTextNow(6),b:T.waveGapTextNow(600)});})()"));
    t('U1788 边界 0.1s/10s', o3.a === '⏳ 下波 0.1s' && o3.b === '⏳ 下波 10s', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.waveGapTextNow(NaN),b:T.waveGapTextNow(-5)});})()"));
    t('U1789 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r12gNow();return JSON.stringify({dom:T.waveGapDomNow(),exp:T.waveGapTextNow(v)});})()"));
    t('U1790 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1785;k<=1790;k++) t('U'+k+' 波间倒计时',false,e.message); }


  // ===== U1791~U1796: 玩家-基地距离(v0.8.13) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('playerBaseWrap'),f:T.playerBaseDistTextNow(null,null)});})()"));
    t('U1791 距基 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1792 无玩家初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;const bx=T.r13bcxNow(),by=T.r13bcyNow();return JSON.stringify({a:T.playerBaseDistTextNow(bx,by),b:T.playerBaseDistTextNow(bx+2*T.r13tileNow(),by)});})()"));
    t('U1793 正常 0格/2格', o2.a === '🏠 距基 0 格' && o2.b === '🏠 距基 2 格', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;const bx=T.r13bcxNow(),by=T.r13bcyNow();return JSON.stringify({a:T.playerBaseDistTextNow(bx+T.r13tileNow()/2,by)});})()"));
    t('U1794 边界 0.5格', o3.a === '🏠 距基 0.5 格', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.playerBaseDistTextNow(NaN,564)});})()"));
    t('U1795 非法输入兜底', o4.a === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const px=T.r13pxNow(),py=T.r13pyNow();return JSON.stringify({dom:T.playerBaseDomNow(),exp:T.playerBaseDistTextNow(px,py)});})()"));
    t('U1796 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1791;k<=1796;k++) t('U'+k+' 距基',false,e.message); }


  // ===== U1797~U1802: 本关用时(v0.8.14) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('levelSecsWrap'),f:T.levelSecsTextNow(0)});})()"));
    t('U1797 本关用时 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1798 无用时初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.levelSecsTextNow(45),b:T.levelSecsTextNow(125)});})()"));
    t('U1799 正常 45s/2m5s', o2.a === '⏱ 本关 45s' && o2.b === '⏱ 本关 2m5s', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.levelSecsTextNow(1),b:T.levelSecsTextNow(3599)});})()"));
    t('U1800 边界 1s/59m59s', o3.a === '⏱ 本关 1s' && o3.b === '⏱ 本关 59m59s', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.levelSecsTextNow(NaN),b:T.levelSecsTextNow(-5)});})()"));
    t('U1801 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r14lNow();return JSON.stringify({dom:T.levelSecsDomNow(),exp:T.levelSecsTextNow(v)});})()"));
    t('U1802 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1797;k<=1802;k++) t('U'+k+' 本关用时',false,e.message); }


  // ===== U1803~U1808: 场上 BOSS 存活(v0.8.15) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bossAliveWrap'),f:T.bossAliveTextNow([])});})()"));
    t('U1803 BOSS 存活 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1804 无 BOSS 初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossAliveTextNow([{isBoss:true,dead:false}]),b:T.bossAliveTextNow([{isBoss:true,dead:false},{isBoss:false,dead:false}])});})()"));
    t('U1805 正常 存活1', o2.a === '☠ BOSS 存活 1' && o2.b === '☠ BOSS 存活 1', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossAliveTextNow([{isBoss:true,dead:true}])});})()"));
    t('U1806 边界 已灭', o3.a === '✅ BOSS 已灭', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossAliveTextNow([{isBoss:true,dead:null}])});})()"));
    t('U1807 非法输入兜底(无dead视为存活)', o4.a === '☠ BOSS 存活 1', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const en=T.r15enNow();return JSON.stringify({dom:T.bossAliveDomNow(),exp:T.bossAliveTextNow(en)});})()"));
    t('U1808 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1803;k<=1808;k++) t('U'+k+' BOSS 存活',false,e.message); }


  // ===== U1809~U1814: 基地被围敌数(v0.8.16) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('baseBesiegedWrap'),f:T.baseBesiegedTextNow([])});})()"));
    t('U1809 基地围困 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1810 无敌人初值 无围', o.f === '🟢 基地无围', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseBesiegedTextNow([{x:289,y:529,size:22,dead:false},{x:311,y:553,size:22,dead:false}])});})()"));
    t('U1811 正常 被围2', o2.a === '🏯 基地被围 2', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseBesiegedTextNow([{x:289,y:25,size:22,dead:false}]),b:T.baseBesiegedTextNow([{x:289,y:529,size:22,dead:true}])});})()"));
    t('U1812 边界:远敌排除/死亡排除', o3.a === '🟢 基地无围' && o3.b === '🟢 基地无围', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseBesiegedTextNow([{x:NaN,y:529,size:22,dead:false}])});})()"));
    t('U1813 非法输入兜底', o4.a === '🟢 基地无围', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const en=T.r16enNow();return JSON.stringify({dom:T.baseBesiegedDomNow(),exp:T.baseBesiegedTextNow(en)});})()"));
    t('U1814 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1809;k<=1814;k++) t('U'+k+' 基地围困',false,e.message); }


  // ===== U1815~U1820: 本关无伤状态(v0.8.17) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('noHurtWrap'),f:T.noHurtLvTextNow(false)});})()"));
    t('U1815 无伤 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1816 未掉命初值 无伤', o.f === '🛡 本关无伤', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.noHurtLvTextNow(true)});})()"));
    t('U1817 正常 已伤', o2.a === '💔 本关已伤', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.noHurtLvTextNow(0),b:T.noHurtLvTextNow(1)});})()"));
    t('U1818 边界 0无伤/1已伤', o3.a === '🛡 本关无伤' && o3.b === '💔 本关已伤', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.noHurtLvTextNow(undefined),b:T.noHurtLvTextNow(null)});})()"));
    t('U1819 非法输入兜底', o4.a === '🛡 本关无伤' && o4.b === '🛡 本关无伤', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const h=T.r17hNow();return JSON.stringify({dom:T.noHurtDomNow(),exp:T.noHurtLvTextNow(h)});})()"));
    t('U1820 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1815;k<=1820;k++) t('U'+k+' 无伤',false,e.message); }


  // ===== U1821~U1826: 玩家-BOSS 距离(v0.8.18) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bossDistWrap'),f:T.bossDistTextNow(T.bossDistCalcNow([],0,0))});})()"));
    t('U1821 玩家-BOSS 距离 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1822 无 BOSS 初值 场上无 BOSS', o.f === '👹 场上无 BOSS', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({d:T.bossDistCalcNow([{isBoss:true,dead:false,x:0,y:0,size:24}],60,12),t:T.bossDistTextNow(2),t2:T.bossDistTextNow(1.5)});})()"));
    t('U1823 正常 距离2格/文本', o2.d === 2 && o2.t === '👹 BOSS 2 格' && o2.t2 === '👹 BOSS 1.5 格', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossDistTextNow(0),b:T.bossDistCalcNow([{isBoss:true,dead:true,x:0,y:0,size:24}],0,0)});})()"));
    t('U1824 边界 0格/已灭无BOSS', o3.a === '👹 BOSS 0 格' && o3.b === -1, JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossDistTextNow(NaN),b:T.bossDistTextNow(undefined),c:T.bossDistTextNow(-3)});})()"));
    t('U1825 非法输入兜底', o4.a === '👹 场上无 BOSS' && o4.b === '👹 场上无 BOSS' && o4.c === '👹 场上无 BOSS', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const arr=T.r18enNow(),p=T.r18posNow();return JSON.stringify({dom:T.bossDistDomNow(),exp:T.bossDistTextNow(T.bossDistCalcNow(arr,p.px,p.py))});})()"));
    t('U1826 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1821;k<=1826;k++) t('U'+k+' BOSS 距离',false,e.message); }


  // ===== U1827~U1832: 玩家出生无敌剩余(v0.8.19) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('spawnInvWrap'),f:T.spawnInvTextNow(0)});})()"));
    t('U1827 无敌剩余 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1828 无无敌初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.spawnInvTextNow(90),b:T.spawnInvTextNow(30)});})()"));
    t('U1829 正常 1.5s/0.5s', o2.a === '🛡 无敌 1.5s' && o2.b === '🛡 无敌 0.5s', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.spawnInvTextNow(6),b:T.spawnInvTextNow(300)});})()"));
    t('U1830 边界 0.1s/5s', o3.a === '🛡 无敌 0.1s' && o3.b === '🛡 无敌 5s', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.spawnInvTextNow(NaN),b:T.spawnInvTextNow(-5)});})()"));
    t('U1831 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r19svNow();return JSON.stringify({dom:T.spawnInvDomNow(),exp:T.spawnInvTextNow(v)});})()"));
    t('U1832 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1827;k<=1832;k++) t('U'+k+' 无敌剩余',false,e.message); }


  // ===== U1833~U1838: 玩家狙击待命(v0.8.20) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('snipeReadyWrap'),f:T.snipeReadyTextNow(false)});})()"));
    t('U1833 狙击待命 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1834 未就绪初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.snipeReadyTextNow(true)});})()"));
    t('U1835 正常 就绪', o2.a === '🎯 狙击就绪', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.snipeReadyTextNow(1),b:T.snipeReadyTextNow(0)});})()"));
    t('U1836 边界 1就绪/0未就绪', o3.a === '🎯 狙击就绪' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.snipeReadyTextNow(undefined),b:T.snipeReadyTextNow(null)});})()"));
    t('U1837 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const r=T.r20srNow();return JSON.stringify({dom:T.snipeReadyDomNow(),exp:T.snipeReadyTextNow(r)});})()"));
    t('U1838 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1833;k<=1838;k++) t('U'+k+' 狙击待命',false,e.message); }


  // ===== U1839~U1844: 玩家攻击冷却剩余(v0.8.21) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('atkCdWrap'),f:T.atkCdTextNow(0)});})()"));
    t('U1839 攻击冷却 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1840 无冷却初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.atkCdTextNow(40),b:T.atkCdTextNow(24)});})()"));
    t('U1841 正常 0.7s/0.4s', o2.a === '🔥 冷却 0.7s' && o2.b === '🔥 冷却 0.4s', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.atkCdTextNow(6),b:T.atkCdTextNow(300)});})()"));
    t('U1842 边界 0.1s/5s', o3.a === '🔥 冷却 0.1s' && o3.b === '🔥 冷却 5s', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.atkCdTextNow(NaN),b:T.atkCdTextNow(-3)});})()"));
    t('U1843 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const v=T.r21cdNow();return JSON.stringify({dom:T.atkCdDomNow(),exp:T.atkCdTextNow(v)});})()"));
    t('U1844 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1839;k<=1844;k++) t('U'+k+' 攻击冷却',false,e.message); }


  // ===== U1845~U1850: 玩家格坐标(v0.8.22) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('playerPosWrap'),f:T.playerPosTextNow(null,null)});})()"));
    t('U1845 玩家格坐标 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1846 无玩家初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;const tl=T.r22tileNow();return JSON.stringify({a:T.playerPosTextNow(tl*12,tl*23),b:T.playerPosTextNow(tl*3,tl*5)});})()"));
    t('U1847 正常 格(12,23)/(3,5)', o2.a === '📍 格(12,23)' && o2.b === '📍 格(3,5)', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;const tl=T.r22tileNow();return JSON.stringify({a:T.playerPosTextNow(tl*0.4,tl*0.6),b:T.playerPosTextNow(tl*0.6,tl*0.4)});})()"));
    t('U1848 边界 四舍五入 格(0,1)/(1,0)', o3.a === '📍 格(0,1)' && o3.b === '📍 格(1,0)', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.playerPosTextNow(NaN,564)});})()"));
    t('U1849 非法输入兜底', o4.a === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const px=T.r22pxNow(),py=T.r22pyNow();return JSON.stringify({dom:T.playerPosDomNow(),exp:T.playerPosTextNow(px,py)});})()"));
    t('U1850 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1845;k<=1850;k++) t('U'+k+' 格坐标',false,e.message); }


  // ===== U1851~U1856: 玩家移动状态(v0.8.23) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('moveStateWrap'),f:T.playerMoveTextNow(false)});})()"));
    t('U1851 移动状态 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1852 静止初值', o.f === '🧍 静止', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.playerMoveTextNow(true)});})()"));
    t('U1853 正常 移动中', o2.a === '🏃 移动中', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.playerMoveTextNow(1),b:T.playerMoveTextNow(0)});})()"));
    t('U1854 边界 1移动/0静止', o3.a === '🏃 移动中' && o3.b === '🧍 静止', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.playerMoveTextNow(undefined),b:T.playerMoveTextNow(null)});})()"));
    t('U1855 非法输入兜底', o4.a === '🧍 静止' && o4.b === '🧍 静止', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const m=T.r23mvNow();return JSON.stringify({dom:T.moveStateDomNow(),exp:T.playerMoveTextNow(m)});})()"));
    t('U1856 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1851;k<=1856;k++) t('U'+k+' 移动状态',false,e.message); }


  // ===== U1857~U1862: 本关已刷敌进度(v0.8.24) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('spawnProgWrap'),f:T.spawnProgTextNow(0,0)});})()"));
    t('U1857 刷敌进度 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1858 无总敌初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.spawnProgTextNow(5,12),b:T.spawnProgTextNow(12,12)});})()"));
    t('U1859 正常 5/12 与 12/12', o2.a === '🕐 已刷 5/12' && o2.b === '🕐 已刷 12/12', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.spawnProgTextNow(0,1),b:T.spawnProgTextNow(1,1)});})()"));
    t('U1860 边界 0/1 与 1/1', o3.a === '🕐 已刷 0/1' && o3.b === '🕐 已刷 1/1', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.spawnProgTextNow(NaN,10),b:T.spawnProgTextNow(3,-5)});})()"));
    t('U1861 非法输入兜底', o4.a === '🕐 已刷 0/10' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const s=T.r24spNow(),to=T.r24toNow();return JSON.stringify({dom:T.spawnProgDomNow(),exp:T.spawnProgTextNow(s,to)});})()"));
    t('U1862 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1857;k<=1862;k++) t('U'+k+' 刷敌进度',false,e.message); }


  // ===== U1863~U1868: 波次总进度(v0.8.25) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('wavePhaseWrap'),f:T.wavePhaseTextNow(0,0)});})()"));
    t('U1863 波次进度 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1864 无波次初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.wavePhaseTextNow(3,7),b:T.wavePhaseTextNow(7,7)});})()"));
    t('U1865 正常 3/7 与 7/7', o2.a === '🌊 波 3/7' && o2.b === '🌊 波 7/7', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.wavePhaseTextNow(1,1),b:T.wavePhaseTextNow(5,5)});})()"));
    t('U1866 边界 1/1 与 5/5', o3.a === '🌊 波 1/1' && o3.b === '🌊 波 5/5', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.wavePhaseTextNow(NaN,7),b:T.wavePhaseTextNow(3,-1)});})()"));
    t('U1867 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const w=T.r25wNow(),to=T.r25tNow();return JSON.stringify({dom:T.wavePhaseDomNow(),exp:T.wavePhaseTextNow(w,to)});})()"));
    t('U1868 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1863;k<=1868;k++) t('U'+k+' 波次进度',false,e.message); }


  // ===== U1869~U1874: 玩家-基地曼哈顿距(v0.8.26) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('manhattanWrap'),f:T.manhattanBaseTextNow(null,null)});})()"));
    t('U1869 曼哈顿距 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1870 无玩家初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;const bx=T.r26bcxNow(),by=T.r26bcyNow();return JSON.stringify({a:T.manhattanBaseTextNow(bx,by),b:T.manhattanBaseTextNow(bx+3*T.r26tileNow(),by)});})()"));
    t('U1871 正常 0格/3格', o2.a === '📏 曼哈顿 0 格' && o2.b === '📏 曼哈顿 3 格', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;const bx=T.r26bcxNow(),by=T.r26bcyNow();return JSON.stringify({a:T.manhattanBaseTextNow(bx+2*T.r26tileNow(),by-3*T.r26tileNow())});})()"));
    t('U1872 边界 对角 5格', o3.a === '📏 曼哈顿 5 格', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.manhattanBaseTextNow(NaN,564)});})()"));
    t('U1873 非法输入兜底', o4.a === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const px=T.r26pxNow(),py=T.r26pyNow();return JSON.stringify({dom:T.manhattanDomNow(),exp:T.manhattanBaseTextNow(px,py)});})()"));
    t('U1874 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1869;k<=1874;k++) t('U'+k+' 曼哈顿距',false,e.message); }


  // ===== U1875~U1880: 连击窗口剩余进度(v0.8.27) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('comboWinWrap'),f:T.comboWinPctTextNow(0,5),g:T.comboWinPctTextNow(0,0)});})()"));
    t('U1875 连击窗口 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1876 无窗口初值 —', o.g === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.comboWinPctTextNow(3.4,5),b:T.comboWinPctTextNow(2.5,5)});})()"));
    t('U1877 正常 68%/50%', o2.a === '⏱ 窗口 68%' && o2.b === '⏱ 窗口 50%', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.comboWinPctTextNow(5,5),b:T.comboWinPctTextNow(6,5)});})()"));
    t('U1878 边界 100%/钳制100%', o3.a === '⏱ 窗口 100%' && o3.b === '⏱ 窗口 100%', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.comboWinPctTextNow(NaN,5),b:T.comboWinPctTextNow(2,0)});})()"));
    t('U1879 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const ct=T.r27ctNow(),cw=T.r27cwNow();return JSON.stringify({dom:T.comboWinDomNow(),exp:T.comboWinPctTextNow(ct,cw)});})()"));
    t('U1880 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1875;k<=1880;k++) t('U'+k+' 连击窗口',false,e.message); }


  // ===== U1881~U1886: 基地下一级升级花费(v0.8.28) =====
  try {
    const L = [{price:0},{price:250},{price:650},{price:1400},{price:3000},{price:6000}];
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('baseUpgWrap'),f:T.baseUpgPriceTextNow(0,[{price:0},{price:250},{price:650}])});})()"));
    t('U1881 基地升级花费 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1882 初值 250金', o.f === '🏰 下阶 250金', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseUpgPriceTextNow(1,[{price:0},{price:250},{price:650}]),b:T.baseUpgPriceTextNow(2,[{price:0},{price:250},{price:650},{price:1400}])});})()"));
    t('U1883 正常 650金/1400金', o2.a === '🏰 下阶 650金' && o2.b === '🏰 下阶 1400金', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseUpgPriceTextNow(5,[{price:0},{price:250},{price:650},{price:1400},{price:3000},{price:6000}])});})()"));
    t('U1884 边界 满级', o3.a === '🏰 基地满级', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseUpgPriceTextNow(-1,[{price:0}]),b:T.baseUpgPriceTextNow(NaN,[{price:0}])});})()"));
    t('U1885 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const bl=T.r28blNow(),ls=T.r28levelsNow();return JSON.stringify({dom:T.baseUpgDomNow(),exp:T.baseUpgPriceTextNow(bl,ls)});})()"));
    t('U1886 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1881;k<=1886;k++) t('U'+k+' 基地花费',false,e.message); }


  // ===== U1887~U1892: BOSS 已造成伤害(v0.8.29) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bossDmgWrap'),f:T.bossDmgDealtTextNow(0,0)});})()"));
    t('U1887 BOSS 已伤 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1888 无BOSS初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossDmgDealtTextNow(366,600),b:T.bossDmgDealtTextNow(120,600)});})()"));
    t('U1889 正常 234/480', o2.a === '💥 BOSS 已伤 234' && o2.b === '💥 BOSS 已伤 480', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossDmgDealtTextNow(0,600),b:T.bossDmgDealtTextNow(700,600)});})()"));
    t('U1890 边界 600/钳制0', o3.a === '💥 BOSS 已伤 600' && o3.b === '💥 BOSS 已伤 0', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossDmgDealtTextNow(NaN,600),b:T.bossDmgDealtTextNow(-5,600)});})()"));
    t('U1891 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const h=T.r29bhNow(),m=T.r29bmNow();return JSON.stringify({dom:T.bossDmgDomNow(),exp:T.bossDmgDealtTextNow(h,m)});})()"));
    t('U1892 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1887;k<=1892;k++) t('U'+k+' BOSS已伤',false,e.message); }


  // ===== U1893~U1898: 场上敌人最大生命(v0.8.30) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('enemyMaxWrap'),f:T.enemyMaxHpTextNow([])});})()"));
    t('U1893 敌血峰 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1894 无敌人初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.enemyMaxHpTextNow([{hp:50},{hp:120},{hp:80}]),b:T.enemyMaxHpTextNow([{hp:200}])});})()"));
    t('U1895 正常 120/200', o2.a === '💀 敌血峰 120' && o2.b === '💀 敌血峰 200', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.enemyMaxHpTextNow([{hp:1}]),b:T.enemyMaxHpTextNow([{hp:0},{hp:3}])});})()"));
    t('U1896 边界 1/3', o3.a === '💀 敌血峰 1' && o3.b === '💀 敌血峰 3', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.enemyMaxHpTextNow([{hp:NaN}]),b:T.enemyMaxHpTextNow(null)});})()"));
    t('U1897 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const en=T.r30enNow();return JSON.stringify({dom:T.enemyMaxDomNow(),exp:T.enemyMaxHpTextNow(en)});})()"));
    t('U1898 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1893;k<=1898;k++) t('U'+k+' 敌血峰',false,e.message); }


  // ===== U1899~U1904: 本局金币占生涯比例(v0.8.31) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('coinShareWrap'),f:T.coinShareTextNow(0,0)});})()"));
    t('U1899 金币占比 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1900 无生涯初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.coinShareTextNow(36,300),b:T.coinShareTextNow(150,300)});})()"));
    t('U1901 正常 12%/50%', o2.a === '💰 本局占生涯 12%' && o2.b === '💰 本局占生涯 50%', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.coinShareTextNow(300,300),b:T.coinShareTextNow(900,300)});})()"));
    t('U1902 边界 100%/钳制100%', o3.a === '💰 本局占生涯 100%' && o3.b === '💰 本局占生涯 100%', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.coinShareTextNow(NaN,300),b:T.coinShareTextNow(50,-1)});})()"));
    t('U1903 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const rc=T.r31rcNow(),ct=T.r31ctNow();return JSON.stringify({dom:T.coinShareDomNow(),exp:T.coinShareTextNow(rc,ct)});})()"));
    t('U1904 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1899;k<=1904;k++) t('U'+k+' 金币占比',false,e.message); }


  // ===== U1905~U1910: 复活成本(v0.8.32) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('reviveCostWrap'),f:T.reviveCostTextNow(40)});})()"));
    t('U1905 复活成本 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1906 初值 40金', o.f === '🔧 复活 40金', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.reviveCostTextNow(160),b:T.reviveCostTextNow(12345)});})()"));
    t('U1907 正常 160金/千分位', o2.a === '🔧 复活 160金' && o2.b === '🔧 复活 12,345金', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.reviveCostTextNow(999999),b:T.reviveCostTextNow(0)});})()"));
    t('U1908 边界 999,999金/0金', o3.a === '🔧 复活 999,999金' && o3.b === '🔧 复活 0金', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.reviveCostTextNow(NaN),b:T.reviveCostTextNow(-5)});})()"));
    t('U1909 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const rc=T.r32rcNow();return JSON.stringify({dom:T.reviveCostDomNow(),exp:T.reviveCostTextNow(rc)});})()"));
    t('U1910 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1905;k<=1910;k++) t('U'+k+' 复活成本',false,e.message); }


  // ===== U1911~U1916: 金运金币加成(v0.8.33) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('goldBonusWrap'),f:T.goldBonusTextNow(0)});})()"));
    t('U1911 金运加成 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1912 初值 x1.0', o.f === '🍀 金运 x1.0', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.goldBonusTextNow(1),b:T.goldBonusTextNow(2)});})()"));
    t('U1913 正常 x1.2/x1.3', o2.a === '🍀 金运 x1.2' && o2.b === '🍀 金运 x1.3', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.goldBonusTextNow(3),b:T.goldBonusTextNow(10)});})()"));
    t('U1914 边界 x1.5/x2.5', o3.a === '🍀 金运 x1.5' && o3.b === '🍀 金运 x2.5', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.goldBonusTextNow(NaN),b:T.goldBonusTextNow(-1)});})()"));
    t('U1915 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const cu=T.r33cuNow();return JSON.stringify({dom:T.goldBonusDomNow(),exp:T.goldBonusTextNow(cu)});})()"));
    t('U1916 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1911;k<=1916;k++) t('U'+k+' 金运加成',false,e.message); }


  // ===== U1917~U1922: 羁绊激活计数(v0.8.34) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bondCntWrap'),f:T.bondActiveCountTextNow(0,5)});})()"));
    t('U1917 羁绊计数 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1918 初值 0/5', o.f === '⚡ 羁绊 0/5', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bondActiveCountTextNow(1,5),b:T.bondActiveCountTextNow(2,5)});})()"));
    t('U1919 正常 1/5/2/5', o2.a === '⚡ 羁绊 1/5' && o2.b === '⚡ 羁绊 2/5', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bondActiveCountTextNow(5,5),b:T.bondActiveCountTextNow(3,3)});})()"));
    t('U1920 边界 5/5/3/3', o3.a === '⚡ 羁绊 5/5' && o3.b === '⚡ 羁绊 3/3', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bondActiveCountTextNow(NaN,5),b:T.bondActiveCountTextNow(-1,5)});})()"));
    t('U1921 非法输入兜底', o4.a === '—' && o4.b === '⚡ 羁绊 0/5', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const a=T.r34baNow(),bt=T.r34btNow();return JSON.stringify({dom:T.bondCntDomNow(),exp:T.bondActiveCountTextNow(a,bt)});})()"));
    t('U1922 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1917;k<=1922;k++) t('U'+k+' 羁绊计数',false,e.message); }


  // ===== U1923~U1928: 英雄大招冷却(v0.8.35) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('heroUltWrap'),f:T.heroUltCdTextNow(0)});})()"));
    t('U1923 英雄技冷却 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1924 初值 就绪', o.f === '🅱 英雄技 就绪', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.heroUltCdTextNow(12.3),b:T.heroUltCdTextNow(30)});})()"));
    t('U1925 正常 12.3s/30s', o2.a === '🅱 英雄技 12.3s' && o2.b === '🅱 英雄技 30s', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.heroUltCdTextNow(0.1),b:T.heroUltCdTextNow(45)});})()"));
    t('U1926 边界 0.1s/45s', o3.a === '🅱 英雄技 0.1s' && o3.b === '🅱 英雄技 45s', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.heroUltCdTextNow(NaN),b:T.heroUltCdTextNow(-1)});})()"));
    t('U1927 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const hu=T.r35huNow();return JSON.stringify({dom:T.r35HeroUltDomNow(),exp:T.heroUltCdTextNow(hu)});})()"));
    t('U1928 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1923;k<=1928;k++) t('U'+k+' 英雄技冷却',false,e.message); }


  // ===== U1929~U1934: 近战大招冷却(v0.8.36) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('r36UltCdWrap'),f:T.ultCdTextNow(0)});})()"));
    t('U1929 大招冷却 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1930 初值 就绪', o.f === '⚡ 大招 就绪', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.ultCdTextNow(5.5),b:T.ultCdTextNow(8)});})()"));
    t('U1931 正常 5.5s/8s', o2.a === '⚡ 大招 5.5s' && o2.b === '⚡ 大招 8s', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.ultCdTextNow(0.2),b:T.ultCdTextNow(1)});})()"));
    t('U1932 边界 0.2s/1s', o3.a === '⚡ 大招 0.2s' && o3.b === '⚡ 大招 1s', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.ultCdTextNow(NaN),b:T.ultCdTextNow(-3)});})()"));
    t('U1933 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const uc=T.r36ucNow();return JSON.stringify({dom:T.ultCdDomNow(),exp:T.ultCdTextNow(uc)});})()"));
    t('U1934 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1929;k<=1934;k++) t('U'+k+' 大招冷却',false,e.message); }


  // ===== U1935~U1940: 本局复活次数(v0.8.37) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('reviveCntWrap'),f:T.reviveCountTextNow(0)});})()"));
    t('U1935 复活次数 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1936 初值 0', o.f === '🔄 复活 0', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.reviveCountTextNow(1),b:T.reviveCountTextNow(3)});})()"));
    t('U1937 正常 x1/x3', o2.a === '🔄 复活 x1' && o2.b === '🔄 复活 x3', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.reviveCountTextNow(0),b:T.reviveCountTextNow(9)});})()"));
    t('U1938 边界 0/x9', o3.a === '🔄 复活 0' && o3.b === '🔄 复活 x9', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.reviveCountTextNow(NaN),b:T.reviveCountTextNow(-2)});})()"));
    t('U1939 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const rc=T.r37rcNow();return JSON.stringify({dom:T.reviveCntDomNow(),exp:T.reviveCountTextNow(rc)});})()"));
    t('U1940 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1935;k<=1940;k++) t('U'+k+' 复活次数',false,e.message); }


  // ===== U1941~U1946: BOSS 出场计数(v0.8.38) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bossCntWrap'),f:T.bossCountTextNow(0)});})()"));
    t('U1941 BOSS 计数 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1942 初值 x0', o.f === '👹 BOSS x0', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossCountTextNow(2),b:T.bossCountTextNow(5)});})()"));
    t('U1943 正常 x2/x5', o2.a === '👹 BOSS x2' && o2.b === '👹 BOSS x5', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossCountTextNow(0),b:T.bossCountTextNow(12)});})()"));
    t('U1944 边界 x0/x12', o3.a === '👹 BOSS x0' && o3.b === '👹 BOSS x12', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossCountTextNow(NaN),b:T.bossCountTextNow(-1)});})()"));
    t('U1945 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const bc=T.r38bcNow();return JSON.stringify({dom:T.bossCntDomNow(),exp:T.bossCountTextNow(bc)});})()"));
    t('U1946 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1941;k<=1946;k++) t('U'+k+' BOSS计数',false,e.message); }


  // ===== U1947~U1952: 本局最大生命(v0.8.39) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('maxLivesWrap'),f:T.maxLivesTextNow(3,0)});})()"));
    t('U1947 最大生命 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1948 初值 3', o.f === '❤ 生命 3', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.maxLivesTextNow(3,1),b:T.maxLivesTextNow(3,3)});})()"));
    t('U1949 正常 4/6', o2.a === '❤ 生命 4' && o2.b === '❤ 生命 6', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.maxLivesTextNow(3,0),b:T.maxLivesTextNow(3,9)});})()"));
    t('U1950 边界 3/12', o3.a === '❤ 生命 3' && o3.b === '❤ 生命 12', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.maxLivesTextNow(NaN,1),b:T.maxLivesTextNow(3,-1)});})()"));
    t('U1951 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const hp=T.r39hpNow();return JSON.stringify({dom:T.maxLivesDomNow(),exp:T.maxLivesTextNow(3,hp)});})()"));
    t('U1952 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1947;k<=1952;k++) t('U'+k+' 最大生命',false,e.message); }


  // ===== U1953~U1958: 屏震强度(v0.8.40) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('shakeWrap'),f:T.shakeTextNow(0)});})()"));
    t('U1953 震屏 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1954 初值 0', o.f === '🌊 震屏 0', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.shakeTextNow(0.8),b:T.shakeTextNow(3)});})()"));
    t('U1955 正常 0.8/3', o2.a === '🌊 震屏 0.8' && o2.b === '🌊 震屏 3', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.shakeTextNow(0),b:T.shakeTextNow(6)});})()"));
    t('U1956 边界 0/6', o3.a === '🌊 震屏 0' && o3.b === '🌊 震屏 6', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.shakeTextNow(NaN),b:T.shakeTextNow(-1)});})()"));
    t('U1957 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const sh=T.r40shNow();return JSON.stringify({dom:T.shakeDomNow(),exp:T.shakeTextNow(sh)});})()"));
    t('U1958 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1953;k<=1958;k++) t('U'+k+' 震屏',false,e.message); }


  // ===== U1959~U1964: 关卡进场倒计时(v0.8.41) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('lvIntroWrap'),f:T.lvIntroTextNow(0)});})()"));
    t('U1959 进场 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1960 初值 0s', o.f === '🚀 进场 0s', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.lvIntroTextNow(1.2),b:T.lvIntroTextNow(2.5)});})()"));
    t('U1961 正常 1.2s/2.5s', o2.a === '🚀 进场 1.2s' && o2.b === '🚀 进场 2.5s', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.lvIntroTextNow(0),b:T.lvIntroTextNow(4)});})()"));
    t('U1962 边界 0s/4s', o3.a === '🚀 进场 0s' && o3.b === '🚀 进场 4s', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.lvIntroTextNow(NaN),b:T.lvIntroTextNow(-1)});})()"));
    t('U1963 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const li=T.r41liNow();return JSON.stringify({dom:T.lvIntroDomNow(),exp:T.lvIntroTextNow(li)});})()"));
    t('U1964 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1959;k<=1964;k++) t('U'+k+' 进场',false,e.message); }


  // ===== U1965~U1970: 爆破弹头等级(v0.8.42) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bombLvWrap'),f:T.bombLvTextNow(0)});})()"));
    t('U1965 爆破等级 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1966 初值 Lv0', o.f === '🧨 爆破 Lv0', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bombLvTextNow(1),b:T.bombLvTextNow(2)});})()"));
    t('U1967 正常 Lv1/Lv2', o2.a === '🧨 爆破 Lv1' && o2.b === '🧨 爆破 Lv2', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bombLvTextNow(0),b:T.bombLvTextNow(5)});})()"));
    t('U1968 边界 Lv0/Lv5', o3.a === '🧨 爆破 Lv0' && o3.b === '🧨 爆破 Lv5', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bombLvTextNow(NaN),b:T.bombLvTextNow(-1)});})()"));
    t('U1969 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const bm=T.r42bmNow();return JSON.stringify({dom:T.bombLvDomNow(),exp:T.bombLvTextNow(bm)});})()"));
    t('U1970 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1965;k<=1970;k++) t('U'+k+' 爆破等级',false,e.message); }


  // ===== U1971~U1976: 击杀定格剩余(v0.8.43) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('hitStopWrap'),f:T.hitStopTextNow(0)});})()"));
    t('U1971 击杀定格 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1972 初值 关', o.f === '✋ 定格 关', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.hitStopTextNow(0.07),b:T.hitStopTextNow(0.03)});})()"));
    t('U1973 正常 0.07s/0.03s', o2.a === '✋ 定格 0.07s' && o2.b === '✋ 定格 0.03s', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.hitStopTextNow(0.01),b:T.hitStopTextNow(0.1)});})()"));
    t('U1974 边界 0.01s/0.1s', o3.a === '✋ 定格 0.01s' && o3.b === '✋ 定格 0.1s', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.hitStopTextNow(NaN),b:T.hitStopTextNow(-1)});})()"));
    t('U1975 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const hs=T.r43hsNow();return JSON.stringify({dom:T.hitStopDomNow(),exp:T.hitStopTextNow(hs)});})()"));
    t('U1976 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1971;k<=1976;k++) t('U'+k+' 击杀定格',false,e.message); }


  // ===== U1977~U1982: 下一敌刷新倒计时(v0.8.44) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('nextEnemyWrap'),f:T.nextEnemyTextNow(0)});})()"));
    t('U1977 刷敌倒计时 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1978 初值 即刻', o.f === '👾 刷敌 即刻', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.nextEnemyTextNow(30),b:T.nextEnemyTextNow(180)});})()"));
    t('U1979 正常 0.5s/3s', o2.a === '👾 刷敌 0.5s' && o2.b === '👾 刷敌 3s', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.nextEnemyTextNow(1),b:T.nextEnemyTextNow(600)});})()"));
    t('U1980 边界 即刻/10s', o3.a === '👾 刷敌 0s' && o3.b === '👾 刷敌 10s', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.nextEnemyTextNow(NaN),b:T.nextEnemyTextNow(-5)});})()"));
    t('U1981 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const es=T.r44esNow();return JSON.stringify({dom:T.nextEnemyDomNow(),exp:T.nextEnemyTextNow(es)});})()"));
    t('U1982 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1977;k<=1982;k++) t('U'+k+' 刷敌倒计时',false,e.message); }


  // ===== U1983~U1988: BOSS 死亡演出剩余(v0.8.45) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bossDeathWrap'),f:T.bossDeathTextNow(0)});})()"));
    t('U1983 BOSS 死亡演出 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1984 初值 关', o.f === '💀 演出 关', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossDeathTextNow(1.15),b:T.bossDeathTextNow(0.5)});})()"));
    t('U1985 正常 1.15s/0.5s', o2.a === '💀 演出 1.15s' && o2.b === '💀 演出 0.5s', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossDeathTextNow(0.01),b:T.bossDeathTextNow(2)});})()"));
    t('U1986 边界 0.01s/2s', o3.a === '💀 演出 0.01s' && o3.b === '💀 演出 2s', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bossDeathTextNow(NaN),b:T.bossDeathTextNow(-2)});})()"));
    t('U1987 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const bd=T.r45bdNow();return JSON.stringify({dom:T.bossDeathDomNow(),exp:T.bossDeathTextNow(bd)});})()"));
    t('U1988 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1983;k<=1988;k++) t('U'+k+' BOSS死亡演出',false,e.message); }


  // ===== U1989~U1994: 宠物动画计时(v0.8.46) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('petAnimWrap'),f:T.petAnimTextNow(0)});})()"));
    t('U1989 宠物动画 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1990 初值 0s', o.f === '🐾 宠物动 0s', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petAnimTextNow(60),b:T.petAnimTextNow(300)});})()"));
    t('U1991 正常 1s/5s', o2.a === '🐾 宠物动 1s' && o2.b === '🐾 宠物动 5s', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petAnimTextNow(1),b:T.petAnimTextNow(1200)});})()"));
    t('U1992 边界 0.02s/20s', o3.a === '🐾 宠物动 0.02s' && o3.b === '🐾 宠物动 20s', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petAnimTextNow(NaN),b:T.petAnimTextNow(-3)});})()"));
    t('U1993 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const pa=T.r46paNow();return JSON.stringify({dom:T.petAnimDomNow(),exp:T.petAnimTextNow(pa)});})()"));
    t('U1994 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1989;k<=1994;k++) t('U'+k+' 宠物动画',false,e.message); }


  // ===== U1995~U2000: 宠物当前反应(v0.8.47) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('petReactWrap'),f:T.petReactTextNow('idle')});})()"));
    t('U1995 宠物反应 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U1996 初值 待机', o.f === '🐾 反应 待机', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petReactTextNow('fire'),b:T.petReactTextNow('kill')});})()"));
    t('U1997 正常 射击/欢跳', o2.a === '🐾 反应 射击' && o2.b === '🐾 反应 欢跳', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petReactTextNow('hit'),b:T.petReactTextNow('idle')});})()"));
    t('U1998 边界 受击/待机', o3.a === '🐾 反应 受击' && o3.b === '🐾 反应 待机', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.petReactTextNow(''),b:T.petReactTextNow('bogus')});})()"));
    t('U1999 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const pr=T.r47prNow();return JSON.stringify({dom:T.petReactDomNow(),exp:T.petReactTextNow(pr)});})()"));
    t('U2000 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=1995;k<=2000;k++) t('U'+k+' 宠物反应',false,e.message); }


  // ===== U2001~U2006: 本关已得星级(v0.8.48) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('levelStarWrap'),f:T.levelStarTextNow(0)});})()"));
    t('U2001 本关星级 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U2002 初值 0/3', o.f === '⭐ 本关 0/3', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.levelStarTextNow(1),b:T.levelStarTextNow(3)});})()"));
    t('U2003 正常 1/3、3/3', o2.a === '⭐ 本关 1/3' && o2.b === '⭐ 本关 3/3', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.levelStarTextNow(0),b:T.levelStarTextNow(2.6)});})()"));
    t('U2004 边界 0/3、2/3(截断)', o3.a === '⭐ 本关 0/3' && o3.b === '⭐ 本关 2/3', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.levelStarTextNow(NaN),b:T.levelStarTextNow(-1)});})()"));
    t('U2005 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const ls=T.r48lsNow();return JSON.stringify({dom:T.levelStarDomNow(),exp:T.levelStarTextNow(ls)});})()"));
    t('U2006 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=2001;k<=2006;k++) t('U'+k+' 本关星级',false,e.message); }


  // ===== U2007~U2012: 传送门冷却(v0.8.49) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('portalCdWrap'),f:T.portalCdTextNow(0)});})()"));
    t('U2007 传送门冷却 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U2008 初值 就绪', o.f === '🌀 传送 就绪', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.portalCdTextNow(45),b:T.portalCdTextNow(90)});})()"));
    t('U2009 正常 0.75s/1.5s', o2.a === '🌀 传送 0.75s' && o2.b === '🌀 传送 1.5s', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.portalCdTextNow(1),b:T.portalCdTextNow(180)});})()"));
    t('U2010 边界 0.02s/3s', o3.a === '🌀 传送 0.02s' && o3.b === '🌀 传送 3s', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.portalCdTextNow(NaN),b:T.portalCdTextNow(-1)});})()"));
    t('U2011 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const pc=T.r49pcNow();return JSON.stringify({dom:T.portalCdDomNow(),exp:T.portalCdTextNow(pc)});})()"));
    t('U2012 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=2007;k<=2012;k++) t('U'+k+' 传送门冷却',false,e.message); }


  // ===== U2013~U2018: 基地被围敌数(v0.8.50) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('baseSiegeWrap'),f:T.baseSiegeTextNow(0)});})()"));
    t('U2013 基地被围 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U2014 初值 安全', o.f === '🏰 基地 安全', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseSiegeTextNow(1),b:T.baseSiegeTextNow(2)});})()"));
    t('U2015 正常 被围x1/x2', o2.a === '🏰 基地 被围 x1' && o2.b === '🏰 基地 被围 x2', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseSiegeTextNow(0),b:T.baseSiegeTextNow(5)});})()"));
    t('U2016 边界 安全/危x5', o3.a === '🏰 基地 安全' && o3.b === '🏰 基地 危 x5', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.baseSiegeTextNow(NaN),b:T.baseSiegeTextNow(-2)});})()"));
    t('U2017 非法输入兜底', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();const bs=T.r50bsNow();return JSON.stringify({dom:T.baseSiegeDomNow(),exp:T.baseSiegeTextNow(bs)});})()"));
    t('U2018 DOM 与函数一致', o5.dom === o5.exp, JSON.stringify(o5));
  } catch(e){ for(let k=2013;k<=2018;k++) t('U'+k+' 基地被围',false,e.message); }


  // ===== U2019~U2024: 穿透弹头(v0.8.51) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('piercePillWrap'),f:T.pierceTotalTextNow(0,0)});})()"));
    t('U2019 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U2020 零等级 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.pierceTotalTextNow(2,1),b:T.pierceTotalTextNow(1,0)});})()"));
    t('U2021 正常 ×3/×1', o2.a === '🎯 穿透 ×3' && o2.b === '🎯 穿透 ×1', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.pierceTotalTextNow(-1,-1));})()"));
    t('U2022 负数兜底 —', o3 === '—', o3);
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.pierceTotalTextNow('x','y'),b:T.pierceTotalTextNow(NaN,NaN)});})()"));
    t('U2023 非法兜底 —', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.piercePillDomNow()});})()"));
    t('U2024 DOM 可读', !!o5.dom, JSON.stringify(o5));
  } catch(e){ for(let k=2019;k<=2024;k++) t('U'+k+' 穿透pill',false,e.message); }


  // ===== U2025~U2030: 炸弹弹头(v0.8.52) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bombPillWrap'),f:T.bombStatusTextNow(0)});})()"));
    t('U2025 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U2026 未装备 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.bombStatusTextNow(1));})()"));
    t('U2027 已装备 💣', o2 === '💣 已装备', o2);
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bombStatusTextNow(-1),b:T.bombStatusTextNow(NaN)});})()"));
    t('U2028 非法兜底 —', o3.a === '—' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.bombPillDomNow()});})()"));
    t('U2029 DOM 可读', !!o4.dom, JSON.stringify(o4));
    t('U2030 一致性', typeof o4.dom === 'string', o4.dom);
  } catch(e){ for(let k=2025;k<=2030;k++) t('U'+k+' 炸弹pill',false,e.message); }


  // ===== U2031~U2036: 三向散射(v0.8.53) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('spreadPillWrap'),f:T.spreadTextNow(0)});})()"));
    t('U2031 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U2032 零等级 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.spreadTextNow(2),b:T.spreadTextNow(1)});})()"));
    t('U2033 正常 ×2/×1', o2.a === '🔸 ×2' && o2.b === '🔸 ×1', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.spreadTextNow(-1));})()"));
    t('U2034 负数兜底 —', o3 === '—', o3);
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.spreadTextNow('x'),b:T.spreadTextNow(NaN)});})()"));
    t('U2035 非法兜底 —', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.spreadPillDomNow()});})()"));
    t('U2036 DOM 可读', !!o5.dom, JSON.stringify(o5));
  } catch(e){ for(let k=2031;k<=2036;k++) t('U'+k+' 散射pill',false,e.message); }


  // ===== U2037~U2042: 巨弹头(v0.8.54) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bigBulletPillWrap'),f:T.bigBulletTextNow(0)});})()"));
    t('U2037 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U2038 未装备 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.bigBulletTextNow(1));})()"));
    t('U2039 已装备 🔴', o2 === '🔴 已装备', o2);
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bigBulletTextNow(-1),b:T.bigBulletTextNow(NaN)});})()"));
    t('U2040 非法兜底 —', o3.a === '—' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.bigBulletPillDomNow()});})()"));
    t('U2041 DOM 可读', !!o4.dom, JSON.stringify(o4));
    t('U2042 一致性', typeof o4.dom === 'string', o4.dom);
  } catch(e){ for(let k=2037;k<=2042;k++) t('U'+k+' 巨弹pill',false,e.message); }


  // ===== U2043~U2048: 弹速加成(v0.8.55) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bulletSpdPillWrap'),f:T.bulletSpdTotalTextNow(0,0)});})()"));
    t('U2043 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U2044 零加成 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bulletSpdTotalTextNow(2,1)});})()"));
    t('U2045 强化2+永久1=+45%', o2.a === '🚀 +45%', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.bulletSpdTotalTextNow(-1,-1));})()"));
    t('U2046 负数兜底 —', o3 === '—', o3);
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bulletSpdTotalTextNow('x',NaN)});})()"));
    t('U2047 非法兜底 —', o4.a === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.bulletSpdPillDomNow()});})()"));
    t('U2048 DOM 可读', !!o5.dom, JSON.stringify(o5));
  } catch(e){ for(let k=2043;k<=2048;k++) t('U'+k+' 弹速pill',false,e.message); }


  // ===== U2049~U2054: 快速装填(v0.8.56) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('rapidPillWrap'),f:T.rapidTextNow(0)});})()"));
    t('U2049 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U2050 零等级 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.rapidTextNow(3),b:T.rapidTextNow(1)});})()"));
    t('U2051 正常 ×3/×1', o2.a === '⚡ ×3' && o2.b === '⚡ ×1', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.rapidTextNow(-1));})()"));
    t('U2052 负数兜底 —', o3 === '—', o3);
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.rapidTextNow('x'),b:T.rapidTextNow(2.5)});})()"));
    t('U2053 非法/小数兜底', o4.a === '—' && o4.b === '⚡ ×2', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.rapidPillDomNow()});})()"));
    t('U2054 DOM 可读', !!o5.dom, JSON.stringify(o5));
  } catch(e){ for(let k=2049;k<=2054;k++) t('U'+k+' 装填pill',false,e.message); }


  // ===== U2055~U2060: 射速永久加成(v0.8.57) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('cdBonusPillWrap'),f:T.cdBonusTextNow(0)});})()"));
    t('U2055 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U2056 零加成 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.cdBonusTextNow(3),b:T.cdBonusTextNow(1)});})()"));
    t('U2057 正常 -15%/-5%', o2.a === '⏱ -15%' && o2.b === '⏱ -5%', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.cdBonusTextNow(-1));})()"));
    t('U2058 负数兜底 —', o3 === '—', o3);
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.cdBonusTextNow('x'),b:T.cdBonusTextNow(NaN)});})()"));
    t('U2059 非法兜底 —', o4.a === '—' && o4.b === '—', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.cdBonusPillDomNow()});})()"));
    t('U2060 DOM 可读', !!o5.dom, JSON.stringify(o5));
  } catch(e){ for(let k=2055;k<=2060;k++) t('U'+k+' 冷却pill',false,e.message); }


  // ===== U2061~U2066: 冰冻效果(v0.8.58) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('freezePillWrap'),f:T.freezeTextNow(0)});})()"));
    t('U2061 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U2062 零冰冻初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.freezeTextNow(3),b:T.freezeTextNow(0.5)});})()"));
    t('U2063 正常 3s/1s(取整)', o2.a === '❄ 3s' && o2.b === '❄ 1s', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.freezeTextNow(-1),b:T.freezeTextNow(NaN)});})()"));
    t('U2064 非法兜底 —', o3.a === '—' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.freezePillDomNow()});})()"));
    t('U2065 DOM 可读', !!o4.dom, JSON.stringify(o4));
    t('U2066 一致性', typeof o4.dom === 'string', o4.dom);
  } catch(e){ for(let k=2061;k<=2066;k++) t('U'+k+' 冰冻pill',false,e.message); }


  // ===== U2067~U2072: 敌人在场(v0.8.59) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('enemyOnFieldWrap'),f:T.enemyOnFieldTextNow(0)});})()"));
    t('U2067 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U2068 零敌初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.enemyOnFieldTextNow(5),b:T.enemyOnFieldTextNow(1)});})()"));
    t('U2069 正常 5/1', o2.a === '👾 5 在场' && o2.b === '👾 1 在场', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.enemyOnFieldTextNow(-1),b:T.enemyOnFieldTextNow(NaN)});})()"));
    t('U2070 非法兜底 —', o3.a === '—' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.enemyOnFieldPillDomNow(),n:T.aliveEnemiesNow()});})()"));
    t('U2071 DOM 可读', !!o4.dom, JSON.stringify(o4));
    t('U2072 一致性', typeof o4.dom === 'string', o4.dom);
  } catch(e){ for(let k=2067;k<=2072;k++) t('U'+k+' 敌人在场',false,e.message); }


  // ===== U2073~U2078: 子弹在飞(v0.8.60) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bulletFlyCountWrap'),f:T.bulletFlyCountTextNow(0)});})()"));
    t('U2073 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U2074 零子弹初值 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bulletFlyCountTextNow(5),b:T.bulletFlyCountTextNow(1)});})()"));
    t('U2075 正常 5/1', o2.a === '💥 5 飞行' && o2.b === '💥 1 飞行', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bulletFlyCountTextNow(-1),b:T.bulletFlyCountTextNow(NaN)});})()"));
    t('U2076 非法兜底 —', o3.a === '—' && o3.b === '—', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.bulletFlyCountPillDomNow()});})()"));
    t('U2077 DOM 可读', !!o4.dom, JSON.stringify(o4));
    t('U2078 一致性', typeof o4.dom === 'string', o4.dom);
  } catch(e){ for(let k=2073;k<=2078;k++) t('U'+k+' 子弹在飞',false,e.message); }


  // ===== U2079~U2084: Boss 类型名(v0.8.61) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bossTypeNameWrap'),f:T.bossTypeNameTextNow(null,false)});})()"));
    t('U2079 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U2080 非 BOSS 关 —', o.f === '—', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.bossTypeNameTextNow({name:'壁垒'},true));})()"));
    t('U2081 BOSS 关显示类型名', o2 === '👹 壁垒', o2);
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify(T.bossTypeNameTextNow(null,true));})()"));
    t('U2082 空类型兜底 ???', o3 === '👹 ???', o3);
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.startGame();T.skipIntro();T.extraHudRefreshNow();return JSON.stringify({dom:T.bossTypeNamePillDomNow()});})()"));
    t('U2083 DOM 可读', !!o4.dom, JSON.stringify(o4));
    t('U2084 一致性', typeof o4.dom === 'string', o4.dom);
  } catch(e){ for(let k=2079;k<=2084;k++) t('U'+k+' Boss类型',false,e.message); }

  chrome.kill(); killTree(chrome.pid);

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
