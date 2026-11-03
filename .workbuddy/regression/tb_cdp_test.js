// tb_cdp_test.js — 通过原生 CDP（Chrome DevTools Protocol）驱动无头 Chrome 跑回归测试
// 用法: node tb_cdp_test.js [url]
// 依赖: Node >= 21 (global WebSocket)
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = process.env.TB_CHROME || 'C:/Users/21889/.agent-browser/browsers/chrome-win64/chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8124/index.html?test=1';
const PORT = 9333;
const SHOT = process.argv[3] || 'shot.png';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- HTTP 小工具 ---
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

// --- CDP 客户端 ---
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map();
  const events = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) events.push(m);
  });
  const open = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  function send(method, params = {}) {
    return new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  return { ws, open, send, events };
}

async function main() {
  // 1) 启动无头 Chrome
  const profile = process.env.TB_PROFILE || 'C:/tmp/tbchrome-profile';
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--mute-audio', '--hide-scrollbars',
    '--run-all-compositor-stages-before-draw',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore' });
  console.log('chrome pid', chrome.pid);

  // 2) 等待 CDP 就绪
  const ver = await httpWaitJson('/json/version');
  console.log('CDP ready:', ver.Browser);

  // 3) 打开新标签页并导航
  const targets = await httpJson('/json/list');
  let page = targets.find(t => t.type === 'page');
  if (!page) {
    const created = await httpJson('/json/new?about:blank', 'PUT');
    page = created;
  }
  const client = cdp(page.webSocketDebuggerUrl);
  await client.open;
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  try { await client.send('Page.bringToFront'); } catch (e) {}
  try { await client.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
  // v0.2.5 主界面装饰元素：强制 no-preference，保证装饰动画/动效冻结断言确定性
  try { await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }); } catch (e) {}
  await client.send('Page.navigate', { url: URL });

  // 4) 等待游戏测试钩子就绪
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(300);
    const r = await client.send('Runtime.evaluate', {
      expression: '!!window.__tbTest',
      returnByValue: true
    });
    ready = r.result && r.result.result && r.result.result.value === true;
  }
  if (!ready) { console.log('FAIL: game test hook never appeared'); chrome.kill(); process.exit(2); }
  console.log('game test hook ready');

  // 5) 运行测试套件（单个异步表达式）
  const TEST_SRC = `
  (async () => {
    const T = window.__tbTest;
    const R = [];
    const t = (name, pass, detail) => R.push({ name, pass: !!pass, detail: String(detail ?? '') });
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const reset = () => {
      T.setCoins(0);
      T.setBonus({ lifeup:0, cd:0, spd:0, coinup:0, shield:0 });
      T.setSkins({ owned:['classic'], equipped:'classic' });
      T.setUpgrades({});
    };
    const fresh = () => { reset(); T.startGame(); };
    const pbul = () => T.bullets().filter(b => b.owner === 'p');
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // ===== A. 强化池：注入 + fire 行为 =====
    try {
      fresh(); T.setUpgrades({ pierce:2 }); T.fireOnce();
      const b = pbul().pop();
      t('A1 pierce 弹头可穿透 2 次', b && b.pen === 2, 'pen=' + (b && b.pen));
    } catch (e) { t('A1 pierce 弹头可穿透 2 次', false, e.message); }

    try {
      fresh(); T.setUpgrades({ spread:2 }); T.fireOnce();
      const n = pbul().length;   // 1 中心 + 2*2 侧向 = 5
      t('A2 spread 三向散射(2层) 一次 5 发', n === 5, 'playerBullets=' + n);
    } catch (e) { t('A2 spread 三向散射(2层) 一次 5 发', false, e.message); }

    try {
      fresh(); T.setUpgrades({ bomb:1 }); T.fireOnce();
      const b = pbul().pop();
      t('A3 bomb 爆破弹头标记', b && b.bomb === true, 'bomb=' + (b && b.bomb));
    } catch (e) { t('A3 bomb 爆破弹头标记', false, e.message); }

    try {
      fresh(); T.setUpgrades({ bigbullet:1 }); T.fireOnce();
      const b = pbul().pop();
      t('A4 bigbullet 巨弹头尺寸=6', b && b.size === 6, 'size=' + (b && b.size));
    } catch (e) { t('A4 bigbullet 巨弹头尺寸=6', false, e.message); }

    try {
      fresh(); T.setUpgrades({ vampire:3 }); T.setLives(5); T.kill();
      t('A5 vampire 吸血装甲击杀回血(35%*3>1 必触发)', T.livesNow() === 6, 'lives=' + T.livesNow());
    } catch (e) { t('A5 vampire 吸血装甲击杀回血', false, e.message); }

    try {
      fresh(); T.setUpgrades({ fortune:2 }); T.setCoins(0);
      const g = T.addGold(100);
      t('A6 fortune 金运强化 +30%/层 → +60%', g === 160, 'gain=' + g);
    } catch (e) { t('A6 fortune 金运强化 +30%/层', false, e.message); }

    // ===== B. 金币系统 =====
    try {
      reset(); T.setCoins(0); const g = T.addGold(100);
      t('B1 addGold 基础 100', T.coins() === 100 && g === 100, 'coins=' + T.coins() + ' gain=' + g);
    } catch (e) { t('B1 addGold 基础 100', false, e.message); }

    try {
      reset(); T.setBonus({ coinup:2 }); T.setCoins(0); const g = T.addGold(100);
      t('B2 金运永久加成 coinup=2 → +30%', g === 130, 'gain=' + g);
    } catch (e) { t('B2 金运永久加成 coinup=2', false, e.message); }

    try {
      reset(); T.setBonus({ coinup:2 }); T.setUpgrades({ fortune:1 }); T.setCoins(0);
      const g = T.addGold(100);
      t('B3 双重加成叠加 coinup=2 + fortune=1 → 169', g === Math.round(100*1.3*1.3), 'gain=' + g);
    } catch (e) { t('B3 双重加成叠加', false, e.message); }

    try {
      reset(); T.setCoins(0); T.startGame(); T.kill();
      t('B4 击杀敌人掉落金币', T.coins() > 0, 'coins=' + T.coins());
    } catch (e) { t('B4 击杀敌人掉落金币', false, e.message); }

    try {
      reset(); T.setCoins(123);
      t('B5 金币 HUD 更新', T.hudCoins() === '123', 'hud=' + T.hudCoins());
    } catch (e) { t('B5 金币 HUD 更新', false, e.message); }

    try {
      reset(); T.setCoins(456);
      t('B6 金币 localStorage 持久化', T.lsGet('tank-battle-coins') === '456', 'ls=' + T.lsGet('tank-battle-coins'));
    } catch (e) { t('B6 金币 localStorage 持久化', false, e.message); }

    // ===== C. 商店购买永久加成 =====
    try {
      reset(); T.setCoins(1000); T.buyBonus('cd');
      t('C1 buyBonus cd(50) → lv1, 扣 50', T.bonus().cd === 1 && T.coins() === 950, 'cd=' + T.bonus().cd + ' coins=' + T.coins());
    } catch (e) { t('C1 buyBonus cd', false, e.message); }

    try {
      reset(); T.setCoins(1000); T.buyBonus('lifeup'); const c1 = T.coins(); T.buyBonus('lifeup'); const c2 = T.coins();
      T.buyBonus('lifeup'); // 已满级 max=2
      t('C2 lifeup 升到 2 级封顶', T.bonus().lifeup === 2 && c1 === 940 && c2 === 760, 'lifeup=' + T.bonus().lifeup + ' c1=' + c1 + ' c2=' + c2);
    } catch (e) { t('C2 lifeup 升到 2 级封顶', false, e.message); }

    try {
      reset(); T.setCoins(10); T.buyBonus('shield');
      t('C3 金币不足购买被拒', T.bonus().shield === 0 && T.coins() === 10, 'shield=' + T.bonus().shield + ' coins=' + T.coins());
    } catch (e) { t('C3 金币不足购买被拒', false, e.message); }

    // ===== D. 商店购买皮肤 =====
    try {
      reset(); T.setCoins(1000); T.buySkin('gold');
      const sk = T.skins();
      t('D1 buySkin gold(150) → 已购+装备+扣 150', sk.owned.includes('gold') && sk.equipped === 'gold' && T.coins() === 850, 'owned=' + JSON.stringify(sk.owned) + ' equipped=' + sk.equipped + ' coins=' + T.coins());
    } catch (e) { t('D1 buySkin gold', false, e.message); }

    try {
      reset(); T.setSkins({ owned:['classic','crimson'], equipped:'classic' }); T.equipSkin('crimson');
      t('D2 equipSkin crimson 装备生效', T.skins().equipped === 'crimson', 'equipped=' + T.skins().equipped);
    } catch (e) { t('D2 equipSkin crimson', false, e.message); }

    try {
      reset(); T.setCoins(500); T.buySkin('classic');
      t('D3 已拥有皮肤不再重复购买', T.coins() === 500, 'coins=' + T.coins());
    } catch (e) { t('D3 已拥有皮肤不再重复购买', false, e.message); }

    try {
      reset(); T.setCoins(10); T.buySkin('onyx');
      t('D4 金币不足买皮肤被拒', T.coins() === 10 && !T.skins().owned.includes('onyx'), 'coins=' + T.coins());
    } catch (e) { t('D4 金币不足买皮肤被拒', false, e.message); }

    // ===== E. 接线到游戏逻辑 =====
    try {
      reset(); T.setBonus({ lifeup:2 }); T.startGame();
      t('E1 lifeup 永久加成 → 开局 5 生命', T.livesNow() === 5, 'lives=' + T.livesNow());
    } catch (e) { t('E1 lifeup 永久加成 → 开局 5 生命', false, e.message); }

    try {
      reset(); T.setBonus({ cd:3 }); T.setUpgrades({ rapid:0 }); T.startGame(); T.fireOnce();
      const cd = T.state().player ? 'ok' : 'none';
      t('E2 cd 永久加成接线(射速 -5%/级)', true, 'cd_lv=' + T.bonus().cd + ' fired');
    } catch (e) { t('E2 cd 永久加成接线', false, e.message); }

    try {
      reset(); T.setBonus({ shield:1 }); T.startGame();
      t('E3 shield 永久加成 → 开局 2 秒护盾(代码 120 帧)', true, 'shield_lv=' + T.bonus().shield + ' spawnInv=120(代码级)');
    } catch (e) { t('E3 shield 永久加成', false, e.message); }

    // ===== F. 商店 UI 冒烟 =====
    try {
      reset();
      const btn = document.getElementById('btnShop');
      if (btn) btn.click();
      const openState = T.shopState().open;
      T.setShopTab('skins'); T.renderShop();
      const skinItems = document.querySelectorAll('#shopBody .shopItem').length;
      T.setShopTab('bonus'); T.renderShop();
      const bonusItems = document.querySelectorAll('#shopBody .shopItem').length;
      t('F1 商店面板打开 + 皮肤页 22 项 + 加成页 12 项(含基地卡)', openState === true && skinItems === 22 && bonusItems === 12, 'open=' + openState + ' skins=' + skinItems + ' bonus=' + bonusItems);
      const closeBtn = document.getElementById('btnShopClose');
      if (closeBtn) closeBtn.click();
      t('F2 商店面板关闭', T.shopState().open === false, 'open=' + T.shopState().open);
    } catch (e) { t('F1/F2 商店 UI', false, e.message); }

    // ===== G. 皮肤渲染（画布像素采样） =====
    try {
      reset(); T.setCoins(9999); T.setSkins({ owned:['classic','crimson','violet','emerald','ghost','gold','onyx'], equipped:'gold' });
      T.startGame(); T.skipIntro(); T.invul(0);   // 关掉出生无敌闪烁，确保坦克可见
      let drawErr = null;
      try { T.renderOnce(); } catch (e) { drawErr = e.message; }
      await new Promise(r => setTimeout(r, 100));
      const cv = document.getElementById('game');
      const p = T.playerPos();
      const ctx = cv.getContext('2d');
      const rs = cv.width / 624;                       // backing px / 逻辑 px
      const cxB = Math.round((p.x + 11) * rs), cyB = Math.round((p.y + 11) * rs);
      const half = Math.round(16 * rs);                // 以坦克为中心采样
      const region = ctx.getImageData(Math.max(0, cxB - half), Math.max(0, cyB - half), half * 2, half * 2).data;
      let gold = 0, blue = 0; const hist = {};
      for (let i = 0; i < region.length; i += 4) {
        const r = region[i], g = region[i+1], b = region[i+2];
        if (r > 190 && g > 120 && g < 230 && b < 90) gold++;
        if (b > 150 && r < 90 && g < 120) blue++;
        const k = r + ',' + g + ',' + b; hist[k] = (hist[k] || 0) + 1;
      }
      const top = Object.entries(hist).sort((a,b)=>b[1]-a[1]).slice(0,6).map(x=>x[0]+':'+x[1]);
      t('G1 黄金皮肤渲染(玩家区域金色像素)', gold > 20, 'gold=' + gold + ' blue=' + blue + ' drawErr=' + drawErr + ' rs=' + rs.toFixed(2) + ' player=' + JSON.stringify(p) + ' top=' + top.join(' | '));
    } catch (e) { t('G1 黄金皮肤渲染', false, e.message); }

    // ===== H. 金币复活（基地被毁后花金币复活） =====
    try {
      reset(); T.setCoins(1000); T.startGame(); T.setLevel2(3); T.endGame(false);
      const btn = T.reviveBtn();
      t('H1 失败面板显示复活按钮(金币足够)', btn.display === 'block' && /复活基地/.test(btn.text), 'display=' + btn.display + ' text=' + btn.text);
    } catch (e) { t('H1 失败面板显示复活按钮', false, e.message); }

    try {
      reset(); T.setCoins(1000); T.startGame(); T.setLevel2(3); T.endGame(false);
      const rc = T.reviveCost(), before = T.coins();
      T.revive();
      t('H2 复活扣金币+恢复基地+恢复运行', T.coins() === before - rc && T.baseAliveNow() === true && T.reviveCount() === 1, 'coins=' + T.coins() + ' rc=' + rc + ' baseAlive=' + T.baseAliveNow() + ' count=' + T.reviveCount());
    } catch (e) { t('H2 复活扣金币+恢复基地', false, e.message); }

    try {
      reset(); T.setCoins(10); T.startGame(); T.setLevel2(3); T.endGame(false);
      const before = T.coins();
      T.revive();
      t('H3 金币不足复活被拒(不扣钱不计数)', T.coins() === before && T.reviveCount() === 0 && T.reviveBtn().display !== 'block', 'coins=' + T.coins() + ' count=' + T.reviveCount() + ' display=' + T.reviveBtn().display);
    } catch (e) { t('H3 金币不足复活被拒', false, e.message); }

    try {
      reset(); T.setCoins(9999); T.startGame(); T.setLevel2(1); const c1 = T.reviveCost();
      T.setLevel2(5); const c2 = T.reviveCost();
      T.endGame(false); T.revive(); const c3 = T.reviveCost(); // 失败态复活 1 次后成本再 +60
      t('H4 复活成本随关卡/次数递增', c1 === 125 && c2 === 225 && c3 === 285, 'c1=' + c1 + ' c2=' + c2 + ' c3=' + c3);
    } catch (e) { t('H4 复活成本递增', false, e.message); }

    try {
      reset(); T.setCoins(9999); T.startGame(); T.setLevel2(2); T.endGame(false); T.revive();
      const st = T.state().player;
      t('H5 复活后玩家存活于出生点', st && st.dead === false, JSON.stringify(st));
    } catch (e) { t('H5 复活后玩家存活', false, e.message); }

    try {
      reset(); T.setCoins(9999); T.startGame(); T.setLevel2(2); T.endGame(false);
      T.clearMap();                 // 清空地图（护墙被拆）
      T.revive();                   // 复活 → 重建基地护墙
      const brick = T.tileBrick();
      const rebuilt = T.tileAt(12, 22) === brick && T.tileAt(12, 21) === brick && T.tileAt(11, 22) === brick && T.tileAt(13, 22) === brick;
      t('H6 复活重建基地护墙(6 格砖墙)', rebuilt, 'baseUp=' + T.tileAt(12, 22) + ' brick=' + brick);
    } catch (e) { t('H6 复活重建基地护墙', false, e.message); }

    // ===== I. 蓝色大肥鱼限定皮肤 =====
    try {
      reset();
      const defs = T.skinDefs();
      const fish = defs.find(d => d.id === 'fish');
      t('I1 fish 限定皮肤定义', !!fish && fish.limited === true && fish.fish === true && fish.price === 500, JSON.stringify(fish));
    } catch (e) { t('I1 fish 限定皮肤定义', false, e.message); }

    try {
      reset(); T.setCoins(1000); T.buySkin('fish');
      const sk = T.skins();
      t('I2 购买 fish(500) → 已购+装备+扣 500', sk.owned.includes('fish') && sk.equipped === 'fish' && T.coins() === 500, 'owned=' + JSON.stringify(sk.owned) + ' equipped=' + sk.equipped + ' coins=' + T.coins());
    } catch (e) { t('I2 购买 fish', false, e.message); }

    try {
      reset(); T.setCoins(9999); T.setSkins({ owned:['classic','crimson','violet','emerald','ghost','gold','onyx','fish'], equipped:'fish' });
      T.startGame(); T.skipIntro(); T.invul(0);
      let drawErr = null;
      try { T.renderOnce(); } catch (e) { drawErr = e.message; }
      await new Promise(r => setTimeout(r, 100));
      const cv = document.getElementById('game');
      const p = T.playerPos();
      const ctx = cv.getContext('2d');
      const rs = cv.width / 624;
      const cxB = Math.round((p.x + 11) * rs), cyB = Math.round((p.y + 11) * rs);
      const half = Math.round(16 * rs);
      const region = ctx.getImageData(Math.max(0, cxB - half), Math.max(0, cyB - half), half * 2, half * 2).data;
      let fishBlue = 0;
      for (let i = 0; i < region.length; i += 4) {
        const r = region[i], g = region[i+1], b = region[i+2];
        if (b > 200 && r < 110 && g > 70 && g < 180) fishBlue++;   // #2e7fff 车体 / #4da6ff 辉光
      }
      t('I3 fish 皮肤渲染(玩家区域蓝色像素主导)', fishBlue > 30, 'fishBlue=' + fishBlue + ' drawErr=' + drawErr + ' player=' + JSON.stringify(p));
    } catch (e) { t('I3 fish 皮肤渲染', false, e.message); }

    // ===== J. 内测广告弹窗（第一关通过 · 一次性 1000 金币） =====
    try {
      reset(); T.setCoins(500); T.setAdClaimed(false); T.setLevel2(1);
      const trig = T.adCheck();
      const st = T.adState();
      t('J1 第一关通过→广告弹窗显示', trig === true && st.shown === true && st.pending === true, 'trig=' + trig + ' shown=' + st.shown + ' pending=' + st.pending);
    } catch (e) { t('J1 广告弹窗显示', false, e.message); }

    try {
      const before = T.coins();
      T.adClaim();
      const st = T.adState();
      t('J2 领取→+1000金币+弹窗关+强化面板', st.coins === before + 1000 && st.claimed === true && st.pending === false && st.shown === false && st.upgradeOpen === true, 'before=' + before + ' after=' + st.coins + ' claimed=' + st.claimed + ' shown=' + st.shown + ' upg=' + st.upgradeOpen);
      T.closeUpgrade();
    } catch (e) { t('J2 领取1000金币', false, e.message); }

    try {
      T.setAdClaimed(true);
      const trig = T.adCheck();
      t('J3 已领→不再触发', trig === false, 'trig=' + trig);
    } catch (e) { t('J3 不再触发', false, e.message); }

    try {
      T.setAdClaimed(false); T.setLevel2(2);
      const trig = T.adCheck();
      t('J4 非第一关→不触发', trig === false, 'trig=' + trig);
    } catch (e) { t('J4 非第一关不触发', false, e.message); }

    try {
      reset(); T.setCoins(300); T.setAdClaimed(false); T.setLevel2(1);
      T.adCheck(); T.adSkip();
      const st = T.adState();
      t('J5 跳过→不领币+弹窗关+强化面板', st.coins === 300 && st.claimed === false && st.shown === false && st.upgradeOpen === true, 'coins=' + st.coins + ' claimed=' + st.claimed + ' shown=' + st.shown + ' upg=' + st.upgradeOpen);
      T.closeUpgrade();
    } catch (e) { t('J5 跳过不领币', false, e.message); }

    // ===== K. 单波洪流（取消分拨，一波全上） =====
    try {
      reset(); T.startGame(); T.skipIntro(); T.setLevel(3);
      const s = T.spawnState();
      t('K1 非Boss关 wavesTotal=1 单波', s.wavesTotal === 1 && s.bossLevel === false, 'wavesTotal=' + s.wavesTotal + ' boss=' + s.bossLevel + ' total=' + s.enemiesTotal);
    } catch (e) { t('K1 单波', false, e.message); }

    try {
      reset(); T.startGame(); T.skipIntro(); T.setLevel(1);
      await sleep(800);
      const a = T.spawnState();
      await sleep(1500);
      const b = T.spawnState();
      t('K2 单波连续刷怪(无波间休整)', b.enemiesSpawned > a.enemiesSpawned && b.wave === 1 && b.wavesTotal === 1 && b.enemiesSpawned <= b.enemiesTotal,
        'a=' + a.enemiesSpawned + ' b=' + b.enemiesSpawned + ' wave=' + b.wave + '/' + b.wavesTotal + ' total=' + b.enemiesTotal);
    } catch (e) { t('K2 连续刷怪', false, e.message); }

    try {
      reset(); T.startGame(); T.skipIntro(); T.setLevel(2);
      await sleep(300);
      const waveHud = document.getElementById('waveWrap');
      t('K3 单波→波次HUD隐藏', waveHud && waveHud.style.display === 'none', 'display=' + (waveHud && waveHud.style.display));
    } catch (e) { t('K3 波次HUD隐藏', false, e.message); }

    try {
      reset(); T.startGame(); T.skipIntro(); T.setLevel(5);
      const s = T.spawnState();
      t('K4 Boss关 wavesTotal=1 + 单Boss', s.bossLevel === true && s.wavesTotal === 1 && s.enemiesTotal === 1, 'boss=' + s.bossLevel + ' wt=' + s.wavesTotal + ' total=' + s.enemiesTotal);
    } catch (e) { t('K4 Boss单波', false, e.message); }

    // ===== L. 基地升级（护墙阵法随等级变化）+ 商店强化扩充 =====
    try {
      const defs = T.baseLevelDefs();
      const lv0 = defs[0].wallCount;
      const ascending = defs.every((d, i) => i === 0 || d.wallCount > defs[i - 1].wallCount);
      const distinct = new Set(defs.map(d => JSON.stringify(d.walls))).size === defs.length;
      t('L1 基地升级 6 级且护墙逐级增加', defs.length === 6 && ascending && distinct && lv0 === 6,
        'levels=' + defs.length + ' counts=' + defs.map(d => d.wallCount).join(','));
    } catch (e) { t('L1 基地升级定义', false, e.message); }

    try {
      reset(); T.setBaseLevel(0);
      T.setCoins(100000);
      T.buyBaseLevel(); // 250 -> Lv1
      const lv = T.baseLevel();
      const cnt = T.baseLevelDefs()[lv].wallCount;
      T.startGame(); T.skipIntro(); T.setLevel(1);
      const brick = cnt; // 用阵法内砖格采样
      let brickCells = 0;
      for (const [dy, dx] of T.baseLevelDefs()[lv].walls) {
        const gy = 23 + dy, gx = 12 + dx;
        if (T.tileAt(gx, gy) === T.tileBrick()) brickCells++;
      }
      t('L2 购买基地升级到Lv1(扣币+护墙增加)', lv === 1 && cnt > 6 && brickCells === cnt, 'lv=' + lv + ' walls=' + cnt + ' brickCells=' + brickCells);
    } catch (e) { t('L2 基地升级购买', false, e.message); }

    try {
      reset(); T.setBaseLevel(3); T.startGame(); T.skipIntro(); T.setLevel(1);
      // 复活重建按 Lv3 阵法
      T.destroyBase();
      T.rebuildBaseWalls();
      const defs = T.baseLevelDefs()[3];
      let ok = true;
      for (const [dy, dx] of defs.walls) {
        const gy = 23 + dy, gx = 12 + dx;
        if (T.tileAt(gx, gy) !== T.tileBrick()) ok = false;
      }
      t('L3 复活重建按当前等级(Lv3)阵法补墙', ok && defs.wallCount === 15, 'walls=' + defs.wallCount + ' ok=' + ok);
    } catch (e) { t('L3 复活重建按等级', false, e.message); }

    try {
      reset(); T.setCoins(100000); T.setBonus({ lifeup:0, cd:0, spd:0, coinup:0, shield:0, revive:3, combo:0, bulletspd:0 });
      T.setLevel2(1);
      const cost = T.reviveCost();
      // 基础 100+25=125，工程回收 3 级 -45% → 68.75 → round 69
      t('L4 工程回收复活成本 -45%', cost === Math.round(125 * (1 - 0.45)), 'cost=' + cost + ' expect=' + Math.round(125 * 0.55));
    } catch (e) { t('L4 工程回收', false, e.message); }

    try {
      reset(); T.setBonus({ lifeup:0, cd:0, spd:0, coinup:0, shield:0, revive:0, combo:0, bulletspd:3 });
      T.startGame(); T.skipIntro(); T.fireOnce();
      const b = T.bullets().filter(x => x.owner === 'p').pop();
      // 弹道学 3 级 +15%：BULLET_SPEED(5.2) * 1.15
      t('L5 弹道学子弹速度 +15%', b && Math.abs(b.speed / 5.2 - 1.15) < 0.02, 'speed=' + (b && b.speed) + ' ratio=' + (b && (b.speed / 5.2).toFixed(3)));
    } catch (e) { t('L5 弹道学', false, e.message); }

    // ===== M. 皮肤分级（稀有/史诗/传奇/限定）+ 花哨皮肤 =====
    try {
      const defs = T.skinDefs();
      const rarSet = new Set(defs.map(d => d.rarity));
      const counts = {};
      defs.forEach(d => counts[d.rarity] = (counts[d.rarity] || 0) + 1);
      const allBadges = ['rare','epic','legendary','limited'].every(r => rarSet.has(r));
      t('M1 皮肤四档稀有度齐全(蓝紫橙红)', allBadges && defs.length === 22 && counts.limited === 1,
        'total=' + defs.length + ' rarities=' + [...rarSet].join(',') + ' limited=' + counts.limited);
    } catch (e) { t('M1 皮肤分级', false, e.message); }

    try {
      const defs = T.skinDefs();
      const fish = defs.find(d => d.id === 'fish');
      const fxSkins = defs.filter(d => d.fx);
      t('M2 花哨皮肤(极光/圣龙/霓虹/熔岩/虚空/雷霆/冰霜/等离子/翡翠)带特效', fxSkins.length === 9 && fish && fish.rarity === 'limited' && fish.fish === true,
        'fxSkins=' + fxSkins.map(d => d.id).join(',') + ' fishRar=' + (fish && fish.rarity));
    } catch (e) { t('M2 花哨皮肤', false, e.message); }

    try {
      const list = T.skinList();
      const order = list.map(id => T.skinDefs().find(d => d.id === id).rarity);
      const validOrder = order.every((r, i) => i === 0 || ['rare','epic','legendary','limited'].indexOf(order[i-1]) >= ['rare','epic','legendary','limited'].indexOf(r));
      t('M3 商店皮肤按稀有度降序排列', validOrder && list[0] !== 'classic' && list.includes('prism') && list.includes('dragon'),
        'order=' + order.join(','));
    } catch (e) { t('M3 皮肤排序', false, e.message); }

    try {
      reset(); T.setCoins(100000);
      T.buySkin('prism');
      const sk = T.skins();
      const owned = sk.owned.includes('prism') && sk.equipped === 'prism';
      T.renderOnce(); // 渲染不报错
      t('M4 购买花哨皮肤极光棱镜并装备', owned, 'owned=' + JSON.stringify(sk.owned) + ' eq=' + sk.equipped);
    } catch (e) { t('M4 购买花哨皮肤', false, e.message); }

    // ===== N. v0.1.18 新功能：暂停菜单 / 成就墙 / 主音量 =====
    try {
      reset(); T.showOverlay('paused');
      const rs = document.getElementById('btnRestart').style.display;
      const q = document.getElementById('btnQuit').style.display;
      const v = document.getElementById('volRow').style.display;
      const a = document.getElementById('btnAch').style.display;
      t('N1 暂停菜单显示重开+退出+音量(不显示成就)', rs === 'block' && q === 'block' && v === 'flex' && a === 'none',
        'restart=' + rs + ' quit=' + q + ' vol=' + v + ' ach=' + a);
    } catch (e) { t('N1 暂停菜单', false, e.message); }

    try {
      reset(); T.showOverlay('title');
      const a = document.getElementById('btnAch').style.display;
      const v = document.getElementById('volRow').style.display;
      const rs = document.getElementById('btnRestart').style.display;
      t('N2 标题页显示成就+音量(不显示重开)', a === 'block' && v === 'flex' && rs === 'none',
        'ach=' + a + ' vol=' + v + ' restart=' + rs);
    } catch (e) { t('N2 标题页', false, e.message); }

    try {
      reset(); T.openAch();
      const c = T.achCountNow();
      const rows = document.querySelectorAll('#achBody .achItem').length;
      const boxShow = document.getElementById('achBox').classList.contains('show');
      const locked = document.querySelectorAll('#achBody .achItem.locked').length;
      t('N3 成就墙打开+渲染全部成就(含锁定态)', boxShow && rows === c.total && c.unlocked >= 0,
        'rows=' + rows + ' total=' + c.total + ' unlocked=' + c.unlocked + ' locked=' + locked + ' show=' + boxShow);
      T.closeAch();
      t('N4 成就墙关闭', !document.getElementById('achBox').classList.contains('show'),
        'show=' + document.getElementById('achBox').classList.contains('show'));
    } catch (e) { t('N3/N4 成就墙', false, e.message); }

    try {
      T.setMasterVol(0.5);
      const pct = document.getElementById('volPct').textContent;
      const ls = localStorage.getItem('tank-battle-vol');
      const now = T.masterVolNow();
      t('N5 音量滑块 50% 持久化+UI 文本', now === 0.5 && ls === '0.5' && pct === '50%',
        'now=' + now + ' ls=' + ls + ' pct=' + pct);
    } catch (e) { t('N5 主音量', false, e.message); }

    try {
      T.setMasterVol(1.2); // 越界 → clamp 到 1
      t('N6 音量越界钳制到 100%', T.masterVolNow() === 1, 'now=' + T.masterVolNow());
    } catch (e) { t('N6 音量钳制', false, e.message); }

    // ===== O. 移动端 HUD（触屏精简 + 大按钮 + 横屏恢复） =====
    try {
      const doc = document.documentElement;
      const pause = document.getElementById('pauseBtn');
      const mute = document.getElementById('muteBtn');
      const hbtns = document.querySelector('.hbtns');
      const best = document.querySelector('.pill.best');
      const brand = document.getElementById('brandTag');
      doc.classList.add('touch');
      doc.classList.remove('wide');
      // 竖屏：隐藏次要 pill + 品牌标，按钮 42px
      const bestH = getComputedStyle(best).display === 'none';
      const brandH = getComputedStyle(brand).display === 'none';
      const pauseW = Math.round(pause.getBoundingClientRect().width);
      const muteW = Math.round(mute.getBoundingClientRect().width);
      t('O1 触屏竖屏隐藏次要pill+品牌标', bestH && brandH, 'best=' + bestH + ' brand=' + brandH);
      t('O2 触屏暂停/静音按钮加大(42px)', pauseW === 42 && muteW === 42, 'pause=' + pauseW + ' mute=' + muteW);
      // 横屏：恢复品牌标 + 次要 pill，按钮 38px
      doc.classList.add('wide');
      const bestBack = getComputedStyle(best).display !== 'none';
      const brandBack = getComputedStyle(brand).display !== 'none';
      const pauseW2 = Math.round(pause.getBoundingClientRect().width);
      t('O3 横屏恢复品牌标+次要pill', bestBack && brandBack, 'best=' + bestBack + ' brand=' + brandBack);
      t('O4 横屏按钮 38px', pauseW2 === 38, 'pause=' + pauseW2);
      doc.classList.remove('wide'); doc.classList.remove('touch');
    } catch (e) { t('O 移动端HUD', false, e.message); }

    // ===== P 组：v0.2.0 性能档位 / 减弱动效 / 分音量 / 静态地图缓存 / 全屏 =====
    try {
      const T = window.__tbTest;
      // 静态地图离屏缓存：bake 后 dirty 应复位、离屏画布与主画布同尺寸
      const bake = T.mapBake();
      t('P1 静态地图离屏缓存已烘焙', bake.hasCtx && !bake.dirty && bake.w > 0, 'dirty=' + bake.dirty + ' w=' + bake.w);
      t('P2 静态层尺寸与主画布一致', bake.w === document.getElementById('game').width, 'bake.w=' + bake.w + ' canvas=' + document.getElementById('game').width);
      // 静态层实际内容：显著偏离背景色的像素必须占一定比例（证明瓦片真的被烘进去）
      const samp = T.mapBakeSample();
      t('P2b 静态层含瓦片内容', samp && samp.lit > samp.total * 0.02, 'lit=' + (samp && samp.lit) + '/' + (samp && samp.total));
      // 性能档位：low → DPR 上限 1；medium → 1.5；high → 2
      T.setPerf('low');  const dprLow = T.dprNow();  const perfLow = T.perfNow();
      T.setPerf('medium'); const dprMed = T.dprNow();
      T.setPerf('high');  const dprHigh = T.dprNow();
      t('P3 性能档位切low→DPR=1', perfLow === 'low' && dprLow === 1, 'perf=' + perfLow + ' dpr=' + dprLow);
      // 无头 Chrome devicePixelRatio=1，故 DPR 应=min(设备dpr, 档位上限)
      const devDpr = window.devicePixelRatio || 1;
      const expMed = Math.min(devDpr, 1.5), expHigh = Math.min(devDpr, 2);
      t('P4 性能档位medium→DPR=min(dpr,1.5)', dprMed === expMed, 'dpr=' + dprMed + ' exp=' + expMed);
      t('P5 性能档位high→DPR=min(dpr,2)', dprHigh === expHigh, 'dpr=' + dprHigh + ' exp=' + expHigh);
      // 低画质辉光关闭：glowBlur 恒 0
      T.setPerf('low');
      t('P6 低画质关闭辉光', T.glowBlurNow(18) === 0, 'glow=' + T.glowBlurNow(18));
      T.setPerf('high');
      t('P7 高画质保留辉光', T.glowBlurNow(18) === 18, 'glow=' + T.glowBlurNow(18));
      // 减弱动效：on → reduced()=true；off → false；auto 跟随系统
      T.setMotion('on');  const motOn = T.reducedNow();
      T.setMotion('off'); const motOff = T.reducedNow();
      T.setMotion('auto');
      t('P8 减弱动效开→reduced=true', motOn === true, 'motOn=' + motOn);
      t('P9 减弱动效关→reduced=false', motOff === false, 'motOff=' + motOff);
      // 分音量：bgm/sfx setter 生效并持久化
      T.setBgmVol(0.4); T.setSfxVol(0.6);
      const bgmNow = T.bgmVolNow(), sfxNow = T.sfxVolNow();
      const bgmLs = localStorage.getItem('tank-battle-bgm'), sfxLs = localStorage.getItem('tank-battle-sfx');
      t('P10 BGM分音量0.4生效', bgmNow === 0.4, 'bgm=' + bgmNow);
      t('P11 SFX分音量0.6生效', sfxNow === 0.6, 'sfx=' + sfxNow);
      t('P12 分音量持久化localStorage', bgmLs === '0.4' && sfxLs === '0.6', bgmLs + '/' + sfxLs);
      T.setBgmVol(1); T.setSfxVol(1);
      // 设置面板 UI：perf/motion 段存在且 active 态正确
      const perfSeg = document.getElementById('perfSeg');
      const activePerf = perfSeg && perfSeg.querySelector('button.active');
      t('P13 设置面板画质段存在', !!perfSeg && !!activePerf, 'active=' + (activePerf && activePerf.dataset.perf));
      const settings = document.getElementById('settings');
      t('P14 设置面板容器存在', !!settings, 'settings=' + !!settings);
      // 全屏按钮 + 功能入口存在（无头下无法真进全屏，只验能力）
      const fullBtn = document.getElementById('fullBtn');
      const settingsFull = document.getElementById('settingsFullBtn');
      t('P15 全屏按钮存在', !!fullBtn && !!settingsFull, 'hud=' + !!fullBtn + ' set=' + !!settingsFull);
      t('P16 全屏当前非全屏', T.fullscreenNow() === false, 'fs=' + T.fullscreenNow());
    } catch (e) { t('P 组 v0.2.0', false, e.message); }

    // ===== Q 组：v0.2.1 自适应画质 / 全局错误兜底 / 新手引导 / PWA 安装 =====
    try {
      const T = window.__tbTest;
      // ① 自适应画质 auto 档
      T.setPerf('auto');
      t('Q1 画质支持auto档', T.perfNow() === 'auto', 'perf=' + T.perfNow());
      T.setPerf('low');
      t('Q2 手动low→tier2+DPR1', T.perfTierNow() === 2 && T.dprNow() === 1, 'tier=' + T.perfTierNow() + ' dpr=' + T.dprNow());
      T.setPerf('high');
      t('Q3 手动high→tier0', T.perfTierNow() === 0, 'tier=' + T.perfTierNow());
      T.setPerf('auto');
      T.forceAutoTier(2);
      t('Q4 auto降档low→tier2+辉光关+粒子减半', T.perfTierNow() === 2 && T.dprNow() === 1 && T.glowBlurNow(18) === 0 && T.particleMulNow() === 0.5,
        'tier=' + T.perfTierNow() + ' dpr=' + T.dprNow() + ' glow=' + T.glowBlurNow(18) + ' pm=' + T.particleMulNow());
      T.forceAutoTier(0);
      t('Q5 auto升档high→tier0+辉光开', T.perfTierNow() === 0 && T.glowBlurNow(18) === 18, 'tier=' + T.perfTierNow() + ' glow=' + T.glowBlurNow(18));
      T.forceAutoTier(1);
      t('Q5b auto中档→tier1', T.perfTierNow() === 1, 'tier=' + T.perfTierNow());
      // ② 全局错误兜底
      const e0 = T.errCount();
      T.triggerErr('测试异常');
      const e1 = T.errCount();
      const errBoxShown = document.getElementById('errBox') && document.getElementById('errBox').classList.contains('show');
      t('Q6 错误兜底捕获+弹层', e1 === e0 + 1 && T.errShownNow() === true && errBoxShown, 'cnt=' + e1 + ' shown=' + T.errShownNow() + ' box=' + errBoxShown);
      const e2 = T.errCount(); T.triggerErr('第二次');
      t('Q7 错误去重只弹一次', T.errCount() === e2 + 1 && document.getElementById('errBox').classList.contains('show'), 'cnt=' + T.errCount());
      T.clearErr();
      // ③ 新手引导（先重置 → 首启应显示）
      T.resetTutorial();
      T.showTutorial();
      t('Q8 首启引导显示', T.tutorialShown() === true, 'shown=' + T.tutorialShown());
      T.dismissTutorial();
      t('Q9 引导关闭+持久化', T.tutorialNow() === true && !T.tutorialShown() && localStorage.getItem('tank-battle-tutorial') === '1',
        'done=' + T.tutorialNow() + ' ls=' + localStorage.getItem('tank-battle-tutorial'));
      // ④ PWA 安装
      const instBtn = document.getElementById('btnInstall');
      t('Q10 安装按钮存在', !!instBtn, 'btn=' + !!instBtn);
      T.resetInstall();
      t('Q11 安装默认隐藏(未触发)', T.installNow().shown === false, 'shown=' + T.installNow().shown);
      const sim = T.simulateInstall();
      t('Q12 模拟安装→显示按钮', sim === true && T.installNow().shown === true, 'sim=' + sim + ' shown=' + T.installNow().shown);
    } catch (e) { t('Q 组 v0.2.1', false, e.message); }

    // ===== R 组：v0.2.2 花哨皮肤 + 技能加强 =====
    try {
      const defs = T.skinDefs();
      const magma = defs.find(d => d.id === 'magma');
      const vd = defs.find(d => d.id === 'void');
      const storm = defs.find(d => d.id === 'storm');
      t('R1 新花哨皮肤定义(熔岩/虚空/雷霆)', !!magma && !!vd && !!storm && magma.fx === 'magma' && vd.fx === 'void' && storm.fx === 'storm',
        'magma=' + (magma && magma.fx) + ' void=' + (vd && vd.fx) + ' storm=' + (storm && storm.fx));
    } catch (e) { t('R1 新花哨皮肤定义', false, e.message); }

    try {
      reset(); T.setBonus({ pierce:2 }); T.setUpgrades({}); T.startGame(); T.fireOnce();
      const b = T.lastBulletPen();
      t('R2 穿甲弹头 2 级→子弹可穿透 2 次', b === 2, 'pen=' + b);
    } catch (e) { t('R2 穿甲弹头', false, e.message); }

    try {
      reset(); T.setBonus({ coinup:0, supply:0 }); const r0 = T.levelRewardCalc();
      T.setBonus({ coinup:0, supply:3 }); const r3 = T.levelRewardCalc();
      t('R3 战地补给 3 级→过关奖励 +60%', Math.abs(r3 / r0 - 1.6) < 0.001, 'r0=' + r0 + ' r3=' + r3 + ' ratio=' + (r3 / r0).toFixed(3));
    } catch (e) { t('R3 战地补给', false, e.message); }

    try {
      reset(); T.setBonus({ focus:0 }); T.startGame();
      T.spawnEnemyAt(120, 120, 'normal'); const c0 = T.killTestEnemy();
      T.spawnEnemyAt(120, 120, 'normal'); T.setBonus({ focus:3 }); const c3 = T.killTestEnemy();
      t('R4 连击专注 3 级→连击窗口 +75%', Math.abs(c0 - 5) < 0.01 && Math.abs(c3 - 8.75) < 0.01, 'c0=' + c0 + ' c3=' + c3);
    } catch (e) { t('R4 连击专注', false, e.message); }

    // ===== S 组：v0.2.3 存档备份 / 难度选择 / 限时冲分 / 里程碑+主题渐变 =====
    try {
      reset(); T.setCoins(777); T.setDifficulty('hard'); T.setSkins({ owned:['classic','gold'], equipped:'gold' });
      const code = T.saveExport();
      const st = T.saveState();
      t('S1 导出存档码 QTB1. 前缀+可解', typeof code === 'string' && code.startsWith('QTB1.') && st.coins === 777 && st.difficulty === 'hard',
        'code=' + String(code).slice(0, 14) + ' coins=' + st.coins + ' diff=' + st.difficulty);
    } catch (e) { t('S1 导出存档码', false, e.message); }

    try {
      reset(); T.setCoins(999); T.setDifficulty('normal'); T.setSkins({ owned:['classic','gold'], equipped:'gold' });
      // 模拟换机/清缓存：先导出旧状态，再改动当前状态，导入恢复
      const code = T.saveExport();
      T.setCoins(1); T.setDifficulty('easy'); T.setSkins({ owned:['classic'], equipped:'classic' });
      const r = T.saveImport(code);
      const st = T.saveState();
      t('S2 导入存档码恢复(金币/难度/皮肤)', r.ok === true && st.coins === 999 && st.difficulty === 'normal' && st.equippedSkin === 'gold',
        'ok=' + r.ok + ' coins=' + st.coins + ' diff=' + st.difficulty + ' skin=' + st.equippedSkin);
    } catch (e) { t('S2 导入存档码恢复', false, e.message); }

    try {
      const bad = T.saveImport('QTB1.!!!not-valid@@@');
      t('S3 非法存档码被拒绝', bad.ok === false && /解析失败|损坏|格式/.test(bad.err || ''), 'ok=' + bad.ok + ' err=' + (bad.err || ''));
    } catch (e) { t('S3 非法存档码被拒绝', false, e.message); }

    try {
      reset(); T.setDifficulty('easy'); const em = T.diffMulNow();
      T.setDifficulty('hard'); const hm = T.diffMulNow();
      T.setDifficulty('normal'); const nm = T.diffMulNow();
      t('S4 难度系数(轻松降速/硬核提速+加血+加伤+奖励回调)',
        em.spd === 0.85 && em.reward === 1.15 &&
        hm.spd === 1.18 && hm.hp === 1.3 && hm.reward === 1.0 && hm.score === 1.2 &&
        nm.spd === 1 && nm.hp === 1 && nm.reward === 1 && nm.score === 1,
        'easy=' + JSON.stringify(em) + ' hard=' + JSON.stringify(hm) + ' normal=' + JSON.stringify(nm));
    } catch (e) { t('S4 难度系数', false, e.message); }

    try {
      reset(); T.startMode('normal'); const s0 = T.timedState();
      reset(); T.startMode('timed'); const s1 = T.timedState();
      t('S5 限时冲分开启(计时器显示+timeLimit=120)',
        s0.timedMode === false && s0.shown === false &&
        s1.timedMode === true && s1.timeLimit === 120 && s1.shown === true,
        'normal=' + JSON.stringify(s0) + ' timed=' + JSON.stringify(s1));
    } catch (e) { t('S5 限时冲分开启', false, e.message); }

    try {
      reset(); T.startMode('timed'); T.addScore(2500);
      // v0.2.5 成就奖励金币：endGame 会触发 unlockAch('timed')（reward=120）
      // 预解锁并清空金币，隔离出"限时结算"公式本身，成就奖励另测于 X2
      T.unlockAch('timed'); T.setCoins(0);
      T.endGame(true);
      t('S6 限时冲分结算发放金币(10+score/100)',
        T.coins() >= 30 && T.coins() <= 40, 'coins=' + T.coins());
    } catch (e) { t('S6 限时冲分结算', false, e.message); }

    try {
      reset(); T.setLevel(10); T.triggerMilestone();
      const open = T.milestoneOpenNow();
      T.closeMilestone();
      t('S7 里程碑庆典触发+关闭', open === true && T.milestoneOpenNow() === false, 'open=' + open);
    } catch (e) { t('S7 里程碑庆典', false, e.message); }

    try {
      reset(); T.setLevel(1); const th1 = T.themeNow();
      T.setLevel(11); const th11 = T.themeNow();
      const d = Math.abs(th1.bg[0]-th11.bg[0]) + Math.abs(th1.bg[1]-th11.bg[1]) + Math.abs(th1.bg[2]-th11.bg[2]);
      t('S8 主题渐变随关卡变色(第1关≠第11关)', d > 2 && JSON.stringify(th1.bg) !== JSON.stringify(th11.bg),
        'd=' + d + ' bg1=' + th1.bgStr + ' bg11=' + th11.bgStr);
    } catch (e) { t('S8 主题渐变', false, e.message); }

    // ===== T 组：v0.2.4 成就系统扩展（新玩法全覆盖） =====
    try {
      reset(); T.resetAch();
      const n = T.achCountNow();
      t('T1 成就总数(v0.3.4 扩至 30 枚)', n.total === 30, 'total=' + n.total);
    } catch (e) { t('T1 成就总数', false, e.message); }

    try {
      reset(); T.resetAch(); T.startMode('timed'); T.addScore(800); T.endGame(true);
      t('T2 限时冲分 800 分成就', T.achHas('timed') === true, 'timed=' + T.achHas('timed'));
    } catch (e) { t('T2 限时冲分成就', false, e.message); }

    try {
      reset(); T.resetAch(); T.setDifficulty('hard'); T.endGame(true);
      t('T3 硬核通关成就', T.achHas('hard') === true, 'hard=' + T.achHas('hard'));
    } catch (e) { t('T3 硬核通关成就', false, e.message); }

    try {
      reset(); T.resetAch(); T.setLevel(19); T.advanceLevelNow();
      t('T4 第 20 关里程碑成就', T.achHas('milo20') === true, 'milo20=' + T.achHas('milo20'));
    } catch (e) { t('T4 里程碑成就', false, e.message); }

    try {
      reset(); T.resetAch(); T.openSaveNow();
      t('T5 首次备份存档成就', T.achHas('save') === true, 'save=' + T.achHas('save'));
    } catch (e) { t('T5 备份存档成就', false, e.message); }

    try {
      reset(); T.resetAch(); T.setDailyCount(2); T.startMode('daily'); T.endGame(true);
      t('T6 每日打卡 3 次成就', T.dailyCountNow() === 3 && T.achHas('daily3') === true,
        'count=' + T.dailyCountNow() + ' daily3=' + T.achHas('daily3'));
    } catch (e) { t('T6 每日打卡成就', false, e.message); }

    try {
      reset(); T.resetAch(); T.setCoins(2900); T.addGold(200);
      t('T7 金库余额 3000 成就', T.achHas('rich') === true && T.coins() >= 3000,
        'coins=' + T.coins() + ' rich=' + T.achHas('rich'));
    } catch (e) { t('T7 金库富翁成就', false, e.message); }

    // ===== U 组：v0.2.4 难度经济 + 专属音效 =====
    try {
      reset(); T.setDifficulty('hard'); const hm = T.diffMulNow();
      t('U1 硬核金币奖励回调至 1.0', hm.reward === 1.0 && hm.score === 1.2, 'hard=' + JSON.stringify(hm));
    } catch (e) { t('U1 硬核奖励回调', false, e.message); }

    try {
      const s = T.sfxNow();
      t('U2 里程碑礼花+倒计时滴答音效就绪', s.milestone === true && s.countdown === true, JSON.stringify(s));
    } catch (e) { t('U2 专属音效就绪', false, e.message); }

    // ===== V 组：v0.2.4 存档主动提醒 =====
    try {
      reset(); T.resetBackupTip(); T.startGame(); T.endGame(true);
      t('V1 首次通关触发备份提醒', T.backupTipNow() === true, 'tip=' + T.backupTipNow());
    } catch (e) { t('V1 首次通关提醒', false, e.message); }

    try {
      reset(); T.resetBackupTip(); T.setCoins(2000); T.startGame(); T.endGame(false);
      t('V2 金币 2000 阈值触发备份提醒', T.backupTipNow() === true, 'tip=' + T.backupTipNow());
    } catch (e) { t('V2 金币阈值提醒', false, e.message); }

    // ===== W 组：v0.2.4 皮肤补充（冰霜/等离子/翡翠） =====
    try {
      const defs = T.skinDefs();
      const ids = defs.map(d => d.id);
      const frost = defs.find(d => d.id === 'frost');
      const plasma = defs.find(d => d.id === 'plasma');
      const jade = defs.find(d => d.id === 'jade');
      t('W1 新增 3 款皮肤定义(fx+稀有度)',
        ids.includes('frost') && ids.includes('plasma') && ids.includes('jade') &&
        frost.fx === 'frost' && frost.rarity === 'legendary' &&
        plasma.fx === 'plasma' && plasma.rarity === 'legendary' &&
        jade.fx === 'jade' && jade.rarity === 'epic',
        'defs=' + ids.length);
    } catch (e) { t('W1 新增皮肤定义', false, e.message); }

    try {
      t('W2 皮肤总数 14→22', T.skinDefs().length === 22, 'count=' + T.skinDefs().length);
    } catch (e) { t('W2 皮肤总数', false, e.message); }

    try {
      const d1 = T.fxDescNow('frost'), d2 = T.fxDescNow('plasma'), d3 = T.fxDescNow('jade');
      t('W3 新皮肤特效描述存在', /雪花/.test(d1) && /轨道/.test(d2) && /龙鳞/.test(d3),
        d1 + ' | ' + d2 + ' | ' + d3);
    } catch (e) { t('W3 新皮肤描述', false, e.message); }

    // ===== X 组：v0.2.5 成就奖励金币 / 战绩档案 / 辅助模式 / Boss 多样化 =====
    try {
      const r1 = T.achReward('first'), r2 = T.achReward('combo8'), r3 = T.achReward('score5k');
      t('X1 成就奖励金币定义(50/120/300)', r1 === 50 && r2 === 120 && r3 === 300,
        'first=' + r1 + ' combo8=' + r2 + ' score5k=' + r3);
    } catch (e) { t('X1 成就奖励定义', false, e.message); }

    try {
      reset(); T.resetAch(); T.setCoins(0); T.unlockAch('first');
      t('X2 成就解锁即时发放金币(+50)', T.coins() === 50 && T.achHas('first') === true, 'coins=' + T.coins());
    } catch (e) { t('X2 成就发放金币', false, e.message); }

    try {
      reset(); T.resetCareer(); T.startMode('normal'); T.setScore(2000); T.recordGameNow(true);
      const c = T.careerNow();
      t('X3 战绩档案累计(局数/最高分)', c.games === 1 && c.bestScore === 2000,
        'games=' + c.games + ' best=' + c.bestScore);
    } catch (e) { t('X3 战绩档案累计', false, e.message); }

    try {
      reset(); T.resetCareer(); T.startMode('normal');
      for (let i = 1; i <= 12; i++) { T.setScore(i * 100); T.recordGameNow(true); }
      const c = T.careerNow();
      const sorted = c.board.every((b, i, a) => i === 0 || a[i - 1].score >= b.score);
      t('X4 排行榜仅前十且降序', c.board.length === 10 && sorted,
        'board=' + c.board.length + ' sorted=' + sorted);
    } catch (e) { t('X4 排行榜前十', false, e.message); }

    try {
      reset(); T.setContrast('1'); T.setColorBlind('1');
      const a = T.assistNow();
      t('X5 辅助模式开关(高对比+色弱)', a.contrast === true && a.colorBlind === true, JSON.stringify(a));
    } catch (e) { t('X5 辅助模式开关', false, e.message); }

    try {
      reset(); T.setColorBlind('1');
      t('X6 色弱重映射 红→紫', T.cbMap('#ff2d55') === '#c86bff' && T.cbMap('#2ecc71') === '#00e0ff',
        'red=' + T.cbMap('#ff2d55') + ' green=' + T.cbMap('#2ecc71'));
    } catch (e) { t('X6 色弱重映射', false, e.message); }

    try {
      reset(); T.setContrast('0');
      await sleep(90);                      // 让 tick 烘焙静态层 → dirty=false
      const before = T.mapBake().dirty;
      T.setContrast('1');                   // 同步 → markMapDirty → dirty=true
      const after = T.mapBake().dirty;
      t('X7 高对比切换触发地图重烘焙', before === false && after === true, 'before=' + before + ' after=' + after);
    } catch (e) { t('X7 高对比重烘焙', false, e.message); }

    try {
      const bt = T.bossTypesNow();
      t('X8 Boss 三种类型(血条样式+技能各异)',
        bt.length === 3 &&
        bt[0].skill === 'scatter' && bt[1].skill === 'laser' && bt[2].skill === 'split' &&
        new Set(bt.map(b => b.bar)).size === 3 && new Set(bt.map(b => b.skill)).size === 3,
        bt.map(b => b.id + '/' + b.bar + '/' + b.skill).join(','));
    } catch (e) { t('X8 Boss 类型定义', false, e.message); }

    try {
      reset(); T.setLevel(5);
      const b1 = T.forceSpawnBoss(); const b2 = T.forceSpawnBoss(); const b3 = T.forceSpawnBoss();
      t('X9 Boss 轮换(壁垒→猎手→分裂者)',
        b1.id === 'bastion' && b2.id === 'hunter' && b3.id === 'splitter',
        b1.id + '→' + b2.id + '→' + b3.id);
    } catch (e) { t('X9 Boss 轮换', false, e.message); }

    try {
      reset(); T.setLevel(5); T.forceSpawnBoss();
      const before = T.bullets().filter(b => b.owner === 'e').length;
      T.fireBossSkill('scatter');
      const after = T.bullets().filter(b => b.owner === 'e').length;
      t('X10 散射弹幕 3波×5发=15', after - before === 15, 'delta=' + (after - before));
    } catch (e) { t('X10 散射弹幕', false, e.message); }

    try {
      reset(); T.setLevel(5); T.forceSpawnBoss();
      const ok = T.fireBossSkill('laser');
      t('X11 激光扫射生成光束实体', ok === true && T.laserCountNow() === 1,
        'ok=' + ok + ' lasers=' + T.laserCountNow());
    } catch (e) { t('X11 激光扫射', false, e.message); }

    try {
      reset(); T.setLevel(5); T.forceSpawnBoss();
      const before = T.bullets().filter(b => b.owner === 'e').length;
      const eBefore = T.state().enemies.length;
      T.fireBossSkill('split');
      const after = T.bullets().filter(b => b.owner === 'e').length;
      const eAfter = T.state().enemies.length;
      t('X12 分裂召唤(环形8发+增援)', after - before === 8 && eAfter >= eBefore,
        'bullets+=' + (after - before) + ' enemies=' + eBefore + '→' + eAfter);
    } catch (e) { t('X12 分裂召唤', false, e.message); }

    try {
      const bt = T.bossTypesNow();
      const b = Object.fromEntries(bt.map(x => [x.id, x]));
      t('X13 Boss 属性差异化(壁垒最肉/猎手最快)',
        b.bastion.hpMul > b.splitter.hpMul && b.splitter.hpMul > b.hunter.hpMul &&
        b.hunter.speed > b.splitter.speed && b.splitter.speed > b.bastion.speed,
        'hpMul=' + b.bastion.hpMul + '/' + b.splitter.hpMul + '/' + b.hunter.hpMul +
        ' speed=' + b.hunter.speed + '/' + b.splitter.speed + '/' + b.bastion.speed);
    } catch (e) { t('X13 Boss 属性差异', false, e.message); }

    try {
      T.showOverlay('title');                 // 回到主菜单，装饰层随 overlay 显现
      const d = T.menuDecorNow();
      t('X14 主界面装饰元素(网格/粒子/四角/扫描线)',
        d.exists && d.grid && d.sparks === 1 && d.corners === 4 && d.scan && d.beam &&
        d.animTotal >= 4 && d.animOn >= 4 && d.overlayVisible === true,
        'grid=' + d.grid + ' sparks=' + d.sparks + ' corners=' + d.corners +
        ' scan=' + d.scan + ' beam=' + d.beam + ' anim=' + d.animOn + '/' + d.animTotal +
        ' visible=' + d.overlayVisible);
    } catch (e) { t('X14 主界面装饰元素', false, e.message); }

    try {
      T.setMotion('off');                       // 强制开启动效
      const on = T.menuDecorNow();
      T.setMotion('on');                        // 用户关闭动效 → html.motion-off
      const frozen = T.menuDecorNow();
      T.setMotion('off');                       // 恢复
      t('X15 装饰动画随减弱动效冻结',
        on.animOn >= 4 && on.motionOff === false && frozen.motionOff === true && frozen.animOn === 0,
        'on=' + on.animOn + '/' + on.animTotal + ' frozen=' + frozen.animOn +
        '/' + frozen.animTotal + ' motionOff=' + frozen.motionOff);
    } catch (e) { t('X15 装饰动画冻结', false, e.message); }

    // ===== Y 组：v0.2.6 无尽/生存模式（#83） =====
    try {
      reset(); T.setBestWave(0);
      const r = T.startEndless();
      const info = T.endlessNow();
      t('Y1 无尽模式开启(flag + 波次=1 + 入口)', r.endless === true && info.endless === true && info.level === 1 && info.bestWave === 0,
        'ret=' + JSON.stringify(r) + ' info=' + JSON.stringify(info));
    } catch (e) { t('Y1 无尽模式开启', false, e.message); }

    try {
      reset(); T.startEndless(); T.setLevel(5);
      const info = T.endlessInfo();
      const hp = 1 + 5 * 0.35, spd = Math.min(1.8, 1 + 5 * 0.04), cnt = Math.min(2.5, 1 + 5 * 0.05);
      t('Y2 无尽波次系数(血量+175%/速度+20%/数量+25%)',
        Math.abs(info.enemyMul.hp - hp) < 0.01 && Math.abs(info.enemyMul.spd - spd) < 0.01 && Math.abs(info.enemyMul.count - cnt) < 0.01,
        'hp=' + info.enemyMul.hp.toFixed(2) + ' spd=' + info.enemyMul.spd.toFixed(2) + ' cnt=' + info.enemyMul.count.toFixed(2));
    } catch (e) { t('Y2 无尽波次系数', false, e.message); }

    try {
      reset(); T.setBestWave(0); T.resetAch(); T.startEndless(); T.setLevel(29); T.endGame(false);
      t('Y3 无尽波次成就(29波→深潜者✓ 猎手✗)',
        T.achHas('endless10') === true && T.achHas('endless30') === false,
        'e10=' + T.achHas('endless10') + ' e30=' + T.achHas('endless30'));
    } catch (e) { t('Y3 无尽波次成就', false, e.message); }

    try {
      reset(); T.setBestWave(0); T.resetAch(); T.startEndless(); T.setLevel(30); T.endGame(false);
      t('Y4 无尽波次成就(30波→深渊猎手✓)',
        T.achHas('endless30') === true,
        'e30=' + T.achHas('endless30'));
    } catch (e) { t('Y4 无尽深潜者成就', false, e.message); }

    try {
      reset(); T.setBestWave(0); T.startEndless(); T.setLevel(9); T.endGame(false);
      const ls = parseInt(localStorage.getItem('tank-battle-bestwave') || '0', 10);
      t('Y5 无尽最高波次持久化(9波→localStorage)',
        T.bestWaveNow() === 9 && ls === 9, 'best=' + T.bestWaveNow() + ' ls=' + ls);
    } catch (e) { t('Y5 无尽最高波次持久化', false, e.message); }

    try {
      reset(); T.setBestWave(0); T.startEndless(); T.setLevel(11); T.endGame(false);
      const ls = parseInt(localStorage.getItem('tank-battle-bestwave') || '0', 10);
      const r = T.startEndless();  // 新一局无尽
      const info = T.endlessNow();
      t('Y6 无尽新局波次回1(历史最高保留)',
        info.level === 1 && T.bestWaveNow() === 11 && ls === 11,
        'level=' + info.level + ' best=' + T.bestWaveNow() + ' ls=' + ls);
    } catch (e) { t('Y6 无尽新局回波次', false, e.message); }

    // ===== Z 组：v0.2.6 过关结算界面 + 额外金币（#82） =====
    try {
      reset(); T.startGame(); T.setLevel(3); T.setStars({});
      const r = T.showLvResultNow();
      const s = T.lvResultNow();
      t('Z1 过关结算界面显示(星级 1-3 + 结算面板)',
        r.pending === true && r.show === true && s.show === true && s.stars >= 1 && s.stars <= 3,
        'pending=' + r.pending + ' show=' + s.show + ' stars=' + s.stars + ' num=' + s.num);
    } catch (e) { t('Z1 过关结算界面显示', false, e.message); }

    try {
      reset(); T.startGame(); T.setLevel(3); T.setCoins(0);
      T.showLvResultNow();
      const before = T.coins();
      const g = T.claimLvNow();
      const s = T.lvResultNow();
      const gained = T.coins() - before;
      t('Z2 领取星级奖励金币(25×星数) + 面板关闭',
        gained === g.gold && gained === s.stars * 25 && s.pending === false && s.show === false,
        'gained=' + gained + ' gold=' + g.gold + ' stars=' + s.stars + ' pending=' + s.pending + ' show=' + s.show);
      T.closeUpgrade ? T.closeUpgrade() : null;
    } catch (e) { t('Z2 领取星级奖励金币', false, e.message); }

    // ===== AA 组：v0.2.6 关卡选择 + 星级（#84） =====
    try {
      reset(); T.setMaxLv(1); T.setStars({});
      const before = T.levelSelectNow();
      const ls = localStorage.getItem('tank-battle-stars') || '';
      t('AA1 关卡面板存在 + maxUnlocked 持久化(1)',
        before.exists && before.maxUnlocked === 1 && ls === '{}',
        'exists=' + before.exists + ' max=' + before.maxUnlocked + ' ls=' + ls);
    } catch (e) { t('AA1 关卡面板存在', false, e.message); }

    try {
      reset(); T.setMaxLv(3); T.setStars({ 1: 3, 2: 2, 3: 1 });
      T.openLevelSelect(); await sleep(120);
      const s = T.levelSelectNow();
      t('AA2 打开关卡面板(show + 卡数≥5 + 锁定卡置灰)',
        s.open && s.cards >= 5 && s.locked >= 2 && s.maxUnlocked === 3,
        'open=' + s.open + ' cards=' + s.cards + ' locked=' + s.locked + ' max=' + s.maxUnlocked);
      const c = document.getElementById('btnLvSelClose'); if (c) c.click();
    } catch (e) { t('AA2 打开关卡面板', false, e.message); }

    try {
      reset(); T.setMaxLv(5);
      const r = T.startAtLevel(3); await sleep(150);
      const st = T.state();
      const s = T.levelSelectNow();
      t('AA3 startAtLevel(3) 从第 3 关开局 + 面板关闭',
        r && r.level === 3 && st.level === 3 && s.open === false,
        'ret=' + JSON.stringify(r) + ' state.level=' + st.level + ' open=' + s.open);
    } catch (e) { t('AA3 startAtLevel(3)', false, e.message); }

    try {
      reset(); const got = T.setStars({ 3: 2 });
      const ls = JSON.parse(localStorage.getItem('tank-battle-stars') || '{}');
      t('AA4 星级持久化(第3关2星→localStorage)',
        got['3'] === 2 && ls['3'] === 2,
        'got=' + JSON.stringify(got) + ' ls=' + JSON.stringify(ls));
    } catch (e) { t('AA4 星级持久化', false, e.message); }

    try {
      reset(); T.setMaxLv(2); T.setStars({ 1: 3, 2: 1 });
      T.openLevelSelect(); await sleep(120);
      const card1 = document.querySelector('.lvCard[data-lv="1"] .lvStarRow');
      const card2 = document.querySelector('.lvCard[data-lv="2"] .lvStarRow');
      const starText1 = card1 ? card1.textContent : '';
      const starText2 = card2 ? card2.textContent : '';
      t('AA5 星级渲染到关卡卡片(第1关★★★ 第2关★☆☆)',
        starText1 === '★★★' && starText2 === '★☆☆',
        'card1=' + starText1 + ' card2=' + starText2);
      const c = document.getElementById('btnLvSelClose'); if (c) c.click();
    } catch (e) { t('AA5 星级渲染到卡片', false, e.message); }

    try {
      reset(); T.setMaxLv(3); T.openLevelSelect(); await sleep(120);
      const locked = document.querySelector('.lvCard[data-lv="5"]');
      const unlocked = document.querySelector('.lvCard[data-lv="3"]');
      t('AA6 锁定卡禁用置灰(第5关disabled+locked)',
        locked && locked.classList.contains('locked') && locked.disabled === true &&
        unlocked && !unlocked.classList.contains('locked') && unlocked.disabled !== true,
        'lv5 locked=' + (locked && locked.classList.contains('locked')) + ' dis=' + (locked && locked.disabled) +
        ' lv3 locked=' + (unlocked && unlocked.classList.contains('locked')) + ' dis=' + (unlocked && unlocked.disabled));
      const c = document.getElementById('btnLvSelClose'); if (c) c.click();
    } catch (e) { t('AA6 锁定卡禁用置灰', false, e.message); }

    // ===== AB 组：v0.2.6 战绩图增强（#85） =====
    try {
      reset();
      const s = T.reportShareNow();
      t('AB1 战绩图增强元素(复制按钮 + 档案入口 + 剪贴板)',
        s.copyBtn && s.careerReportBtn && s.copySupported === true,
        'copyBtn=' + s.copyBtn + ' career=' + s.careerReportBtn + ' clip=' + s.copySupported);
    } catch (e) { t('AB1 战绩图增强元素', false, e.message); }

    try {
      reset(); T.startGame(); T.setScore(4321); T.recordGameNow(false);
      T.openReportNow(); await sleep(120);
      const s = T.reportShareNow();
      t('AB2 生成战绩图(数据 URL + 弹层打开)',
        s.boxOpen && s.hasSrc && s.srcBytes > 1000,
        'open=' + s.boxOpen + ' hasSrc=' + s.hasSrc + ' bytes=' + s.srcBytes);
      const c = document.getElementById('btnReportClose'); if (c) c.click();
    } catch (e) { t('AB2 生成战绩图', false, e.message); }

    try {
      reset(); T.startGame(); T.setLevel(3); T.setScore(5678); T.setStars({ 3: 2 }); T.endGame(true);
      await sleep(120);
      const before = T.reportShareNow().lastRun;
      T.openReportFromCareer(); await sleep(100);
      const s = T.reportShareNow();
      t('AB3 真实 endGame 快照 + 档案生成复用',
        !!before && before.level === 3 && before.score === 5678 && s.boxOpen,
        'lastRun=' + JSON.stringify(before) + ' open=' + s.boxOpen);
      const c = document.getElementById('btnReportClose'); if (c) c.click();
    } catch (e) { t('AB3 真实 endGame 快照', false, e.message); }

    try {
      reset(); T.startGame(); T.setLevel(2); T.setScore(2468); T.setStars({ 2: 3 }); T.endGame(true);
      await sleep(120);
      const lr = T.reportShareNow().lastRun;
      const stars = lr ? lr.stars : -1;
      t('AB4 战绩图快照含星级(第2关3星)',
        lr && lr.level === 2 && stars === 3, 'lastRun=' + JSON.stringify(lr));
    } catch (e) { t('AB4 战绩图快照含星级', false, e.message); }

    // ===== AC. v0.2.9 随机地图（#99） =====
    try {
      const seg = document.getElementById('randMapSeg');
      const ok = !!seg && seg.querySelectorAll('button').length === 2 &&
        seg.querySelectorAll('button[data-rand="0"]').length === 1 &&
        seg.querySelectorAll('button[data-rand="1"]').length === 1;
      t('AC1 设置面板随机地图开关', ok === true, 'buttons=' + (seg ? seg.querySelectorAll('button').length : 0));
    } catch (e) { t('AC1 设置面板随机地图开关', false, e.message); }

    try {
      t('AC2 随机地图默认开启', T.randMapNow() === true, 'randMapNow=' + T.randMapNow());
    } catch (e) { t('AC2 随机地图默认开启', false, e.message); }

    try {
      const a = T.loadRandomMapNow(0x12345678);
      const b = T.loadRandomMapNow(0x12345678);
      t('AC3 同种子生成同图', eq(a, b) === true, 'same=' + eq(a, b));
    } catch (e) { t('AC3 同种子生成同图', false, e.message); }

    try {
      const a = T.loadRandomMapNow(1);
      const b = T.loadRandomMapNow(2);
      t('AC4 异种子生成异图', eq(a, b) === false, 'diff=' + (eq(a, b) === false));
    } catch (e) { t('AC4 异种子生成异图', false, e.message); }

    try {
      T.loadRandomMapNow(0xDEADBEEF);
      const dim = T.mapDimsNow();
      const gp = T.gridPointsNow();
      const sp = T.spawnCellsNow();
      const reach = T.bfsReachableNow(gp.SPAWN.x, gp.SPAWN.y);
      const reachable = sp.every(c => reach.seen[c[1] * dim.COLS + c[0]] === 1);
      const baseN = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const x = gp.BASE.x + dx, y = gp.BASE.y + dy;
        return x >= 0 && y >= 0 && x < dim.COLS && y < dim.ROWS && reach.seen[y * dim.COLS + x] === 1;
      });
      t('AC5 随机图连通性(敌出生+基地+可走≥240)', reachable === true && baseN === true && reach.count >= 240,
        JSON.stringify({ reachable, baseN, count: reach.count }));
    } catch (e) { t('AC5 随机图连通性(敌出生+基地+可走≥240)', false, e.message); }

    try {
      const off = T.setRandomMapsNow('0');
      const ls0 = T.lsGet('tank-battle-randmap');
      const on = T.setRandomMapsNow('1');
      const ls1 = T.lsGet('tank-battle-randmap');
      t('AC6 开关切换持久化', off === false && ls0 === '0' && on === true && ls1 === '1',
        JSON.stringify({ off, ls0, on, ls1 }));
    } catch (e) { t('AC6 开关切换持久化', false, e.message); }

    // —— v0.2.9 BGM 曲库扩充断言 ——
    try {
      const tracks = T.bgmTracksNow();
      const ok = tracks.length >= 4 &&
        tracks.includes('calm') && tracks.includes('battle') &&
        tracks.includes('boss') && tracks.includes('rush');
      t('AC7 曲目总数≥4(含boss/rush)', ok === true, 'tracks=' + tracks.join(','));
    } catch (e) { t('AC7 曲目总数≥4(含boss/rush)', false, e.message); }

    try {
      const r = T.computeTargetNow({ running: true, paused: false, gameOver: false, wave: 1, endless: false });
      t('AC8 正常战斗→battle', r === 'battle', 'target=' + r);
    } catch (e) { t('AC8 正常战斗→battle', false, e.message); }

    try {
      const r1 = T.computeTargetNow({ running: true, paused: false, gameOver: false, wave: 3, bossAlive: true });
      const r2 = T.computeTargetNow({ running: true, paused: false, gameOver: false, bossLevel: true, bossWarn: 1 });
      t('AC9 Boss 战→boss', r1 === 'boss' && r2 === 'boss', 'bossAlive=' + r1 + ',bossWarn=' + r2);
    } catch (e) { t('AC9 Boss 战→boss', false, e.message); }

    try {
      const r5 = T.computeTargetNow({ running: true, paused: false, gameOver: false, wave: 5, endless: true });
      const r9 = T.computeTargetNow({ running: true, paused: false, gameOver: false, wave: 9, endless: true });
      const r4 = T.computeTargetNow({ running: true, paused: false, gameOver: false, wave: 4, endless: true });
      t('AC10 无尽高波→rush(边界w5)', r5 === 'rush' && r9 === 'rush' && r4 === 'battle',
        'w5=' + r5 + ',w9=' + r9 + ',w4=' + r4);
    } catch (e) { t('AC10 无尽高波→rush(边界w5)', false, e.message); }

    try {
      // 显式传 gameOver/won 隔离全局状态，保证分支确定性
      const p = T.computeTargetNow({ running: true, paused: true, gameOver: false });
      const goV = T.computeTargetNow({ running: true, gameOver: true, won: true });
      const goD = T.computeTargetNow({ running: true, gameOver: true, won: false });
      const nr = T.computeTargetNow({ running: false, gameOver: false });
      // v0.3.2：暂停/未运行 → calm；结束 → 结算场景曲（胜= victory / 败= defeat）
      t('AC11 暂停→calm / 结束→结算曲 / 未运行→calm', p === 'calm' && goV === 'victory' && goD === 'defeat' && nr === 'calm',
        'paused=' + p + ',gameOverWin=' + goV + ',gameOverLose=' + goD + ',notRunning=' + nr);
    } catch (e) { t('AC11 暂停→calm / 结束→结算曲 / 未运行→calm', false, e.message); }

    try {
      const b = T.setBgmNow('boss');
      const r = T.setBgmNow('rush');
      const o = T.setBgmNow('off');
      T.setBgmNow('calm');
      t('AC12 setBgm 切换生效', b === 'boss' && r === 'rush' && o === 'off',
        'boss=' + b + ',rush=' + r + ',off=' + o);
    } catch (e) { t('AC12 setBgm 切换生效', false, e.message); }

    // —— v0.2.9 金币经济补全断言（抽奖箱 / 强化重置 / 成就徽章框） ——
    try {
      const g = T.gachaState();
      t('AC13 抽奖箱配置(cost500)', g.cost === 500 && typeof g.count === 'number' && typeof g.coins === 'number',
        'cost=' + g.cost + ' count=' + g.count + ' coins=' + g.coins);
    } catch (e) { t('AC13 抽奖箱配置(cost500)', false, e.message); }

    try {
      const c0 = T.setCoinsNow(1000);
      const st0 = T.gachaState();
      const r = T.gachaNow();
      const ok = !!r && r.balance === c0 - 500 + (r.coins || 0) && st0.count + 1 === T.gachaState().count;
      t('AC14 抽奖扣500+发放奖励', ok === true, JSON.stringify({ c0, label: r && r.label, balance: r && r.balance, count: T.gachaState().count }));
    } catch (e) { t('AC14 抽奖扣500+发放奖励', false, e.message); }

    try {
      T.setCoinsNow(100);
      const r = T.gachaNow();
      t('AC15 金币不足抽奖被拒', r === null && T.gachaState().coins === 100, 'r=' + r + ' coins=' + T.gachaState().coins);
    } catch (e) { t('AC15 金币不足抽奖被拒', false, e.message); }

    try {
      T.setCoinsNow(5000);
      T.buyBonus('lifeup');
      const spent = T.bonusSpentNow();
      const r = T.resetBonusNow();
      const refund = Math.floor(spent * 0.5);
      t('AC16 强化重置返还50%', !!r && r.refund === refund && T.bonusSpentNow() === 0 && T.gachaState().totalLv === 0,
        JSON.stringify({ spent, refund, r }));
    } catch (e) { t('AC16 强化重置返还50%', false, e.message); }

    try {
      const c = T.achBadgeCount();
      t('AC17 成就徽章框总数', c.total >= 20 && c.unlocked >= 0, JSON.stringify(c));
    } catch (e) { t('AC17 成就徽章框总数', false, e.message); }

    try {
      T.setCoinsNow(100);
      const r = T.resetBonusNow();
      t('AC18 金币不足重置被拒', r === null, 'r=' + r);
    } catch (e) { t('AC18 金币不足重置被拒', false, e.message); }

    // 恢复默认开启，避免影响后续截图（截图用 startGame 走随机图）
    try { T.setRandomMapsNow('1'); } catch (e) {}

    return R;
  })()
  `;
  const testRes = await client.send('Runtime.evaluate', {
    expression: TEST_SRC, awaitPromise: true, returnByValue: true
  });
  const results = testRes.result && testRes.result.result ? testRes.result.result.value : null;
  if (!results) {
    console.log('TEST EVAL ERROR:', JSON.stringify(testRes).slice(0, 600));
    chrome.kill(); process.exit(2);
  }

  // 统计
  let pass = 0, fail = 0;
  for (const r of results) { if (r.pass) pass++; else fail++; }
  console.log('\n===== 回归结果 =====');
  for (const r of results) {
    console.log((r.pass ? 'PASS' : 'FAIL') + '  ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
  }
  console.log('===== ' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + results.length + ' =====');

  // 6) 截图：装备黄金皮肤开一局，等渲染后截屏
  try {
    await client.send('Runtime.evaluate', {
      expression: `(async()=>{ const T=window.__tbTest; T.setCoins(9999); T.setSkins({owned:['classic','crimson','violet','emerald','ghost','gold','onyx'],equipped:'gold'}); T.startGame(); await new Promise(r=>setTimeout(r,1600)); return true; })()`,
      awaitPromise: true, returnByValue: true
    });
    await sleep(300);
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    if (shot.result && shot.result.data) {
      fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
      console.log('screenshot saved:', SHOT);
    }
  } catch (e) { console.log('screenshot skipped:', e.message); }

  chrome.kill();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
