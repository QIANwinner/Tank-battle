// tb_wskin_shot.js — v0.3.3 僚机皮肤商店视觉截图（打开商店 → 切到「僚机」Tab → 截图）
// 用法: node tb_wskin_shot.js [url] [out.png]
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = process.env.TB_CHROME || 'C:/Users/21889/.agent-browser/browsers/chrome-win64/chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8124/index.html?test=1';
const OUT = process.argv[3] || 'C:/Users/21889/Desktop/开源项目/Tank-battle/wskin_shop_shot.png';
const PORT = 9337;

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
  const profile = process.env.TB_PROFILE || 'C:/tmp/tbwskin-profile';
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--mute-audio', '--hide-scrollbars', '--window-size=480,860',
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
  // 准备：给足金币、购买部分僚机皮肤，然后打开商店并切到「僚机」Tab
  const SRC = `(async () => {
    const T = window.__tbTest;
    T.setCoins(2000);
    T.setWSkins({ owned: ['wing-teal'], equipped: 'wing-teal' });
    T.buyWSkin('wing-gold'); T.buyWSkin('wing-crimson');
    // 打开商店
    const shop = document.getElementById('shopBox');
    document.getElementById('btnShop').click();
    await new Promise(r => setTimeout(r, 120));
    // 切到僚机 Tab
    document.getElementById('tabWingman').click();
    await new Promise(r => setTimeout(r, 220));
    const items = shop.querySelectorAll('.shopItem').length;
    const equippedTxt = (shop.querySelector('.siBtn.equipped') || {}).textContent || '';
    const open = shop.classList.contains('show');
    const tabActive = document.getElementById('tabWingman').classList.contains('active');
    return { open, tabActive, items, equippedTxt };
  })()`;
  const res = await client.send('Runtime.evaluate', { expression: SRC, awaitPromise: true, returnByValue: true });
  const info = (res.result && res.result.result && res.result.result.value) || {};
  console.log('shop open=', info.open, 'tabActive=', info.tabActive, 'items=', info.items, 'equipped=', info.equippedTxt);
  await sleep(150);
  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  if (shot.result && shot.result.data) { fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64')); console.log('saved:', OUT); }
  chrome.kill();
  process.exit(info.open && info.tabActive && info.items === 5 ? 0 : 1);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
