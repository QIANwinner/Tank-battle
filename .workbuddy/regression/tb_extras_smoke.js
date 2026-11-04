// tb_extras_smoke.js — v0.6.25-26 签到pill+分差pill 专项冒烟验证(独立文件,不受 heroult 674 条污染)
// 用法: node tb_extras_smoke.js [url]
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = process.env.TB_CHROME || 'C:/Users/21889/.agent-browser/browsers/chrome-win64/chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8124/index.html?test=1';
const PORT = 9367;

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
  const profile = process.env.TB_PROFILE || 'C:/tmp/tbextras-profile';
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

  const R = [];
  const t = (name, pass, detail) => R.push({ name, pass: !!pass, detail: String(detail ?? '') });

  // ===== U663~U668: 签到状态 pill(v0.6.25) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('signinPillWrap'),f0:T.signinStatusTextNow(true,3),f1:T.signinStatusTextNow(false,3)});})()"));
    t('U663 签到 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U664 已签/待签双态文案', o.f0 === '✅ 已签 3 天' && o.f1 === '📅 待签 · 连 3 天', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.signinStatusTextNow(false,0),b:T.signinStatusTextNow(true,0)});})()"));
    t('U665 零天边界', o2.a === '📅 今日未签' && o2.b === '✅ 已签 0 天', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.signinStatusTextNow(false,-5),b:T.signinStatusTextNow(true,'x'),c:T.signinStatusTextNow(false,99)});})()"));
    t('U666 非法输入钳制', o3.a === '📅 今日未签' && o3.b === '✅ 已签 0 天' && o3.c === '📅 待签 · 连 99 天', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.signinReset();T.signinSetState(-1,5);T.extraHudRefreshNow();return JSON.stringify({dom:T.signinPillDomNow()});})()"));
    t('U667 DOM 与真实签到状态一致(昨天连5→今天待签连6)', (o4.dom || '').indexOf('连 6 天') >= 0, JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.signinClaim();T.extraHudRefreshNow();return JSON.stringify({dom:T.signinPillDomNow()});})()"));
    t('U668 领取后翻转为已签', (o5.dom || '').indexOf('✅ 已签 6 天') >= 0, JSON.stringify(o5));
  } catch(e){ for(let k=663;k<=668;k++) t('U'+k+' 签到pill',false,e.message); }

  // ===== U669~U674: 最高分差值 pill(v0.6.26) =====
  try {
    const o = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({dom:!!document.getElementById('bestDeltaWrap'),f:T.bestDeltaTextNow(500,1000)});})()"));
    t('U669 差值 pill 已加入 HUD', o.dom === true, JSON.stringify(o));
    t('U670 落后口径(距纪录 500)', o.f === '🎯 距纪录 500', JSON.stringify(o));
    const o2 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bestDeltaTextNow(1500,1000),b:T.bestDeltaTextNow(1000,0),c:T.bestDeltaTextNow(1000,1000)});})()"));
    t('U671 新纪录/首纪录/追平', o2.a === '🔥 +500 新纪录!' && o2.b === '🌊 首个纪录 1000' && o2.c === '🎯 距纪录 0', JSON.stringify(o2));
    const o3 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bestDeltaTextNow(0,0),b:T.bestDeltaTextNow(-5,1000)});})()"));
    t('U672 零分与负分兜底', o3.a === '🎯 距纪录 0' && o3.b === '🎯 距纪录 1000', JSON.stringify(o3));
    const o4 = JSON.parse(await ev("(function(){const T=window.__tbTest;return JSON.stringify({a:T.bestDeltaTextNow('x','y'),b:T.bestDeltaTextNow(NaN,NaN)});})()"));
    t('U673 非法输入兜底 0/0', o4.a === '🎯 距纪录 0' && o4.b === '🎯 距纪录 0', JSON.stringify(o4));
    const o5 = JSON.parse(await ev("(function(){const T=window.__tbTest;T.setBestNow(2000);T.extraHudRefreshNow();const dom=T.bestDeltaDomNow();T.setBestNow(0);T.extraHudRefreshNow();return JSON.stringify({dom});})()"));
    t('U674 DOM 与函数一致(score0 vs 纪录2000)', o5.dom === '🎯 距纪录 2000', JSON.stringify(o5));
  } catch(e){ for(let k=669;k<=674;k++) t('U'+k+' 分差pill',false,e.message); }

  chrome.kill();

  let pass = 0, fail = 0;
  for (const r of R) {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
    r.pass ? pass++ : fail++;
  }
  console.log('----');
  console.log('extras smoke: ' + pass + ' pass, ' + fail + ' fail, ' + R.length + ' total');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
