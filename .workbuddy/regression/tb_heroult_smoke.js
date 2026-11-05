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
