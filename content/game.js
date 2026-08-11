/* ============================================================
   NEXUS — game.js · JARVIS HUD (2D canvas)
   A dark, futuristic Iron-Man-style interface for Agent Sea:
   a reactive arc-reactor core that breathes, spins while thinking,
   pulses while speaking, and reacts to your voice level. The five
   specialists are glowing nodes in a ring; delegating fires an
   energy beam from the core to that node and back.

   Implements window.World (same contract renderer.js drives):
     init, setManager, setAgent, dispatch, deliver, speak, focus, resize
   Plus setLevel(0..1) and setListening(bool) for the mic-reactive core
   (called by jarvis.js). Pure Canvas 2D — no libraries. Never throws.
   ============================================================ */
(function () {
  'use strict';

  var BLUE = '#7c9cff', CYAN = '#66e0ff', DIM = '#2b3a66';
  var AGENTS = [
    { id: 'research', name: 'SCOUT', accent: '#4f6bff' },
    { id: 'docs', name: 'QUILL', accent: '#34d399' },
    { id: 'marketing', name: 'SPARK', accent: '#f59e0b' },
    { id: 'inbox', name: 'ECHO', accent: '#ec4899' },
    { id: 'api', name: 'WIRE', accent: '#22d3ee' }
  ];

  var canvas, ctx, dpr = 1, W = 0, H = 0, running = false, t = 0, lastT = 0;
  var mgrState = 'idle';           // idle | thinking | speaking
  var listening = false;
  var level = 0, levelEase = 0;    // mic amplitude 0..1
  var speakPulse = 0;
  var agent = {};                  // id -> { state, glow }
  var beams = [];                  // { dir:1(out)|-1(back), id, t, dur, color }
  AGENTS.forEach(function (a) { agent[a.id] = { state: 'idle', glow: 0 }; });
  var lastRouted = null;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function statusText() {
    if (mgrState === 'thinking') return 'PROCESSING';
    if (mgrState === 'speaking') return 'SPEAKING';
    if (listening) return 'LISTENING';
    return 'STANDING BY';
  }

  function resize() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth || window.innerWidth; H = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.max(1, (W * dpr) | 0); canvas.height = Math.max(1, (H * dpr) | 0);
  }

  function loop(now) {
    if (!running) return;
    var dt = Math.min(0.05, (now - lastT) / 1000 || 0); lastT = now; t += dt;
    try { update(dt); render(); } catch (e) {}
    requestAnimationFrame(loop);
  }

  function update(dt) {
    levelEase += (level - levelEase) * Math.min(1, dt * 12);
    speakPulse = mgrState === 'speaking' ? (0.5 + 0.5 * Math.sin(t * 9)) : Math.max(0, speakPulse - dt * 2);
    for (var id in agent) {
      var s = agent[id];
      var on = s.state === 'assigned' || s.state === 'working' || s.state === 'searching' || s.state === 'delivering';
      s.glow += ((on ? 1 : 0) - s.glow) * Math.min(1, dt * 5);
    }
    for (var i = beams.length - 1; i >= 0; i--) { beams[i].t += dt; if (beams[i].t >= beams[i].dur) beams.splice(i, 1); }
  }

  /* ---------- render ---------- */
  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var bg = ctx.createRadialGradient(W / 2, H * 0.46, 0, W / 2, H * 0.46, Math.max(W, H) * 0.75);
    bg.addColorStop(0, '#0b1428'); bg.addColorStop(0.5, '#070b16'); bg.addColorStop(1, '#04060c');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    drawGrid();

    var cx = W / 2, cy = H * 0.46;
    var R = Math.min(W, H) * 0.15;
    var ringR = R * 2.55;
    drawBeams(cx, cy, ringR);
    drawNodes(cx, cy, ringR);
    drawCore(cx, cy, R);
    drawWaveform(cx, cy, R);
    drawChrome(cx, cy);
  }

  function drawGrid() {
    ctx.save();
    ctx.strokeStyle = 'rgba(124,156,255,0.05)'; ctx.lineWidth = 1;
    var step = 46;
    for (var x = (W / 2) % step; x < W; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (var y = (H * 0.46) % step; y < H; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    ctx.restore();
  }

  function ring(cx, cy, r, w, color, alpha, dashCount, rot) {
    ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = w;
    if (dashCount) {
      var seg = (Math.PI * 2) / dashCount;
      for (var i = 0; i < dashCount; i++) {
        var a0 = rot + i * seg, a1 = a0 + seg * 0.62;
        ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.stroke();
      }
    } else { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); }
    ctx.restore();
  }

  function drawCore(cx, cy, R) {
    var think = mgrState === 'thinking' ? 1 : 0;
    var pulse = 1 + levelEase * 0.45 + speakPulse * 0.18 + (listening ? 0.05 : 0);
    // outer glow halo
    var halo = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * (2.1 * pulse));
    halo.addColorStop(0, 'rgba(124,156,255,0.28)');
    halo.addColorStop(0.5, 'rgba(90,130,240,0.10)');
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, R * 2.1 * pulse, 0, Math.PI * 2); ctx.fill();

    // rotating tick ring
    ring(cx, cy, R * 1.75, 2, BLUE, 0.5, 48, t * 0.15);
    // segmented arcs (counter-rotating)
    ring(cx, cy, R * 1.45, 3, CYAN, 0.55 + think * 0.3, 6, -t * (0.35 + think * 0.9));
    ring(cx, cy, R * 1.2, 2, BLUE, 0.5, 3, t * (0.5 + think * 1.2));
    ring(cx, cy, R * 0.98, 6, 'rgba(124,156,255,0.18)', 1, 0, 0);

    // inner core
    var coreR = R * 0.72 * pulse;
    var cg = ctx.createRadialGradient(cx, cy - coreR * 0.15, coreR * 0.1, cx, cy, coreR);
    cg.addColorStop(0, '#eaf2ff'); cg.addColorStop(0.35, CYAN); cg.addColorStop(0.75, BLUE); cg.addColorStop(1, 'rgba(58,91,208,0.15)');
    ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.fill();
    // core spokes
    ctx.save(); ctx.globalAlpha = 0.5; ctx.strokeStyle = '#dfeaff'; ctx.lineWidth = 1.5;
    for (var k = 0; k < 3; k++) {
      var a = t * (0.4 + think) + k * (Math.PI * 2 / 3);
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * coreR * 0.35, cy + Math.sin(a) * coreR * 0.35);
      ctx.lineTo(cx + Math.cos(a) * coreR * 0.9, cy + Math.sin(a) * coreR * 0.9); ctx.stroke();
    }
    ctx.restore();

    // speaking pulse rings
    if (mgrState === 'speaking') {
      var pr = (t * 0.9) % 1;
      ctx.save(); ctx.globalAlpha = (1 - pr) * 0.5; ctx.strokeStyle = CYAN; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, R * (1 + pr * 1.4), 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }
  }

  function nodePos(cx, cy, ringR, i) {
    var a = -Math.PI / 2 + i * (Math.PI * 2 / AGENTS.length);
    return { x: cx + Math.cos(a) * ringR, y: cy + Math.sin(a) * ringR, a: a };
  }

  function drawNodes(cx, cy, ringR) {
    for (var i = 0; i < AGENTS.length; i++) {
      var A = AGENTS[i], st = agent[A.id], p = nodePos(cx, cy, ringR, i);
      var glow = st.glow;
      // halo
      if (glow > 0.02) {
        var hg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 34);
        hg.addColorStop(0, hexA(A.accent, 0.5 * glow)); hg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(p.x, p.y, 34, 0, Math.PI * 2); ctx.fill();
      }
      // ring
      ctx.strokeStyle = hexA(A.accent, 0.35 + glow * 0.6); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, 13, 0, Math.PI * 2); ctx.stroke();
      // dot
      ctx.fillStyle = hexA(A.accent, 0.4 + glow * 0.6); ctx.beginPath(); ctx.arc(p.x, p.y, 5 + glow * 2, 0, Math.PI * 2); ctx.fill();
      // busy spinner
      if (st.state === 'searching' || st.state === 'working') {
        ctx.strokeStyle = hexA(A.accent, 0.9); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p.x, p.y, 17, t * 4, t * 4 + 1.6); ctx.stroke();
      }
      // label
      ctx.fillStyle = hexA(A.accent, 0.55 + glow * 0.45); ctx.font = '600 10px -apple-system, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(A.name, p.x, p.y + 20);
    }
  }

  function drawBeams(cx, cy, ringR) {
    for (var b = 0; b < beams.length; b++) {
      var beam = beams[b], idx = -1;
      for (var i = 0; i < AGENTS.length; i++) if (AGENTS[i].id === beam.id) idx = i;
      if (idx < 0) continue;
      var p = nodePos(cx, cy, ringR, idx), pr = beam.t / beam.dur;
      var sx = cx, sy = cy, ex = p.x, ey = p.y;
      if (beam.dir < 0) { sx = p.x; sy = p.y; ex = cx; ey = cy; }
      // line
      ctx.strokeStyle = hexA(beam.color, 0.25); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
      // moving pulse
      var mx = sx + (ex - sx) * pr, my = sy + (ey - sy) * pr;
      var pg = ctx.createRadialGradient(mx, my, 0, mx, my, 10);
      pg.addColorStop(0, hexA(beam.color, 0.95)); pg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = pg; ctx.beginPath(); ctx.arc(mx, my, 10, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawWaveform(cx, cy, R) {
    var n = 40, bw = 3, gap = 4, total = n * (bw + gap);
    var x0 = cx - total / 2, y = cy + R * 2.9;
    ctx.fillStyle = hexA(BLUE, 0.7);
    for (var i = 0; i < n; i++) {
      var d = Math.abs(i - n / 2) / (n / 2);
      var base = (mgrState === 'speaking') ? (0.4 + 0.6 * Math.abs(Math.sin(t * 8 + i * 0.5))) : levelEase;
      var h = 2 + base * 26 * (1 - d * 0.6) * (0.5 + 0.5 * Math.sin(t * 6 + i));
      ctx.fillRect(x0 + i * (bw + gap), y - h / 2, bw, Math.max(2, h));
    }
  }

  function drawChrome(cx, cy) {
    // corner brackets
    ctx.strokeStyle = hexA(BLUE, 0.35); ctx.lineWidth = 2; var m = 22, L = 26;
    corner(m, m, 1, 1); corner(W - m, m, -1, 1); corner(m, H - m, 1, -1); corner(W - m, H - m, -1, -1);
    function corner(x, y, sx, sy) {
      ctx.beginPath(); ctx.moveTo(x + sx * L, y); ctx.lineTo(x, y); ctx.lineTo(x, y + sy * L); ctx.stroke();
    }
    // title + status
    ctx.textAlign = 'center';
    ctx.fillStyle = hexA(CYAN, 0.9); ctx.font = '700 15px -apple-system, sans-serif';
    ctx.fillText('A G E N T   S E A', cx, cy - Math.min(W, H) * 0.15 - 44);
    var st = statusText();
    ctx.fillStyle = st === 'STANDING BY' ? hexA(BLUE, 0.55) : hexA(CYAN, 0.95);
    ctx.font = '600 11px -apple-system, sans-serif';
    ctx.fillText('/ / ' + st, cx, cy - Math.min(W, H) * 0.15 - 26);
  }

  function hexA(hex, a) {
    hex = (hex || '#7c9cff').replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    var n = parseInt(hex, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* ---------- public API ---------- */
  var API = {
    init: function (el) {
      try {
        canvas = el || document.getElementById('stage'); if (!canvas) return;
        ctx = canvas.getContext('2d'); resize();
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
