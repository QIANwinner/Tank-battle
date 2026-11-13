// tb_hero_smoke.js — v0.3.6 英雄系统专项冒烟验证(任务122①,CDP 驱动无头 Chrome)
// 用法: node tb_hero_smoke.js [url]
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = process.env.TB_CHROME || 'C:/Users/21889/.agent-browser/browsers/chrome-win64/chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8124/index.html?test=1';
const PORT = 9378;

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
    const r = await client.send('Runtime.evaluate', { expression: '!!window.__tbTest', returnByValue: true, awaitPromise: true });
    ready = r.result && r.result.result && r.result.result.value === true;
  }
  if (!ready) { console.log('FAIL: game test hook never appeared'); chrome.kill(); process.exit(2); }
  console.log('game test hook ready');

  async function reload() {
    await client.send('Page.navigate', { url: URL });
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      const r = await client.send('Runtime.evaluate', { expression: '!!window.__tbTest', returnByValue: true, awaitPromise: true });
      if (r.result && r.result.result && r.result.result.value === true) return true;
    }
    return false;
  }
  async function ev(expr) {
    const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  }


  const assert = require('node:assert/strict');
  try {
    const tour = await ev(`(() => {
      const T=window.__tbTest, box=document.getElementById('tourBox');
      const initial=getComputedStyle(box).display;
      T.showTourNow(0);
      const opened=getComputedStyle(box).display !== 'none' && !!document.getElementById('tourTitle').textContent;
      document.getElementById('tourClose').click();
      const skipped=box.hidden && getComputedStyle(box).display === 'none';
      T.showTourNow(0);
      const next=document.getElementById('tourNext'); next.click(); next.click();
      const last=next.textContent;
      next.click();
      return {initial,opened,skipped,last,finished:box.hidden && getComputedStyle(box).display === 'none',seen:localStorage.getItem('tb-tour-seen')};
    })()`);
    assert.equal(tour.initial,'none'); assert.equal(tour.opened,true); assert.equal(tour.skipped,true);
    assert.equal(tour.last,'开始游戏'); assert.equal(tour.finished,true); assert.equal(tour.seen,'1');
    console.log('PASS tour initially hidden, skip closes it, three steps finish and persist');
    const result = await ev(`(() => {
      const T = window.__tbTest;
      T.saveImport('QTB1.' + btoa(JSON.stringify({t:'QTB',v:1,petcoins:77,pets:['cat'],petlevels:{cat:3},pet:'cat',heroes:['sniper'],hero:'sniper',gacha:4,bonusspent:100,wskins:['wing-teal'],wskin:'wing-teal'})));
      const backup = T.saveExport();
      T.saveImport('QTB1.' + btoa(JSON.stringify({t:'QTB',v:1,petcoins:0,pets:[],petlevels:{},pet:'',heroes:[],hero:'none',gacha:0,bonusspent:0})));
      T.saveImport(backup);
      return T.saveAllNow();
    })()`);
    assert.equal(result.petcoins,77); assert.equal(result.pet,'cat'); assert.equal(result.petlevels.cat,3);
    assert.equal(result.hero,'sniper'); assert.equal(result.gacha,4); assert.equal(result.bonusspent,100);
    console.log('PASS backup round trip: hero, pets, levels, currencies and counters');
    await ev(`(() => { const t = document.getElementById('compactHud'); t.checked=true; t.dispatchEvent(new Event('change')); })()`);
    assert.equal(await ev(`getComputedStyle(document.querySelector('#hud .m-hide')).display`),'none');
    await reload();
    const reloaded = await ev(`({save:window.__tbTest.saveAllNow(),compact:document.getElementById('compactHud').checked, errors:window.__tbErrCount})`);
    assert.equal(reloaded.save.pet,'cat'); assert.equal(reloaded.save.hero,'sniper'); assert.equal(reloaded.compact,true); assert.equal(reloaded.errors,0);
    console.log('PASS saved progress and compact HUD survive reload');
    const failure = await ev(`(() => {
      const original=Storage.prototype.setItem;
      Storage.prototype.setItem=function(){throw new DOMException('quota','QuotaExceededError');};
      window.__tbTest.setPetCoins(88);
      const visible=!!document.getElementById('saveWarning') && !document.getElementById('saveWarning').hidden;
      Storage.prototype.setItem=original;
      document.querySelector('#saveWarning button').click();
      return {visible,hidden:document.getElementById('saveWarning').hidden,coins:window.__tbTest.saveAllNow().petcoins};
    })()`);
    assert.equal(failure.visible,true); assert.equal(failure.hidden,true); assert.equal(failure.coins,88);
    console.log('PASS storage failure warning and retry in browser');
    await ev(`window.__tbTest.dismissTutorial(); window.__tbTest.setDailySeed(20261113); window.__tbTest.startMode("daily")`);
    await sleep(1800);
    const metrics = await ev(`new Promise(resolve => {
      const samples=[];let previous=performance.now();
      function frame(now){samples.push(now-previous);previous=now;if(samples.length<180)requestAnimationFrame(frame);else{
        samples.sort((a,b)=>a-b);resolve({frames:samples.length,p50ms:samples[90],p95ms:samples[171],maxms:samples[179],errors:window.__tbErrCount});}}
      requestAnimationFrame(frame);
    })`);
    assert.equal(metrics.errors,0);
    console.log('PERFORMANCE (headless baseline, not a device guarantee): '+JSON.stringify(metrics));
    const shot=await client.send('Page.captureScreenshot',{format:'png'});
    if(shot.result?.data) fs.writeFileSync(process.env.TB_SHOT || 'release-smoke.png',Buffer.from(shot.result.data,'base64'));
  } finally { chrome.kill(); }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
