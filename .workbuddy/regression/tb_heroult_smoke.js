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
