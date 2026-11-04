// tb_particlepool_smoke.js — v0.3.15 粒子对象池化专项冒烟验证(CDP 驱动无头 Chrome)
// 设计:所有粒子断言经 __tbTest 钩子(particleSpawn/particleStep/particleInfo/particleRecycleAll)确定性驱动,
//       绕过主循环(running=false 时主循环只 draw 不 update),headless 时间流速不影响结果。
// 用法: node tb_particlepool_smoke.js [url]
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = process.env.TB_CHROME || 'C:/Users/21889/.agent-browser/browsers/chrome-win64/chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8124/index.html?test=1';
const PORT = 9360;

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
  const profile = process.env.TB_PROFILE || 'C:/tmp/tbparticlepool-profile';
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

  // ===== P1: 首轮生成无池可复用(全新建对象) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.particleRecycleAll();
      T.particleSpawn(100, 200, '#ffffff', 10);
      return JSON.stringify(T.particleInfo());
    })()`));
    t('P1 首轮生成 active=10 pool=0(全新建)', o.active === 10 && o.pool === 0, JSON.stringify(o));
  } catch (e) { t('P1 首轮生成', false, e.message); }

  // ===== P2: 推进到全部死亡 → 回收进池 =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.particleStep(0.7);          // life∈[0.3,0.6],一次性推 0.7s 全部死亡
      return JSON.stringify(T.particleInfo());
    })()`));
    t('P2 死亡回收 active=0 pool=10', o.active === 0 && o.pool === 10, JSON.stringify(o));
  } catch (e) { t('P2 死亡回收', false, e.message); }

  // ===== P3: 复用池对象且属性被完整重写(无旧状态残留) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.particleSpawn(300, 400, '#ff0000', 10);
      const info = T.particleInfo();
      // 活动粒子全部属性核查:坐标/颜色/寿命区间/size 区间
      let ok = true, detail = '';
      for (const p of T.particlesAll()) {
        if (p.x !== 300 || p.y !== 400 || p.color !== '#ff0000' ||
            p.life < 0.3 || p.life > 0.6 || p.max !== 0.6 || p.size < 1.5 || p.size > 3.5) { ok = false; detail = JSON.stringify(p); break; }
      }
      return JSON.stringify({ info, ok, detail });
    })()`));
    t('P3 复用池对象 active=10 pool=0 + 属性重写', o.info.active === 10 && o.info.pool === 0 && o.ok, o.detail || JSON.stringify(o.info));
  } catch (e) { t('P3 复用池对象', false, e.message); }

  // ===== P4: 位置/寿命推进行为正确(k=dt*60 等价旧逻辑) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.particleRecycleAll();
      T.particleSpawn(500, 500, '#00ff00', 5);
      const before = T.particlesAll();
      T.particleStep(0.1);           // dt=0.1,k=6 → 位移=vx*6 ∈[-15,15]
      const after = T.particlesAll();
      let ok = after.length === 5;
      for (let i = 0; i < after.length; i++) {
        const dx = after[i].x - before[i].x, dy = after[i].y - before[i].y;
        const dl = before[i].life - after[i].life;
        if (Math.abs(dx) > 15.01 || Math.abs(dy) > 15.01 || Math.abs(dl - 0.1) > 0.001) { ok = false; break; }
      }
      return JSON.stringify({ ok, active: T.particleInfo().active, n: after.length });
    })()`));
    t('P4 位移=±15 内 / life-0.1 / 无提前回收', o.ok && o.active === 5 && o.n === 5, JSON.stringify(o));
  } catch (e) { t('P4 推进行为', false, e.message); }

  // ===== P5: 池上限截断(PARTICLE_POOL_MAX=512) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.particleRecycleAll();
      T.particleSpawn(0, 0, '#aaaaff', 600);   // 超上限批量
      T.particleStep(0.7);
      return JSON.stringify(T.particleInfo());
    })()`));
    t('P5 池上限截断 pool<=512', o.active === 0 && o.pool === 512 && o.poolMax === 512, JSON.stringify(o));
  } catch (e) { t('P5 池上限截断', false, e.message); }

  // ===== P6: recycleAll 回收当前活动粒子 =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.particleRecycleAll();        // 清 512 池残留(上限内,保留)
      T.particleSpawn(10, 10, '#00ffff', 5);
      const before = T.particleInfo();
      T.particleRecycleAll();
      const after = T.particleInfo();
      return JSON.stringify({ before, after });
    })()`));
    t('P6 recycleAll active→0 pool 回收', o.after.active === 0 && o.after.pool === o.before.pool + 5, JSON.stringify(o));
  } catch (e) { t('P6 recycleAll', false, e.message); }

  // ===== P7: 存活期不提前回收(部分死亡部分存活边界) =====
  try {
    const o = JSON.parse(await ev(`(async () => {
      const T = window.__tbTest;
      T.particleRecycleAll();
      const p0 = T.particleInfo().pool;   // 记录当前池(前序用例可能已充盈)
      T.particleSpawn(20, 20, '#ffaa00', 10);
      T.particleStep(0.05);          // min life 0.3-0.05=0.25>0 → 无死亡
      const mid = T.particleInfo();
      T.particleStep(0.6);           // 总推 0.65 > max 0.6 → 全部死亡
      const end = T.particleInfo();
      return JSON.stringify({ p0, mid, end });
    })()`));
    t('P7 存活不回收 + 后续全死', o.mid.active === 10 && o.mid.pool === o.p0 - 10 && o.end.active === 0, JSON.stringify(o));
  } catch (e) { t('P7 存活边界', false, e.message); }

  chrome.kill();

  let pass = 0, fail = 0;
  for (const r of R) {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
    r.pass ? pass++ : fail++;
  }
  console.log('----');
  console.log('particlepool smoke: ' + pass + ' pass, ' + fail + ' fail, ' + R.length + ' total');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
