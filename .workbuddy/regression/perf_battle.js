// These functions run inside the foreground browser, on its own vsync clock.
async function calibrate() {
  const canvas = document.body.appendChild(document.createElement('canvas'));
  const ctx = canvas.getContext('2d');
  const raf = () => new Promise(requestAnimationFrame);
  const gaps = [];
  let last = await raf();
  // Same length as the battle sample: what a near-empty page manages on this display right now.
  for (let i = 0; i < 720; i++) {
    ctx.fillStyle = i % 2 ? '#fff' : '#888';
    ctx.fillRect(0, 0, 40, 40);
    const now = await raf();
    gaps.push(now - last);
    last = now;
  }
  gaps.sort((a,b) => a-b);
  return { idleP50ms:+gaps[359].toFixed(2), idleP99ms:+gaps[712].toFixed(2), idleMaxMs:+gaps[719].toFixed(2),
    idleWithin120Pct:+(100*gaps.filter(ms => ms <= 1000/120 + .5).length/gaps.length).toFixed(1) };
}

function installBattleProbe() {
  const raf = window.requestAnimationFrame.bind(window);
  const p = window.battleProbe = { active:false, painted:false, times:[], costs:[], slow:[] };
  // Long animation frames say whether a hitch was script, style/layout or neither (raster, GC, another process).
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) if (p.active) p.slow.push({ ms:Math.round(e.duration),
        scriptMs:Math.round(e.scripts.reduce((sum, s) => sum + s.duration, 0)),
        styleLayoutMs:Math.round(e.startTime + e.duration - e.styleAndLayoutStart),
        by:e.scripts.map(s => s.sourceFunctionName || s.invoker).slice(0, 3).join(',') });
    }).observe({ type:'long-animation-frame' });
  } catch (e) { /* older Chrome: gaps are still measured */ }
  window.requestAnimationFrame = cb => cb.name !== 'tick' ? raf(cb) : raf(now => {
    if (!p.active) return cb(now);
    p.painted = false;
    const start = performance.now();
    cb(now);
    p.costs.push(performance.now() - start);
    if (p.painted) p.times.push(now);
  });
}

async function measureBattle(scenario) {
  const T = window.__tbTest, p = window.battleProbe;
  const canvas = document.getElementById('game'), ctx = canvas.getContext('2d');
  const drawImage = ctx.drawImage;
  ctx.drawImage = function(...args) {
    p.painted = true;
    return drawImage.apply(this, args);
  };
  T.dismissTutorial(); T.setDailySeed(20261113); T.startMode('daily');
  T.invul(); T.stopSpawn();
  for (let i = 0; i < 6; i++) T.spawnEnemyAt(48 + i * 72, 96, 'normal');
  if (scenario === 'boss') T.forceSpawnBoss();
  const raf = () => new Promise(requestAnimationFrame);
  if (document.hidden) throw Error('Battle window is hidden');
  while (document.getElementById('lvIntro').classList.contains('show')) await raf();
  const start = await raf();
  let now = start, burst = start, volleys = 0;
  while (now - start < 7500) {
    if (now >= burst) {
      T.fireOnce();
      if (scenario === 'boss') {
        T.fireBossSkill('scatter');
        T.particleSpawn(310, 170, '#ff8050', 32);
      }
      burst += 250; volleys++;
    }
    if (now - start >= 1500) p.active = true;
    now = await raf();
  }
  p.active = false;
  // Losing focus pauses the game, which then repaints at 15 Hz; such a run says nothing about battle frame pacing.
  if (document.hidden || !T.state().running || T.state().paused || window.__tbErrCount || p.times.length !== p.costs.length) {
    throw Error('Battle was interrupted (hidden, paused or lost focus); run again without touching the window');
  }
  const gaps = p.times.slice(1).map((t,i) => t-p.times[i]);
  const stats = a => {
    const sorted = a.slice().sort((x,y) => x-y);
    const q = f => +sorted[Math.ceil(sorted.length * f) - 1].toFixed(2);
    return { p50:q(.5), p95:q(.95), p99:q(.99), max:q(1) };
  };
  const hud = document.getElementById('hud');
  const shown = [...hud.querySelectorAll('.pill')].filter(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight;
  }).length;
  return { version:document.getElementById('mark').textContent, viewport:[innerWidth,innerHeight],
    hud:{ nodes:hud.querySelectorAll('*').length, pillsOnScreen:shown, scrollWidth:hud.scrollWidth,
      buttonsRight:Math.round(hud.querySelector('.hbtns').getBoundingClientRect().right) },
    dpr:devicePixelRatio, canvas:canvas.width, volleys, draws:p.times.length, callbacks:p.costs.length,
    drawFps:+(1000*gaps.length / (p.times.at(-1)-p.times[0])).toFixed(1),
    drawGapsMs:stats(gaps), callbackMs:stats(p.costs),
    slowFrames:p.slow.sort((a,b) => b.ms-a.ms).slice(0, 3), readoutsSkipped:!!document.querySelector('.hudReadouts.offscreen'),
    within120Pct:+(100*gaps.filter(ms => ms <= 1000/120 + .5).length/gaps.length).toFixed(1) };
}

module.exports = { calibrate, installBattleProbe, measureBattle };
