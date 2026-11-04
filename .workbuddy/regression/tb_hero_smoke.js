// tb_hero_smoke.js — v0.3.6 英雄系统专项冒烟验证(任务122①,CDP 驱动无头 Chrome)
// 用法: node tb_hero_smoke.js [url]
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = process.env.TB_CHROME || 'C:/Users/21889/.agent-browser/browsers/chrome-win64/chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8124/index.html?test=1';
const PORT = 9338;

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
  const profile = process.env.TB_PROFILE || 'C:/tmp/tbhero-profile';
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

  // ===== H1: 默认无英雄 · 全部被动为 0 · 基准值不变 =====
  try {
    const h = await ev('window.__tbTest.heroNow()');
    await ev('window.__tbTest.setPetCoins(99); window.__tbTest.buyHeroNow("sniper"); window.__tbTest.buyHeroNow("vanguard"); window.__tbTest.setHero("none")');
    await ev('window.__tbTest.startGame()');
    const lives = await ev('window.__tbTest.livesNow()');
    const spd = await ev('window.__tbTest.playerSpd()');
    const cd = await ev('window.__tbTest.fireOnce()');
    const pAll = ['blade', 'fortress', 'sniper', 'vanguard'].every(async k => (await ev('window.__tbTest.heroPassiveNow("' + k + '")')) === 0);
    t('H1 默认无英雄(lives3 · 速度2.4 · 冷却14 · 被动全0)', h === 'none' && lives === 3 && spd === 2.4 && Math.abs(cd - 14) < 0.01 && pAll,
      'hero=' + h + ' lives=' + lives + ' spd=' + spd + ' cd=' + cd);
  } catch (e) { t('H1 默认无英雄', false, e.message); }

  // ===== H2: 剑刃 → 开火冷却 ×0.85(14→11.9) =====
  try {
    const ok = await ev('window.__tbTest.setHero("blade")');
    await ev('window.__tbTest.startGame()');
    const cd = await ev('window.__tbTest.fireOnce()');
    t('H2 剑刃开火冷却 -15%(11.9)', ok === true && Math.abs(cd - 11.9) < 0.01, 'cd=' + cd);
  } catch (e) { t('H2 剑刃开火冷却 -15%(11.9)', false, e.message); }

  // ===== H3: 堡垒 → 生命 +1(4) · 开局护盾 +180 帧(3 秒) =====
  try {
    await ev('window.__tbTest.setHero("fortress")');
    await ev('window.__tbTest.startGame()');
    const lives = await ev('window.__tbTest.livesNow()');
    const inv = await ev('window.__tbTest.playerInvNow()');
    t('H3 堡垒生命+1·开局护盾+3秒(4 · 180帧)', lives === 4 && inv === 180, 'lives=' + lives + ' inv=' + inv);
  } catch (e) { t('H3 堡垒生命+1·开局护盾+3秒', false, e.message); }

  // ===== H4: 狙击 → 弹速 ×1.25(6.5) · 弹体 +1(5) =====
  try {
    await ev('window.__tbTest.setHero("sniper")');
    await ev('window.__tbTest.startGame()');
    await ev('window.__tbTest.fireOnce()');
    const b = await ev('window.__tbTest.bullets().slice(-1)[0]');
    t('H4 狙击弹速+25%·弹体+1(6.5 · size5)', b && Math.abs(b.speed - 6.5) < 0.01 && b.size === 5, JSON.stringify(b));
  } catch (e) { t('H4 狙击弹速+25%·弹体+1', false, e.message); }

  // ===== H5: 先锋 → 移速 ×1.15(2.76) · 连击窗口 ×1.2(6 秒) =====
  try {
    await ev('window.__tbTest.setHero("vanguard")');
    await ev('window.__tbTest.startGame()');
    const spd = await ev('window.__tbTest.playerSpd()');
    const cw = await ev('window.__tbTest.comboWindowNow()');
    t('H5 先锋移速+15%·连击窗口+20%(2.76 · 6)', Math.abs(spd - 2.76) < 0.001 && Math.abs(cw - 6) < 0.01, 'spd=' + spd + ' cw=' + cw);
  } catch (e) { t('H5 先锋移速+15%·连击窗口+20%', false, e.message); }

  // ===== H6: 双人同屏英雄被动关闭(防不对称) =====
  try {
    await ev('window.__tbTest.setHero("blade")');
    await ev('window.__tbTest.startMode("coop")');
    const spd2 = await ev('window.__tbTest.playerSpd()');
    const p = await ev('window.__tbTest.heroPassiveNow("blade")');
    await ev('window.__tbTest.startGame()');   // 回单人局
    const cd = await ev('window.__tbTest.fireOnce()');
    t('H6 双人局英雄被动关闭 · 回单人恢复', Math.abs(spd2 - 2.4) < 0.001 && p === 0 && Math.abs(cd - 11.9) < 0.01,
      'coop spd=' + spd2 + ' passive=' + p + ' solo cd=' + cd);
  } catch (e) { t('H6 双人局英雄被动关闭', false, e.message); }

  // ===== H7: 英雄选择跨刷新持久化 =====
  try {
    await ev('window.__tbTest.setHero("sniper")');
    const ok = await reload();
    const h = await ev('window.__tbTest.heroNow()');
    await ev('window.__tbTest.setHero("none")');
    t('H7 英雄选择跨刷新持久化(sniper)', ok && h === 'sniper', 'ok=' + ok + ' hero=' + h);
  } catch (e) { t('H7 英雄选择跨刷新持久化', false, e.message); }

  // ===== H8: 英雄定义 5 名(id 齐全) =====
  try {
    const ids = await ev('window.__tbTest.heroDefsNow()');
    const ok = ids.length === 6 && ['none', 'blade', 'fortress', 'sniper', 'vanguard', 'magnet'].every(x => ids.includes(x));
    t('H8 英雄定义 5 名齐全', ok, JSON.stringify(ids));
  } catch (e) { t('H8 英雄定义 5 名齐全', false, e.message); }

  chrome.kill();

  let pass = 0, fail = 0;
  for (const r of R) {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
    r.pass ? pass++ : fail++;
  }
  console.log('----');
  console.log('hero smoke: ' + pass + ' pass, ' + fail + ' fail, ' + R.length + ' total');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
