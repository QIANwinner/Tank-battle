// tb_pet_fx_shot.js — 宠物参战反应视觉截图（触发 kill 欢跳瞬间，验证 drawPet 渲染不报错）
// 用法: node tb_pet_fx_shot.js [url] [out.png]
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = process.env.TB_CHROME || 'C:/Users/21889/.agent-browser/browsers/chrome-win64/chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8124/index.html?test=1';
const OUT = process.argv[3] || '.workbuddy/regression/pet_fx_shot.png';
const PORT = 9335;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function httpJson(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } });
    });
    req.on('error', reject); req.end();
  });
}
function httpWaitJson(path, method, tries = 40) {
  return new Promise((resolve, reject) => {
    let n = 0; const tick = () => httpJson(path, method).then(resolve).catch(() => { if (++n >= tries) return reject(new Error('CDP not ready: ' + path)); setTimeout(tick, 250); });
    tick();
  });
}
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map();
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const open = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  function send(method, params = {}) { return new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); }); }
  return { ws, open, send };
}

async function main() {
  const profile = process.env.TB_PROFILE || 'C:/tmp/tbpetfx-profile';
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--mute-audio', '--hide-scrollbars', '--window-size=480,720',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' });
  console.log('chrome pid', chrome.pid);
  const ver = await httpWaitJson('/json/version');
  console.log('CDP ready:', ver.Browser);
  const targets = await httpJson('/json/list');
  let page = targets.find(t => t.type === 'page');
  if (!page) page = await httpJson('/json/new?about:blank', 'PUT');
  const client = cdp(page.webSocketDebuggerUrl);
  await client.open;
  await client.send('Runtime.enable'); await client.send('Page.enable');
  try { await client.send('Page.bringToFront'); } catch (e) {}
  await client.send('Page.navigate', { url: URL });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) { await sleep(300); const r = await client.send('Runtime.evaluate', { expression: '!!window.__tbTest', returnByValue: true }); ready = r.result && r.result.result && r.result.result.value === true; }
  if (!ready) { console.log('FAIL: hook never appeared'); chrome.kill(); process.exit(2); }
  console.log('hook ready');
  const SRC = `(async () => {
    const T = window.__tbTest;
    T.setPetOwn(['cat']); T.setPet('cat', 3);
    T.setBonus({ lifeup:0,cd:0,spd:0,coinup:0,shield:0,revive:0,combo:0,bulletspd:0,pierce:0,supply:0,focus:0 });
    T.startGame(); T.skipIntro();
    // 轮询等待跟随实体生成（最多 ~1.5s）
    let f = null;
    for (let i = 0; i < 30; i++) { f = T.petFollowNow(); if (f) break; await new Promise(r => setTimeout(r, 50)); }
    if (!f) return { fx: 'no-follow', drawErr: T.drawErr ? T.drawErr() : null };
    T.petReactNow('kill');
    await new Promise(r => setTimeout(r, 130));   // 欢跳中段，宠物上跳
    const fx = T.petFxNow();
    const drawErr = T.drawErr ? T.drawErr() : null;
    return { fx, drawErr };
  })()`;
  const res = await client.send('Runtime.evaluate', { expression: SRC, awaitPromise: true, returnByValue: true });
  const info = (res.result && res.result.result && res.result.result.value) || {};
  console.log('petFx=', info.fx, 'drawErr=', info.drawErr);
  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  if (shot.result && shot.result.data) { fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64')); console.log('saved:', OUT); }
  chrome.kill();
  process.exit(info.fx === 'kill' && !info.drawErr ? 0 : 1);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
