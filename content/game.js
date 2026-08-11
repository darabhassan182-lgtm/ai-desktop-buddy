/* ============================================================
   NEXUS — game.js · AGENT SEA · cinematic Jarvis HUD (Canvas 2D)
   A film-grade arc-reactor interface: a molten core with layered
   counter-rotating rings, an audio-reactive voiceprint, drifting
   energy particles, a parallax starfield, curved dispatch beams,
   a slow "camera" drift, and filmic post (vignette, scanlines,
   grain, chromatic aberration). Reacts to Director state + mic.

   Implements window.World (the exact contract renderer.js drives):
     init, setManager, setAgent, dispatch, deliver, speak, focus, resize
   Plus setLevel(0..1) and setListening(bool) (called by jarvis.js).
   Pure Canvas 2D. Additive bloom via 'lighter'. Never throws.
   ============================================================ */
(function () {
  'use strict';

  var BLUE = '#7c9cff', CYAN = '#66e0ff', ICE = '#eaf4ff', DEEP = '#3a5bd0';
  var AGENTS = [
    { id: 'research',  name: 'SCOUT', tag: 'RESEARCH', accent: '#5b8cff' },
    { id: 'docs',      name: 'QUILL', tag: 'DOCS',     accent: '#34d399' },
    { id: 'marketing', name: 'SPARK', tag: 'CREATIVE', accent: '#f5a623' },
    { id: 'inbox',     name: 'ECHO',  tag: 'COMMS',    accent: '#ec4899' },
    { id: 'api',       name: 'WIRE',  tag: 'AUTOMATE', accent: '#22d3ee' }
  ];

  var canvas, ctx, dpr = 1, W = 0, H = 0, running = false, t = 0, lastT = 0;
  var mgrState = 'idle';                 // idle | thinking | speaking
  var listening = false;
  var level = 0, levelEase = 0;          // mic amplitude 0..1
  var speakPulse = 0, thinkEase = 0, spin = 0;
  var agent = {};                        // id -> { state, glow, seed }
  var beams = [];                        // { dir, id, t, dur, color }
  var stars = [], motes = [], spec = new Array(24);
  var noiseTiles = [], scanPat = null;
  var bgGrad = null, vignGrad = null, hexFade = null, NOISE = 512;   // cached per-resize (no per-frame allocs)
  AGENTS.forEach(function (a, i) { agent[a.id] = { state: 'idle', glow: 0, seed: i * 1.7 }; });
  var lastRouted = null;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, k) { return a + (b - a) * k; }
  function statusText() {
    if (mgrState === 'thinking') return 'PROCESSING';
    if (mgrState === 'speaking') return 'SPEAKING';
    if (listening) return 'LISTENING';
    return 'STANDING BY';
  }
  function hexA(hex, a) {
    hex = (hex || '#7c9cff').replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    var n = parseInt(hex, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* ---------- build size-dependent + one-time assets ---------- */
  function rand(seed) { var x = Math.sin(seed * 999.13) * 43758.5453; return x - Math.floor(x); }

  function buildStars() {
    stars = [];
    var n = Math.round(clamp((W * H) / 9000, 90, 260));
    for (var i = 0; i < n; i++) {
      stars.push({
        x: rand(i + 1) * W, y: rand(i + 7.3) * H,
        z: 0.3 + rand(i + 3.1) * 0.7,               // depth → parallax + size
        tw: rand(i + 5.5) * 6.28, sp: 1.5 + rand(i + 2.2) * 2.5
      });
    }
  }
  function buildMotes() {
    if (motes.length) return;
    for (var i = 0; i < 70; i++) {
      motes.push({ a: rand(i + 11) * 6.28, r: 0.4 + rand(i + 13) * 0.9, sp: 0.15 + rand(i + 17) * 0.5, s: 0.6 + rand(i + 19) * 1.8, ph: rand(i + 23) * 6.28 });
    }
  }
  function buildNoise() {
    if (noiseTiles.length) return;
    for (var k = 0; k < 3; k++) {
      var c = document.createElement('canvas'); c.width = c.height = NOISE;
      var g = c.getContext('2d'); var img = g.createImageData(NOISE, NOISE);
      for (var i = 0; i < img.data.length; i += 4) {
        var v = (Math.random() * 255) | 0;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = Math.random() < 0.5 ? (Math.random() * 42) | 0 : 0;
      }
      g.putImageData(img, 0, 0); noiseTiles.push(c);
    }
  }
  function buildGradients() {
    if (!ctx) return;
    bgGrad = ctx.createRadialGradient(W / 2, H * 0.44, 0, W / 2, H * 0.5, Math.max(W, H) * 0.8);
    bgGrad.addColorStop(0, '#0c1730'); bgGrad.addColorStop(0.45, '#080d1c'); bgGrad.addColorStop(1, '#03050b');
    vignGrad = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.72);
    vignGrad.addColorStop(0, 'rgba(0,0,0,0)'); vignGrad.addColorStop(1, 'rgba(0,0,0,0.5)');
    var rin = Math.min(W, H) * 0.155;
    hexFade = ctx.createRadialGradient(W / 2, H * 0.47, rin, W / 2, H * 0.47, Math.max(W, H) * 0.6);
    hexFade.addColorStop(0, 'rgba(3,5,11,0)'); hexFade.addColorStop(1, 'rgba(3,5,11,0.85)');
  }
  function buildScan() {
    if (scanPat) return;
    var c = document.createElement('canvas'); c.width = 1; c.height = 3;
    var g = c.getContext('2d'); g.fillStyle = 'rgba(0,0,0,0.16)'; g.fillRect(0, 2, 1, 1);
    scanPat = ctx.createPattern(c, 'repeat');
  }

  function resize() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth || window.innerWidth; H = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.max(1, (W * dpr) | 0); canvas.height = Math.max(1, (H * dpr) | 0);
    buildStars(); buildGradients();
  }

  /* ---------- loop ---------- */
  function loop(now) {
    if (!running) return;
    var dt = Math.min(0.05, (now - lastT) / 1000 || 0); lastT = now; t += dt;
    try { update(dt); render(); } catch (e) {}
    requestAnimationFrame(loop);
  }

  function update(dt) {
    levelEase += (level - levelEase) * Math.min(1, dt * 12);
    thinkEase += ((mgrState === 'thinking' ? 1 : 0) - thinkEase) * Math.min(1, dt * 4);
    speakPulse = mgrState === 'speaking' ? (0.5 + 0.5 * Math.sin(t * 9)) : Math.max(0, speakPulse - dt * 2);
    spin += dt * (0.25 + thinkEase * 1.4);
    // audio spectrum bars (smoothed, symmetric-ish)
    for (var s = 0; s < spec.length; s++) {
      var target;
      if (mgrState === 'speaking') target = 0.28 + 0.72 * Math.abs(Math.sin(t * 7 + s * 0.7)) * (0.6 + 0.4 * Math.sin(t * 3 + s));
      else target = levelEase * (0.5 + 0.5 * Math.abs(Math.sin(t * 5 + s * 0.9)));
      spec[s] = lerp(spec[s] || 0, target, Math.min(1, dt * 14));
    }
    for (var id in agent) {
      var st = agent[id];
      var on = st.state === 'assigned' || st.state === 'working' || st.state === 'searching' || st.state === 'delivering';
      st.glow += ((on ? 1 : 0) - st.glow) * Math.min(1, dt * 5);
    }
    for (var i = beams.length - 1; i >= 0; i--) { beams[i].t += dt; if (beams[i].t >= beams[i].dur) beams.splice(i, 1); }
  }

  /* ---------- render ---------- */
  function render() {
    buildNoise(); buildScan();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // cinematic camera drift (slow float, like a handheld hologram shot)
    var camX = Math.sin(t * 0.13) * 9 + Math.sin(t * 0.061) * 5;
    var camY = Math.cos(t * 0.11) * 7 + Math.sin(t * 0.047) * 4;
    var cx = W / 2 + camX, cy = H * 0.47 + camY;
    var R = clamp(Math.min(W, H) * 0.155, 78, 240);
    var ringR = R * 2.7;

    drawBackground(camX, camY);
    drawStars(camX, camY);
    drawHexField(cx, cy, R);
    drawMotes(cx, cy, R);

    drawTethers(cx, cy, ringR);
    drawBeams(cx, cy, ringR);
    drawNodes(cx, cy, ringR);
    drawCore(cx, cy, R);
    drawVoicePrint(cx, cy, R);
    drawChrome(cx, cy, R);

    drawPost();
  }

  function drawBackground(camX, camY) {
    ctx.fillStyle = bgGrad || '#080d1c'; ctx.fillRect(0, 0, W, H);
    // drifting nebula wash
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    var nb = ctx.createRadialGradient(W * (0.34 + 0.03 * Math.sin(t * 0.1)), H * 0.62, 0, W * 0.34, H * 0.62, Math.max(W, H) * 0.5);
    nb.addColorStop(0, 'rgba(60,91,208,0.10)'); nb.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = nb; ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  function drawStars(camX, camY) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      var x = s.x + camX * s.z * 1.4, y = s.y + camY * s.z * 1.4;
      var tw = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * s.sp + s.tw));
      var r = s.z * 1.3 * tw;
      ctx.globalAlpha = 0.25 + s.z * 0.55 * tw;
      ctx.fillStyle = i % 7 === 0 ? CYAN : '#cfe0ff';
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
    }
    ctx.restore();
  }

  function drawHexField(cx, cy, R) {
    ctx.save();
    ctx.strokeStyle = hexA(BLUE, 0.05); ctx.lineWidth = 1;
    var step = 46, ox = (cx % step), oy = (cy % step);
    for (var x = ox; x < W; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (var y = oy; y < H; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    // radial darken so the grid fades away from the core (cached gradient)
    if (hexFade) { ctx.fillStyle = hexFade; ctx.fillRect(0, 0, W, H); }
    ctx.restore();
  }

  function drawMotes(cx, cy, R) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    var pull = thinkEase, push = speakPulse;
    for (var i = 0; i < motes.length; i++) {
      var m = motes[i];
      var ang = m.a + t * m.sp * (0.4 + m.r * 0.5);
      var rad = R * (1.3 + m.r * 2.2);
      rad *= (1 - pull * 0.25 * (0.5 + 0.5 * Math.sin(t * 2 + m.ph)));
      rad += push * 26 * Math.sin(t * 3 + m.ph);
      var breathe = 0.5 + 0.5 * Math.sin(t * m.sp * 2 + m.ph);
      var x = cx + Math.cos(ang) * rad, y = cy + Math.sin(ang) * rad * 0.92;
      ctx.globalAlpha = 0.10 + breathe * 0.35 + levelEase * 0.2;
      ctx.fillStyle = i % 3 === 0 ? CYAN : BLUE;
      ctx.beginPath(); ctx.arc(x, y, m.s * (0.7 + breathe * 0.6), 0, 6.2832); ctx.fill();
    }
    ctx.restore();
  }

  function nodePos(cx, cy, ringR, i) {
    var a = -Math.PI / 2 + i * (6.2832 / AGENTS.length) + Math.sin(t * 0.2) * 0.015;
    var bob = Math.sin(t * 1.1 + i) * 4;
    return { x: cx + Math.cos(a) * ringR, y: cy + Math.sin(a) * ringR + bob, a: a };
  }

  function drawTethers(cx, cy, ringR) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < AGENTS.length; i++) {
      var A = AGENTS[i], st = agent[A.id], p = nodePos(cx, cy, ringR, i);
      ctx.strokeStyle = hexA(A.accent, 0.06 + st.glow * 0.22); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(p.x, p.y); ctx.stroke();
    }
    ctx.restore();
  }

  function ring(cx, cy, r, w, color, alpha, dashCount, rot, blur) {
    ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = w;
    if (dashCount) {
      var seg = 6.2832 / dashCount;
      for (var i = 0; i < dashCount; i++) { var a0 = rot + i * seg; ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + seg * 0.6); ctx.stroke(); }
    } else { ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.2832); ctx.stroke(); }
    ctx.restore();
  }

  function drawCore(cx, cy, R) {
    var pulse = 1 + levelEase * 0.42 + speakPulse * 0.16 + (listening ? 0.05 : 0);

    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    // outer halo
    var halo = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 2.4 * pulse);
    halo.addColorStop(0, 'rgba(124,156,255,0.30)'); halo.addColorStop(0.45, 'rgba(70,110,230,0.12)'); halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, R * 2.4 * pulse, 0, 6.2832); ctx.fill();

    // chromatic-aberration ghosts of the halo
    var caw = 2 + speakPulse * 3;
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = 'rgba(255,80,120,0.06)'; ctx.beginPath(); ctx.arc(cx - caw, cy, R * 1.6 * pulse, 0, 6.2832); ctx.fill();
    ctx.fillStyle = 'rgba(80,220,255,0.06)'; ctx.beginPath(); ctx.arc(cx + caw, cy, R * 1.6 * pulse, 0, 6.2832); ctx.fill();
    ctx.restore();

    // structural rings
    ring(cx, cy, R * 1.92, 1, hexA(BLUE, 0.4), 1, 72, spin * 0.4, 0);
    ring(cx, cy, R * 1.78, 2, BLUE, 0.5, 48, -spin * 0.6, 4);
    ring(cx, cy, R * 1.5, 3, CYAN, 0.55 + thinkEase * 0.3, 6, spin * 1.1, 8);
    ring(cx, cy, R * 1.24, 2, BLUE, 0.5, 3, -spin * 1.5, 6);
    ring(cx, cy, R * 1.02, 6, 'rgba(124,156,255,0.16)', 1, 0, 0, 0);
    ring(cx, cy, R * 1.02, 1.5, CYAN, 0.7, 0, 0, 10);

    // molten plasma center
    ctx.save();
    var coreR = R * 0.74 * pulse;
    ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, 6.2832); ctx.clip();
    var cg = ctx.createRadialGradient(cx, cy - coreR * 0.15, coreR * 0.08, cx, cy, coreR);
    cg.addColorStop(0, ICE); cg.addColorStop(0.32, CYAN); cg.addColorStop(0.7, BLUE); cg.addColorStop(1, 'rgba(40,70,180,0.2)');
    ctx.fillStyle = cg; ctx.fillRect(cx - coreR, cy - coreR, coreR * 2, coreR * 2);
    // turbulent blobs
    ctx.globalCompositeOperation = 'lighter';
    for (var b = 0; b < 3; b++) {
      var a = spin * (1.2 + b * 0.3) + b * 1.7;
      var br = coreR * (0.2 + 0.28 * ((b % 3) / 2));
      var bx = cx + Math.cos(a) * coreR * 0.32, by = cy + Math.sin(a * 1.3) * coreR * 0.32;
      var bg = ctx.createRadialGradient(bx, by, 0, bx, by, br);
      bg.addColorStop(0, 'rgba(234,244,255,0.5)'); bg.addColorStop(1, 'rgba(102,224,255,0)');
      ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(bx, by, br, 0, 6.2832); ctx.fill();
    }
    ctx.restore();

    // rotating iris spokes
    ctx.save(); ctx.globalAlpha = 0.55; ctx.strokeStyle = ICE; ctx.lineWidth = 1.5;
    for (var k = 0; k < 3; k++) {
      var aa = spin * 1.2 + k * 2.094;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(aa) * coreR * 0.34, cy + Math.sin(aa) * coreR * 0.34);
      ctx.lineTo(cx + Math.cos(aa) * coreR * 0.92, cy + Math.sin(aa) * coreR * 0.92); ctx.stroke();
    }
    ctx.restore();

    // bright rim
    ring(cx, cy, coreR, 1.5, ICE, 0.8, 0, 0, 12);

    // speaking shock rings
    if (mgrState === 'speaking') {
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (var s = 0; s < 2; s++) {
        var pr = ((t * 0.8 + s * 0.5) % 1);
        ctx.globalAlpha = (1 - pr) * 0.4; ctx.strokeStyle = CYAN; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, R * (1 + pr * 1.6), 0, 6.2832); ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawVoicePrint(cx, cy, R) {
    // circular audio-reactive bars just outside the core
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    var base = R * 1.06, n = spec.length;
    for (var half = 0; half < 2; half++) {
      for (var i = 0; i < n; i++) {
        var a = -Math.PI / 2 + (half ? 1 : -1) * (i / (n - 1)) * Math.PI * 0.92;
        var amp = spec[i] * R * 0.5;
        var x0 = cx + Math.cos(a) * base, y0 = cy + Math.sin(a) * base;
        var x1 = cx + Math.cos(a) * (base + amp), y1 = cy + Math.sin(a) * (base + amp);
        ctx.strokeStyle = hexA(i % 4 === 0 ? CYAN : BLUE, 0.35 + spec[i] * 0.5);
        ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawNodes(cx, cy, ringR) {
    for (var i = 0; i < AGENTS.length; i++) {
      var A = AGENTS[i], st = agent[A.id], p = nodePos(cx, cy, ringR, i);
      var glow = st.glow, busy = (st.state === 'searching' || st.state === 'working');

      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      if (glow > 0.02) {
        var hg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 40);
        hg.addColorStop(0, hexA(A.accent, 0.55 * glow)); hg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(p.x, p.y, 40, 0, 6.2832); ctx.fill();
      }
      ctx.restore();

      // rotating bracket ring
      ring(p.x, p.y, 15, 1.5, hexA(A.accent, 0.3 + glow * 0.6), 1, 4, t * (busy ? 3 : 0.6) + i, glow > 0.1 ? 6 : 0);
      // outline + dot
      ctx.strokeStyle = hexA(A.accent, 0.3 + glow * 0.6); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, 11, 0, 6.2832); ctx.stroke();
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = hexA(A.accent, 0.6 + glow * 0.4);
      ctx.beginPath(); ctx.arc(p.x, p.y, 5 + glow * 3, 0, 6.2832); ctx.fill();
      ctx.restore();
      // busy sweep
      if (busy) { ctx.strokeStyle = hexA(A.accent, 0.9); ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(p.x, p.y, 19, t * 5, t * 5 + 1.5); ctx.stroke(); }

      // labels
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillStyle = hexA(ICE, 0.55 + glow * 0.4); ctx.font = '700 11px ui-monospace, Menlo, monospace';
      ctx.fillText(A.name, p.x, p.y + 22);
      ctx.fillStyle = hexA(A.accent, 0.4 + glow * 0.4); ctx.font = '600 8px ui-monospace, Menlo, monospace';
      ctx.fillText(A.tag, p.x, p.y + 35);
    }
  }

  function drawBeams(cx, cy, ringR) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (var b = 0; b < beams.length; b++) {
      var beam = beams[b], idx = -1;
      for (var i = 0; i < AGENTS.length; i++) if (AGENTS[i].id === beam.id) idx = i;
      if (idx < 0) continue;
      var p = nodePos(cx, cy, ringR, idx), pr = beam.t / beam.dur;
      var sx = cx, sy = cy, ex = p.x, ey = p.y;
      if (beam.dir < 0) { sx = p.x; sy = p.y; ex = cx; ey = cy; }
      // curved control point (perpendicular bow)
      var mx = (sx + ex) / 2, my = (sy + ey) / 2;
      var nx = -(ey - sy), ny = (ex - sx), nl = Math.hypot(nx, ny) || 1;
      var bow = 26 * Math.sin(pr * Math.PI);
      var qx = mx + (nx / nl) * bow, qy = my + (ny / nl) * bow;
      // full faint arc
      ctx.strokeStyle = hexA(beam.color, 0.18); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo(qx, qy, ex, ey); ctx.stroke();
      // travelling head along the quadratic
      var u = pr, iu = 1 - u;
      var hx = iu * iu * sx + 2 * iu * u * qx + u * u * ex;
      var hy = iu * iu * sy + 2 * iu * u * qy + u * u * ey;
      var pg = ctx.createRadialGradient(hx, hy, 0, hx, hy, 12);
      pg.addColorStop(0, hexA(beam.color, 0.95)); pg.addColorStop(0.4, hexA(beam.color, 0.5)); pg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = pg; ctx.beginPath(); ctx.arc(hx, hy, 12, 0, 6.2832); ctx.fill();
      // sparkle trail
      for (var s = 1; s <= 4; s++) {
        var tu = clamp(u - s * 0.06, 0, 1), tiu = 1 - tu;
        var tx = tiu * tiu * sx + 2 * tiu * tu * qx + tu * tu * ex;
        var ty = tiu * tiu * sy + 2 * tiu * tu * qy + tu * tu * ey;
        ctx.globalAlpha = (1 - s / 5) * 0.5; ctx.fillStyle = beam.color;
        ctx.beginPath(); ctx.arc(tx, ty, 2.4, 0, 6.2832); ctx.fill(); ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  }

  function drawChrome(cx, cy, R) {
    // animated corner brackets w/ ticks
    ctx.strokeStyle = hexA(BLUE, 0.4); ctx.lineWidth = 2; var m = 24, L = 30;
    corner(m, m, 1, 1); corner(W - m, m, -1, 1); corner(m, H - m, 1, -1); corner(W - m, H - m, -1, -1);
    function corner(x, y, sx, sy) {
      ctx.beginPath(); ctx.moveTo(x + sx * L, y); ctx.lineTo(x, y); ctx.lineTo(x, y + sy * L); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + sx * 8, y + sy * 8); ctx.lineTo(x + sx * 16, y + sy * 8); ctx.stroke();
    }

    // side telemetry meters
    ctx.save();
    for (var s = 0; s < 5; s++) {
      var yy = H * 0.32 + s * 16, val = 0.3 + 0.5 * (0.5 + 0.5 * Math.sin(t * (1 + s * 0.4) + s));
      ctx.fillStyle = hexA(BLUE, 0.12); ctx.fillRect(m, yy, 54, 4);
      ctx.fillStyle = hexA(CYAN, 0.6); ctx.fillRect(m, yy, 54 * val, 4);
    }
    ctx.restore();

    // title + status (above the core)
    var topY = cy - R * 1.95;
    ctx.textAlign = 'center';
    ctx.fillStyle = hexA(ICE, 0.95); ctx.font = '700 16px ui-monospace, Menlo, monospace';
    ctx.fillText('A G E N T   S E A', cx, topY);
    var stt = statusText(), blink = (Math.sin(t * 3) > -0.3);
    ctx.fillStyle = stt === 'STANDING BY' ? hexA(BLUE, 0.6) : hexA(CYAN, 0.95);
    ctx.font = '600 11px ui-monospace, Menlo, monospace';
    ctx.fillText('/ / ' + stt + (blink ? ' _' : '  '), cx, topY + 20);

    // bottom baseline coordinate ticker
    ctx.textAlign = 'left'; ctx.fillStyle = hexA(BLUE, 0.4); ctx.font = '600 9px ui-monospace, Menlo, monospace';
    ctx.fillText('SEA · DIRECTOR CORE · ' + (mgrState.toUpperCase()) + ' · LVL ' + (levelEase * 100 | 0), m, H - m + 4);
  }

  function drawPost() {
    // vignette (cached gradient)
    if (vignGrad) { ctx.fillStyle = vignGrad; ctx.fillRect(0, 0, W, H); }
    // scanlines
    if (scanPat) { ctx.save(); ctx.globalAlpha = 0.5; ctx.fillStyle = scanPat; ctx.fillRect(0, 0, W, H); ctx.restore(); }
    // film grain — large tiles → only a few draws per frame
    if (noiseTiles.length) {
      ctx.save(); ctx.globalAlpha = 0.045; ctx.globalCompositeOperation = 'lighter';
      var nt = noiseTiles[(t * 20 | 0) % noiseTiles.length];
      var ox = (Math.sin(t * 40) * 30) | 0, oy = (Math.cos(t * 37) * 30) | 0;
      for (var x = ox - NOISE; x < W; x += NOISE) for (var y = oy - NOISE; y < H; y += NOISE) ctx.drawImage(nt, x, y);
      ctx.restore();
    }
    // faint flicker
    ctx.save(); ctx.globalAlpha = 0.015 + 0.015 * Math.sin(t * 30); ctx.fillStyle = CYAN; ctx.fillRect(0, 0, W, H); ctx.restore();
  }

  /* ---------- public API ---------- */
  var API = {
    init: function (el) {
      try {
        canvas = el || document.getElementById('stage'); if (!canvas) return;
        ctx = canvas.getContext('2d'); resize(); buildMotes();
        window.addEventListener('resize', resize);
        running = true; lastT = performance.now(); requestAnimationFrame(loop);
      } catch (e) { try { console.warn('[World] HUD init failed', e); } catch (_) {} }
    },
    setManager: function (state) { mgrState = (state === 'thinking' || state === 'speaking') ? state : 'idle'; },
    setAgent: function (id, state) { if (agent[id]) agent[id].state = state || 'idle'; },
    dispatch: function (id) { if (agent[id]) { lastRouted = id; beams.push({ dir: 1, id: id, t: 0, dur: 0.7, color: colorFor(id) }); } },
    deliver: function (id) { if (agent[id]) beams.push({ dir: -1, id: id, t: 0, dur: 0.7, color: colorFor(id) }); },
    speak: function (id, on) { if (id === 'manager' && on) mgrState = 'speaking'; },
    focus: function () {},
    resize: function () { resize(); },
    setLevel: function (v) { level = clamp(+v || 0, 0, 1); },
    setListening: function (b) { listening = !!b; }
  };
  function colorFor(id) { for (var i = 0; i < AGENTS.length; i++) if (AGENTS[i].id === id) return AGENTS[i].accent; return BLUE; }
  window.World = API;
})();
