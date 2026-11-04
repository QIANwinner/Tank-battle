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
