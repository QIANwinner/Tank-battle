// tb_mobile_smoke.js — v0.3.11 移动端触屏控制区专项冒烟验证(CDP 设备模拟)
// 验证:桌面模式触屏控件隐藏;375px 触屏下三按钮(大招/英雄技/开火)可见不重叠不溢出、英雄技可点
// 注意:触控模拟开启后该渲染器 ontouchstart 永久为真,无法撤销——桌面断言必须在模拟前执行
// 用法: node tb_mobile_smoke.js [url]
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = process.env.TB_CHROME || 'C:/Users/21889/.agent-browser/browsers/chrome-win64/chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8124/index.html?test=1';
const PORT = 9351;

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
  const profile = process.env.TB_PROFILE || 'C:/tmp/tbmobile-profile';
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
  await client.send('Page.navigate', { url: URL });

  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(300);
    const r = await client.send('Runtime.evaluate', { expression: '!!window.__tbTest', returnByValue: true });
    ready = r.result && r.result.result && r.result.result.value === true;
  }
  if (!ready) { console.log('FAIL: game test hook never appeared'); chrome.kill(); process.exit(2); }
  console.log('game test hook ready (desktop first)');

  async function ev(expr) {
    const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  }

  const R = [];
  const t = (name, pass, detail) => R.push({ name, pass: !!pass, detail: String(detail ?? '') });

  // ===== M1: 桌面模式(未模拟)→ 触屏控件隐藏 =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const pad = document.getElementById("pad");
      const touch = document.documentElement.classList.contains("touch");
      const padVisible = !!pad && getComputedStyle(pad).display !== "none";
      return JSON.stringify({ touch, padVisible });
    })()`));
    t('M1 桌面模式触屏控件隐藏', o.touch === false && o.padVisible === false, JSON.stringify(o));
  } catch (e) { t('M1 桌面模式触屏控件隐藏', false, e.message); }

  // ===== 触屏设备模拟:375×667 + 5 点触控(此后渲染器永久带 touch,故放在桌面断言之后) =====
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await client.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
  await client.send('Page.navigate', { url: URL });
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    const r = await client.send('Runtime.evaluate', { expression: '!!window.__tbTest', returnByValue: true });
    if (r.result && r.result.result && r.result.result.value === true) break;
  }
  console.log('mobile emulation on');

  // ===== M2: 触屏模式生效 · 三按钮可见 =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const g = id => document.getElementById(id);
      const vis = el => !!el && el.getBoundingClientRect().width > 0;
      return JSON.stringify({
        touch: document.documentElement.classList.contains("touch"),
        ult: vis(g("tUlt")), hero: vis(g("tHeroUlt")), fire: vis(g("tFire")),
        vw: window.innerWidth
      });
    })()`));
    t('M2 触屏模式 · 三按钮可见(视口' + o.vw + 'px)', o.touch === true && o.ult && o.hero && o.fire, JSON.stringify(o));
  } catch (e) { t('M2 触屏模式', false, e.message); }

  // ===== M3: 三按钮两两不重叠(防误触,窄屏缩径 56px) =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const r = id => { const b = document.getElementById(id).getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.x + b.width, b: b.y + b.height }; };
      const a = r("tUlt"), h = r("tHeroUlt"), f = r("tFire");
      const overlap = (p, q) => p.x < q.r && p.r > q.x && p.y < q.b && p.b > q.y;
      return JSON.stringify({ uH: overlap(a, h), uF: overlap(a, f), hF: overlap(h, f),
        w: [a.w, h.w, f.w] });
    })()`));
    t('M3 三按钮两两不重叠(窄屏缩径 56px)', o.uH === false && o.uF === false && o.hF === false && o.w[0] <= 60 && o.w[1] <= 60 && o.w[2] <= 92, JSON.stringify(o));
  } catch (e) { t('M3 三按钮两两不重叠', false, e.message); }

  // ===== M4: 按钮区不横向溢出(右缘 ≤ 视口宽) =====
  try {
    const o = JSON.parse(await ev(`(function(){
      const r = id => document.getElementById(id).getBoundingClientRect();
      const rc = document.getElementById("rightCtl").getBoundingClientRect();
      return JSON.stringify({ rcRight: Math.round(rc.right), fireRight: Math.round(r("tFire").right), vw: window.innerWidth, docW: document.documentElement.scrollWidth });
    })()`));
    t('M4 按钮区不溢出(右缘≤' + o.vw + ')', o.rcRight <= o.vw + 1 && o.fireRight <= o.vw + 1 && o.docW <= o.vw + 1, JSON.stringify(o));
  } catch (e) { t('M4 按钮区不溢出', false, e.message); }

  // ===== M5: 触屏点「英雄技」真实触发大招(v0.3.11 补上的绑定) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.setHero("blade"); T.setPetCoins(99); T.buyHeroNow("sniper"); T.buyHeroNow("vanguard");
      T.setHero("blade"); T.startGame(); T.skipIntro();
      document.getElementById("tHeroUlt").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 60));
      return JSON.stringify({ cd: T.heroUltNow().cd, rapid: T.heroUltNow().rapid });
    })()`));
    t('M5 触屏点英雄技触发大招(已入冷却20-45 · 狂暴生效)', o.cd > 20 && o.cd <= 45 && o.rapid > 0 && o.rapid <= 5, JSON.stringify(o));
  } catch (e) { t('M5 触屏点英雄技', false, e.message); }

  chrome.kill();

  let pass = 0, fail = 0;
  for (const r of R) {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
    r.pass ? pass++ : fail++;
  }
  console.log('----');
  console.log('mobile smoke: ' + pass + ' pass, ' + fail + ' fail, ' + R.length + ' total');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
