// perf_probe.js — 测量 Tank-battle 首屏加载耗时（CDP）
// 用法: TB_THROTTLE=4 TB_MOBILE=1 node perf_probe.js [url] [chrome]
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');

const CHROME = process.argv[3] || process.env.TB_CHROME || 'C:/Users/21889/.agent-browser/browsers/chrome-win64/chrome.exe';
const pageUrl = process.argv[2] || 'http://127.0.0.1:8124/index.html';
const battle = process.env.TB_BATTLE === '1';
const { measureBattle, installBattleProbe, calibrate } = require('./perf_battle');

function httpJson(path, port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}
// 找到页面级 target 的 webSocketDebuggerUrl（Performance/Runtime 均为页面域）
async function pageTarget(profile) {
  for (let i = 0; i < 100; i++) {
    try {
      const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      const list = await httpJson('/json/list', port);
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('no page target');
}
function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m);
    }
  });
  ws.addEventListener('close', () => {
    for (const p of pending.values()) p.reject(new Error('CDP closed'));
    pending.clear();
  });
  const open = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const i = ++id; pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  return { ws, open, send };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profile = fs.mkdtempSync((process.env.TB_PROFILE || path.join(os.tmpdir(), 'tb-perf')) + '-');
  const chrome = spawn(CHROME, [
    // Battle runs need a real window on the display's vsync; keep it rendering even when another window covers it.
    ...(battle ? ['--no-first-run', '--no-default-browser-check', '--start-maximized',
      '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--disable-background-timer-throttling'] :
      ['--headless=new', '--disable-gpu', '--window-size=720,840']), '--disable-dev-shm-usage', '--mute-audio',
    '--remote-debugging-port=0', '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore' });
  const exited = new Promise(resolve => { chrome.once('exit', resolve); chrome.once('error', resolve); });
  // A minimised or closed window never fires another animation frame; fail instead of waiting forever.
  const watchdog = battle && setTimeout(() => { console.error('ERR battle window stopped rendering'); chrome.kill(); process.exit(1); }, 90000);
  let client;
  try {
    if (!chrome.pid) throw Error('Could not start Chrome: ' + CHROME);
    client = cdpClient(await pageTarget(profile));
    await client.open;
    const send = client.send;
    await send('Page.enable');
    async function evaluate(expression) {
      const { result } = await send('Runtime.evaluate', { expression, returnByValue:true, awaitPromise:true, userGesture:true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    }
    const throttle = Number(process.env.TB_THROTTLE || 1), mobile = process.env.TB_MOBILE === '1';
    await send('Emulation.setCPUThrottlingRate', { rate:throttle });
    if (mobile) {
      await send('Emulation.setDeviceMetricsOverride', { width:390, height:844, deviceScaleFactor:1, mobile:true });
      await send('Emulation.setTouchEmulationEnabled', { enabled:true });
    }
    await send('Network.enable');
    await send('Network.setBypassServiceWorker', { bypass:true });
    const target = new URL(pageUrl);
    let reference;
    if (battle) {
      target.searchParams.set('test', '1');
      await send('Page.bringToFront');
      reference = await evaluate(`(${calibrate})()`);
      await send('Page.addScriptToEvaluateOnNewDocument', { source:`(${installBattleProbe})()` });
    }
    await send('Page.navigate', { url:target.href });
    let ready = false;
    for (let i = 0; i < 150 && !ready; i++) {
      ready = await evaluate("document.readyState === 'complete' && document.getElementById('tutBox')?.classList.contains('show') && performance.getEntriesByName('first-contentful-paint').length > 0");
      if (!ready) await sleep(100);
    }
    if (!ready) throw Error('No painted, interactive first-visit menu');
    if (battle) {
      const scenario = process.env.TB_SCENE || 'boss';
      if (!['wave', 'boss'].includes(scenario)) throw Error('TB_SCENE must be wave or boss');
      await send('Performance.enable');
      const mainThread = async () => {
        const { result } = await send('Performance.getMetrics');
        return Object.fromEntries(result.metrics.map(m => [m.name, m.value]));
      };
      const before = await mainThread(), t0 = Date.now();
      let timer;
      const sample = await Promise.race([
        evaluate(`(${measureBattle})(${JSON.stringify(scenario)})`),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Battle run timed out (window not rendering?)')), 45000); })
      ]).finally(() => clearTimeout(timer));
      const after = await mainThread(), seconds = (Date.now() - t0) / 1000;
      const perSecond = name => +((after[name] - before[name]) * 1000 / seconds).toFixed(1);
      console.log(JSON.stringify({ reference, scenario, throttle, mobile, ...sample,
        mainThreadMsPerSec:{ script:perSecond('ScriptDuration'), style:perSecond('RecalcStyleDuration'),
          layout:perSecond('LayoutDuration'), task:perSecond('TaskDuration') } }));
      return;
    }
    const sample = await evaluate(`(async () => {
      const raf = () => new Promise(resolve => requestAnimationFrame(resolve));
      const nav = performance.getEntriesByType('navigation')[0];
      const fcp = performance.getEntriesByName('first-contentful-paint')[0].startTime;
      const t = performance.now(); document.getElementById('tutBtn').click();
      const handler = performance.now() - t;
      await raf(); await raf();
      const startPaint = performance.now() - t;
      if (!document.getElementById('overlay').classList.contains('hide')) throw Error('Start failed');
      const deadline = performance.now() + 15000;
      while (document.getElementById('lvIntro').classList.contains('show')) {
        if (performance.now() > deadline) throw Error('Level intro stalled');
        await raf();
      }
      const frames = []; let last = await raf();
      for (let i = 0; i < 90; i++) { const now = await raf(); frames.push(now-last); last=now; }
      frames.sort((a,b) => a-b);
      return { version:document.getElementById('mark').textContent, fcp:Math.round(fcp),
        ready:Math.round(nav.domContentLoadedEventEnd), startHandler:Math.round(handler),
        startPaint:Math.round(startPaint), frameP50:+frames[44].toFixed(1), frameP95:+frames[85].toFixed(1),
        framesOver50:frames.filter(n => n > 50.5).length, errors:window.__tbErrCount };
    })()`);
    if (sample.errors !== 0) throw Error('Page errors: ' + sample.errors);
    console.log(JSON.stringify({ throttle, mobile, ...sample }));
  } finally {
    clearTimeout(watchdog);
    if (client?.ws.readyState === WebSocket.OPEN) {
      await client.send('Browser.close').catch(() => chrome.kill());
      client.ws.close();
    } else if (chrome.pid) chrome.kill();
    await exited;
    try { fs.rmSync(profile, { recursive:true, force:true, maxRetries:4, retryDelay:150 }); }
    catch (e) { console.warn('Temporary profile retained:', profile, e.message); }
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
