/* ============================================================
   NEXUS — game.js  ·  "Sunlit Atrium"
   The entire real-time isometric office world, drawn 100%
   procedurally on HTML5 Canvas 2D. Vanilla JS, no libraries,
   no assets, no fonts. Defines window.World, the scene API
   that renderer.js drives.

   One Director (Nova) at the head desk, five specialists in a
   shallow horseshoe. Warm oak room, precious light, dormant
   accents that ignite only when an agent is working.

   Public API (never throws on bad input):
     World.init(canvasEl)
     World.setManager('idle'|'thinking'|'speaking')
     World.setAgent(agentId, 'idle'|'assigned'|'working'|
                             'searching'|'delivering'|'done')
     World.dispatch(agentId)   // task orb  Nova -> agent
     World.deliver(agentId)    // result orb agent -> Nova
     World.speak(agentId, on)  // mouth + soundwaves
     World.focus(agentId|null) // gentle camera emphasis
     World.resize()
   ============================================================ */
(function () {
  'use strict';

  /* ==========================================================
     1. ISOMETRIC CONSTANTS  (§1 of the spec)
     ========================================================== */
  var TILE_W = 64, TILE_H = 32, HALF_W = 32, HALF_H = 16, TILE_Z = 40;
  var ROOM_W = 10, ROOM_D = 8;      // floor spans x[0..10], y[0..8]
  var WALL_H = 2.15;                 // low back walls (world height units)

  var DONE_DUR = 0.85;              // seconds for the "done" beat
  var ORB_DUR  = 0.6;              // task/result orb travel time
  var PART_CAP = 60;               // hard live-particle ceiling

  /* ==========================================================
     2. AGENTS  (fixed ids, names, tiles, accents — never remap)
     ========================================================== */
  var AGENTS = {
    manager:   { name: 'Nova',  tile: [5.0, 2.0], z: 0.30, accent: '#7c9cff', prop: 'none' },
    research:  { name: 'Scout', tile: [2.0, 3.5], z: 0.00, accent: '#4f6bff', prop: 'magnifier' },
    inbox:     { name: 'Echo',  tile: [8.0, 3.5], z: 0.00, accent: '#ec4899', prop: 'envelope' },
    docs:      { name: 'Quill', tile: [2.8, 6.0], z: 0.00, accent: '#34d399', prop: 'document' },
    marketing: { name: 'Spark', tile: [7.2, 6.0], z: 0.00, accent: '#f59e0b', prop: 'megaphone' },
    api:       { name: 'Wire',  tile: [5.0, 6.6], z: 0.00, accent: '#22d3ee', prop: 'plug' }
  };
  var IDS = ['manager', 'research', 'inbox', 'docs', 'marketing', 'api'];
  var SPECIALISTS = ['research', 'inbox', 'docs', 'marketing', 'api'];
  var AGENT_STATES = {
    idle: 1, assigned: 1, working: 1, searching: 1, delivering: 1, done: 1
  };

  /* ==========================================================
     3. PALETTES  (§2)  — light & dark. Accents + light core are
     identical across themes so agent identity always reads.
     ========================================================== */
  var PAL_LIGHT = {
    bgTop: '#F2E9D8', bgBot: '#E7DAC2',
    floorTop0: '#F0DEB8', floorTop1: '#E4CFA6',
    floorChecker: '#E0C99E', seam: '#D3B98A', floorWarm: '#F5E6C4',
    floorLeft: '#D8BE93', floorRight: '#CDB183',
    wallWin: '#E2D4BC', wallPlain: '#ECE1CD',
    baseboard: '#B08A5E',
    lightCore: '#FFF4D8', lightMid: '#FFE9B8',
    shadow: '#7C6A50', contact: '#C9A878',
    textP: '#3A322A', textS: '#6B5E4C',
    pane: '#DCE9F5', wood: '#B08A5E', paper: '#FFF8EC',
    deskTop: '#D8B98A', deskLeft: '#CDB183', deskRight: '#C2A472',
    chair: '#B89A6E', monitorDark: '#2A2A30', mug: '#C7A98B',
    leaf1: '#7E9B6E', leaf2: '#6C8A5E', pot: '#B98A63',
    rugSage: '#A9B79A', rugClay: '#C7A98B', cork: '#C9A876',
    pill: '#FFFBF2'
  };
  var PAL_DARK = {
    bgTop: '#241F18', bgBot: '#1C1813',
    floorTop0: '#94835F', floorTop1: '#8A7A5C',
    floorChecker: '#82724F', seam: '#6E6248', floorWarm: '#9C8A62',
    floorLeft: '#7C6E52', floorRight: '#6E6248',
    wallWin: '#332C22', wallPlain: '#3A3228',
    baseboard: '#6E573C',
    lightCore: '#FFF4D8', lightMid: '#FFE9B8',
    shadow: '#000000', contact: '#4A3A24',
    textP: '#E8DFCE', textS: '#B7A98F',
    pane: '#2A3646', wood: '#6E573C', paper: '#CFC4AE',
    deskTop: '#6E603F', deskLeft: '#635737', deskRight: '#574C30',
    chair: '#5E5136', monitorDark: '#15151A', mug: '#6E5C46',
    leaf1: '#4E6349', leaf2: '#425640', pot: '#5E4632',
    rugSage: '#5E6B54', rugClay: '#6E5C46', cork: '#5A4A32',
    pill: '#2A251D'
  };

  /* ==========================================================
     4. UTILITIES
     ========================================================== */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function hexToRgb(h) {
    h = (h || '#000').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function toRgb(c) { return typeof c === 'string' ? hexToRgb(c) : c; }
  function rgba(c, a) {
    var o = toRgb(c);
    return 'rgba(' + (o.r | 0) + ',' + (o.g | 0) + ',' + (o.b | 0) + ',' + a + ')';
  }
  function mix(c1, c2, t) {
    var a = toRgb(c1), b = toRgb(c2);
    return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) };
  }
  function lighten(c, t) { return mix(c, { r: 255, g: 255, b: 255 }, t); }
  function darken(c, t) { return mix(c, { r: 0, g: 0, b: 0 }, t); }
  function mulC(c, f) { var o = toRgb(c); return { r: o.r * f, g: o.g * f, b: o.b * f }; }
  function desatC(c, amt) {
    var o = toRgb(c), l = 0.30 * o.r + 0.59 * o.g + 0.11 * o.b;
    return { r: lerp(o.r, l, amt), g: lerp(o.g, l, amt), b: lerp(o.b, l, amt) };
  }

  // Cubic-bezier timing solver -> function(x)->y (y may overshoot >1).
  function cubicBezier(x1, y1, x2, y2) {
    function A(a, b) { return 1 - 3 * b + 3 * a; }
    function B(a, b) { return 3 * b - 6 * a; }
    function C(a) { return 3 * a; }
    function calc(t, a, b) { return ((A(a, b) * t + B(a, b)) * t + C(a)) * t; }
    function slope(t, a, b) { return 3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a); }
    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      var t = x, i, d, cx;
      for (i = 0; i < 6; i++) {
        cx = calc(t, x1, x2) - x;
        d = slope(t, x1, x2);
        if (Math.abs(d) < 1e-6) break;
        t = clamp(t - cx / d, 0, 1);
      }
      return calc(t, y1, y2);
    };
  }
  var easeOrb = cubicBezier(0.34, 1.2, 0.64, 1);   // task/result pop
  var easeStd = cubicBezier(0.4, 0, 0.2, 1);
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

  // Critically-damped-ish spring (interruptible, retargetable).
  function spring(x, k, d) { return { x: x, v: 0, t: x, k: k || 180, d: d || 26 }; }
  function stepSpring(s, dt) {
    // sub-step for stability if dt spikes
    var steps = dt > 0.02 ? Math.ceil(dt / 0.016) : 1, h = dt / steps, i, a;
    for (i = 0; i < steps; i++) {
      a = s.k * (s.t - s.x) - s.d * s.v;
      s.v += a * h;
      s.x += s.v * h;
    }
  }

  /* ==========================================================
     5. WORLD STATE
     ========================================================== */
  var canvas = null, ctx = null, PAL = PAL_LIGHT;
  var dpr = 1, cssW = 0, cssH = 0;
  var originX = 0, originY = 0, zoom = 1, baseZoom = 1;
  var running = false, started = false;
  var lastTS = 0, time = 0, bootT = 0;
  var reduced = false, dark = false;

  var camX = spring(0), camY = spring(0), camZ = spring(1, 150, 24);
  var effCamX = 0, effCamY = 0;
  var focusId = null, activeAgent = null;

  var mgr = { state: 'idle', speaking: false, halo: spring(0.22), think: 0, speakPh: 0, sonarT: 0, pop: spring(0, 220, 13), tilt: 0 };
  var RT = {};                 // per-agent runtime
  var LAY = {};                // per-agent tile layout
  var orbs = [], parts = [], motes = [], shafts = [];

  /* ---- per-agent runtime ---- */
  function makeRT() {
    return {
      state: 'idle', prev: 'idle',
      rim: spring(0.2), lamp: spring(0), mon: spring(0), lean: spring(0),
      desat: spring(0), lift: spring(0), arm: spring(0),
      pop: spring(1, 220, 13), bounce: spring(0, 210, 12),
      breath: Math.random() * Math.PI * 2,
      blinkNext: 2.5 + Math.random() * 3.5, blinkT: 0,
      work: Math.random() * Math.PI * 2,
      propPh: Math.random() * Math.PI * 2,
      gaze: { x: 0, y: 0 }, gazeT: { x: 0, y: 0 },
      doneT: -1,
      ping: 0,                 // assigned "!" ping timer (counts down)
      thoughtT: 0, glyphT: 0, steamT: Math.random(),
      speaking: false, mouthPh: 0,
      lastDeliver: -1, leanSign: 0
    };
  }

  /* ==========================================================
     6. LAYOUT  — tile positions for every desk cluster piece
     ========================================================== */
  function buildLayout() {
    var novaTile = AGENTS.manager.tile;
    for (var i = 0; i < IDS.length; i++) {
      var id = IDS[i], A = AGENTS[id], tx = A.tile[0], ty = A.tile[1];
      var L;
      if (id === 'manager') {
        // Nova faces the room (camera / +y). Desk sits in FRONT of her.
        L = {
          anchor: { wx: tx, wy: ty, z: A.z },
          bean:   { wx: tx, wy: ty - 0.55, z: A.z },
          chair:  { wx: tx, wy: ty - 0.95, z: A.z },
          desk:   { wx: tx, wy: ty + 0.05, z: A.z },
          mon:    { wx: tx, wy: ty + 0.02, z: A.z },
          mug:    { wx: tx + 0.42, wy: ty - 0.05, z: A.z },
          lamp:   { wx: tx - 0.5, wy: ty + 0.05, z: A.z }
        };
      } else {
        // Specialists face the camera; monitor sits on the desk between
        // bean and camera so we see both the glowing screen and the face.
        L = {
          anchor: { wx: tx, wy: ty, z: 0 },
          bean:   { wx: tx, wy: ty - 0.55, z: 0 },
          chair:  { wx: tx, wy: ty - 0.95, z: 0 },
          desk:   { wx: tx, wy: ty, z: 0 },
          mon:    { wx: tx, wy: ty + 0.18, z: 0 },
          mug:    { wx: tx + 0.34, wy: ty + 0.05, z: 0 },
          lamp:   { wx: tx - 0.42, wy: ty + 0.05, z: 0 }
        };
      }
      // lean sign: tilt toward Nova horizontally when assigned
      var novaScreenX = (novaTile[0] - novaTile[1]);
      var meScreenX = (tx - ty);
      L.leanSign = Math.sign(novaScreenX - meScreenX) || 0;
      LAY[id] = L;
      RT[id] = makeRT();
      RT[id].leanSign = L.leanSign;
    }
  }

  function beanTile(id) { return LAY[id] ? LAY[id].bean : { wx: 5, wy: 4, z: 0 }; }
  function chestOf(id) { var b = beanTile(id); return { wx: b.wx, wy: b.wy, wz: b.z + 0.55 }; }

  /* ==========================================================
     7. ISOMETRIC PROJECTION
     ========================================================== */
  function iso(wx, wy, wz) {
    wz = wz || 0;
    return {
      x: originX + (wx - wy) * HALF_W * zoom + effCamX,
      y: originY + (wx + wy) * HALF_H * zoom - wz * TILE_Z * zoom + effCamY
    };
  }
  // screen position at a given zoom WITHOUT camera offset (for focus math)
  function isoNoCam(wx, wy, wz, z) {
    return {
      x: originX + (wx - wy) * HALF_W * z,
      y: originY + (wx + wy) * HALF_H * z - (wz || 0) * TILE_Z * z
    };
  }

  /* ==========================================================
     8. CANVAS SETUP / RESIZE / CAMERA FIT  (§8)
     ========================================================== */
  function readEnv() {
    try { dark = document.documentElement.classList.contains('dark') ||
      (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch (e) { dark = false; }
    try { reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e2) { reduced = false; }
    PAL = dark ? PAL_DARK : PAL_LIGHT;
  }

  function resize() {
    if (!canvas || !ctx) return;
    cssW = canvas.clientWidth || (canvas.parentNode && canvas.parentNode.clientWidth) || window.innerWidth || 1024;
    cssH = canvas.clientHeight || (canvas.parentNode && canvas.parentNode.clientHeight) || window.innerHeight || 768;
    dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    // room screen extent @ zoom 1
    var roomW = (ROOM_W + ROOM_D) * HALF_W;                 // 576
    var roomH = (ROOM_W + ROOM_D) * HALF_H + WALL_H * TILE_Z; // 288 + 86
    baseZoom = Math.min(cssW / roomW, cssH / roomH) * 0.86;
    baseZoom = clamp(baseZoom, 0.2, 4);
    if (!started) { zoom = baseZoom; camZ.x = baseZoom; camZ.t = baseZoom; }
    else if (!focusId) { camZ.t = baseZoom; }
    else { camZ.t = baseZoom * 1.12; }
    centerRoom(zoom);
    buildShafts();
    seedMotes();
  }

  // Center the room bounds, nudged slightly up so the horseshoe reads.
  function centerRoom(z) {
    // room screen-space center (rel, before origin) with camX/Y = 0
    // x center at (min+max)/2 => (-256 + 320)/2 = 32 ; y center ≈ 100
    originX = cssW / 2 - 32 * z;
    originY = cssH / 2 - 100 * z - Math.min(cssH * 0.03, 46);
  }

  function updateCamera(dt) {
    // zoom first, then re-center so the room stays framed as it scales
    stepSpring(camZ, dt);
    zoom = camZ.x;
    centerRoom(zoom);

    if (focusId && LAY[focusId]) {
      var a = LAY[focusId].anchor;
      var d = isoNoCam(a.wx, a.wy, a.z, zoom);
      camX.t = cssW / 2 - d.x;
      camY.t = cssH * 0.48 - d.y;
      camZ.t = baseZoom * 1.12;
    } else {
      camX.t = 0; camY.t = 0; camZ.t = baseZoom;
    }
    stepSpring(camX, dt);
    stepSpring(camY, dt);

    var px = 0, py = 0;
    if (!reduced) {
      var p = time * (Math.PI * 2 / 30);
      px = 3 * Math.sin(p);
      py = 2 * Math.sin(p * 1.3 + 1);
    }
    effCamX = camX.x + px;
    effCamY = camY.x + py;
  }

  /* ==========================================================
     9. STATE MACHINE  (setAgent / setManager / speak / focus)
     ========================================================== */
  function applyAgentState(id, st) {
    var rt = RT[id]; if (!rt) return;
    var L = LAY[id];
    if (st === 'idle') {
      rt.rim.t = 0.2; rt.lamp.t = 0; rt.mon.t = 0; rt.lean.t = 0; rt.arm.t = 0;
      if (activeAgent === id) activeAgent = null;
    } else if (st === 'assigned') {
      rt.rim.t = 1; rt.lamp.t = 1; rt.mon.t = 0.18; rt.arm.t = 0;
      rt.lean.t = rt.leanSign * 0.11;
      rt.pop.x = 0.86; rt.pop.v = 0;      // anticipation -> springy pop
      rt.ping = 0.9;
      activeAgent = id;
    } else if (st === 'working' || st === 'searching') {
      rt.rim.t = 1; rt.lamp.t = 1; rt.mon.t = 1; rt.arm.t = 1;
      rt.lean.t = rt.leanSign * 0.05;
      activeAgent = id;
    } else if (st === 'delivering') {
      rt.rim.t = 1; rt.lamp.t = 1; rt.mon.t = 0.6; rt.arm.t = 0.6;
      rt.lean.t = 0;                        // straighten for hand-off
      activeAgent = id;
      deliver(id);                          // auto-fly result (debounced)
    } else if (st === 'done') {
      rt.rim.t = 1; rt.lamp.t = 0.4; rt.mon.t = 0.3; rt.lean.t = 0; rt.arm.t = 0;
      rt.doneT = 0;
      rt.bounce.x = 0; rt.bounce.v = -7.5;  // double-bounce impulse
      spawnSparkles(id);
      if (activeAgent === id) activeAgent = null;
    }
  }

  function setAgent(id, st) {
    var rt = RT[id];
    if (!rt) return;                        // unknown agent -> ignore
    if (!AGENT_STATES[st]) return;          // unknown state -> ignore
    rt.prev = rt.state; rt.state = st;
    applyAgentState(id, st);
  }

  function setManager(st) {
    if (st !== 'idle' && st !== 'thinking' && st !== 'speaking') return;
    var prev = mgr.state; mgr.state = st;
    var rt = RT.manager;
    if (st === 'thinking') {
      mgr.halo.t = 0.85; mgr.think = 0;
    } else if (st === 'speaking') {
      mgr.halo.t = 1; mgr.speakPh = 0; mgr.sonarT = 0;
      spawnSonar();                         // one 3-ring warm ripple on start
      mgr.pop.x = 0; mgr.pop.v = 0;
    } else { // idle
      mgr.halo.t = 0.22; mgr.speaking = false;
      if (rt) rt.speaking = false;
      if (prev === 'speaking') resetAgentsDormant();
    }
  }

  function resetAgentsDormant() {
    for (var i = 0; i < SPECIALISTS.length; i++) {
      var id = SPECIALISTS[i], rt = RT[id];
      if (!rt) continue;
      if (rt.state !== 'done') { rt.state = 'idle'; applyAgentState(id, 'idle'); }
    }
    activeAgent = null;
  }

  function speak(id, on) {
    var rt = RT[id]; if (!rt) return;
    rt.speaking = !!on;
    if (on) rt.mouthPh = 0;
    if (id === 'manager') { mgr.speaking = !!on; if (on) mgr.speakPh = 0; }
  }

  function focus(id) {
    focusId = (id && LAY[id]) ? id : null;
  }

  /* ==========================================================
     10. ORBS  (§7)  — dispatch / deliver share one pool
     ========================================================== */
  function spawnOrb(type, accent, from, to, agentId) {
    var ctrl = {
      wx: (from.wx + to.wx) / 2,
      wy: (from.wy + to.wy) / 2,
      wz: Math.max(from.wz, to.wz) + 1.35
    };
    orbs.push({
      type: type, accent: accent, from: from, to: to, ctrl: ctrl,
      t: 0, dur: reduced ? 0.12 : ORB_DUR, agentId: agentId
    });
  }

  function dispatch(id) {
    var A = AGENTS[id]; if (!A || id === 'manager') return;
    spawnOrb('dispatch', A.accent, chestOf('manager'), chestOf(id), id);
    // ensure the receiving desk lights up even if setAgent lags
    var rt = RT[id]; if (rt) { rt.rim.t = 1; }
  }

  function deliver(id) {
    var A = AGENTS[id], rt = RT[id];
    if (!A || !rt || id === 'manager') return;
    if (time - rt.lastDeliver < 0.28) return;   // debounce dual-trigger
    rt.lastDeliver = time;
    spawnOrb('deliver', A.accent, chestOf(id), chestOf('manager'), id);
  }

  function quad(p0, pc, p1, t) {
    var u = 1 - t;
    return {
      x: u * u * p0.x + 2 * u * t * pc.x + t * t * p1.x,
      y: u * u * p0.y + 2 * u * t * pc.y + t * t * p1.y
    };
  }
  function quadW(p0, pc, p1, t, key) {
    var u = 1 - t;
    return u * u * p0[key] + 2 * u * t * pc[key] + t * t * p1[key];
  }

  function updateOrbs(dt) {
    for (var i = orbs.length - 1; i >= 0; i--) {
      var o = orbs[i];
      o.t += dt / o.dur;
      var e = easeOrb(clamp(o.t, 0, 1));
      // trail motes
      if (!reduced && o.t < 1 && parts.length < PART_CAP) {
        var wx = quadW(o.from, o.ctrl, o.to, e, 'wx');
        var wy = quadW(o.from, o.ctrl, o.to, e, 'wy');
        var wz = quadW(o.from, o.ctrl, o.to, e, 'wz');
        parts.push({ type: 'trail', wx: wx, wy: wy, wz: wz, accent: o.accent, life: 0, max: 0.34, r: 2.2 + Math.random() * 1.5 });
      }
      if (o.t >= 1) {
        onOrbArrive(o);
        orbs.splice(i, 1);
      }
    }
  }

  function onOrbArrive(o) {
    if (o.type === 'dispatch') {
      var rt = RT[o.agentId];
      if (rt) {
        rt.rim.t = 1;
        rt.pop.x = 0.9; rt.pop.v = 0;            // eager hop absorb
      }
      parts.push({ type: 'ring', wx: o.to.wx, wy: o.to.wy, wz: o.to.wz, accent: o.accent, life: 0, max: 0.16 });
    } else { // deliver -> absorbed into Nova's halo
      mgr.halo.x = Math.min(1.2, mgr.halo.x + 0.28);
      mgr.pop.x = -0.35; mgr.pop.v = 0;          // small catch squash
      parts.push({ type: 'ring', wx: o.to.wx, wy: o.to.wy, wz: o.to.wz, accent: '#FFF4D8', life: 0, max: 0.18 });
    }
  }

  /* ==========================================================
     11. PARTICLES  (§6)
     ========================================================== */
  function spawnSparkles(id) {
    var b = beanTile(id), A = AGENTS[id], n = reduced ? 3 : 5, i;
    for (i = 0; i < n; i++) {
      if (parts.length >= PART_CAP) break;
      parts.push({
        type: 'sparkle', accent: A.accent, life: 0, max: 0.55 + Math.random() * 0.25,
        wx: b.wx + (Math.random() - 0.5) * 0.7, wy: b.wy + (Math.random() - 0.5) * 0.4,
        wz: 1.1 + Math.random() * 0.5, vz: 0.9 + Math.random() * 0.6,
        rot: Math.random() * Math.PI, sz: 3 + Math.random() * 2.5
      });
    }
    parts.push({ type: 'check', accent: A.accent, life: 0, max: 0.9, wx: b.wx, wy: b.wy, wz: 1.35 });
  }
  function spawnSonar() {
    var c = chestOf('manager');
    parts.push({ type: 'sonar', wx: c.wx, wy: c.wy, wz: c.wz - 0.1, life: 0, max: 0.9 });
  }

  var GLYPHS = ['{ }', '</>', '01', ';;', '#', 'λ', '()', '==', '*'];

  function updateParts(dt) {
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.life += dt;
      if (p.type === 'sparkle' || p.type === 'thought' || p.type === 'glyph') {
        p.wz += (p.vz || 0.8) * dt;
      }
      if (p.life >= p.max) parts.splice(i, 1);
    }
    // spawn working thought-dots + code glyphs above active props
    for (var s = 0; s < SPECIALISTS.length; s++) {
      var id = SPECIALISTS[s], rt = RT[id];
      if (!rt) continue;
      var working = (rt.state === 'working' || rt.state === 'searching');
      if (!working) continue;
      rt.thoughtT -= dt; rt.glyphT -= dt;
      var b = beanTile(id), A = AGENTS[id];
      if (rt.thoughtT <= 0 && parts.length < PART_CAP) {
        rt.thoughtT = 1.0 + Math.random() * 0.6;
        parts.push({ type: 'thought', accent: A.accent, life: 0, max: 0.9, wx: b.wx + 0.35, wy: b.wy - 0.1, wz: b.z + 1.15, vz: 0.7, r: 2.2 });
      }
      if (rt.glyphT <= 0 && parts.length < PART_CAP) {
        rt.glyphT = 0.5 + Math.random() * 0.5;
        parts.push({ type: 'glyph', accent: A.accent, life: 0, max: 1.2, wx: b.wx + (Math.random() - 0.5) * 0.5, wy: b.wy - 0.15, wz: b.z + 1.3, vz: 0.9, ch: GLYPHS[(Math.random() * GLYPHS.length) | 0] });
      }
    }
  }

  /* ---- dust motes: always-on specks inside sun shafts (§6.1) ---- */
  function seedMotes() {
    motes.length = 0;
    if (!shafts.length) return;
    var count = reduced ? 10 : 20, i;
    for (i = 0; i < count; i++) motes.push(newMote());
  }
  function newMote() {
    var sh = shafts[(Math.random() * shafts.length) | 0] || shafts[0];
    return {
      sh: sh, u: Math.random(), v: Math.random(),
      ph: Math.random() * Math.PI * 2, sp: 0.02 + Math.random() * 0.05,
      r: 0.5 + Math.random() * 1.0
    };
  }
  function updateMotes(dt) {
    if (reduced) dt *= 0.6;
    for (var i = 0; i < motes.length; i++) {
      var m = motes[i];
      m.v -= m.sp * dt;               // rise toward the window
      m.u += Math.sin(time * 0.3 + m.ph) * 0.02 * dt;
      m.ph += dt;
      if (m.v < -0.05) { motes[i] = newMote(); motes[i].v = 1.05; }
    }
  }

  /* ==========================================================
     12. SUN SHAFTS  (built from window footprints)
     ========================================================== */
  var WINDOWS = [ { x0: 1.3, x1: 3.9 }, { x0: 6.1, x1: 8.7 } ];  // along y=0 wall
  function buildShafts() {
    shafts.length = 0;
    for (var i = 0; i < WINDOWS.length; i++) {
      var w = WINDOWS[i];
      // parallelogram on the floor from the window drifting toward +y, +x
      shafts.push({
        // world corners: [nearWindow-left, nearWindow-right, far-right, far-left]
        p: [
          { wx: w.x0, wy: 0.05 }, { wx: w.x1, wy: 0.05 },
          { wx: w.x1 + 1.5, wy: 5.6 }, { wx: w.x0 + 1.5, wy: 5.6 }
        ]
      });
    }
  }
  // bilinear point inside a shaft quad, in world coords
  function shaftPoint(sh, u, v) {
    var p = sh.p;
    var ax = lerp(p[0].wx, p[1].wx, u), ay = lerp(p[0].wy, p[1].wy, u);
    var bx = lerp(p[3].wx, p[2].wx, u), by = lerp(p[3].wy, p[2].wy, u);
    return { wx: lerp(ax, bx, v), wy: lerp(ay, by, v) };
  }

  /* ==========================================================
     13. LOW-LEVEL DRAW HELPERS
     ========================================================== */
  function poly(pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }
  function fillPoly(pts, color, a) { poly(pts); ctx.fillStyle = (a == null && typeof color === 'string') ? color : rgba(color, a == null ? 1 : a); ctx.fill(); }
  function col(c, a) { return (a == null && typeof c === 'string') ? c : rgba(c, a == null ? 1 : a); }

  function roundRect(x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function superPath(cx, cy, a, b, n) {
    var steps = 44, i, t, ct, st, x, y;
    ctx.beginPath();
    for (i = 0; i <= steps; i++) {
      t = i / steps * Math.PI * 2;
      ct = Math.cos(t); st = Math.sin(t);
      x = cx + Math.sign(ct) * Math.pow(Math.abs(ct), 2 / n) * a;
      y = cy + Math.sign(st) * Math.pow(Math.abs(st), 2 / n) * b;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  // Iso box (rounded-ish prism): top + right(+x) + left(+y) faces.
  function isoBox(cx, cy, zb, hw, hd, hz, topC, leftC, rightC) {
    var tp = function (x, y) { return iso(x, y, zb + hz); };
    var bt = function (x, y) { return iso(x, y, zb); };
    // right face (x = cx+hw)
    fillPoly([tp(cx + hw, cy - hd), tp(cx + hw, cy + hd), bt(cx + hw, cy + hd), bt(cx + hw, cy - hd)], rightC);
    // left face (y = cy+hd)
    fillPoly([tp(cx - hw, cy + hd), tp(cx + hw, cy + hd), bt(cx + hw, cy + hd), bt(cx - hw, cy + hd)], leftC);
    // top
    fillPoly([tp(cx - hw, cy - hd), tp(cx + hw, cy - hd), tp(cx + hw, cy + hd), tp(cx - hw, cy + hd)], topC);
  }

  function contactShadow(sx, sy, w, h, alpha) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.translate(sx, sy);
    var g = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(w, h) / 2);
    g.addColorStop(0, rgba(PAL.contact, alpha));
    g.addColorStop(0.7, rgba(PAL.contact, alpha * 0.7));
    g.addColorStop(1, rgba(PAL.contact, 0));
    ctx.scale(1, h / w);
    ctx.beginPath(); ctx.arc(0, 0, w / 2, 0, Math.PI * 2);
    ctx.fillStyle = g; ctx.fill();
    ctx.restore();
  }

  /* ==========================================================
     14. FLOOR + WALLS + WINDOWS  (§4)
     ========================================================== */
  function drawFloor() {
    var a = iso(0, 0, 0), b = iso(ROOM_W, 0, 0), c = iso(ROOM_W, ROOM_D, 0), d = iso(0, ROOM_D, 0);
    var g = ctx.createLinearGradient(0, a.y, 0, c.y);
    g.addColorStop(0, col(PAL.floorTop0));
    g.addColorStop(1, col(PAL.floorTop1));
    poly([a, b, c, d]); ctx.fillStyle = g; ctx.fill();

    // 4% checker on alternating tiles
    ctx.fillStyle = rgba(PAL.floorChecker, 0.5);
    for (var x = 0; x < ROOM_W; x++) {
      for (var y = 0; y < ROOM_D; y++) {
        if ((x + y) & 1) {
          poly([iso(x, y), iso(x + 1, y), iso(x + 1, y + 1), iso(x, y + 1)]);
          ctx.fill();
        }
      }
    }
    // soft plank seams
    ctx.strokeStyle = rgba(PAL.seam, dark ? 0.35 : 0.45);
    ctx.lineWidth = 1;
    for (var i = 0; i <= ROOM_W; i++) { var p1 = iso(i, 0), p2 = iso(i, ROOM_D); line(p1, p2); }
    for (var j = 0; j <= ROOM_D; j++) { var q1 = iso(0, j), q2 = iso(ROOM_W, j); line(q1, q2); }
  }
  function line(p1, p2) {
    ctx.beginPath();
    ctx.moveTo(Math.round(p1.x) + 0.5, Math.round(p1.y) + 0.5);
    ctx.lineTo(Math.round(p2.x) + 0.5, Math.round(p2.y) + 0.5);
    ctx.stroke();
  }

  function drawSunShafts() {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    var drift = Math.sin(time * (Math.PI * 2 / 20)) * 2;      // ±2px over 20s
    var breathe = 0.5 + 0.5 * Math.sin(time * 0.5);
    for (var i = 0; i < shafts.length; i++) {
      var sh = shafts[i], p = sh.p;
      var s0 = iso(p[0].wx, p[0].wy), s1 = iso(p[1].wx, p[1].wy),
          s2 = iso(p[2].wx, p[2].wy), s3 = iso(p[3].wx, p[3].wy);
      // gradient from window (bright) to far end (transparent)
      var gx0 = (s0.x + s1.x) / 2, gy0 = (s0.y + s1.y) / 2;
      var gx1 = (s2.x + s3.x) / 2, gy1 = (s2.y + s3.y) / 2;
      var g = ctx.createLinearGradient(gx0 + drift, gy0, gx1 + drift, gy1);
      var top = (0.16 + breathe * 0.06);
      g.addColorStop(0, rgba(PAL.lightCore, top));
      g.addColorStop(0.5, rgba(PAL.lightMid, top * 0.5));
      g.addColorStop(1, rgba(PAL.lightMid, 0));
      ctx.save(); ctx.translate(drift, 0);
      poly([s0, s1, s2, s3]); ctx.fillStyle = g; ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  function drawDust() {
    if (!motes.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < motes.length; i++) {
      var m = motes[i];
      if (m.v < 0 || m.v > 1) continue;
      var w = shaftPoint(m.sh, m.u, m.v);
      var s = iso(w.wx, w.wy, 0.15 + (1 - m.v) * 0.9);   // lift into the beam
      var tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(m.ph * 2));
      var a = tw * 0.5 * (1 - Math.abs(m.v - 0.5) * 0.7);
      ctx.beginPath();
      ctx.arc(s.x, s.y, m.r * zoom, 0, Math.PI * 2);
      ctx.fillStyle = rgba(PAL.lightCore, a);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawWalls() {
    // window wall (y = 0), plain wall (x = 0). Faces rise in +z.
    drawWall('y', 0, ROOM_W, PAL.wallWin, true);
    drawWall('x', 0, ROOM_D, PAL.wallPlain, false);
  }
  function drawWall(axis, a0, a1, color, isWindow) {
    var tp, bt;
    if (axis === 'y') { // along +x at y=0
      tp = function (t) { return iso(t, 0, WALL_H); };
      bt = function (t) { return iso(t, 0, 0); };
    } else {            // along +y at x=0
      tp = function (t) { return iso(0, t, WALL_H); };
      bt = function (t) { return iso(0, t, 0); };
    }
    var A = tp(a0), B = tp(a1), C = bt(a1), D = bt(a0);
    var g = ctx.createLinearGradient(0, A.y, 0, C.y);
    g.addColorStop(0, col(lighten(color, dark ? 0.04 : 0.05)));
    g.addColorStop(1, col(darken(color, 0.06)));
    poly([A, B, C, D]); ctx.fillStyle = g; ctx.fill();

    // baseboard
    var bbH = 0.14;
    var b1 = (axis === 'y') ? iso(a0, 0, bbH) : iso(0, a0, bbH);
    var b2 = (axis === 'y') ? iso(a1, 0, bbH) : iso(0, a1, bbH);
    poly([b1, b2, C, D]); ctx.fillStyle = col(PAL.baseboard); ctx.fill();

    // top edge highlight
    ctx.strokeStyle = rgba(lighten(color, 0.18), 0.5); ctx.lineWidth = 1;
    line(A, B);

    if (isWindow) drawWindows();
    else drawPlainWallDecor();
  }

  function drawWindows() {
    var z0 = 0.55, z1 = 1.75;
    for (var i = 0; i < WINDOWS.length; i++) {
      var w = WINDOWS[i];
      var pad = 0.12;
      // frame
      wallQuadY(w.x0 - pad, w.x1 + pad, z0 - pad, z1 + pad, PAL.wood, null);
      // pane (cool wash) with soft glow
      var A = iso(w.x0, 0, z1), B = iso(w.x1, 0, z1), C = iso(w.x1, 0, z0), D = iso(w.x0, 0, z0);
      var g = ctx.createLinearGradient(0, A.y, 0, C.y);
      g.addColorStop(0, col(lighten(PAL.pane, 0.10)));
      g.addColorStop(1, col(PAL.pane));
      poly([A, B, C, D]); ctx.fillStyle = g; ctx.fill();
      // additive sky glow
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      poly([A, B, C, D]); ctx.fillStyle = rgba(PAL.lightCore, 0.10); ctx.fill();
      ctx.restore();
      // mullions
      ctx.strokeStyle = rgba(PAL.wood, 0.9); ctx.lineWidth = 1.5;
      var mx, mz;
      for (mx = 1; mx < 3; mx++) {
        var t = w.x0 + (w.x1 - w.x0) * (mx / 3);
        line(iso(t, 0, z0), iso(t, 0, z1));
      }
      for (mz = 1; mz < 2; mz++) {
        var tz = z0 + (z1 - z0) * (mz / 2);
        line(iso(w.x0, 0, tz), iso(w.x1, 0, tz));
      }
    }
  }
  function wallQuadY(x0, x1, z0, z1, fill) {
    var A = iso(x0, 0, z1), B = iso(x1, 0, z1), C = iso(x1, 0, z0), D = iso(x0, 0, z0);
    poly([A, B, C, D]); ctx.fillStyle = col(fill); ctx.fill();
  }
  function wallQuadX(y0, y1, z0, z1, fill) {
    var A = iso(0, y0, z1), B = iso(0, y1, z1), C = iso(0, y1, z0), D = iso(0, y0, z0);
    poly([A, B, C, D]); ctx.fillStyle = col(fill); ctx.fill();
  }

  function drawPlainWallDecor() {
    // cork pinboard
    wallQuadX(4.2, 6.2, 0.85, 1.7, PAL.cork);
    ctx.strokeStyle = rgba(PAL.wood, 0.8); ctx.lineWidth = 1.5;
    poly([iso(0, 4.2, 1.7), iso(0, 6.2, 1.7), iso(0, 6.2, 0.85), iso(0, 4.2, 0.85)]); ctx.stroke();
    var notes = ['#EAD7B0', '#D9C7E0', '#CFE0D2', '#E7C9B8'];
    for (var i = 0; i < 4; i++) {
      var yy = 4.45 + i * 0.42, zz = 1.45 - (i % 2) * 0.35;
      var s = iso(0, yy, zz);
      ctx.save(); ctx.translate(s.x, s.y); ctx.rotate((i % 2 ? 1 : -1) * 0.04);
      roundRect(-8 * zoom, -8 * zoom, 16 * zoom, 14 * zoom, 2);
      ctx.fillStyle = col(notes[i]); ctx.fill();
      ctx.fillStyle = rgba('#B04A3A', 0.7);
      ctx.beginPath(); ctx.arc(0, -6 * zoom, 1.4 * zoom, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    // shelf + succulent
    wallQuadX(2.0, 2.9, 1.15, 1.22, PAL.wood);
    drawSucculent(iso(0, 2.45, 1.4));
    // wall clock (tracks real time)
    drawClock(iso(0, 6.9, 1.35));
  }

  function drawSucculent(s) {
    ctx.save(); ctx.translate(s.x, s.y);
    var r = zoom;
    // small pot
    ctx.fillStyle = col(PAL.pot);
    roundRect(-5 * r, -2 * r, 10 * r, 8 * r, 2 * r); ctx.fill();
    // rosette leaves
    var n = 7, i;
    for (i = 0; i < n; i++) {
      var ang = -Math.PI / 2 + (i - n / 2) * 0.5 + Math.sin(time * 0.6 + i) * 0.03;
      ctx.save(); ctx.translate(0, -2 * r); ctx.rotate(ang);
      ctx.fillStyle = col(i % 2 ? PAL.leaf1 : PAL.leaf2);
      ctx.beginPath();
      ctx.ellipse(0, -5 * r, 2.2 * r, 5.5 * r, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  function drawClock(s) {
    ctx.save(); ctx.translate(s.x, s.y);
    var R = 13 * zoom;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.fillStyle = col(PAL.paper); ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = col(PAL.wood); ctx.stroke();
    // ticks
    ctx.strokeStyle = rgba(PAL.textS, 0.6); ctx.lineWidth = 1;
    for (var i = 0; i < 12; i++) {
      var a = i / 12 * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * R * 0.82, Math.sin(a) * R * 0.82);
      ctx.lineTo(Math.cos(a) * R * 0.92, Math.sin(a) * R * 0.92);
      ctx.stroke();
    }
    var now = new Date();
    var sec = now.getSeconds() + now.getMilliseconds() / 1000;
    var min = now.getMinutes() + sec / 60;
    var hr = (now.getHours() % 12) + min / 60;
    hand(hr / 12 * Math.PI * 2 - Math.PI / 2, R * 0.5, 2, PAL.textP);
    hand(min / 60 * Math.PI * 2 - Math.PI / 2, R * 0.75, 1.5, PAL.textP);
    hand(sec / 60 * Math.PI * 2 - Math.PI / 2, R * 0.82, 0.8, AGENTS.manager.accent);
    ctx.beginPath(); ctx.arc(0, 0, 1.6 * zoom, 0, Math.PI * 2); ctx.fillStyle = col(PAL.textP); ctx.fill();
    ctx.restore();
    function hand(ang, len, w, c) {
      ctx.beginPath(); ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(ang) * len, Math.sin(ang) * len);
      ctx.lineWidth = w; ctx.strokeStyle = col(c); ctx.lineCap = 'round'; ctx.stroke();
    }
  }

  /* ==========================================================
     15. MONSTERA, DAIS+RUG, CUSHION
     ========================================================== */
  function drawMonstera() {
    var base = iso(0.7, 1.2, 0);
    contactShadow(base.x + 4 * zoom, base.y + 3 * zoom, 42 * zoom, 16 * zoom, 0.2);
    // pot
    isoBox(0.7, 1.2, 0, 0.28, 0.28, 0.42, PAL.pot, darken(PAL.pot, 0.1), darken(PAL.pot, 0.16));
    ctx.save(); ctx.translate(base.x, base.y - 12 * zoom);
    var sway = Math.sin(time * 0.6) * 0.05;
    // stems + big leaves
    var leaves = [
      { a: -1.9, l: 46, s: 1.0 }, { a: -1.2, l: 54, s: 1.15 },
      { a: -0.55, l: 44, s: 0.95 }, { a: -2.5, l: 40, s: 0.9 },
      { a: -1.55, l: 60, s: 1.25 }
    ];
    for (var i = 0; i < leaves.length; i++) {
      var lf = leaves[i];
      var ang = lf.a + sway * (1 + i * 0.15) + Math.sin(time * 0.5 + i) * 0.03;
      var ex = Math.cos(ang) * lf.l * lf.s * zoom;
      var ey = Math.sin(ang) * lf.l * lf.s * zoom;
      // stem
      ctx.strokeStyle = col(PAL.leaf2); ctx.lineWidth = 2 * zoom; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(ex * 0.4, ey * 0.5, ex, ey); ctx.stroke();
      // leaf
      ctx.save(); ctx.translate(ex, ey); ctx.rotate(ang + Math.PI / 2);
      var g = ctx.createLinearGradient(0, -18 * zoom, 0, 6 * zoom);
      g.addColorStop(0, col(lighten(PAL.leaf1, 0.08)));
      g.addColorStop(1, col(PAL.leaf2));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(0, -6 * lf.s * zoom, 10 * lf.s * zoom, 16 * lf.s * zoom, 0, 0, Math.PI * 2);
      ctx.fill();
      // split-leaf notches + midrib
      ctx.strokeStyle = rgba(darken(PAL.leaf2, 0.15), 0.6); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, 6 * zoom); ctx.lineTo(0, -20 * lf.s * zoom); ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  function drawDaisAndRug() {
    var A = AGENTS.manager, cx = A.tile[0], cy = A.tile[1];
    // raised oak dais (1 tile, z 0..0.3)
    isoBox(cx, cy, 0, 1.15, 1.05, 0.3, PAL.deskTop, PAL.floorLeft, PAL.floorRight);
    // woven rug on top of the dais
    var z = 0.3, rw = 0.95, rd = 0.85;
    var r0 = iso(cx - rw, cy - rd, z), r1 = iso(cx + rw, cy - rd, z),
        r2 = iso(cx + rw, cy + rd, z), r3 = iso(cx - rw, cy + rd, z);
    poly([r0, r1, r2, r3]);
    ctx.fillStyle = col(mix(PAL.rugSage, PAL.rugClay, 0.5), 0.9); ctx.fill();
    // weave dashes
    ctx.save(); poly([r0, r1, r2, r3]); ctx.clip();
    ctx.lineWidth = 1;
    for (var g = -2; g <= 2; g += 0.28) {
      ctx.strokeStyle = rgba(PAL.rugSage, 0.5);
      line(iso(cx + g, cy - rd, z), iso(cx + g, cy + rd, z));
      ctx.strokeStyle = rgba(PAL.rugClay, 0.4);
      line(iso(cx - rw, cy + g * 0.9, z), iso(cx + rw, cy + g * 0.9, z));
    }
    ctx.restore();
    // Nova-blue piping
    ctx.strokeStyle = rgba(A.accent, 0.55); ctx.lineWidth = 1.5;
    poly([r0, r1, r2, r3]); ctx.stroke();
    // brass director ring on the floor around the dais
    drawIsoRing(cx, cy, 1.55, 1.4, mix(PAL.wood, '#D8B98A', 0.5), 2.2);
  }

  function drawIsoRing(cx, cy, rx, ry, color, w) {
    ctx.save();
    var s = iso(cx, cy, 0);
    ctx.translate(s.x, s.y);
    ctx.scale(1, HALF_H / HALF_W);
    ctx.beginPath();
    ctx.arc(0, 0, rx * HALF_W * zoom, 0, Math.PI * 2);
    ctx.lineWidth = w * zoom;
    ctx.strokeStyle = col(color, 0.8);
    ctx.stroke();
    ctx.restore();
  }

  function drawCushion() {
    var s = iso(9.1, 7.1, 0);
    contactShadow(s.x + 3 * zoom, s.y + 3 * zoom, 40 * zoom, 15 * zoom, 0.18);
    ctx.save(); ctx.translate(s.x, s.y - 5 * zoom);
    ctx.scale(1, 0.6);
    superPath(0, 0, 20 * zoom, 18 * zoom, 3.2);
    var g = ctx.createRadialGradient(-5 * zoom, -5 * zoom, 2, 0, 0, 22 * zoom);
    g.addColorStop(0, col(lighten(PAL.rugClay, 0.12)));
    g.addColorStop(1, col(darken(PAL.rugClay, 0.06)));
    ctx.fillStyle = g; ctx.fill();
    ctx.restore();
    // tuft
    ctx.beginPath(); ctx.arc(s.x, s.y - 6 * zoom, 2 * zoom, 0, Math.PI * 2);
    ctx.fillStyle = col(darken(PAL.rugClay, 0.15)); ctx.fill();
  }

  /* ==========================================================
     16. DESK CLUSTER
     ========================================================== */
  function drawCluster(id) {
    var A = AGENTS[id], rt = RT[id], L = LAY[id];
    if (id === 'manager') { drawNovaCluster(); return; }

    // lamp floor pool (additive)
    if (rt.lamp.x > 0.01) drawLampPool(L.lamp, rt.lamp.x);

    // desk shadow
    var dsc = iso(L.desk.wx, L.desk.wy + 0.15, 0);
    contactShadow(dsc.x, dsc.y, 108 * zoom, 40 * zoom, 0.2);

    // chair behind bean
    drawChair(L.chair);

    // desk prism
    var accent = A.accent, rimA = clamp((rt.rim.x - 0.2) / 0.8, 0, 1);
    drawDesk(L.desk, accent, 0.25 + rimA * 0.75);

    // lamp arm, mug, resting prop
    drawLamp(L.lamp, rt.lamp.x);
    drawMug(L.mug);
    if (rt.state !== 'working' && rt.state !== 'searching') drawRestProp(id, L.mug);

    // steam from mug
    drawSteam(L.mug, rt);

    // bean (contact shadow + body + held prop)
    drawBean(id);

    // monitor slab (in front of bean, screen faces camera)
    drawMonitor(id);

    // assigned "!" ping above head
    if (rt.ping > 0) drawPing(id, rt.ping);
  }

  function drawNovaCluster() {
    var A = AGENTS.manager, rt = RT.manager, L = LAY.manager;
    // desk shadow on the dais
    var dsc = iso(L.desk.wx, L.desk.wy + 0.15, A.z);
    contactShadow(dsc.x, dsc.y, 120 * zoom, 44 * zoom, 0.18);
    drawChair(L.chair);
    // halo behind head
    drawHalo();
    // Nova bean
    drawBean('manager');
    // round head-desk in FRONT of her
    drawRoundDesk(L.desk, A.accent);
    drawMug(L.mug);
    drawSteam(L.mug, rt);
    // thinking thought-bubble
    if (mgr.state === 'thinking') drawThoughtBubble();
  }

  function drawChair(t) {
    // low stool seat + short rounded backrest
    isoBox(t.wx, t.wy, t.z, 0.34, 0.3, 0.42, PAL.chair, darken(PAL.chair, 0.08), darken(PAL.chair, 0.14));
    var s = iso(t.wx, t.wy - 0.2, t.z + 0.42);
    ctx.save(); ctx.translate(s.x, s.y);
    roundRect(-15 * zoom, -26 * zoom, 30 * zoom, 30 * zoom, 8 * zoom);
    ctx.fillStyle = col(darken(PAL.chair, 0.05)); ctx.fill();
    ctx.restore();
  }

  function drawDesk(t, accent, inlayA) {
    isoBox(t.wx, t.wy, t.z, 0.75, 0.42, 0.5, PAL.deskTop, PAL.deskLeft, PAL.deskRight);
    // 3px front edge for thickness
    var fl = iso(t.wx - 0.75, t.wy + 0.42, t.z + 0.5), fr = iso(t.wx + 0.75, t.wy + 0.42, t.z + 0.5);
    ctx.strokeStyle = rgba(darken(PAL.deskRight, 0.12), 0.7); ctx.lineWidth = 2; line(fl, fr);
    // accent inlay along the top-front edge
    var ia = iso(t.wx - 0.72, t.wy + 0.4, t.z + 0.5), ib = iso(t.wx + 0.72, t.wy + 0.4, t.z + 0.5);
    ctx.strokeStyle = rgba(accent, inlayA); ctx.lineWidth = 1.5; line(ia, ib);
  }

  function drawRoundDesk(t, accent) {
    var s = iso(t.wx, t.wy, t.z);
    var rx = 0.95 * HALF_W * zoom, ry = rx * (HALF_H / HALF_W);
    // side (thickness) = a shifted-down ellipse
    ctx.beginPath(); ctx.ellipse(s.x, s.y + 8 * zoom, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = col(PAL.deskRight); ctx.fill();
    // top
    var g = ctx.createRadialGradient(s.x - rx * 0.3, s.y - ry * 0.3, 2, s.x, s.y, rx);
    g.addColorStop(0, col(lighten(PAL.deskTop, 0.06)));
    g.addColorStop(1, col(PAL.deskTop));
    ctx.beginPath(); ctx.ellipse(s.x, s.y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = g; ctx.fill();
    ctx.lineWidth = 1.5 * zoom; ctx.strokeStyle = rgba(accent, 0.35); ctx.stroke();
    // small director console glow line
    var c = iso(t.wx, t.wy - 0.1, t.z);
    ctx.strokeStyle = rgba(accent, 0.4 + 0.2 * Math.sin(time * 3)); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(c.x - 10 * zoom, c.y); ctx.lineTo(c.x + 10 * zoom, c.y); ctx.stroke();
  }

  function drawLampPool(t, k) {
    var s = iso(t.wx, t.wy + 0.3, 0);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    var g = ctx.createRadialGradient(s.x, s.y, 2, s.x, s.y, 60 * zoom);
    g.addColorStop(0, rgba(PAL.lightCore, 0.4 * k));
    g.addColorStop(1, rgba(PAL.lightCore, 0));
    ctx.fillStyle = g;
    ctx.save(); ctx.translate(s.x, s.y); ctx.scale(1, 0.5);
    ctx.beginPath(); ctx.arc(0, 0, 60 * zoom, 0, Math.PI * 2); ctx.fill();
    ctx.restore(); ctx.restore();
  }

  function drawLamp(t, k) {
    var base = iso(t.wx, t.wy, t.z + 0.5);
    ctx.save(); ctx.translate(base.x, base.y);
    ctx.strokeStyle = col(PAL.wood); ctx.lineWidth = 2.4 * zoom; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(0, -22 * zoom); ctx.lineTo(11 * zoom, -30 * zoom);
    ctx.stroke();
    // head
    ctx.beginPath();
    ctx.ellipse(12 * zoom, -30 * zoom, 5 * zoom, 3.5 * zoom, -0.5, 0, Math.PI * 2);
    ctx.fillStyle = col(PAL.wood); ctx.fill();
    if (k > 0.02) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.beginPath(); ctx.arc(12 * zoom, -28 * zoom, 4 * zoom, 0, Math.PI * 2);
      ctx.fillStyle = rgba(PAL.lightCore, 0.8 * k); ctx.fill();
    }
    ctx.restore();
  }

  function drawMug(t) {
    var s = iso(t.wx, t.wy, t.z + 0.5);
    ctx.save(); ctx.translate(s.x, s.y);
    roundRect(-4 * zoom, -9 * zoom, 8 * zoom, 9 * zoom, 2 * zoom);
    ctx.fillStyle = col(PAL.mug); ctx.fill();
    ctx.beginPath();
    ctx.ellipse(0, -9 * zoom, 4 * zoom, 1.6 * zoom, 0, 0, Math.PI * 2);
    ctx.fillStyle = col(darken(PAL.mug, 0.18)); ctx.fill();
    // handle
    ctx.beginPath(); ctx.arc(5 * zoom, -5 * zoom, 2.4 * zoom, -1.2, 1.2);
    ctx.lineWidth = 1.4 * zoom; ctx.strokeStyle = col(PAL.mug); ctx.stroke();
    ctx.restore();
  }

  function drawSteam(t, rt) {
    var s = iso(t.wx, t.wy, t.z + 0.5);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(s.x, s.y - 10 * zoom);
    for (var i = 0; i < 2; i++) {
      var ph = time * 1.2 + i * 2 + rt.steamT * 6;
      ctx.beginPath();
      for (var y = 0; y <= 14; y += 2) {
        var wob = Math.sin(ph - y * 0.35) * (2 + y * 0.18) * zoom;
        var xx = (i ? 2 : -2) * zoom + wob;
        if (y === 0) ctx.moveTo(xx, -y * zoom); else ctx.lineTo(xx, -y * zoom);
      }
      var a = 0.10 * (0.6 + 0.4 * Math.sin(ph));
      ctx.strokeStyle = rgba(PAL.lightCore, a);
      ctx.lineWidth = 2.5 * zoom; ctx.lineCap = 'round'; ctx.stroke();
    }
    ctx.restore();
  }

  /* ---- monitor (base + camera-facing screen slab) ---- */
  function drawMonitor(id) {
    var A = AGENTS[id], rt = RT[id], L = LAY[id];
    var base = iso(L.mon.wx, L.mon.wy, L.mon.z + 0.5);
    // neck (kept short so the bean's visor clears the screen top)
    ctx.save(); ctx.translate(base.x, base.y);
    ctx.fillStyle = col(darken(PAL.deskRight, 0.2));
    roundRect(-3 * zoom, -6 * zoom, 6 * zoom, 6 * zoom, 1.5 * zoom); ctx.fill();
    // screen slab
    var sw = 38 * zoom, sh = 17 * zoom, sy = -6 * zoom;
    roundRect(-sw / 2, sy - sh, sw, sh, 4 * zoom);
    ctx.fillStyle = col(darken(PAL.deskRight, 0.35)); ctx.fill();       // bezel
    var inset = 3 * zoom;
    var glow = rt.mon.x;
    // idle subtle flicker + working glow
    var flick = 0.5 + 0.5 * Math.sin(time * 13 + id.length) + 0.3 * Math.sin(time * 37);
    var screenGlow = glow > 0.05 ? glow * (0.75 + 0.25 * clamp(flick, 0, 1)) : 0.04 * clamp(flick, 0, 1);
    roundRect(-sw / 2 + inset, sy - sh + inset, sw - inset * 2, sh - inset * 2, 3 * zoom);
    ctx.fillStyle = col(PAL.monitorDark); ctx.fill();
    if (screenGlow > 0.001) {
      ctx.save();
      roundRect(-sw / 2 + inset, sy - sh + inset, sw - inset * 2, sh - inset * 2, 3 * zoom);
      ctx.clip();
      var g = ctx.createRadialGradient(0, sy - sh / 2, 2, 0, sy - sh / 2, sw * 0.6);
      g.addColorStop(0, rgba(A.accent, clamp(screenGlow, 0, 1)));
      g.addColorStop(1, rgba(A.accent, 0));
      ctx.fillStyle = g;
      ctx.fillRect(-sw / 2, sy - sh, sw, sh);
      // faint code lines
      ctx.strokeStyle = rgba(lighten(A.accent, 0.4), 0.25 * screenGlow); ctx.lineWidth = 1;
      for (var ln = 0; ln < 4; ln++) {
        var yy = sy - sh + 8 * zoom + ln * 5 * zoom;
        ctx.beginPath();
        ctx.moveTo(-sw / 2 + 6 * zoom, yy);
        ctx.lineTo(-sw / 2 + (10 + ((Math.sin(time * 2 + ln + id.length) * 0.5 + 0.5) * 24)) * zoom, yy);
        ctx.stroke();
      }
      ctx.restore();
      // progress arc sweeping bottom edge when working
      if (rt.state === 'working' || rt.state === 'searching') {
        var pr = (time * 0.5) % 1;
        ctx.strokeStyle = rgba(lighten(A.accent, 0.3), 0.8); ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(-sw / 2 + inset, sy - inset);
        ctx.lineTo(-sw / 2 + inset + (sw - inset * 2) * pr, sy - inset);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* ==========================================================
     17. CHARACTERS (jellybean / Among-Us)  (§3, §5)
     ========================================================== */
  function drawBean(id) {
    var A = AGENTS[id], rt = RT[id], L = LAY[id];
    var isNova = id === 'manager';
    var base = iso(L.bean.wx, L.bean.wy, L.bean.z);
    var charScale = isNova ? 1.12 : 1.0;

    // dim/desaturate when another agent is focused
    var desat = rt.desat.x, dim = (focusId && focusId !== id) ? 0.9 : 1.0;
    var lift = rt.lift.x * zoom;

    // breathing + bobs
    var breath = reduced ? 0 : Math.sin(rt.breath) * 0.02;
    var bob = reduced ? 0 : Math.sin(rt.breath) * 0.5;
    var workBob = 0, workLean = 0;
    if (rt.state === 'working' || rt.state === 'searching') {
      workBob = Math.sin(rt.work * 2) * 1.4;
      workLean = Math.sin(rt.work * 2) * 0.03;
    }
    var novaBob = 0;
    if (isNova) {
      if (mgr.state === 'speaking') novaBob = Math.sin(mgr.speakPh * 9) * 1.2;
      if (mgr.state === 'thinking') novaBob = Math.sin(time * 1.4) * 0.6;
    }
    var bounce = rt.bounce.x;              // done double-bounce (negative = up)
    var pop = rt.pop.x;                    // squash/stretch (target 1)
    if (isNova) pop = 1 + mgr.pop.x;       // Nova catch squash uses mgr.pop

    var feetY = base.y - (bob + workBob + novaBob) * zoom + bounce * zoom - lift;
    var feetX = base.x;

    // ---- contact shadow (grows on lift / squash) ----
    var shW = 34 * charScale * zoom * (1.05 + (rt.lift.x > 0 ? 0.15 : 0)) * (2 - pop);
    contactShadow(feetX + 6 * zoom, base.y + 2 * zoom, shW, shW * 0.32, 0.22 + (rt.lift.x > 0 ? 0.06 : 0));

    // ---- lean angle ----
    var lean = rt.lean.x + workLean;
    if (isNova && mgr.state === 'thinking') lean = Math.sin(time * 1.0) * 0.05;

    var S = zoom * charScale;
    var sy = pop, sx = 1 / Math.sqrt(Math.max(0.3, pop));

    ctx.save();
    ctx.translate(feetX, feetY);
    ctx.rotate(lean);
    ctx.scale(S * sx, S * sy * (1 + breath));

    // body color (dormant = desaturated variant, but keep hue)
    var bodyBase = desat > 0 ? desatC(A.accent, desat * 0.5) : A.accent;
    if (dim < 1) bodyBase = mulC(bodyBase, dim);

    drawBeanBody(id, rt, bodyBase, A.accent, isNova);

    ctx.restore();

    // ---- held prop beside hand (working/searching only) ----
    if (!isNova && (rt.state === 'working' || rt.state === 'searching')) {
      var hand = { x: feetX + 22 * S * sx, y: feetY - 30 * S };
      drawProp(A.prop, hand.x, hand.y, S, A.accent, true, rt, id);
    }

    // Nova antenna bead + speaking soundwaves handled via halo/particles
  }

  function drawBeanBody(id, rt, bodyBase, accent, isNova) {
    // proportions (local units, feet at 0,0, body rises in -y)
    var a = 17, b = 23, legH = 7;
    var bodyCy = -(legH + b);

    // ---- legs ----
    ctx.fillStyle = col(darken(bodyBase, 0.12));
    roundRect(-8, -legH, 6.5, legH + 2, 3); ctx.fill();
    roundRect(1.5, -legH, 6.5, legH + 2, 3); ctx.fill();

    // ---- backpack nub (shaded lower-right) ----
    ctx.fillStyle = col(darken(bodyBase, 0.16));
    ctx.beginPath();
    ctx.ellipse(a * 0.72, bodyCy + 8, 6, 9, -0.2, 0, Math.PI * 2); ctx.fill();

    // ---- body capsule ----
    superPath(0, bodyCy, a, b, 4);
    var g = ctx.createLinearGradient(0, bodyCy - b, 0, bodyCy + b);
    g.addColorStop(0, col(lighten(bodyBase, 0.08)));
    g.addColorStop(0.5, col(bodyBase));
    g.addColorStop(1, col(darken(bodyBase, 0.06)));
    ctx.fillStyle = g; ctx.fill();

    // belly band (molded plastic look) ~14% down
    ctx.save(); superPath(0, bodyCy, a, b, 4); ctx.clip();
    var bandY = bodyCy - b + 0.14 * (2 * b);
    ctx.fillStyle = rgba(mulC(bodyBase, 0.86), 0.5);
    ctx.fillRect(-a, bandY, 2 * a, 3.4);
    ctx.restore();

    // rim light on shaded lower-right
    ctx.save(); superPath(0, bodyCy, a, b, 4); ctx.clip();
    ctx.strokeStyle = rgba(mulC(bodyBase, 0.7), 0.9); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(3, bodyCy + 2, a - 1, -0.4, 1.7); ctx.stroke();
    ctx.restore();

    // ---- accent rim (the "I'm live" signal): 20% -> 100% ----
    superPath(0, bodyCy, a, b, 4);
    ctx.lineWidth = 1.5; ctx.strokeStyle = rgba(accent, clamp(rt.rim.x, 0, 1)); ctx.stroke();

    // ---- arms (extend during action) ----
    var armT = rt.arm.x;
    if (armT > 0.02) {
      ctx.fillStyle = col(darken(bodyBase, 0.1));
      var typing = 0;
      if (rt.state === 'working' || rt.state === 'searching') typing = Math.abs(Math.sin(rt.work * 6)) * 3;
      // right arm reaching toward the (camera-side) monitor / keyboard
      ctx.save(); ctx.translate(a * 0.6, bodyCy + 4); ctx.rotate(0.6 * armT);
      roundRect(0, -3, 4 + 10 * armT, 6, 3); ctx.fill();
      // hand bob
      ctx.beginPath(); ctx.arc(4 + 10 * armT, typing, 3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      // left arm
      ctx.save(); ctx.translate(-a * 0.6, bodyCy + 4); ctx.rotate(-0.6 * armT);
      roundRect(-4 - 10 * armT, -3, 4 + 10 * armT, 6, 3); ctx.fill();
      ctx.beginPath(); ctx.arc(-4 - 10 * armT, -typing, 3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // ---- visor eye ----
    drawVisor(id, rt, bodyCy, isNova);

    // ---- blush (active only) ----
    var active = rt.rim.x > 0.6;
    if (active) {
      ctx.fillStyle = rgba(accent, 0.10 * clamp((rt.rim.x - 0.6) / 0.4, 0, 1));
      ctx.beginPath(); ctx.ellipse(-11, bodyCy + 1, 4, 3, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(11, bodyCy + 1, 4, 3, 0, 0, Math.PI * 2); ctx.fill();
    }

    // ---- mouth (speaking) ----
    var speaking = rt.speaking && (!isNova || mgr.speaking);
    if (speaking) {
      var open = 0.5 + 0.5 * Math.sin((isNova ? mgr.speakPh : rt.mouthPh) * 12);
      ctx.fillStyle = col('#2A2018');
      ctx.beginPath();
      ctx.ellipse(0, bodyCy + 8, 3.2, 1.2 + open * 2.6, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // ---- Nova signature: antenna bead ----
    if (isNova) {
      ctx.strokeStyle = col(PAL.wood); ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(0, bodyCy - b); ctx.lineTo(0, bodyCy - b - 7); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, bodyCy - b - 8.5, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = col(lighten(accent, 0.1)); ctx.fill();
    }
  }

  function drawVisor(id, rt, bodyCy, isNova) {
    var vw = 18, vh = 9, vy = bodyCy - 6;
    // pale visor
    roundRect(-vw / 2, vy - vh / 2, vw, vh, vh / 2);
    ctx.fillStyle = col('#EAF6FF'); ctx.fill();
    // inner shade
    ctx.save();
    roundRect(-vw / 2, vy - vh / 2, vw, vh, vh / 2); ctx.clip();
    var vg = ctx.createLinearGradient(0, vy - vh / 2, 0, vy + vh / 2);
    vg.addColorStop(0, rgba('#FFFFFF', 0.6));
    vg.addColorStop(1, rgba('#BCDAF0', 0));
    ctx.fillStyle = vg; ctx.fillRect(-vw / 2, vy - vh / 2, vw, vh);

    // pupil (with gaze offset + blink squash)
    var blink = rt.blinkT > 0 ? clamp(rt.blinkT / 0.06, 0, 1) : 0;   // 1 mid-blink
    var closed = rt.blinkT > 0 ? Math.sin((1 - Math.abs(rt.blinkT / 0.06 - 0.5) * 2) * Math.PI / 2) : 0;
    var gx = rt.gaze.x, gy = rt.gaze.y;
    var ph = 1 - closed;   // pupil height factor
    ctx.fillStyle = col('#20304F');
    ctx.beginPath();
    ctx.ellipse(gx, vy + gy, 3.6, 3.4 * Math.max(0.08, ph), 0, 0, Math.PI * 2);
    ctx.fill();
    // specular sliver
    if (ph > 0.4) {
      ctx.fillStyle = rgba('#FFFFFF', 0.9 * ph);
      ctx.beginPath(); ctx.ellipse(gx - 1.4, vy + gy - 1.2, 1.1, 1.1, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    // visor outline
    roundRect(-vw / 2, vy - vh / 2, vw, vh, vh / 2);
    ctx.lineWidth = 1; ctx.strokeStyle = rgba('#20304F', 0.15); ctx.stroke();
  }

  /* ---- props ---- */
  function drawProp(kind, x, y, S, accent, lit, rt, id) {
    ctx.save();
    ctx.translate(x, y);
    var alpha = lit ? 1 : 0.4;
    var glow = lit && rt && (rt.state === 'working' || rt.state === 'searching');
    if (glow) {
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.beginPath(); ctx.arc(0, 0, 10 * S, 0, Math.PI * 2);
      ctx.fillStyle = rgba(accent, 0.18); ctx.fill(); ctx.restore();
    }
    ctx.lineWidth = 1.6 * S;
    ctx.strokeStyle = rgba(accent, alpha);
    ctx.fillStyle = rgba(accent, alpha);
    if (kind === 'magnifier') {
      var sweep = rt ? Math.sin(rt.propPh * 2) * 0.4 : 0;
      ctx.save(); ctx.rotate(sweep);
      // light cone when searching
      if (rt && rt.state === 'searching') {
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.beginPath(); ctx.moveTo(0, 6 * S);
        ctx.lineTo(-9 * S, 22 * S); ctx.lineTo(9 * S, 22 * S); ctx.closePath();
        ctx.fillStyle = rgba(accent, 0.12); ctx.fill(); ctx.restore();
      }
      ctx.beginPath(); ctx.arc(0, 0, 5 * S, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = col(PAL.wood, alpha); ctx.lineWidth = 2.2 * S;
      ctx.beginPath(); ctx.moveTo(3.5 * S, 3.5 * S); ctx.lineTo(9 * S, 9 * S); ctx.stroke();
      ctx.restore();
    } else if (kind === 'document') {
      ctx.fillStyle = rgba(PAL.paper, alpha);
      roundRect(-6 * S, -8 * S, 12 * S, 16 * S, 1.5 * S); ctx.fill();
      ctx.strokeStyle = rgba(accent, alpha * 0.5); ctx.lineWidth = 1 * S;
      for (var i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(-4 * S, (-4 + i * 3.5) * S); ctx.lineTo(4 * S, (-4 + i * 3.5) * S); ctx.stroke(); }
      // pen nib
      var tap = rt && (rt.state === 'working') ? Math.abs(Math.sin(rt.propPh * 5)) * 2 * S : 0;
      ctx.strokeStyle = rgba(accent, alpha); ctx.lineWidth = 2 * S;
      ctx.beginPath(); ctx.moveTo(7 * S, -6 * S); ctx.lineTo(4 * S, 2 * S + tap); ctx.stroke();
    } else if (kind === 'megaphone') {
      ctx.beginPath();
      ctx.moveTo(-2 * S, -5 * S); ctx.lineTo(8 * S, -9 * S);
      ctx.lineTo(8 * S, 9 * S); ctx.lineTo(-2 * S, 5 * S); ctx.closePath();
      ctx.fill();
      ctx.fillStyle = rgba(PAL.paper, alpha);
      roundRect(-6 * S, -4 * S, 5 * S, 8 * S, 1.5 * S); ctx.fill();
      if (glow) {
        ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = rgba(accent, 0.5);
        for (var w = 0; w < 2; w++) { var rr = (10 + w * 5 + (time * 20) % 6) * S; ctx.beginPath(); ctx.arc(9 * S, 0, rr, -0.6, 0.6); ctx.stroke(); }
        ctx.restore();
      }
    } else if (kind === 'envelope') {
      ctx.fillStyle = rgba(PAL.paper, alpha);
      roundRect(-8 * S, -6 * S, 16 * S, 12 * S, 1.5 * S); ctx.fill();
      ctx.strokeStyle = rgba(accent, alpha); ctx.lineWidth = 1.5 * S;
      roundRect(-8 * S, -6 * S, 16 * S, 12 * S, 1.5 * S); ctx.stroke();
      var flut = rt && rt.state === 'working' ? Math.sin(rt.propPh * 5) * 2 * S : 0;
      ctx.beginPath(); ctx.moveTo(-8 * S, -6 * S); ctx.lineTo(0, 2 * S + flut); ctx.lineTo(8 * S, -6 * S); ctx.stroke();
    } else if (kind === 'plug') {
      // rotating gear
      var rot = rt ? rt.propPh * 2 : 0;
      drawGear(2 * S, -1 * S, 6 * S, 8, rot, accent, alpha);
      // plug prongs
      ctx.strokeStyle = rgba(accent, alpha); ctx.lineWidth = 2 * S;
      ctx.beginPath(); ctx.moveTo(-8 * S, -3 * S); ctx.lineTo(-3 * S, -3 * S); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-8 * S, 1 * S); ctx.lineTo(-3 * S, 1 * S); ctx.stroke();
    }
    ctx.restore();
  }
  function drawGear(cx, cy, r, teeth, rot, color, alpha) {
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot);
    ctx.fillStyle = rgba(color, alpha);
    ctx.beginPath();
    for (var i = 0; i < teeth; i++) {
      var a0 = i / teeth * Math.PI * 2, a1 = (i + 0.5) / teeth * Math.PI * 2;
      ctx.lineTo(Math.cos(a0) * r, Math.sin(a0) * r);
      ctx.lineTo(Math.cos(a0 + 0.18) * r * 1.35, Math.sin(a0 + 0.18) * r * 1.35);
      ctx.lineTo(Math.cos(a1) * r, Math.sin(a1) * r);
    }
    ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, r * 0.4, 0, Math.PI * 2);
    ctx.fillStyle = rgba(darken(color, 0.3), alpha); ctx.fill();
    ctx.restore();
  }

  function drawRestProp(id, t) {
    var A = AGENTS[id];
    var s = iso(t.wx - 0.35, t.wy - 0.05, t.z + 0.5);
    drawProp(A.prop, s.x, s.y, zoom * 0.85, A.accent, false, RT[id], id);
  }

  /* ==========================================================
     18. NOVA halo / thought bubble  (§5)
     ========================================================== */
  function drawHalo() {
    var L = LAY.manager;
    var head = iso(L.bean.wx, L.bean.wy, L.bean.z + 1.35);
    var pulse = mgr.state === 'thinking' ? (0.7 + 0.3 * Math.sin(time * (Math.PI * 2 / 1.4))) : 1;
    var k = mgr.halo.x * pulse;
    if (k < 0.02) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    var R = 26 * zoom;
    var g = ctx.createRadialGradient(head.x, head.y, 2, head.x, head.y, R);
    g.addColorStop(0, rgba(lighten(AGENTS.manager.accent, 0.3), 0.55 * k));
    g.addColorStop(0.6, rgba(AGENTS.manager.accent, 0.22 * k));
    g.addColorStop(1, rgba(AGENTS.manager.accent, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(head.x, head.y, R, 0, Math.PI * 2); ctx.fill();
    // thinking pulls faint particles inward
    if (mgr.state === 'thinking' && !reduced) {
      for (var i = 0; i < 5; i++) {
        var ang = time * 0.8 + i * (Math.PI * 2 / 5);
        var rr = (1 - ((time * 0.5 + i * 0.2) % 1)) * R * 1.6;
        ctx.beginPath(); ctx.arc(head.x + Math.cos(ang) * rr, head.y + Math.sin(ang) * rr, 1.3 * zoom, 0, Math.PI * 2);
        ctx.fillStyle = rgba(AGENTS.manager.accent, 0.4 * (1 - rr / (R * 1.6))); ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawThoughtBubble() {
    var L = LAY.manager;
    var head = iso(L.bean.wx - 0.6, L.bean.wy - 0.2, L.bean.z + 1.9);
    ctx.save();
    ctx.translate(head.x, head.y);
    ctx.fillStyle = rgba(PAL.pill, 0.95);
    ctx.strokeStyle = rgba(PAL.textS, 0.15); ctx.lineWidth = 1;
    // little trailing puffs
    ctx.beginPath(); ctx.arc(10 * zoom, 14 * zoom, 2.2 * zoom, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(15 * zoom, 20 * zoom, 1.5 * zoom, 0, Math.PI * 2); ctx.fill();
    // bubble
    roundRect(-16 * zoom, -8 * zoom, 34 * zoom, 20 * zoom, 9 * zoom);
    ctx.fill(); ctx.stroke();
    // cycling dots
    for (var i = 0; i < 3; i++) {
      var a = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(time * 4 - i * 1.1));
      ctx.beginPath();
      ctx.arc((-8 + i * 8) * zoom, 2 * zoom, 2.2 * zoom, 0, Math.PI * 2);
      ctx.fillStyle = rgba(AGENTS.manager.accent, a); ctx.fill();
    }
    ctx.restore();
  }

  /* ==========================================================
     19. ORBS + PARTICLES DRAW
     ========================================================== */
  function drawOrbs() {
    ctx.save();
    for (var i = 0; i < orbs.length; i++) {
      var o = orbs[i];
      var e = easeOrb(clamp(o.t, 0, 1));
      var p0 = iso(o.from.wx, o.from.wy, o.from.wz);
      var pc = iso(o.ctrl.wx, o.ctrl.wy, o.ctrl.wz);
      var p1 = iso(o.to.wx, o.to.wy, o.to.wz);
      var p = quad(p0, pc, p1, e);
      // moving floor light pool
      var fp = iso(quadW(o.from, o.ctrl, o.to, e, 'wx'), quadW(o.from, o.ctrl, o.to, e, 'wy'), 0);
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      var pg = ctx.createRadialGradient(fp.x, fp.y, 1, fp.x, fp.y, 26 * zoom);
      pg.addColorStop(0, rgba(o.accent, 0.18)); pg.addColorStop(1, rgba(o.accent, 0));
      ctx.fillStyle = pg;
      ctx.save(); ctx.translate(fp.x, fp.y); ctx.scale(1, 0.5); ctx.beginPath(); ctx.arc(0, 0, 26 * zoom, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      // glow
      ctx.globalCompositeOperation = 'lighter';
      var gg = ctx.createRadialGradient(p.x, p.y, 1, p.x, p.y, 14 * zoom);
      var glowC = o.type === 'deliver' ? o.accent : o.accent;
      gg.addColorStop(0, rgba(lighten(glowC, 0.3), 0.9));
      gg.addColorStop(0.4, rgba(glowC, 0.5));
      gg.addColorStop(1, rgba(glowC, 0));
      ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(p.x, p.y, 14 * zoom, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      // core (white center) + accent rim for deliver
      ctx.beginPath(); ctx.arc(p.x, p.y, 4 * zoom, 0, Math.PI * 2);
      ctx.fillStyle = rgba('#FFFDF5', 0.98); ctx.fill();
      if (o.type === 'deliver') {
        ctx.beginPath(); ctx.arc(p.x, p.y, 5.5 * zoom, 0, Math.PI * 2);
        ctx.lineWidth = 1.5 * zoom; ctx.strokeStyle = rgba(o.accent, 0.9); ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawParts() {
    ctx.save();
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i], t = clamp(p.life / p.max, 0, 1);
      if (p.type === 'trail') {
        var s = iso(p.wx, p.wy, p.wz);
        ctx.globalCompositeOperation = 'lighter';
        ctx.beginPath(); ctx.arc(s.x, s.y, p.r * zoom * (1 - t * 0.5), 0, Math.PI * 2);
        ctx.fillStyle = rgba(p.accent, 0.4 * (1 - t)); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      } else if (p.type === 'ring') {
        var sr = iso(p.wx, p.wy, p.wz);
        ctx.beginPath(); ctx.arc(sr.x, sr.y, (4 + t * 16) * zoom, 0, Math.PI * 2);
        ctx.lineWidth = 2 * zoom * (1 - t); ctx.strokeStyle = rgba(p.accent, 0.7 * (1 - t)); ctx.stroke();
      } else if (p.type === 'sonar') {
        var sc = iso(p.wx, p.wy, p.wz);
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        for (var k = 0; k < 3; k++) {
          var tt = clamp((p.life - k * 0.12) / (p.max - 0.24), 0, 1);
          if (tt <= 0) continue;
          ctx.beginPath();
          ctx.arc(sc.x, sc.y, (6 + tt * 46) * zoom, 0, Math.PI * 2);
          ctx.lineWidth = 2.2 * zoom * (1 - tt);
          ctx.strokeStyle = rgba(PAL.lightCore, 0.5 * (1 - tt));
          ctx.stroke();
        }
        ctx.restore();
      } else if (p.type === 'thought') {
        var st = iso(p.wx, p.wy, p.wz);
        ctx.globalCompositeOperation = 'lighter';
        ctx.beginPath(); ctx.arc(st.x, st.y, p.r * zoom, 0, Math.PI * 2);
        ctx.fillStyle = rgba(p.accent, 0.5 * (1 - t)); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      } else if (p.type === 'glyph') {
        var sg = iso(p.wx, p.wy, p.wz);
        ctx.font = (10 * zoom | 0) + 'px ' + FONT;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = rgba(p.accent, 0.55 * (1 - t));
        ctx.fillText(p.ch, sg.x, sg.y);
      } else if (p.type === 'sparkle') {
        var ss = iso(p.wx, p.wy, p.wz);
        drawStar(ss.x, ss.y, p.sz * zoom * (1 - t * 0.4), p.rot + t * 1.5, rgba(p.accent, 0.9 * (1 - t)));
      } else if (p.type === 'check') {
        var scK = iso(p.wx, p.wy, p.wz);
        var ca = t < 0.3 ? t / 0.3 : (1 - (t - 0.3) / 0.7);
        ctx.save(); ctx.translate(scK.x, scK.y);
        ctx.strokeStyle = rgba(p.accent, clamp(ca, 0, 1)); ctx.lineWidth = 2.6 * zoom; ctx.lineCap = 'round';
        var dr = clamp(t / 0.3, 0, 1);
        ctx.beginPath();
        ctx.moveTo(-5 * zoom, 0);
        ctx.lineTo(-1 * zoom, 4 * zoom * dr);
        ctx.lineTo((6 * dr) * zoom, -5 * dr * zoom);
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore();
  }
  function drawStar(x, y, r, rot, color) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = color; ctx.beginPath();
    for (var i = 0; i < 4; i++) {
      var a = i / 4 * Math.PI * 2;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      ctx.lineTo(Math.cos(a + Math.PI / 4) * r * 0.34, Math.sin(a + Math.PI / 4) * r * 0.34);
    }
    ctx.closePath(); ctx.fill(); ctx.restore();
  }

  function drawPing(id, k) {
    var L = LAY[id];
    var s = iso(L.bean.wx, L.bean.wy, L.bean.z + 1.55);
    var t = 1 - k / 0.9;
    var pop = t < 0.3 ? easeOut(t / 0.3) : 1;
    var up = -6 * t * zoom;
    ctx.save();
    ctx.translate(s.x, s.y + up);
    ctx.globalAlpha = clamp(k / 0.3, 0, 1);
    ctx.scale(pop, pop);
    // bubble
    roundRect(-6 * zoom, -12 * zoom, 12 * zoom, 16 * zoom, 4 * zoom);
    ctx.fillStyle = col(AGENTS[id].accent); ctx.fill();
    // "!"
    ctx.fillStyle = col('#FFFFFF');
    roundRect(-1.2 * zoom, -9 * zoom, 2.4 * zoom, 7 * zoom, 1 * zoom); ctx.fill();
    ctx.beginPath(); ctx.arc(0, 1 * zoom, 1.3 * zoom, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  /* ==========================================================
     20. FOCUS NAME LABELS  (§9)
     ========================================================== */
  var FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  function drawLabels() {
    for (var i = 0; i < IDS.length; i++) {
      var id = IDS[i], rt = RT[id], A = AGENTS[id], L = LAY[id];
      var fa = (focusId === id) ? 1 : 0;
      var aa = clamp((rt.rim.x - 0.2) / 0.8, 0, 1);
      var alpha = Math.max(fa, aa * (focusId ? 0.4 : 0.7));
      if (alpha < 0.03) continue;
      var s = iso(L.bean.wx, L.bean.wy + 0.55, L.bean.z);
      var name = A.name;
      ctx.save();
      ctx.font = '600 ' + (11 * Math.max(1, zoom * 0.9) | 0) + 'px ' + FONT;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var w = ctx.measureText(name).width + 16 * zoom;
      var h = 16 * zoom;
      // warm halo behind for legibility
      ctx.globalAlpha = alpha;
      roundRect(s.x - w / 2, s.y - h / 2, w, h, h / 2);
      ctx.fillStyle = rgba(PAL.pill, 0.9); ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = rgba(A.accent, 0.5); ctx.stroke();
      ctx.fillStyle = col(PAL.textP);
      ctx.fillText(name, s.x, s.y + 0.5 * zoom);
      ctx.restore();
    }
  }

  /* ==========================================================
     21. LIGHTING / GRADING / VIGNETTE  (§2)
     ========================================================== */
  function drawGrading() {
    // warm key light (window side, upper) — additive
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    var kx = cssW * 0.42, ky = cssH * 0.12;
    var kg = ctx.createRadialGradient(kx, ky, 10, kx, ky, Math.max(cssW, cssH) * 0.8);
    kg.addColorStop(0, rgba(PAL.lightCore, dark ? 0.10 : 0.07));
    kg.addColorStop(1, rgba(PAL.lightCore, 0));
    ctx.fillStyle = kg; ctx.fillRect(0, 0, cssW, cssH);
    // cool fill from the opposite (lower) side
    var fx = cssW * 0.7, fy = cssH * 0.95;
    var fg = ctx.createRadialGradient(fx, fy, 10, fx, fy, Math.max(cssW, cssH) * 0.7);
    fg.addColorStop(0, rgba('#9DB4D6', dark ? 0.06 : 0.045));
    fg.addColorStop(1, rgba('#9DB4D6', 0));
    ctx.fillStyle = fg; ctx.fillRect(0, 0, cssW, cssH);
    ctx.restore();

    // vignette (radial transparent -> soft dark at ~120%)
    var vg = ctx.createRadialGradient(cssW / 2, cssH * 0.46, Math.min(cssW, cssH) * 0.35, cssW / 2, cssH * 0.5, Math.max(cssW, cssH) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, dark ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.10)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, cssW, cssH);
  }

  function drawBg() {
    var g = ctx.createLinearGradient(0, 0, 0, cssH);
    g.addColorStop(0, col(PAL.bgTop));
    g.addColorStop(1, col(PAL.bgBot));
    ctx.fillStyle = g; ctx.fillRect(0, 0, cssW, cssH);
  }

  function drawBootFade() {
    if (bootT >= 0.7) return;
    var p = easeOut(clamp(bootT / 0.7, 0, 1));
    ctx.save();
    ctx.globalAlpha = 1 - p;
    drawBg();
    ctx.restore();
  }

  /* ==========================================================
     22. UPDATE (springs, timers, gaze)  (§5)
     ========================================================== */
  function updateAgents(dt) {
    for (var i = 0; i < IDS.length; i++) {
      var id = IDS[i], rt = RT[id], L = LAY[id];
      // springs
      stepSpring(rt.rim, dt); stepSpring(rt.lamp, dt); stepSpring(rt.mon, dt);
      stepSpring(rt.lean, dt); stepSpring(rt.desat, dt); stepSpring(rt.lift, dt);
      stepSpring(rt.arm, dt); stepSpring(rt.pop, dt); stepSpring(rt.bounce, dt);
      // focus targets
      if (focusId) {
        rt.desat.t = (focusId === id) ? 0 : 0.5;
        rt.lift.t = (focusId === id) ? 3 : 0;
      } else { rt.desat.t = 0; rt.lift.t = 0; }

      // breathing (phase-offset per agent so the room breathes async)
      if (!reduced) rt.breath += dt * (2 * Math.PI / (3.6 + i * 0.22));
      // faster bob when working
      if (rt.state === 'working' || rt.state === 'searching') rt.work += dt * 4.2;
      rt.propPh += dt * ((rt.state === 'working' || rt.state === 'searching') ? 3.5 : 0.6);

      // blink
      if (!reduced) {
        if (rt.blinkT > 0) { rt.blinkT -= dt; }
        else { rt.blinkNext -= dt; if (rt.blinkNext <= 0) { rt.blinkT = 0.12; rt.blinkNext = 2.8 + Math.random() * 3.4; } }
      }

      // assigned ping timer
      if (rt.ping > 0) rt.ping -= dt;

      // speaking mouth phase
      if (rt.speaking) rt.mouthPh += dt;

      // done -> auto-return to idle after the beat
      if (rt.doneT >= 0) {
        rt.doneT += dt;
        if (rt.state === 'done') { rt.rim.t = lerp(1, 0.2, clamp((rt.doneT - 0.4) / 0.4, 0, 1)); rt.lamp.t = lerp(0.4, 0, clamp((rt.doneT - 0.4) / 0.4, 0, 1)); }
        if (rt.doneT >= DONE_DUR) { rt.doneT = -1; if (rt.state === 'done') { rt.state = 'idle'; applyAgentState(id, 'idle'); } }
      }

      // gaze
      updateGaze(id, rt, dt);
    }
    // manager overlay
    stepSpring(mgr.halo, dt); stepSpring(mgr.pop, dt);
    if (mgr.state === 'thinking') mgr.think += dt;
    if (mgr.speaking) {
      mgr.speakPh += dt;
      mgr.sonarT -= dt;
      if (mgr.sonarT <= 0 && parts.length < PART_CAP) { spawnSonar(); mgr.sonarT = 0.9; }
    }
  }

  function updateGaze(id, rt, dt) {
    var target = null;
    if (id === 'manager') {
      if (activeAgent && LAY[activeAgent]) target = beanTile(activeAgent);
    } else {
      if (mgr.state !== 'idle') target = beanTile('manager');
      else if (activeAgent && activeAgent !== id && LAY[activeAgent]) target = beanTile(activeAgent);
    }
    if (target) {
      var a = beanTile(id);
      var dx = (target.wx - target.wy) - (a.wx - a.wy);
      var dy = (target.wx + target.wy) - (a.wx + a.wy);
      var len = Math.hypot(dx, dy) || 1;
      rt.gazeT.x = (dx / len) * 2.2;
      rt.gazeT.y = (dy / len) * 1.6 - 0.5;
    } else {
      rt.gazeT.x = Math.sin(time * 0.4 + rt.breath) * 1.2;
      rt.gazeT.y = 0;
    }
    var s = reduced ? 1 : clamp(dt * 6, 0, 1);
    rt.gaze.x += (rt.gazeT.x - rt.gaze.x) * s;
    rt.gaze.y += (rt.gazeT.y - rt.gaze.y) * s;
  }

  /* ==========================================================
     23. MAIN LOOP
     ========================================================== */
  function frame(ts) {
    if (!running) return;
    try {
      if (!lastTS) lastTS = ts;
      var dt = (ts - lastTS) / 1000;
      lastTS = ts;
      if (!(dt >= 0)) dt = 0;
      if (dt > 0.05) dt = 0.05;              // clamp after stalls / tab switch
      time += dt; bootT += dt;

      readEnv();
      var hidden = false;
      try { hidden = document.hidden; } catch (e) {}

      updateCamera(dt);
      updateAgents(dt);
      updateOrbs(dt);
      updateParts(dt);
      if (!hidden) updateMotes(dt);

      render();
    } catch (err) { /* never break the loop */ }
    requestAnimationFrame(frame);
  }

  function render() {
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    drawBg();

    drawFloor();
    drawSunShafts();
    drawWalls();
    drawDust();
    drawMonstera();
    drawDaisAndRug();
    drawCushion();

    // depth-sorted desk clusters (painter's algorithm by anchor sum)
    var order = IDS.slice().sort(function (a, b) {
      return (LAY[a].anchor.wx + LAY[a].anchor.wy) - (LAY[b].anchor.wx + LAY[b].anchor.wy);
    });
    for (var i = 0; i < order.length; i++) drawCluster(order[i]);

    drawOrbs();
    drawParts();
    drawLabels();

    drawGrading();
    drawBootFade();
  }

  /* ==========================================================
     24. PUBLIC API  (never throws)
     ========================================================== */
  function init(el) {
    canvas = el || document.getElementById('stage');
    if (!canvas || !canvas.getContext) return;
    ctx = canvas.getContext('2d');
    if (!ctx) return;
    readEnv();
    buildLayout();
    resize();
    setManager('idle');

    // react to theme / motion changes
    try {
      var md = window.matchMedia('(prefers-color-scheme: dark)');
      var addL = md.addEventListener ? md.addEventListener.bind(md, 'change') : md.addListener && md.addListener.bind(md);
      if (addL) addL(readEnv);
      var rm = window.matchMedia('(prefers-reduced-motion: reduce)');
      var addR = rm.addEventListener ? rm.addEventListener.bind(rm, 'change') : rm.addListener && rm.addListener.bind(rm);
      if (addR) addR(function () { readEnv(); seedMotes(); });
    } catch (e) {}
    try { window.addEventListener('resize', resize); } catch (e2) {}

    started = true;
    if (!running) { running = true; lastTS = 0; requestAnimationFrame(frame); }
  }

  function guard(fn) {
    return function () {
      try { return fn.apply(null, arguments); } catch (e) { /* swallow — never throw */ }
    };
  }

  window.World = {
    init: guard(init),
    setManager: guard(setManager),
    setAgent: guard(setAgent),
    dispatch: guard(dispatch),
    deliver: guard(deliver),
    speak: guard(speak),
    focus: guard(focus),
    resize: guard(resize)
  };
})();