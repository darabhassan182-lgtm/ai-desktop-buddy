/* ============================================================
   NEXUS — game.js  ·  WORLD 2.0  "Office at Night"
   A committed-dark, minimalist, scrollable isometric company
   office — significantly larger than the viewport — where the
   six agents physically WALK (grid pathfinding + walk cycle)
   for ambient / working / delivering behavior.

   100% procedural HTML5 Canvas 2D. Vanilla JS, no libraries,
   no assets, no fonts, fully offline. Defines window.World,
   the scene API that renderer.js drives.

   Public API (never throws on bad input):
     World.init(canvasEl)                       // canvasEl is #stage
     World.setManager('idle'|'thinking'|'speaking')
     World.setAgent(agentId,'idle'|'assigned'|'working'|
                            'searching'|'delivering'|'done')
     World.dispatch(agentId)   // task cue   Nova  -> agent
     World.deliver(agentId)    // result cue agent -> Nova  (debounced)
     World.speak(agentId, on)  // agentId may be 'manager'
     World.focus(agentId|null) // ease camera to pod / release
     World.resize()
   ============================================================ */
(function () {
  'use strict';

  /* ==========================================================
     1. ISOMETRIC CONSTANTS + WORLD SIZE
     ========================================================== */
  var TILE_W = 64, TILE_H = 32, HALF_W = 32, HALF_H = 16, TILE_Z = 40;
  var WORLD_W = 40, WORLD_D = 32;     // a large hall — bigger than any viewport
  var WALL_H = 3.0;                   // taller dark back walls ground the space

  var DONE_DUR = 0.9;                 // seconds for the "done" beat
  var ORB_DUR = 0.6;                  // task/result orb travel time
  var PART_CAP = 60;                  // hard live-particle ceiling

  // Walking
  var STEP_FREQ = 6.5;               // rad of gait per tile travelled (~2 steps/tile)
  var MAX_AMBIENT = 2;               // keep the dark room calm, not busy
  var DELIVER_MAX = 16;              // max path (tiles) we bother walking a delivery

  // Camera
  var ZOOM_MAX = 2.4;
  var MARGIN = 120;                  // pan overscroll breathing room (px)
  var PAN_KEY_SPEED = 900;          // px/s (scaled by 1/zoom)
  var FRICTION = 0.0025;            // momentum decay base (per second)
  var USE_CACHE = true;            // offscreen static-scene cache (guarded fallback)

  var FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

  /* ==========================================================
     2. COMMITTED-DARK PALETTE (single PAL — no light theme)
     ========================================================== */
  var PAL = {
    voidTop: '#0C0E12', voidBot: '#070809',
    floorNear: '#161920', floorFar: '#101217', floorTile: '#1B1F27',
    seam: 'rgba(255,255,255,0.045)', seamZone: 'rgba(124,156,255,0.10)',
    wallBack: '#111420', wallBackBot: '#0B0D14',
    wallSide: '#0C0E13', wallSideBot: '#08090D',
    baseboard: '#05060A', wallEdge: 'rgba(255,255,255,0.06)',
    glassFrame: '#20242E', glassPane: 'rgba(130,160,210,0.05)', glassEdge: 'rgba(150,180,230,0.14)',
    deskTop: '#1C2028', deskLeft: '#14171D', deskRight: '#0F1116',
    chair: '#171A21', monitorDark: '#0A0B0E', counter: '#191D24',
    sofa: '#1A1D25', sofaSeat: '#20242D', rug: '#13161C',
    rack: '#101319', rackLED: '#22d3ee',
    planterPot: '#14171D', leafDark: '#22302A', leafLit: '#2C3D34',
    whiteboard: '#161A20', boardEdge: 'rgba(255,255,255,0.08)',
    keyGlow: '#DCE6F5', moonPane: '#8FA8CC',
    textP: '#E7ECF4', textS: '#8B94A5',
    pill: 'rgba(18,20,26,0.86)', contact: '#000000',
    // extras used by procedural props / characters
    beanBody: '#20242D', paper: '#CFC4AE', propWood: '#3A404B',
    visor: '#DCE6F5', pupil: '#20304F', amber: '#E0A040'
  };

  var ACCENTS = {
    manager: '#7c9cff', research: '#4f6bff', docs: '#34d399',
    marketing: '#f59e0b', inbox: '#ec4899', api: '#22d3ee'
  };

  /* ==========================================================
     3. AGENTS  (fixed ids, names, accents, props — never remap)
        Each pod: desk anchor tile, chair (behind, -y), home-stand
        (front, +y, walkable), and a role work-spot to walk to.
     ========================================================== */
  var AGENTS = {
    manager:   { name: 'Nova',  role: 'Director',  accent: ACCENTS.manager,   prop: 'none',
                 desk: [20, 9],  chair: [20, 8],  stand: [20, 10], z: 0.30, work: [19, 2] },
    research:  { name: 'Scout', role: 'research',  accent: ACCENTS.research,  prop: 'magnifier',
                 desk: [13, 12], chair: [13, 11], stand: [13, 13], z: 0, work: [2, 15] },
    inbox:     { name: 'Echo',  role: 'inbox',     accent: ACCENTS.inbox,     prop: 'envelope',
                 desk: [27, 12], chair: [27, 11], stand: [27, 13], z: 0, work: [34, 20] },
    docs:      { name: 'Quill', role: 'docs',      accent: ACCENTS.docs,      prop: 'document',
                 desk: [13, 17], chair: [13, 16], stand: [13, 18], z: 0, work: [16, 2] },
    marketing: { name: 'Spark', role: 'marketing', accent: ACCENTS.marketing, prop: 'megaphone',
                 desk: [27, 17], chair: [27, 16], stand: [27, 18], z: 0, work: [21, 2] },
    api:       { name: 'Wire',  role: 'api',       accent: ACCENTS.api,       prop: 'plug',
                 desk: [20, 20], chair: [20, 19], stand: [20, 21], z: 0, work: [3, 3] }
  };
  var IDS = ['manager', 'research', 'inbox', 'docs', 'marketing', 'api'];
  var SPECIALISTS = ['research', 'inbox', 'docs', 'marketing', 'api'];
  var AGENT_STATES = { idle: 1, assigned: 1, working: 1, searching: 1, delivering: 1, done: 1 };

  // Ambient points of interest (the office's social magnets)
  var POI_COFFEE = [33, 27];
  var POI_BOARD = [19, 2];
  var PLANTERS = [[9, 8], [24, 10], [11, 20], [24, 21], [16, 24], [30, 20]];
  var MONSTERA = [3, 21];

  /* ==========================================================
     4. UTILITIES (colour + easing + spring)
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
    if (typeof c === 'string' && c.charAt(0) === 'r') return c; // already rgba()
    var o = toRgb(c);
    return 'rgba(' + (o.r | 0) + ',' + (o.g | 0) + ',' + (o.b | 0) + ',' + a + ')';
  }
  function col(c, a) { return (a == null) ? (typeof c === 'string' ? c : rgba(c, 1)) : rgba(c, a); }
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
  var easeOrb = cubicBezier(0.34, 1.2, 0.64, 1);
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

  function spring(x, k, d) { return { x: x, v: 0, t: x, k: k || 180, d: d || 26 }; }
  function stepSpring(s, dt) {
    var steps = dt > 0.02 ? Math.ceil(dt / 0.016) : 1, h = dt / steps, i, a;
    for (i = 0; i < steps; i++) {
      a = s.k * (s.t - s.x) - s.d * s.v;
      s.v += a * h;
      s.x += s.v * h;
    }
  }

  /* ==========================================================
     5. WORLD / CAMERA STATE
     ========================================================== */
  var canvas = null, ctx = null;
  var dpr = 1, cssW = 0, cssH = 0;
  var originX = 0, originY = 0, zoom = 1, zoom0 = 1, fitZoom = 1, ZOOM_MIN = 0.3;
  var running = false, started = false;
  var lastTS = 0, time = 0, bootT = 0, reduced = false;

  // Free-pan camera
  var camPanX = 0, camPanY = 0, camVX = 0, camVY = 0;
  var camZ = spring(1, 150, 24);         // zoom easing spring (used for focus)
  var focusId = null;
  var camTargetX = 0, camTargetY = 0, focusZoom = 1;
  var dragging = false, dragPointer = null, lastPX = 0, lastPY = 0, dragMoved = 0;
  var keyPan = { left: 0, right: 0, up: 0, down: 0 };
  var zoomDirty = true;                  // triggers static-cache rebuild when settled
  var lastZoomChange = 0;

  // Hint
  var hintAlpha = 0, hintFading = false, hinted = false;

  var mgr = { state: 'idle', speaking: false, halo: spring(0.22), think: 0, speakPh: 0, sonarT: 0, pop: spring(0, 220, 13) };
  var activeAgent = null;
  var RT = {};   // per-agent runtime (springs, timers)
  var LAY = {};  // per-agent world-space layout (centres)
  var MV = {};   // per-agent mover (walking)
  var orbs = [], parts = [], motes = [];

  // Walkability grid
  var walk = null;   // Uint8Array WORLD_W*WORLD_D  (1 walkable, 0 blocked)

  // Offscreen static cache
  var cacheCanvas = null, cacheCtx = null, cacheReady = false, cacheZoom = -1;
  var cacheW = 0, cacheH = 0;

  /* ---- per-agent runtime ---- */
  function makeRT() {
    return {
      state: 'idle', prev: 'idle',
      rim: spring(0.18), lamp: spring(0), mon: spring(0),
      desat: spring(0), lift: spring(0), arm: spring(0),
      pop: spring(1, 220, 13), bounce: spring(0, 210, 12),
      breath: Math.random() * Math.PI * 2,
      blinkNext: 2.5 + Math.random() * 3.5, blinkT: 0,
      work: Math.random() * Math.PI * 2,
      propPh: Math.random() * Math.PI * 2,
      gaze: { x: 0, y: 0 }, gazeT: { x: 0, y: 0 },
      doneT: -1, ping: 0,
      thoughtT: 0, glyphT: 0, steamT: Math.random(),
      speaking: false, mouthPh: 0,
      lastDeliver: -1, walkDeliver: false
    };
  }

  /* ---- per-agent mover ---- */
  function makeMV(A) {
    var s = A.stand;
    return {
      wx: s[0] + 0.5, wy: s[1] + 0.5, z: A.z,
      path: null, pi: 0,
      speed: 2.3, moving: false, facing: 'SE',
      stepPhase: 0, bob: 0, armSwing: 0,
      task: 'idle', dwellT: 0,
      ambientT: 8 + Math.random() * 12,
      wdT: 0, wdPhase: 0,            // watchdog
      workLoopT: 0
    };
  }

  /* ==========================================================
     6. GRID / WALKABILITY  (§3.4)
     ========================================================== */
  function idx(tx, ty) { return ty * WORLD_W + tx; }
  function inBounds(tx, ty) { return tx >= 0 && ty >= 0 && tx < WORLD_W && ty < WORLD_D; }
  function isWalk(tx, ty) { return inBounds(tx, ty) && walk[idx(tx, ty)] === 1; }

  function blockRect(x0, y0, x1, y1) {
    for (var y = y0; y <= y1; y++)
      for (var x = x0; x <= x1; x++)
        if (inBounds(x, y)) walk[idx(x, y)] = 0;
  }
  function blockTile(t) { if (inBounds(t[0], t[1])) walk[idx(t[0], t[1])] = 0; }

  function buildGrid() {
    walk = new Uint8Array(WORLD_W * WORLD_D);
    var x, y;
    for (x = 0; x < WORLD_W; x++) for (y = 0; y < WORLD_D; y++) walk[idx(x, y)] = 1;

    // walls (col x=0, row y=0) — never stand there
    blockRect(0, 0, WORLD_W - 1, 0);
    blockRect(0, 0, 0, WORLD_D - 1);

    // server racks (against back wall)
    blockTile([2, 1]); blockTile([3, 1]); blockTile([4, 1]);

    // meeting room (glass box + long table + interior) — actors never enter
    blockRect(27, 1, WORLD_W - 1, 11);

    // lounge: L-sofa + round low table
    blockRect(3, 23, 7, 24);
    blockRect(3, 25, 4, 27);
    blockTile([8, 26]);

    // kitchenette: counter runs
    blockRect(31, 30, 37, 30);
    blockRect(38, 23, 38, 30);

    // printer / mail station
    blockTile([34, 19]);

    // planters + monstera
    for (var i = 0; i < PLANTERS.length; i++) blockTile(PLANTERS[i]);
    blockTile(MONSTERA);

    // agent desks + chairs
    for (var s = 0; s < IDS.length; s++) {
      var A = AGENTS[IDS[s]];
      blockTile(A.desk); blockTile(A.chair);
    }

    // guarantee corridors + every stand / work-spot / POI is walkable,
    // and assert connectivity (never ship a trap — clear offenders).
    ensureWalkable();
    assertConnectivity();
  }

  function ensureWalkable() {
    var i, A;
    for (i = 0; i < IDS.length; i++) {
      A = AGENTS[IDS[i]];
      openTile(A.stand); openTile(A.work);
    }
    openTile(POI_COFFEE); openTile(POI_BOARD);
    // corridors
    var x, y;
    for (x = 8; x <= 30; x++) { openTile([x, 14]); openTile([x, 15]); }
    for (y = 10; y <= 24; y++) if (walk[idx(20, y)] !== undefined && !isDeskTile(20, y)) openTile([20, y]);
  }
  function isDeskTile(tx, ty) {
    for (var i = 0; i < IDS.length; i++) {
      var A = AGENTS[IDS[i]];
      if ((A.desk[0] === tx && A.desk[1] === ty) || (A.chair[0] === tx && A.chair[1] === ty)) return true;
    }
    return false;
  }
  function openTile(t) { if (inBounds(t[0], t[1])) walk[idx(t[0], t[1])] = 1; }

  function assertConnectivity() {
    var start = AGENTS.manager.stand;
    var seen = bfsFrom(start[0], start[1]);
    var targets = [];
    for (var i = 0; i < IDS.length; i++) { targets.push(AGENTS[IDS[i]].stand); targets.push(AGENTS[IDS[i]].work); }
    targets.push(POI_COFFEE); targets.push(POI_BOARD);
    for (var t = 0; t < targets.length; t++) {
      var tt = targets[t];
      if (!seen[idx(tt[0], tt[1])]) {
        // fallback: clear a small neighbourhood so it's reachable (never a trap)
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) openTile([tt[0] + dx, tt[1] + dy]);
      }
    }
  }
  function bfsFrom(sx, sy) {
    var seen = new Uint8Array(WORLD_W * WORLD_D);
    if (!isWalk(sx, sy)) return seen;
    var q = [sx + sy * WORLD_W], head = 0;
    seen[idx(sx, sy)] = 1;
    var nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (head < q.length) {
      var cur = q[head++], cx = cur % WORLD_W, cy = (cur / WORLD_W) | 0;
      for (var k = 0; k < 4; k++) {
        var nx = cx + nb[k][0], ny = cy + nb[k][1];
        if (isWalk(nx, ny) && !seen[idx(nx, ny)]) { seen[idx(nx, ny)] = 1; q.push(nx + ny * WORLD_W); }
      }
    }
    return seen;
  }

  /* ==========================================================
     7. A* PATHFINDING (4-neighbour + safe diagonal) + string-pull
     ========================================================== */
  function astar(sx, sy, tx, ty) {
    sx |= 0; sy |= 0; tx |= 0; ty |= 0;
    if (!inBounds(sx, sy) || !inBounds(tx, ty)) return null;
    if (!isWalk(tx, ty)) return null;
    if (sx === tx && sy === ty) return [[sx, sy]];

    var N = WORLD_W * WORLD_D;
    var g = new Float32Array(N), f = new Float32Array(N), came = new Int32Array(N), closed = new Uint8Array(N), open = new Uint8Array(N);
    for (var i = 0; i < N; i++) { g[i] = Infinity; came[i] = -1; }
    var startI = idx(sx, sy);
    g[startI] = 0; f[startI] = octile(sx, sy, tx, ty);
    var heap = [startI]; open[startI] = 1;

    function hpush(v) { heap.push(v); var c = heap.length - 1; while (c > 0) { var p = (c - 1) >> 1; if (f[heap[p]] <= f[heap[c]]) break; var tmp = heap[p]; heap[p] = heap[c]; heap[c] = tmp; c = p; } }
    function hpop() { var top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; var c = 0, n = heap.length; for (;;) { var l = 2 * c + 1, r = l + 1, sm = c; if (l < n && f[heap[l]] < f[heap[sm]]) sm = l; if (r < n && f[heap[r]] < f[heap[sm]]) sm = r; if (sm === c) break; var tmp = heap[sm]; heap[sm] = heap[c]; heap[c] = tmp; c = sm; } } return top; }

    var nb = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]];
    var goalI = idx(tx, ty), guard = 0;
    while (heap.length && guard++ < 20000) {
      var cur = hpop(); open[cur] = 0;
      if (cur === goalI) return reconstruct(came, cur);
      if (closed[cur]) continue;
      closed[cur] = 1;
      var cx = cur % WORLD_W, cy = (cur / WORLD_W) | 0;
      for (var k = 0; k < 8; k++) {
        var dx = nb[k][0], dy = nb[k][1], nx = cx + dx, ny = cy + dy;
        if (!isWalk(nx, ny)) continue;
        if (dx !== 0 && dy !== 0) { if (!isWalk(cx + dx, cy) || !isWalk(cx, cy + dy)) continue; } // no corner cut
        var ni = idx(nx, ny);
        if (closed[ni]) continue;
        var ng = g[cur] + nb[k][2];
        if (ng < g[ni]) {
          came[ni] = cur; g[ni] = ng; f[ni] = ng + octile(nx, ny, tx, ty);
          if (!open[ni]) { open[ni] = 1; hpush(ni); }
        }
      }
    }
    return null;
  }
  function octile(ax, ay, bx, by) {
    var dx = Math.abs(ax - bx), dy = Math.abs(ay - by);
    return (dx + dy) + (1.4142 - 2) * Math.min(dx, dy);
  }
  function reconstruct(came, cur) {
    var out = [];
    while (cur !== -1) { out.push([cur % WORLD_W, (cur / WORLD_W) | 0]); cur = came[cur]; }
    out.reverse();
    return out;
  }
  // drop collinear waypoints so walks read as straight strides
  function stringPull(tiles) {
    if (!tiles || tiles.length <= 2) return tiles;
    var out = [tiles[0]];
    for (var i = 1; i < tiles.length - 1; i++) {
      var a = tiles[i - 1], b = tiles[i], c = tiles[i + 1];
      var abx = b[0] - a[0], aby = b[1] - a[1], bcx = c[0] - b[0], bcy = c[1] - b[1];
      if (abx !== bcx || aby !== bcy) out.push(b);
    }
    out.push(tiles[tiles.length - 1]);
    return out;
  }
  function pathLenTiles(sx, sy, tx, ty) {
    var p = astar(sx, sy, tx, ty);
    if (!p) return -1;
    var d = 0;
    for (var i = 1; i < p.length; i++) d += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    return d;
  }

  /* ==========================================================
     8. LAYOUT (world-space centres per pod)
     ========================================================== */
  function tileCenter(tx, ty) { return { wx: tx + 0.5, wy: ty + 0.5 }; }

  function buildLayout() {
    for (var i = 0; i < IDS.length; i++) {
      var id = IDS[i], A = AGENTS[id];
      var dc = tileCenter(A.desk[0], A.desk[1]);
      var cc = tileCenter(A.chair[0], A.chair[1]);
      var sc = tileCenter(A.stand[0], A.stand[1]);
      LAY[id] = {
        z: A.z,
        desk: { wx: dc.wx, wy: dc.wy },
        chair: { wx: cc.wx, wy: cc.wy },
        stand: { wx: sc.wx, wy: sc.wy },
        mon: { wx: dc.wx, wy: dc.wy - 0.12 },
        mug: { wx: dc.wx + 0.30, wy: dc.wy + 0.10 }
      };
      RT[id] = makeRT();
      MV[id] = makeMV(A);
    }
  }

  function moverChest(id) { var mv = MV[id]; return { wx: mv.wx, wy: mv.wy, wz: (mv.z || 0) + 0.95 }; }

  /* ==========================================================
     9. ISOMETRIC PROJECTION + INVERSE
     ========================================================== */
  function iso(wx, wy, wz) {
    wz = wz || 0;
    return {
      x: originX + (wx - wy) * HALF_W * zoom + camPanX,
      y: originY + (wx + wy) * HALF_H * zoom - wz * TILE_Z * zoom + camPanY
    };
  }
  function screenToWorld(sx, sy) {
    var dx = (sx - camPanX - originX) / zoom;
    var dy = (sy - camPanY - originY) / zoom;
    var a = dx / HALF_W, b = dy / HALF_H;
    return { wx: (a + b) / 2, wy: (b - a) / 2 };
  }

  /* ==========================================================
     10. CANVAS SETUP / RESIZE / CAMERA FIT
     ========================================================== */
  function readEnv() {
    try { reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (e) { reduced = false; }
  }

  function worldScreenW() { return (WORLD_W + WORLD_D) * HALF_W; }
  function worldScreenH() { return (WORLD_W + WORLD_D) * HALF_H + WALL_H * TILE_Z; }

  function resize() {
    if (!canvas || !ctx) return;
    cssW = canvas.clientWidth || (canvas.parentNode && canvas.parentNode.clientWidth) || window.innerWidth || 1024;
    cssH = canvas.clientHeight || (canvas.parentNode && canvas.parentNode.clientHeight) || window.innerHeight || 768;
    dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));

    originX = cssW / 2;
    originY = cssH * 0.5;

    fitZoom = Math.min(cssW / worldScreenW(), cssH / worldScreenH());
    ZOOM_MIN = fitZoom * 0.9;
    zoom0 = clamp(fitZoom * 1.9, ZOOM_MIN, 1.4);

    if (!started) {
      zoom = zoom0; camZ.x = zoom0; camZ.t = zoom0;
      centerOnNova(true);
    } else {
      zoom = clamp(zoom, ZOOM_MIN, ZOOM_MAX);
      camZ.x = zoom; camZ.t = zoom;
      clampCam();
    }
    invalidateCache();
    seedMotes();
  }

  function centerOnNova(instant) {
    var s = LAY.manager ? LAY.manager.stand : { wx: 20.5, wy: 10.5 };
    var dx = (s.wx - s.wy) * HALF_W * zoom;
    var dy = (s.wx + s.wy) * HALF_H * zoom;
    camPanX = cssW / 2 - (originX + dx);
    camPanY = cssH * 0.46 - (originY + dy);
    camVX = camVY = 0;
    clampCam();
  }

  function clampCam() {
    var minSX = (0 - WORLD_D) * HALF_W * zoom, maxSX = (WORLD_W - 0) * HALF_W * zoom;
    var minSY = -WALL_H * TILE_Z * zoom, maxSY = (WORLD_W + WORLD_D) * HALF_H * zoom;
    var loX = cssW - MARGIN - (maxSX + originX), hiX = MARGIN - (minSX + originX);
    var loY = cssH - MARGIN - (maxSY + originY), hiY = MARGIN - (minSY + originY);
    camPanX = (loX > hiX) ? (loX + hiX) / 2 : clamp(camPanX, loX, hiX);
    camPanY = (loY > hiY) ? (loY + hiY) / 2 : clamp(camPanY, loY, hiY);
  }

  function setZoom(nz) {
    nz = clamp(nz, ZOOM_MIN, ZOOM_MAX);
    if (Math.abs(nz - zoom) < 1e-4) return;
    zoom = nz; camZ.x = nz; camZ.t = nz;
    zoomDirty = true; lastZoomChange = time; cacheReady = false;
  }
  function zoomAt(cx, cy, factor) {
    var before = screenToWorld(cx, cy);
    setZoom(zoom * factor);
    var sx = originX + (before.wx - before.wy) * HALF_W * zoom + camPanX;
    var sy = originY + (before.wx + before.wy) * HALF_H * zoom + camPanY;
    camPanX += cx - sx; camPanY += cy - sy;
    clampCam();
  }

  function clearFocusForUser() { focusId = null; }

  function updateCamera(dt) {
    // focus easing (spring to a computed pan target + zoom)
    if (focusId && LAY[focusId]) {
      var s = LAY[focusId].stand;
      focusZoom = clamp(zoom0 * 1.12, ZOOM_MIN, ZOOM_MAX);
      camZ.t = focusZoom; stepSpring(camZ, dt);
      if (Math.abs(camZ.x - zoom) > 1e-4) { zoom = camZ.x; cacheReady = false; zoomDirty = true; lastZoomChange = time; }
      var dx = (s.wx - s.wy) * HALF_W * zoom, dy = (s.wx + s.wy) * HALF_H * zoom;
      camTargetX = cssW / 2 - (originX + dx);
      camTargetY = cssH * 0.46 - (originY + dy);
      var k = 1 - Math.pow(0.0009, dt);   // smooth critically-damped-ish ease
      camPanX += (camTargetX - camPanX) * k;
      camPanY += (camTargetY - camPanY) * k;
      camVX = camVY = 0;
      clampCam();
    } else {
      // keyboard pan intent
      var kx = (keyPan.left - keyPan.right), ky = (keyPan.up - keyPan.down);
      if (kx || ky) {
        var v = PAN_KEY_SPEED / zoom * dt;
        camPanX += kx * v; camPanY += ky * v;
        camVX = camVY = 0;
        markPanned(20);
        clampCam();
      } else if (!dragging) {
        // momentum glide
        if (Math.abs(camVX) > 4 || Math.abs(camVY) > 4) {
          camPanX += camVX * dt; camPanY += camVY * dt;
          var f = Math.pow(FRICTION, dt);
          camVX *= f; camVY *= f;
          if (Math.abs(camVX) < 4) camVX = 0;
          if (Math.abs(camVY) < 4) camVY = 0;
          clampCam();
        }
      }
    }

    // rebuild static cache once zoom settles at a new value
    if (USE_CACHE && !cacheReady && (time - lastZoomChange) > 0.12) buildCache();

    // hint fade-in after boot, fade-out after first pan
    if (!hinted) {
      if (bootT > 0.8 && !hintFading) hintAlpha = Math.min(1, hintAlpha + dt / 0.5);
    }
    if (hintFading) { hintAlpha = Math.max(0, hintAlpha - dt / 0.6); if (hintAlpha <= 0) hinted = true; }
  }

  function markPanned(threshold) {
    dragMoved += threshold;
    if (!hintFading && !hinted) hintFading = true;
  }

  /* ==========================================================
     11. INPUT (drag pan / wheel / zoom / keyboard) — guarded
     ========================================================== */
  function bindInput() {
    if (!canvas) return;
    try { canvas.style.cursor = 'grab'; } catch (e) {}

    on(canvas, 'pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      dragging = true; dragPointer = e.pointerId; dragMoved = 0;
      lastPX = e.clientX; lastPY = e.clientY;
      camVX = camVY = 0;
      clearFocusForUser();
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      try { canvas.classList.add('dragging'); } catch (_) {}
    });
    on(canvas, 'pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - lastPX, dy = e.clientY - lastPY;
      lastPX = e.clientX; lastPY = e.clientY;
      camPanX += dx; camPanY += dy;
      // velocity estimate for momentum handoff
      var idt = 1 / 60; try { idt = clamp((e.movementX !== undefined ? 0.016 : 0.016), 0.008, 0.05); } catch (_) {}
      camVX = dx / idt; camVY = dy / idt;
      dragMoved += Math.abs(dx) + Math.abs(dy);
      if (dragMoved > 8 && !hintFading && !hinted) hintFading = true;
      clampCam();
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      try { canvas.releasePointerCapture(dragPointer); } catch (_) {}
      try { canvas.classList.remove('dragging'); } catch (_) {}
      // clamp momentum to sane range
      camVX = clamp(camVX, -2600, 2600); camVY = clamp(camVY, -2600, 2600);
    }
    on(canvas, 'pointerup', endDrag);
    on(canvas, 'pointercancel', endDrag);
    on(canvas, 'pointerleave', endDrag);

    on(canvas, 'wheel', function (e) {
      var cx = e.clientX, cy = e.clientY;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        var factor = Math.exp(-e.deltaY * 0.0015);
        clearFocusForUser();
        zoomAt(cx, cy, factor);
        markPanned(1);
        return;
      }
      e.preventDefault();
      clearFocusForUser();
      camVX = camVY = 0;
      if (e.shiftKey) camPanX -= (e.deltaY || e.deltaX);
      else camPanY -= e.deltaY;
      markPanned(1);
      clampCam();
    }, { passive: false });

    // click on minimap to pan there
    on(canvas, 'pointerdown', function (e) { tryMinimapJump(e.clientX, e.clientY); });

    on(window, 'keydown', function (e) {
      var ae = null; try { ae = document.activeElement; } catch (_) {}
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
      var k = e.key;
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') { keyPan.left = 1; clearFocusForUser(); markPanned(1); }
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') { keyPan.right = 1; clearFocusForUser(); markPanned(1); }
      else if (k === 'ArrowUp' || k === 'w' || k === 'W') { keyPan.up = 1; clearFocusForUser(); markPanned(1); }
      else if (k === 'ArrowDown' || k === 's' || k === 'S') { keyPan.down = 1; clearFocusForUser(); markPanned(1); }
      else if (k === '+' || k === '=') { clearFocusForUser(); zoomAt(cssW / 2, cssH / 2, 1.1); }
      else if (k === '-' || k === '_') { clearFocusForUser(); zoomAt(cssW / 2, cssH / 2, 0.9); }
      else if (k === '0') { clearFocusForUser(); setZoom(zoom0); centerOnNova(true); }
      else if (k === 'Escape') { focus(null); return; }
      else return;
      if (e.preventDefault) e.preventDefault();
    });
    on(window, 'keyup', function (e) {
      var k = e.key;
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') keyPan.left = 0;
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') keyPan.right = 0;
      else if (k === 'ArrowUp' || k === 'w' || k === 'W') keyPan.up = 0;
      else if (k === 'ArrowDown' || k === 's' || k === 'S') keyPan.down = 0;
    });
  }
  function on(el, ev, fn, opts) { if (el && el.addEventListener) { try { el.addEventListener(ev, fn, opts); } catch (_) {} } }

  function tryMinimapJump(sx, sy) {
    if (cssW < 560) return;
    var mm = minimapRect();
    if (sx < mm.x || sx > mm.x + mm.w || sy < mm.y || sy > mm.y + mm.h) return;
    // map click within minimap back to world, center camera there
    var s = mm.s, ox = mm.ox, oy = mm.oy;
    var lx = (sx - ox) / s, ly = (sy - oy) / s;   // (wx-wy)*HW-ish, (wx+wy)*HH-ish (centred)
    var aw = lx / HALF_W + (WORLD_W - WORLD_D) / 2;   // wx-wy
    var bw = ly / HALF_H + (WORLD_W + WORLD_D) / 2;   // wx+wy
    var wx = (aw + bw) / 2, wy = (bw - aw) / 2;
    clearFocusForUser();
    var dx = (wx - wy) * HALF_W * zoom, dy = (wx + wy) * HALF_H * zoom;
    camPanX = cssW / 2 - (originX + dx);
    camPanY = cssH / 2 - (originY + dy);
    camVX = camVY = 0;
    markPanned(1); clampCam();
  }

  /* ==========================================================
     12. STATE MACHINE (setAgent / setManager / speak / focus)
     ========================================================== */
  function goHome(id) {
    var A = AGENTS[id], mv = MV[id];
    goTo(id, A.stand[0], A.stand[1], 'return');
  }
  function atHome(id) {
    var A = AGENTS[id], mv = MV[id];
    return Math.abs(mv.wx - (A.stand[0] + 0.5)) < 0.25 && Math.abs(mv.wy - (A.stand[1] + 0.5)) < 0.25;
  }

  function applyAgentState(id, st) {
    var rt = RT[id], mv = MV[id]; if (!rt || !mv) return;
    var A = AGENTS[id];
    if (st === 'idle') {
      rt.rim.t = 0.18; rt.lamp.t = 0; rt.mon.t = 0; rt.arm.t = 0;
      rt.walkDeliver = false;
      if (!atHome(id) && !mv.moving) goHome(id);
      else if (mv.task === 'work' || mv.task === 'deliver') goHome(id);
      mv.ambientT = 9 + Math.random() * 12;
      if (activeAgent === id) activeAgent = null;
    } else if (st === 'assigned') {
      rt.rim.t = 1; rt.lamp.t = 1; rt.mon.t = 0.20; rt.arm.t = 0;
      rt.pop.x = 0.86; rt.pop.v = 0; rt.ping = 0.9;
      activeAgent = id;
      // anticipation happens AT the desk — return home if wandered off
      if (!atHome(id) && mv.task !== 'return') goHome(id);
    } else if (st === 'working' || st === 'searching') {
      rt.rim.t = 1; rt.lamp.t = 1; rt.mon.t = 1;
      activeAgent = id;
      if (A.work) goTo(id, A.work[0], A.work[1], 'work');
      mv.workLoopT = 4 + Math.random() * 3;
    } else if (st === 'delivering') {
      rt.rim.t = 1; rt.lamp.t = 1; rt.mon.t = 0.6;
      activeAgent = id;
      var here = [Math.round(mv.wx - 0.5), Math.round(mv.wy - 0.5)];
      var nova = AGENTS.manager.stand;
      var len = pathLenTiles(here[0], here[1], nova[0], nova[1]);
      if (!reduced && len >= 0 && len <= DELIVER_MAX) {
        rt.walkDeliver = true;
        goTo(id, nova[0], nova[1], 'deliver');
      } else {
        rt.walkDeliver = false;
      }
      deliver(id);                    // orb (skipped internally while walkDeliver)
    } else if (st === 'done') {
      rt.rim.t = 1; rt.lamp.t = 0.4; rt.mon.t = 0.3; rt.arm.t = 0;
      rt.doneT = 0; rt.walkDeliver = false;
      rt.bounce.x = 0; rt.bounce.v = -7.5;
      spawnSparkles(id);
      if (activeAgent === id) activeAgent = null;
    }
  }

  function setAgent(id, st) {
    var rt = RT[id];
    if (!rt) return;                 // unknown agent -> ignore
    if (!AGENT_STATES[st]) return;   // unknown state -> ignore
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
      spawnSonar();
      mgr.pop.x = 0; mgr.pop.v = 0;
    } else {
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
    if (focusId) { camVX = camVY = 0; }
  }

  /* ==========================================================
     13. WALKING (goTo / movement / facing / behaviors)
     ========================================================== */
  function goTo(id, tx, ty, task) {
    var mv = MV[id];
    var raw = astar(Math.round(mv.wx - 0.5), Math.round(mv.wy - 0.5), tx, ty);
    if (!raw || raw.length < 1) { mv.moving = false; mv.task = 'idle'; return false; }
    var pulled = stringPull(raw);
    mv.path = [];
    for (var i = 0; i < pulled.length; i++) mv.path.push({ wx: pulled[i][0] + 0.5, wy: pulled[i][1] + 0.5 });
    mv.pi = 0; mv.moving = mv.path.length > 0; mv.task = task;
    mv.wdT = 0; mv.wdPhase = mv.stepPhase;
    // skip the first waypoint if we're already basically on it
    if (mv.path.length && Math.hypot(mv.path[0].wx - mv.wx, mv.path[0].wy - mv.wy) < 0.12) mv.pi = 1;
    if (mv.pi >= mv.path.length) { mv.moving = false; }
    return mv.moving;
  }

  function integrateMove(id, dt) {
    var mv = MV[id], A = AGENTS[id];
    var target = mv.path[mv.pi];
    if (!target) { arrive(id); return; }
    var dx = target.wx - mv.wx, dy = target.wy - mv.wy;
    var d = Math.hypot(dx, dy);
    var step = mv.speed * dt;
    if (d <= 1e-4 || step >= d) {
      mv.wx = target.wx; mv.wy = target.wy;
      mv.pi++;
      if (mv.pi >= mv.path.length) { arrive(id); }
    } else {
      var ux = dx / d, uy = dy / d;
      mv.wx += ux * step; mv.wy += uy * step;
      if (!reduced) mv.stepPhase += step * STEP_FREQ;
      setFacing(mv, ux, uy);
    }
    // Nova rises onto / steps off her dais smoothly
    if (id === 'manager') updateDaisZ(mv, dt);
    // watchdog: if not making progress, snap to end and idle
    mv.wdT += dt;
    if (mv.wdT > 2 && Math.abs(mv.stepPhase - mv.wdPhase) < 0.01) {
      var last = mv.path[mv.path.length - 1];
      if (last) { mv.wx = last.wx; mv.wy = last.wy; }
      arrive(id);
    } else if (mv.wdT > 2) { mv.wdT = 0; mv.wdPhase = mv.stepPhase; }
  }

  function updateDaisZ(mv, dt) {
    var tx = Math.round(mv.wx - 0.5), ty = Math.round(mv.wy - 0.5);
    var onDais = (tx === 20 && (ty === 9 || ty === 10));
    var tz = onDais ? 0.30 : 0;
    mv.z += (tz - mv.z) * Math.min(1, dt * 8);
  }

  function setFacing(mv, ux, uy) {
    var sx = ux - uy, sy = ux + uy;
    if (sy >= 0 && sx >= 0) mv.facing = 'SE';
    else if (sy >= 0 && sx < 0) mv.facing = 'SW';
    else if (sy < 0 && sx >= 0) mv.facing = 'NE';
    else mv.facing = 'NW';
  }

  function arrive(id) {
    var mv = MV[id], rt = RT[id], A = AGENTS[id];
    mv.moving = false; mv.path = null; mv.pi = 0;
    if (id === 'manager') updateDaisZ(mv, 1);

    if (mv.task === 'deliver') {
      // hand-off beat: face Nova, absorb into her halo
      mv.facing = novaFacingFrom(mv);
      mgr.halo.x = Math.min(1.3, mgr.halo.x + 0.28);
      mgr.pop.x = -0.35; mgr.pop.v = 0;
      parts.push({ type: 'ring', wx: 20.5, wy: 10.0, wz: 1.0, accent: PAL.keyGlow, life: 0, max: 0.18 });
      if (A.accent) parts.push({ type: 'ring', wx: mv.wx, wy: mv.wy, wz: 0.9, accent: A.accent, life: 0, max: 0.22 });
      rt.walkDeliver = false;
      mv.dwellT = 0.5; mv.task = 'handoff';
    } else if (mv.task === 'ambient') {
      mv.dwellT = 1.5 + Math.random() * 2.5; mv.task = 'dwell';
      mv.facing = (Math.random() < 0.5) ? 'SE' : 'SW';
    } else if (mv.task === 'work') {
      mv.facing = faceFixture(mv, A.work);
      mv.dwellT = 0; mv.task = 'atwork';
    } else if (mv.task === 'return' || mv.task === 'handoff' || mv.task === 'dwell') {
      mv.task = 'idle';
      mv.facing = homeFacing(id);
      if (rt.state === 'idle') mv.ambientT = 9 + Math.random() * 12;
    } else {
      mv.task = 'idle';
    }
  }
  function homeFacing(id) {
    // face toward the room centre so the visor reads
    var mv = MV[id];
    var cx = WORLD_W / 2, cy = WORLD_D / 2;
    var ux = cx - mv.wx, uy = cy - mv.wy, l = Math.hypot(ux, uy) || 1;
    var tmp = { facing: 'SE' }; setFacing(tmp, ux / l, uy / l);
    // prefer a front-facing pose
    if (tmp.facing === 'NE') return 'SE';
    if (tmp.facing === 'NW') return 'SW';
    return tmp.facing;
  }
  function novaFacingFrom(mv) {
    var ux = 20.5 - mv.wx, uy = 10.0 - mv.wy, l = Math.hypot(ux, uy) || 1;
    var tmp = {}; setFacing(tmp, ux / l, uy / l); return tmp.facing;
  }
  function faceFixture(mv, spot) {
    if (!spot) return mv.facing;
    var ux = (spot[0] + 0.5) - mv.wx, uy = (spot[1] + 0.5) - mv.wy;
    // fixtures are on back walls (toward -y) -> face away from camera (NE/NW) at work
    var l = Math.hypot(ux, uy);
    if (l < 0.2) return (spot[0] < mv.wx) ? 'NW' : 'NE';
    var tmp = {}; setFacing(tmp, ux / l, uy / l); return tmp.facing;
  }

  function countAmbientWalkers() {
    var n = 0;
    for (var i = 0; i < IDS.length; i++) {
      var mv = MV[IDS[i]];
      if (mv.task === 'ambient' || mv.task === 'dwell' || (mv.task === 'return' && RT[IDS[i]].state === 'idle')) n++;
    }
    return n;
  }

  function pickAmbientPOI(id) {
    var A = AGENTS[id];
    var opts = [];
    opts.push(POI_COFFEE);
    opts.push(POI_BOARD);
    // a random colleague's stand
    var others = SPECIALISTS.filter(function (o) { return o !== id; });
    if (id === 'manager') others = SPECIALISTS.slice();
    if (others.length) opts.push(AGENTS[others[(Math.random() * others.length) | 0]].stand);
    // nearest planter
    var best = null, bd = 1e9;
    for (var p = 0; p < PLANTERS.length; p++) {
      var pl = PLANTERS[p], d = Math.hypot(pl[0] - A.stand[0], pl[1] - A.stand[1]);
      if (d < bd) { bd = d; best = pl; }
    }
    if (best) opts.push([best[0], best[1] + 1]); // stand in front of the planter
    var pick = opts[(Math.random() * opts.length) | 0];
    return pick;
  }

  function updateBehavior(id, dt) {
    var mv = MV[id], rt = RT[id], A = AGENTS[id];

    if (mv.moving) { integrateMove(id, dt); return; }

    // dwell timers (ambient pause / hand-off pause)
    if (mv.dwellT > 0) {
      mv.dwellT -= dt;
      if (mv.dwellT <= 0) {
        if (mv.task === 'dwell') goHome(id);
        else if (mv.task === 'handoff') goHome(id);
      }
      return;
    }

    // WORKING / SEARCHING — loop micro-walks near the fixture to feel alive
    if ((rt.state === 'working' || rt.state === 'searching') && mv.task === 'atwork') {
      mv.workLoopT -= dt;
      if (mv.workLoopT <= 0) {
        mv.workLoopT = 4 + Math.random() * 3;
        // brief step to an adjacent reference tile, then back to the fixture
        var spot = A.work, cand = adjWalkable(spot[0], spot[1]);
        if (cand) { goTo(id, cand[0], cand[1], 'workstep'); }
      }
      return;
    }
    if (mv.task === 'workstep') { goTo(id, A.work[0], A.work[1], 'work'); return; }

    // ASSIGNED / DELIVERING that resolved to no-walk: just hold at desk
    if (rt.state === 'assigned' || rt.state === 'delivering') return;

    // AMBIENT (idle only) — occasional short stroll
    if (rt.state === 'idle' && atHome(id)) {
      mv.ambientT -= dt;
      if (mv.ambientT <= 0) {
        var base = (id === 'manager') ? 22 : 10;
        mv.ambientT = base + Math.random() * 14;
        if (id === 'manager' && Math.random() < 0.5) return; // Nova mostly presides
        if (countAmbientWalkers() < MAX_AMBIENT) {
          var poi = pickAmbientPOI(id);
          if (poi) goTo(id, poi[0], poi[1], 'ambient');
        }
      }
    }
  }

  function adjWalkable(tx, ty) {
    var nb = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
    var out = [];
    for (var i = 0; i < nb.length; i++) { var x = tx + nb[i][0], y = ty + nb[i][1]; if (isWalk(x, y)) out.push([x, y]); }
    if (!out.length) return null;
    return out[(Math.random() * out.length) | 0];
  }

  /* ==========================================================
     14. ORBS
     ========================================================== */
  function spawnOrb(type, accent, from, to, agentId) {
    var ctrl = { wx: (from.wx + to.wx) / 2, wy: (from.wy + to.wy) / 2, wz: Math.max(from.wz, to.wz) + 1.35 };
    orbs.push({ type: type, accent: accent, from: from, to: to, ctrl: ctrl, t: 0, dur: reduced ? 0.12 : ORB_DUR, agentId: agentId });
  }
  function dispatch(id) {
    var A = AGENTS[id]; if (!A || id === 'manager') return;
    spawnOrb('dispatch', A.accent, moverChest('manager'), moverChest(id), id);
    var rt = RT[id]; if (rt) rt.rim.t = 1;
  }
  function deliver(id) {
    var A = AGENTS[id], rt = RT[id];
    if (!A || !rt || id === 'manager') return;
    if (time - rt.lastDeliver < 0.28) return;   // debounce dual-trigger (state machine + renderer)
    rt.lastDeliver = time;
    if (rt.walkDeliver) return;                 // the walking hand-off carries the result instead
    spawnOrb('deliver', A.accent, moverChest(id), moverChest('manager'), id);
  }
  function quad(p0, pc, p1, t) { var u = 1 - t; return { x: u * u * p0.x + 2 * u * t * pc.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * pc.y + t * t * p1.y }; }
  function quadW(p0, pc, p1, t, key) { var u = 1 - t; return u * u * p0[key] + 2 * u * t * pc[key] + t * t * p1[key]; }

  function updateOrbs(dt) {
    for (var i = orbs.length - 1; i >= 0; i--) {
      var o = orbs[i];
      o.t += dt / o.dur;
      var e = easeOrb(clamp(o.t, 0, 1));
      if (!reduced && o.t < 1 && parts.length < PART_CAP) {
        parts.push({ type: 'trail', wx: quadW(o.from, o.ctrl, o.to, e, 'wx'), wy: quadW(o.from, o.ctrl, o.to, e, 'wy'), wz: quadW(o.from, o.ctrl, o.to, e, 'wz'), accent: o.accent, life: 0, max: 0.34, r: 2.2 + Math.random() * 1.5 });
      }
      if (o.t >= 1) { onOrbArrive(o); orbs.splice(i, 1); }
    }
  }
  function onOrbArrive(o) {
    if (o.type === 'dispatch') {
      var rt = RT[o.agentId];
      if (rt) { rt.rim.t = 1; rt.pop.x = 0.9; rt.pop.v = 0; }
      parts.push({ type: 'ring', wx: o.to.wx, wy: o.to.wy, wz: o.to.wz, accent: o.accent, life: 0, max: 0.16 });
    } else {
      mgr.halo.x = Math.min(1.3, mgr.halo.x + 0.28);
      mgr.pop.x = -0.35; mgr.pop.v = 0;
      parts.push({ type: 'ring', wx: o.to.wx, wy: o.to.wy, wz: o.to.wz, accent: PAL.keyGlow, life: 0, max: 0.18 });
    }
  }

  /* ==========================================================
     15. PARTICLES + MOONLIGHT MOTES
     ========================================================== */
  function spawnSparkles(id) {
    var mv = MV[id], A = AGENTS[id], n = reduced ? 3 : 5, i;
    for (i = 0; i < n; i++) {
      if (parts.length >= PART_CAP) break;
      parts.push({ type: 'sparkle', accent: A.accent, life: 0, max: 0.55 + Math.random() * 0.25, wx: mv.wx + (Math.random() - 0.5) * 0.7, wy: mv.wy + (Math.random() - 0.5) * 0.4, wz: (mv.z || 0) + 1.1 + Math.random() * 0.5, vz: 0.9 + Math.random() * 0.6, rot: Math.random() * Math.PI, sz: 3 + Math.random() * 2.5 });
    }
    parts.push({ type: 'check', accent: A.accent, life: 0, max: 0.9, wx: mv.wx, wy: mv.wy, wz: (mv.z || 0) + 1.35 });
  }
  function spawnSonar() { var c = moverChest('manager'); parts.push({ type: 'sonar', wx: c.wx, wy: c.wy, wz: c.wz - 0.1, life: 0, max: 0.9 }); }

  var GLYPHS = ['{ }', '</>', '01', ';;', '#', 'fn', '()', '==', '*'];
  function updateParts(dt) {
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.life += dt;
      if (p.type === 'sparkle' || p.type === 'thought' || p.type === 'glyph') p.wz += (p.vz || 0.8) * dt;
      if (p.life >= p.max) parts.splice(i, 1);
    }
    // working thought-dots + code glyphs above active props
    for (var s = 0; s < SPECIALISTS.length; s++) {
      var id = SPECIALISTS[s], rt = RT[id], mv = MV[id];
      if (!rt) continue;
      var working = (rt.state === 'working' || rt.state === 'searching') && !mv.moving && (mv.task === 'atwork' || mv.task === 'workstep');
      if (!working) continue;
      rt.thoughtT -= dt; rt.glyphT -= dt;
      var A = AGENTS[id];
      if (rt.thoughtT <= 0 && parts.length < PART_CAP) { rt.thoughtT = 1.0 + Math.random() * 0.6; parts.push({ type: 'thought', accent: A.accent, life: 0, max: 0.9, wx: mv.wx + 0.35, wy: mv.wy - 0.1, wz: (mv.z || 0) + 1.15, vz: 0.7, r: 2.2 }); }
      if (rt.glyphT <= 0 && parts.length < PART_CAP) { rt.glyphT = 0.5 + Math.random() * 0.5; parts.push({ type: 'glyph', accent: A.accent, life: 0, max: 1.2, wx: mv.wx + (Math.random() - 0.5) * 0.5, wy: mv.wy - 0.15, wz: (mv.z || 0) + 1.3, vz: 0.9, ch: GLYPHS[(Math.random() * GLYPHS.length) | 0] }); }
    }
  }

  // Moonlight parallelograms (cool floor wash through the meeting-room glass)
  var MOON = [
    { p: [{ wx: 22, wy: 11 }, { wx: 27, wy: 11 }, { wx: 30, wy: 24 }, { wx: 23, wy: 24 }] },
    { p: [{ wx: 2, wy: 20 }, { wx: 7, wy: 20 }, { wx: 9, wy: 31 }, { wx: 3, wy: 31 }] }
  ];
  function seedMotes() {
    motes.length = 0;
    var count = reduced ? 8 : 18, i;
    for (i = 0; i < count; i++) motes.push(newMote());
  }
  function newMote() {
    var sh = MOON[(Math.random() * MOON.length) | 0];
    return { sh: sh, u: Math.random(), v: Math.random(), ph: Math.random() * Math.PI * 2, sp: 0.02 + Math.random() * 0.04, r: 0.5 + Math.random() * 1.0 };
  }
  function updateMotes(dt) {
    if (reduced) dt *= 0.6;
    for (var i = 0; i < motes.length; i++) {
      var m = motes[i];
      m.v -= m.sp * dt; m.u += Math.sin(time * 0.3 + m.ph) * 0.02 * dt; m.ph += dt;
      if (m.v < -0.05) { motes[i] = newMote(); motes[i].v = 1.05; }
    }
  }
  function shaftPoint(sh, u, v) {
    var p = sh.p;
    var ax = lerp(p[0].wx, p[1].wx, u), ay = lerp(p[0].wy, p[1].wy, u);
    var bx = lerp(p[3].wx, p[2].wx, u), by = lerp(p[3].wy, p[2].wy, u);
    return { wx: lerp(ax, bx, v), wy: lerp(ay, by, v) };
  }

  /* ==========================================================
     16. LOW-LEVEL DRAW HELPERS
     ========================================================== */
  function poly(pts) { ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y); ctx.closePath(); }
  function fillPoly(pts, color, a) { poly(pts); ctx.fillStyle = (a == null) ? col(color) : rgba(color, a); ctx.fill(); }
  function line(p1, p2) { ctx.beginPath(); ctx.moveTo(Math.round(p1.x) + 0.5, Math.round(p1.y) + 0.5); ctx.lineTo(Math.round(p2.x) + 0.5, Math.round(p2.y) + 0.5); ctx.stroke(); }
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
    var steps = 40, i, t, ct, st, x, y;
    ctx.beginPath();
    for (i = 0; i <= steps; i++) {
      t = i / steps * Math.PI * 2; ct = Math.cos(t); st = Math.sin(t);
      x = cx + Math.sign(ct) * Math.pow(Math.abs(ct), 2 / n) * a;
      y = cy + Math.sign(st) * Math.pow(Math.abs(st), 2 / n) * b;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }
  function isoBox(cx, cy, zb, hw, hd, hz, topC, leftC, rightC) {
    var tp = function (x, y) { return iso(x, y, zb + hz); };
    var bt = function (x, y) { return iso(x, y, zb); };
    fillPoly([tp(cx + hw, cy - hd), tp(cx + hw, cy + hd), bt(cx + hw, cy + hd), bt(cx + hw, cy - hd)], rightC);
    fillPoly([tp(cx - hw, cy + hd), tp(cx + hw, cy + hd), bt(cx + hw, cy + hd), bt(cx - hw, cy + hd)], leftC);
    fillPoly([tp(cx - hw, cy - hd), tp(cx + hw, cy - hd), tp(cx + hw, cy + hd), tp(cx - hw, cy + hd)], topC);
  }
  function contactShadow(sx, sy, w, h, alpha) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.translate(sx, sy);
    var g = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(w, h) / 2 || 1);
    g.addColorStop(0, rgba(PAL.contact, alpha));
    g.addColorStop(0.7, rgba(PAL.contact, alpha * 0.7));
    g.addColorStop(1, rgba(PAL.contact, 0));
    ctx.scale(1, h / w);
    ctx.beginPath(); ctx.arc(0, 0, w / 2, 0, Math.PI * 2);
    ctx.fillStyle = g; ctx.fill();
    ctx.restore();
  }

  /* ==========================================================
     17. STATIC SCENE (floor + walls + mounted decor + glass room)
        Drawn either into the offscreen cache (full) or directly
        (culled) as a robust fallback.
     ========================================================== */
  function drawStaticScene(range) {
    drawFloor(range);
    drawZoneHairlines();
    drawDaisRug();
    drawLoungeRug();
    drawWalls(range);
    drawWhiteboard();
    drawBookshelf();
    drawServerRacks();
    drawGlassRoom();
  }

  function drawFloor(r) {
    // base gradient over the whole floor diamond (single fill)
    var a = iso(0, 0, 0), b = iso(WORLD_W, 0, 0), c = iso(WORLD_W, WORLD_D, 0), d = iso(0, WORLD_D, 0);
    var g = ctx.createLinearGradient(0, Math.min(a.y, b.y), 0, Math.max(c.y, d.y));
    g.addColorStop(0, col(PAL.floorFar));
    g.addColorStop(1, col(PAL.floorNear));
    poly([a, b, c, d]); ctx.fillStyle = g; ctx.fill();

    // alternating checker (batched into one path, low alpha)
    var x0 = r.x0, x1 = r.x1, y0 = r.y0, y1 = r.y1, x, y;
    ctx.beginPath();
    for (x = x0; x <= x1; x++) for (y = y0; y <= y1; y++) {
      if ((x + y) & 1) {
        var p0 = iso(x, y), p1 = iso(x + 1, y), p2 = iso(x + 1, y + 1), p3 = iso(x, y + 1);
        ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.closePath();
      }
    }
    ctx.fillStyle = rgba(PAL.floorTile, 0.35); ctx.fill();

    // plank seams (batched strokes)
    ctx.strokeStyle = PAL.seam; ctx.lineWidth = 1;
    ctx.beginPath();
    for (x = x0; x <= x1 + 1; x++) { var s1 = iso(x, y0), s2 = iso(x, y1 + 1); ctx.moveTo(Math.round(s1.x) + 0.5, Math.round(s1.y) + 0.5); ctx.lineTo(Math.round(s2.x) + 0.5, Math.round(s2.y) + 0.5); }
    for (y = y0; y <= y1 + 1; y++) { var t1 = iso(x0, y), t2 = iso(x1 + 1, y); ctx.moveTo(Math.round(t1.x) + 0.5, Math.round(t1.y) + 0.5); ctx.lineTo(Math.round(t2.x) + 0.5, Math.round(t2.y) + 0.5); }
    ctx.stroke();
  }

  function zoneStroke(x0, y0, x1, y1) {
    poly([iso(x0, y0), iso(x1, y0), iso(x1, y1), iso(x0, y1)]);
    ctx.strokeStyle = PAL.seamZone; ctx.lineWidth = 1; ctx.stroke();
  }
  function drawZoneHairlines() {
    zoneStroke(27, 1, 39, 11);   // meeting room
    zoneStroke(2, 22, 12, 30);   // lounge
    zoneStroke(30, 22, 38, 30);  // kitchenette
    zoneStroke(1, 1, 6, 5);      // server nook
  }

  function drawWalls(r) {
    // back wall (y=0), side wall (x=0)
    drawWall('y', 0, WORLD_W, PAL.wallBack, PAL.wallBackBot);
    drawWall('x', 0, WORLD_D, PAL.wallSide, PAL.wallSideBot);
  }
  function drawWall(axis, a0, a1, top, bot) {
    var tp, bt;
    if (axis === 'y') { tp = function (t) { return iso(t, 0, WALL_H); }; bt = function (t) { return iso(t, 0, 0); }; }
    else { tp = function (t) { return iso(0, t, WALL_H); }; bt = function (t) { return iso(0, t, 0); }; }
    var A = tp(a0), B = tp(a1), C = bt(a1), D = bt(a0);
    var g = ctx.createLinearGradient(0, A.y, 0, C.y);
    g.addColorStop(0, col(top)); g.addColorStop(1, col(bot));
    poly([A, B, C, D]); ctx.fillStyle = g; ctx.fill();
    // baseboard
    var bbH = 0.14;
    var b1 = (axis === 'y') ? iso(a0, 0, bbH) : iso(0, a0, bbH);
    var b2 = (axis === 'y') ? iso(a1, 0, bbH) : iso(0, a1, bbH);
    poly([b1, b2, C, D]); ctx.fillStyle = col(PAL.baseboard); ctx.fill();
    // top-edge highlight hairline
    ctx.strokeStyle = PAL.wallEdge; ctx.lineWidth = 1; line(A, B);
  }

  function drawWhiteboard() {
    // mounted on the y=0 wall, span x13..24, a quiet dark panel
    var x0 = 13, x1 = 24, z0 = 1.1, z1 = 2.35;
    var A = iso(x0, 0, z1), B = iso(x1, 0, z1), C = iso(x1, 0, z0), D = iso(x0, 0, z0);
    poly([A, B, C, D]); ctx.fillStyle = col(PAL.whiteboard); ctx.fill();
    ctx.strokeStyle = PAL.boardEdge; ctx.lineWidth = 1.5; poly([A, B, C, D]); ctx.stroke();
    // faint marker strokes
    ctx.strokeStyle = rgba('#8FA8CC', 0.16); ctx.lineWidth = 1;
    line(iso(14.2, 0, 1.9), iso(18.0, 0, 1.9));
    line(iso(14.2, 0, 1.6), iso(20.5, 0, 1.6));
    line(iso(19.5, 0, 2.05), iso(23.2, 0, 2.05));
    // a few sparse accent sticky notes (<=4)
    var notes = [ACCENTS.docs, ACCENTS.marketing, ACCENTS.manager, ACCENTS.inbox];
    for (var i = 0; i < 4; i++) {
      var s = iso(15 + i * 2.1, 0, 1.35 + (i % 2) * 0.5);
      ctx.save(); ctx.translate(s.x, s.y);
      roundRect(-4.5 * zoom, -4.5 * zoom, 9 * zoom, 8 * zoom, 1.5 * zoom);
      ctx.fillStyle = rgba(notes[i], 0.55); ctx.fill();
      ctx.restore();
    }
  }

  function drawBookshelf() {
    // mounted on x=0 wall, y13..17 — three thin shelves w/ book ticks
    var y0 = 13, y1 = 17;
    for (var sh = 0; sh < 3; sh++) {
      var z = 0.7 + sh * 0.55;
      var A = iso(0, y0, z + 0.06), B = iso(0, y1, z + 0.06), C = iso(0, y1, z), D = iso(0, y0, z);
      poly([A, B, C, D]); ctx.fillStyle = col(darken(PAL.wallSide, 0.2)); ctx.fill();
      ctx.strokeStyle = PAL.wallEdge; ctx.lineWidth = 1; line(A, B);
      // book ticks
      for (var k = 0; k < 8; k++) {
        var yy = y0 + 0.4 + k * ((y1 - y0 - 0.6) / 7);
        ctx.strokeStyle = rgba('#3A404B', 0.5); ctx.lineWidth = 1.4;
        line(iso(0, yy, z + 0.06), iso(0, yy, z + 0.42));
      }
    }
  }

  function drawServerRacks() {
    var xs = [2, 3, 4];
    for (var i = 0; i < xs.length; i++) {
      var cx = xs[i] + 0.5, cy = 1.5;
      isoBox(cx, cy, 0, 0.34, 0.32, 2.2, PAL.rack, darken(PAL.rack, 0.25), darken(PAL.rack, 0.4));
      // faint front seam lines (unit slots)
      var f0 = iso(cx - 0.3, cy + 0.3, 0.2), f1 = iso(cx + 0.3, cy + 0.3, 0.2);
      ctx.strokeStyle = rgba('#000000', 0.4); ctx.lineWidth = 1;
      for (var s = 1; s <= 5; s++) { var zz = 0.2 + s * 0.35; line(iso(cx - 0.3, cy + 0.3, zz), iso(cx + 0.3, cy + 0.3, zz)); }
    }
  }

  function drawGlassRoom() {
    // west wall (x=27, y1..11) and south wall (y=11, x27..39), framed glass, door gap y9..10
    var z1 = 2.0;
    // long table (inside — never entered)
    isoBox(33.5, 6.0, 0, 3.4, 1.9, 0.42, PAL.deskTop, PAL.deskLeft, PAL.deskRight);
    ctx.strokeStyle = rgba('#8FA8CC', 0.10); ctx.lineWidth = 1; line(iso(30.2, 4.2, 0.42), iso(36.8, 4.2, 0.42));
    // chairs (discs) around the table
    var chairs = [[31, 4], [33.5, 4], [36, 4], [31, 8], [33.5, 8], [36, 8]];
    for (var c = 0; c < chairs.length; c++) drawStoolDisc(chairs[c][0], chairs[c][1], 0.28);

    // glass panes (translucent) + frames — west
    glassPanel('x', 27, 1, 9, z1);       // above the door
    glassPanel('x', 27, 10, 11, z1);     // below the door (y10..11)
    // south
    glassPanel('y', 11, 27, 39, z1);
    // top rails + posts (thin frames)
    frameEdge('x', 27, 1, 11, z1);
    frameEdge('y', 11, 27, 39, z1);
  }
  function glassPanel(axis, fixed, a0, a1, z1) {
    var A, B, C, D;
    if (axis === 'x') { A = iso(fixed, a0, z1); B = iso(fixed, a1, z1); C = iso(fixed, a1, 0); D = iso(fixed, a0, 0); }
    else { A = iso(a0, fixed, z1); B = iso(a1, fixed, z1); C = iso(a1, fixed, 0); D = iso(a0, fixed, 0); }
    poly([A, B, C, D]); ctx.fillStyle = PAL.glassPane; ctx.fill();
    // single highlight line per panel
    ctx.strokeStyle = PAL.glassEdge; ctx.lineWidth = 1; line(A, B);
    // faint interior cool wash near the base
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    poly([A, B, C, D]); ctx.fillStyle = rgba(PAL.moonPane, 0.03); ctx.fill();
    ctx.restore();
  }
  function frameEdge(axis, fixed, a0, a1, z1) {
    ctx.strokeStyle = col(PAL.glassFrame); ctx.lineWidth = 2;
    var top0, top1;
    if (axis === 'x') { top0 = iso(fixed, a0, z1); top1 = iso(fixed, a1, z1); }
    else { top0 = iso(a0, fixed, z1); top1 = iso(a1, fixed, z1); }
    line(top0, top1);
    // vertical posts
    var posts = axis === 'x' ? [a0, a1] : [a0, a1];
    for (var i = 0; i < posts.length; i++) {
      var t = posts[i];
      var pt = (axis === 'x') ? iso(fixed, t, z1) : iso(t, fixed, z1);
      var pb = (axis === 'x') ? iso(fixed, t, 0) : iso(t, fixed, 0);
      line(pt, pb);
    }
  }

  function drawDaisRug() {
    // Nova dais riser (x=20, y9..10) + rug + floor ring — the one saturated floor accent
    var cx = 20.5, cy = 9.5;
    isoBox(cx, cy, 0, 0.56, 1.05, 0.30, PAL.deskTop, PAL.deskLeft, PAL.deskRight);
    // rug on top of the dais
    var z = 0.30, rw = 0.44, rd = 0.9;
    var r0 = iso(cx - rw, cy - rd, z), r1 = iso(cx + rw, cy - rd, z), r2 = iso(cx + rw, cy + rd, z), r3 = iso(cx - rw, cy + rd, z);
    poly([r0, r1, r2, r3]); ctx.fillStyle = col(PAL.rug); ctx.fill();
    ctx.strokeStyle = rgba(ACCENTS.manager, 0.5); ctx.lineWidth = 1.5; poly([r0, r1, r2, r3]); ctx.stroke();
    // Nova-blue floor ring around the dais
    drawIsoRing(cx, cy, 1.75, 1.6, ACCENTS.manager, 1.6, 0.22);
  }
  function drawIsoRing(cx, cy, rx, ry, color, w, a) {
    ctx.save();
    var s = iso(cx, cy, 0);
    ctx.translate(s.x, s.y); ctx.scale(1, HALF_H / HALF_W);
    ctx.beginPath(); ctx.arc(0, 0, rx * HALF_W * zoom, 0, Math.PI * 2);
    ctx.lineWidth = w * zoom; ctx.strokeStyle = rgba(color, a == null ? 0.8 : a); ctx.stroke();
    ctx.restore();
  }
  function drawLoungeRug() {
    var x0 = 3, x1 = 10, y0 = 23, y1 = 29, z = 0.02;
    var r0 = iso(x0, y0, z), r1 = iso(x1, y0, z), r2 = iso(x1, y1, z), r3 = iso(x0, y1, z);
    poly([r0, r1, r2, r3]); ctx.fillStyle = col(PAL.rug); ctx.fill();
    // subtle woven hairlines + one accent piping (Nova-blue)
    ctx.save(); poly([r0, r1, r2, r3]); ctx.clip();
    ctx.strokeStyle = rgba('#ffffff', 0.03); ctx.lineWidth = 1;
    for (var gx = x0; gx <= x1; gx += 0.6) line(iso(gx, y0, z), iso(gx, y1, z));
    ctx.restore();
    ctx.strokeStyle = rgba(ACCENTS.manager, 0.28); ctx.lineWidth = 1.4; poly([r0, r1, r2, r3]); ctx.stroke();
  }

  /* ==========================================================
     18. OFFSCREEN STATIC CACHE
     ========================================================== */
  function invalidateCache() { cacheReady = false; zoomDirty = true; lastZoomChange = time; }
  function buildCache() {
    zoomDirty = false;
    if (!USE_CACHE) { cacheReady = false; return; }
    var cwCss = worldScreenW() * zoom, chCss = worldScreenH() * zoom;
    var pxW = Math.ceil(cwCss * dpr), pxH = Math.ceil(chCss * dpr);
    if (pxW < 1 || pxH < 1 || pxW > 4096 || pxH > 4096) { cacheReady = false; return; }
    try {
      if (!cacheCanvas) { cacheCanvas = document.createElement('canvas'); cacheCtx = cacheCanvas.getContext('2d'); }
      if (!cacheCtx) { cacheReady = false; return; }
      cacheCanvas.width = pxW; cacheCanvas.height = pxH;
      cacheW = cwCss; cacheH = chCss;

      var sc = ctx, sox = originX, soy = originY, spx = camPanX, spy = camPanY;
      ctx = cacheCtx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cwCss, chCss);
      originX = WORLD_D * HALF_W * zoom; originY = WALL_H * TILE_Z * zoom; camPanX = 0; camPanY = 0;
      drawStaticScene({ x0: 0, x1: WORLD_W - 1, y0: 0, y1: WORLD_D - 1 });
      ctx = sc; originX = sox; originY = soy; camPanX = spx; camPanY = spy;

      cacheReady = true; cacheZoom = zoom;
    } catch (e) { cacheReady = false; }
  }
  function blitCache() {
    var blitOffsetX = originX + camPanX - WORLD_D * HALF_W * zoom;
    var blitOffsetY = originY + camPanY - WALL_H * TILE_Z * zoom;
    var srcX = clamp(-blitOffsetX, 0, cacheW), srcR = clamp(cssW - blitOffsetX, 0, cacheW);
    var srcY = clamp(-blitOffsetY, 0, cacheH), srcB = clamp(cssH - blitOffsetY, 0, cacheH);
    var w = srcR - srcX, h = srcB - srcY;
    if (w <= 0 || h <= 0) return;
    ctx.drawImage(cacheCanvas, srcX * dpr, srcY * dpr, w * dpr, h * dpr, srcX + blitOffsetX, srcY + blitOffsetY, w, h);
  }

  /* ==========================================================
     19. FLOOR OVERLAY (moonlight + motes + rack LEDs) — under actors
     ========================================================== */
  function drawFloorOverlay() {
    // moonlight parallelograms (cool, dim, slow drift)
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    var drift = reduced ? 0 : Math.sin(time * (Math.PI * 2 / 26)) * 1.5;
    for (var i = 0; i < MOON.length; i++) {
      var sh = MOON[i], p = sh.p;
      var s0 = iso(p[0].wx, p[0].wy), s1 = iso(p[1].wx, p[1].wy), s2 = iso(p[2].wx, p[2].wy), s3 = iso(p[3].wx, p[3].wy);
      var g = ctx.createLinearGradient((s0.x + s1.x) / 2 + drift, (s0.y + s1.y) / 2, (s2.x + s3.x) / 2 + drift, (s2.y + s3.y) / 2);
      g.addColorStop(0, rgba(PAL.moonPane, 0.09)); g.addColorStop(0.5, rgba(PAL.moonPane, 0.04)); g.addColorStop(1, rgba(PAL.moonPane, 0));
      ctx.save(); ctx.translate(drift, 0); poly([s0, s1, s2, s3]); ctx.fillStyle = g; ctx.fill(); ctx.restore();
    }
    // dust motes in the moonlight
    for (var m = 0; m < motes.length; m++) {
      var mt = motes[m]; if (mt.v < 0 || mt.v > 1) continue;
      var w = shaftPoint(mt.sh, mt.u, mt.v);
      var s = iso(w.wx, w.wy, 0.1 + (1 - mt.v) * 0.6);
      var tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(mt.ph * 2));
      var a = tw * 0.3 * (1 - Math.abs(mt.v - 0.5) * 0.7);
      ctx.beginPath(); ctx.arc(s.x, s.y, mt.r * zoom, 0, Math.PI * 2); ctx.fillStyle = rgba(PAL.keyGlow, a); ctx.fill();
    }
    ctx.restore();

    // server rack LEDs (only cyan in furniture) — slow blink
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    var xs = [2, 3, 4];
    for (var r = 0; r < xs.length; r++) {
      var cx = xs[r] + 0.5;
      for (var k = 0; k < 4; k++) {
        var zz = 0.6 + k * 0.4;
        var blink = 0.35 + 0.4 * (0.5 + 0.5 * Math.sin(time * (1.6 + k * 0.4) + r));
        var s = iso(cx + 0.24, 1.8, zz);
        ctx.beginPath(); ctx.arc(s.x, s.y, 1.4 * zoom, 0, Math.PI * 2); ctx.fillStyle = rgba(PAL.rackLED, blink); ctx.fill();
      }
    }
    ctx.restore();

    // coffee point amber glow (the one warm point)
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    var cs = iso(POI_COFFEE[0] + 0.2, 29.6, 0.55);
    var cg = ctx.createRadialGradient(cs.x, cs.y, 1, cs.x, cs.y, 22 * zoom);
    cg.addColorStop(0, rgba(PAL.amber, 0.28)); cg.addColorStop(1, rgba(PAL.amber, 0));
    ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(cs.x, cs.y, 22 * zoom, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  /* ==========================================================
     20. SORTABLE ENTITIES (desks, actors, free furniture, orbs)
     ========================================================== */
  function onScreen(cx, cy, radPx) {
    return cx > -radPx && cx < cssW + radPx && cy > -radPx && cy < cssH + radPx;
  }

  function buildDrawList() {
    var list = [];
    var i;
    // desk clusters + actors
    for (i = 0; i < IDS.length; i++) {
      var id = IDS[i], L = LAY[id], mv = MV[id];
      list.push({ depth: L.desk.wx + L.desk.wy, z: LAY[id].z, kind: 'desk', id: id });
      list.push({ depth: mv.wx + mv.wy + 0.001, z: (mv.z || 0) + 2, kind: 'actor', id: id });
    }
    // planters
    for (i = 0; i < PLANTERS.length; i++) { var pl = PLANTERS[i]; list.push({ depth: pl[0] + 0.5 + pl[1] + 0.5, z: 1, kind: 'planter', x: pl[0], y: pl[1] }); }
    list.push({ depth: MONSTERA[0] + 0.5 + MONSTERA[1] + 0.5, z: 2, kind: 'monstera', x: MONSTERA[0], y: MONSTERA[1] });
    // lounge
    list.push({ depth: 7 + 24, z: 1, kind: 'sofa' });
    list.push({ depth: 8.5 + 26.5, z: 0.5, kind: 'lowtable' });
    list.push({ depth: 10.5 + 29.5, z: 0.3, kind: 'cushion' });
    // kitchenette
    list.push({ depth: 37 + 30, z: 1, kind: 'counter' });
    list.push({ depth: 32.5 + 28.5, z: 0.5, kind: 'stool', x: 32, y: 28 });
    list.push({ depth: 34.5 + 28.5, z: 0.5, kind: 'stool', x: 34, y: 28 });
    list.push({ depth: POI_COFFEE[0] + 0.5 + 30.5, z: 1, kind: 'coffee' });
    // printer
    list.push({ depth: 34.5 + 19.5, z: 0.6, kind: 'printer', x: 34, y: 19 });
    // orbs (interpolated depth, small bias to ride above floor decor)
    for (i = 0; i < orbs.length; i++) {
      var o = orbs[i], e = easeOrb(clamp(o.t, 0, 1));
      list.push({ depth: quadW(o.from, o.ctrl, o.to, e, 'wx') + quadW(o.from, o.ctrl, o.to, e, 'wy') + 0.05, z: 3, kind: 'orb', orb: o });
    }
    list.sort(function (a, b) { return (a.depth - b.depth) || (a.z - b.z); });
    return list;
  }

  function drawEntity(en) {
    switch (en.kind) {
      case 'desk': drawDeskEntity(en.id); break;
      case 'actor': drawActor(en.id); break;
      case 'planter': drawPlanter(en.x, en.y, false); break;
      case 'monstera': drawMonstera(en.x, en.y); break;
      case 'sofa': drawSofa(); break;
      case 'lowtable': drawLowTable(); break;
      case 'cushion': drawCushion(); break;
      case 'counter': drawCounter(); break;
      case 'stool': drawStool(en.x, en.y); break;
      case 'coffee': drawCoffeeMachine(); break;
      case 'printer': drawPrinter(en.x, en.y); break;
      case 'orb': drawOrb(en.orb); break;
    }
  }

  /* ==========================================================
     21. DESK ENTITY (chair, desk prism, monitor, mug, rest prop)
     ========================================================== */
  function drawDeskEntity(id) {
    var A = AGENTS[id], rt = RT[id], L = LAY[id], mv = MV[id];
    var isNova = id === 'manager';
    var dc = iso(L.desk.wx, L.desk.wy, L.z);
    if (!onScreen(dc.x, dc.y, 120 * zoom)) return;

    // cool key desk pool when active (replaces warm lamp)
    if (rt.lamp.x > 0.01) drawDeskPool(L.desk, L.z, rt.lamp.x, A.accent);

    // desk shadow
    var dsc = iso(L.desk.wx, L.desk.wy + 0.2, 0);
    contactShadow(dsc.x, dsc.y, 100 * zoom, 40 * zoom, 0.24);

    // chair behind desk
    drawChair(L.chair, L.z);

    if (isNova) {
      drawRoundDesk(L.desk, L.z, A.accent);
    } else {
      var rimA = clamp((rt.rim.x - 0.18) / 0.82, 0, 1);
      drawDesk(L.desk, L.z, A.accent, 0.12 + rimA * 0.73);
      drawMonitor(id);
    }
    drawMug(L.mug, L.z);
    drawSteam(L.mug, L.z, rt);
    // resting prop when idle & home
    if (!isNova && rt.state === 'idle' && atHome(id) && !mv.moving) drawRestProp(id, L.mug, L.z);
  }

  function drawChair(t, z) {
    isoBox(t.wx, t.wy, z, 0.28, 0.26, 0.40, PAL.chair, darken(PAL.chair, 0.1), darken(PAL.chair, 0.18));
    var s = iso(t.wx, t.wy - 0.18, z + 0.40);
    ctx.save(); ctx.translate(s.x, s.y);
    roundRect(-13 * zoom, -24 * zoom, 26 * zoom, 28 * zoom, 7 * zoom);
    ctx.fillStyle = col(darken(PAL.chair, 0.05)); ctx.fill();
    ctx.restore();
  }

  function drawDesk(t, z, accent, inlayA) {
    isoBox(t.wx, t.wy, z, 0.46, 0.42, 0.5, PAL.deskTop, PAL.deskLeft, PAL.deskRight);
    var fl = iso(t.wx - 0.46, t.wy + 0.42, z + 0.5), fr = iso(t.wx + 0.46, t.wy + 0.42, z + 0.5);
    ctx.strokeStyle = rgba('#000000', 0.5); ctx.lineWidth = 2; line(fl, fr);
    var ia = iso(t.wx - 0.44, t.wy + 0.40, z + 0.5), ib = iso(t.wx + 0.44, t.wy + 0.40, z + 0.5);
    ctx.strokeStyle = rgba(accent, inlayA); ctx.lineWidth = 1.5; line(ia, ib);
  }

  function drawRoundDesk(t, z, accent) {
    var s = iso(t.wx, t.wy, z);
    var rx = 0.7 * HALF_W * zoom, ry = rx * (HALF_H / HALF_W);
    ctx.beginPath(); ctx.ellipse(s.x, s.y + 8 * zoom, rx, ry, 0, 0, Math.PI * 2); ctx.fillStyle = col(PAL.deskRight); ctx.fill();
    var g = ctx.createRadialGradient(s.x - rx * 0.3, s.y - ry * 0.3, 2, s.x, s.y, rx);
    g.addColorStop(0, col(lighten(PAL.deskTop, 0.06))); g.addColorStop(1, col(PAL.deskTop));
    ctx.beginPath(); ctx.ellipse(s.x, s.y, rx, ry, 0, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
    ctx.lineWidth = 1.5 * zoom; ctx.strokeStyle = rgba(accent, 0.35); ctx.stroke();
    var c = iso(t.wx, t.wy - 0.05, z);
    ctx.strokeStyle = rgba(accent, 0.4 + 0.2 * Math.sin(time * 3)); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(c.x - 9 * zoom, c.y); ctx.lineTo(c.x + 9 * zoom, c.y); ctx.stroke();
  }

  function drawDeskPool(t, z, k, accent) {
    var s = iso(t.wx, t.wy + 0.35, 0);
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    var g = ctx.createRadialGradient(s.x, s.y, 2, s.x, s.y, 54 * zoom);
    g.addColorStop(0, rgba(accent, 0.16 * k)); g.addColorStop(1, rgba(accent, 0));
    ctx.fillStyle = g; ctx.translate(s.x, s.y); ctx.scale(1, 0.5);
    ctx.beginPath(); ctx.arc(0, 0, 54 * zoom, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawMug(t, z) {
    var s = iso(t.wx, t.wy, z + 0.5);
    ctx.save(); ctx.translate(s.x, s.y);
    roundRect(-3.5 * zoom, -8 * zoom, 7 * zoom, 8 * zoom, 2 * zoom); ctx.fillStyle = col(PAL.counter); ctx.fill();
    ctx.beginPath(); ctx.ellipse(0, -8 * zoom, 3.5 * zoom, 1.4 * zoom, 0, 0, Math.PI * 2); ctx.fillStyle = col(darken(PAL.counter, 0.25)); ctx.fill();
    ctx.beginPath(); ctx.arc(4.5 * zoom, -4.5 * zoom, 2.2 * zoom, -1.2, 1.2); ctx.lineWidth = 1.3 * zoom; ctx.strokeStyle = col(PAL.counter); ctx.stroke();
    ctx.restore();
  }
  function drawSteam(t, z, rt) {
    if (reduced) return;
    var s = iso(t.wx, t.wy, z + 0.5);
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.translate(s.x, s.y - 9 * zoom);
    for (var i = 0; i < 2; i++) {
      var ph = time * 1.2 + i * 2 + rt.steamT * 6;
      ctx.beginPath();
      for (var y = 0; y <= 12; y += 2) { var wob = Math.sin(ph - y * 0.35) * (2 + y * 0.18) * zoom; var xx = (i ? 2 : -2) * zoom + wob; if (y === 0) ctx.moveTo(xx, -y * zoom); else ctx.lineTo(xx, -y * zoom); }
      ctx.strokeStyle = rgba(PAL.keyGlow, 0.06 * (0.6 + 0.4 * Math.sin(ph))); ctx.lineWidth = 2.4 * zoom; ctx.lineCap = 'round'; ctx.stroke();
    }
    ctx.restore();
  }

  function drawMonitor(id) {
    var A = AGENTS[id], rt = RT[id], L = LAY[id];
    var base = iso(L.mon.wx, L.mon.wy, L.z + 0.5);
    if (!onScreen(base.x, base.y, 80 * zoom)) return;
    ctx.save(); ctx.translate(base.x, base.y);
    ctx.fillStyle = col(darken(PAL.deskRight, 0.2)); roundRect(-3 * zoom, -6 * zoom, 6 * zoom, 6 * zoom, 1.5 * zoom); ctx.fill();
    var sw = 34 * zoom, sh = 16 * zoom, sy = -6 * zoom;
    roundRect(-sw / 2, sy - sh, sw, sh, 3.5 * zoom); ctx.fillStyle = col(darken(PAL.deskRight, 0.3)); ctx.fill();
    var inset = 2.6 * zoom, glow = rt.mon.x;
    var flick = 0.5 + 0.5 * Math.sin(time * 13 + id.length) + 0.3 * Math.sin(time * 37);
    var screenGlow = glow > 0.05 ? glow * (0.75 + 0.25 * clamp(flick, 0, 1)) : 0.05 * clamp(flick, 0, 1);
    roundRect(-sw / 2 + inset, sy - sh + inset, sw - inset * 2, sh - inset * 2, 2.6 * zoom); ctx.fillStyle = col(PAL.monitorDark); ctx.fill();
    if (screenGlow > 0.001) {
      ctx.save(); roundRect(-sw / 2 + inset, sy - sh + inset, sw - inset * 2, sh - inset * 2, 2.6 * zoom); ctx.clip();
      var g = ctx.createRadialGradient(0, sy - sh / 2, 2, 0, sy - sh / 2, sw * 0.6);
      g.addColorStop(0, rgba(A.accent, clamp(screenGlow, 0, 1))); g.addColorStop(1, rgba(A.accent, 0));
      ctx.fillStyle = g; ctx.fillRect(-sw / 2, sy - sh, sw, sh);
      ctx.strokeStyle = rgba(lighten(A.accent, 0.4), 0.25 * screenGlow); ctx.lineWidth = 1;
      for (var ln = 0; ln < 4; ln++) { var yy = sy - sh + 7 * zoom + ln * 4.5 * zoom; ctx.beginPath(); ctx.moveTo(-sw / 2 + 5 * zoom, yy); ctx.lineTo(-sw / 2 + (9 + (Math.sin(time * 2 + ln + id.length) * 0.5 + 0.5) * 22) * zoom, yy); ctx.stroke(); }
      if (rt.state === 'working' || rt.state === 'searching') { var pr = (time * 0.5) % 1; ctx.strokeStyle = rgba(lighten(A.accent, 0.3), 0.8); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(-sw / 2 + inset, sy - inset); ctx.lineTo(-sw / 2 + inset + (sw - inset * 2) * pr, sy - inset); ctx.stroke(); }
      ctx.restore();
      // additive spill onto the desktop
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      var sg = ctx.createRadialGradient(0, sy, 2, 0, sy, sw * 0.7);
      sg.addColorStop(0, rgba(A.accent, 0.10 * screenGlow)); sg.addColorStop(1, rgba(A.accent, 0));
      ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(0, sy + 2 * zoom, sw * 0.7, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  /* ==========================================================
     22. CHARACTERS (jellybean + walk cycle + facing)
     ========================================================== */
  function drawActor(id) {
    var A = AGENTS[id], rt = RT[id], mv = MV[id];
    var isNova = id === 'manager';
    var base = iso(mv.wx, mv.wy, mv.z || 0);
    var charScale = isNova ? 1.12 : 1.0;
    if (!onScreen(base.x, base.y, 90 * zoom)) return;

    var dim = (focusId && focusId !== id) ? 0.9 : 1.0;
    var desat = rt.desat.x, lift = rt.lift.x * zoom;

    var moving = mv.moving;
    var workPose = !moving && (rt.state === 'working' || rt.state === 'searching') && (mv.task === 'atwork' || mv.task === 'workstep');

    // bobs
    var breath = reduced ? 0 : Math.sin(rt.breath) * 0.02;
    var idleBob = reduced ? 0 : Math.sin(rt.breath) * 0.5;
    var walkBob = (moving && !reduced) ? Math.abs(Math.sin(mv.stepPhase)) * 2.2 : 0;
    var workBob = workPose ? Math.sin(rt.work * 2) * 1.3 : 0;
    var novaBob = 0;
    if (isNova) { if (mgr.state === 'speaking') novaBob = Math.sin(mgr.speakPh * 9) * 1.2; else if (mgr.state === 'thinking') novaBob = Math.sin(time * 1.4) * 0.6; }
    var bob = moving ? walkBob : (idleBob + workBob + novaBob);
    var bounce = rt.bounce.x;
    var pop = rt.pop.x;
    if (isNova) pop = 1 + mgr.pop.x;

    var feetY = base.y - bob * zoom + bounce * zoom - lift;
    var feetX = base.x;

    // contact shadow (follows feet, pulses with bob)
    var shW = 30 * charScale * zoom * (1.05 + (rt.lift.x > 0 ? 0.15 : 0)) * (2 - pop);
    contactShadow(feetX + 4 * zoom, base.y + 2 * zoom, shW * (1 - bob * 0.02), shW * 0.32, 0.22 + (rt.lift.x > 0 ? 0.06 : 0));

    // lean into travel / work
    var lean = 0;
    if (moving && !reduced) lean = Math.sin(mv.stepPhase) * 0.02;
    else if (workPose) lean = Math.sin(rt.work * 2) * 0.03;
    else if (isNova && mgr.state === 'thinking') lean = Math.sin(time) * 0.05;

    var facingBack = (mv.facing === 'NE' || mv.facing === 'NW');
    var facingSide = (mv.facing === 'SE' || mv.facing === 'NE') ? 1 : -1;

    var S = zoom * charScale;
    var sy = pop, sx = 1 / Math.sqrt(Math.max(0.3, pop));

    ctx.save();
    ctx.translate(feetX, feetY);
    ctx.rotate(lean);
    ctx.scale(S * sx, S * sy * (1 + breath));

    var bodyBase = desat > 0 ? desatC(PAL.beanBody, desat * 0.5) : PAL.beanBody;
    if (dim < 1) bodyBase = mulC(bodyBase, dim);

    var gait = {
      moving: moving, stepPhase: mv.stepPhase, facingBack: facingBack, facingSide: facingSide,
      workPose: workPose, armT: rt.arm.x, state: rt.state, propPh: rt.propPh
    };
    drawBeanBody(id, rt, bodyBase, A.accent, isNova, gait);
    ctx.restore();

    // held prop (working/searching only) — on the facing side hand
    if (!isNova && workPose) {
      var hx = feetX + facingSide * 20 * S, hy = feetY - 30 * S;
      drawProp(A.prop, hx, hy, S, A.accent, true, rt);
    }
    // delivering hand-off: a small result glyph travels in-hand
    if (!isNova && rt.walkDeliver && moving) {
      var gx = feetX + facingSide * 16 * S, gy = feetY - 34 * S;
      drawResultGlyph(gx, gy, S, A.accent);
    }

    // assigned "!" ping above head
    if (rt.ping > 0) drawPing(id, rt.ping, feetX, base.y);

    // Nova halo + thought bubble (bloom over her body)
    if (isNova) {
      drawHalo(feetX, feetY);
      if (mgr.state === 'thinking') drawThoughtBubble(feetX, feetY);
    }
  }

  function drawBeanBody(id, rt, bodyBase, accent, isNova, gait) {
    var a = 16, b = 22, legH = 7;
    var bodyCy = -(legH + b);

    // mirror for W-facing
    if (gait.facingSide < 0) ctx.scale(-1, 1);

    // ---- legs (walk cycle) ----
    var swing = 0, lift1 = 0, lift2 = 0;
    if (gait.moving && !reduced) {
      swing = Math.sin(gait.stepPhase) * 3.2;
      lift1 = Math.max(0, Math.sin(gait.stepPhase)) * 3;
      lift2 = Math.max(0, Math.sin(gait.stepPhase + Math.PI)) * 3;
    }
    ctx.fillStyle = col(darken(bodyBase, 0.12));
    roundRect(-8 + swing, -legH - lift2, 6.5, legH + 2, 3); ctx.fill();
    roundRect(1.5 - swing, -legH - lift1, 6.5, legH + 2, 3); ctx.fill();

    // ---- back nub / backpack (bigger when facing away) ----
    ctx.fillStyle = col(darken(bodyBase, 0.16));
    var nubR = gait.facingBack ? 8 : 6;
    ctx.beginPath(); ctx.ellipse(a * 0.7, bodyCy + 8, nubR, gait.facingBack ? 11 : 9, -0.2, 0, Math.PI * 2); ctx.fill();

    // ---- body capsule ----
    superPath(0, bodyCy, a, b, 4);
    var g = ctx.createLinearGradient(0, bodyCy - b, 0, bodyCy + b);
    g.addColorStop(0, col(lighten(bodyBase, 0.10)));
    g.addColorStop(0.5, col(bodyBase));
    g.addColorStop(1, col(darken(bodyBase, 0.08)));
    ctx.fillStyle = g; ctx.fill();

    // molded belly band
    ctx.save(); superPath(0, bodyCy, a, b, 4); ctx.clip();
    ctx.fillStyle = rgba(mulC(bodyBase, 0.82), 0.5);
    ctx.fillRect(-a, bodyCy - b + 0.14 * (2 * b), 2 * a, 3.2);
    ctx.restore();

    // soft inner shade
    ctx.save(); superPath(0, bodyCy, a, b, 4); ctx.clip();
    ctx.strokeStyle = rgba(mulC(bodyBase, 0.65), 0.9); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(3, bodyCy + 2, a - 1, -0.4, 1.7); ctx.stroke();
    ctx.restore();

    // ---- accent rim (the "I'm live" signal) 0.18 -> 1.0 ----
    superPath(0, bodyCy, a, b, 4);
    ctx.lineWidth = 1.5; ctx.strokeStyle = rgba(accent, clamp(rt.rim.x, 0, 1)); ctx.stroke();

    // ---- arms ----
    if (gait.moving && !reduced) {
      // opposite-phase walk swing
      var asw = Math.sin(gait.stepPhase) * 0.25;
      ctx.fillStyle = col(darken(bodyBase, 0.1));
      ctx.save(); ctx.translate(a * 0.55, bodyCy + 6); ctx.rotate(0.15 + asw); roundRect(-2.5, -2.5, 5, 12, 2.5); ctx.fill(); ctx.restore();
      ctx.save(); ctx.translate(-a * 0.55, bodyCy + 6); ctx.rotate(-0.15 + asw); roundRect(-2.5, -2.5, 5, 12, 2.5); ctx.fill(); ctx.restore();
    } else if (gait.armT > 0.02 && gait.workPose) {
      var armT = gait.armT;
      ctx.fillStyle = col(darken(bodyBase, 0.1));
      var typing = Math.abs(Math.sin(gait.propPh * 6)) * 3;
      ctx.save(); ctx.translate(a * 0.6, bodyCy + 4); ctx.rotate(0.6 * armT); roundRect(0, -3, 4 + 10 * armT, 6, 3); ctx.fill(); ctx.beginPath(); ctx.arc(4 + 10 * armT, typing, 3, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      ctx.save(); ctx.translate(-a * 0.6, bodyCy + 4); ctx.rotate(-0.6 * armT); roundRect(-4 - 10 * armT, -3, 4 + 10 * armT, 6, 3); ctx.fill(); ctx.beginPath(); ctx.arc(-4 - 10 * armT, -typing, 3, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }

    // ---- visor (front-facing only) ----
    if (!gait.facingBack) {
      drawVisor(id, rt, bodyCy, isNova);
      // blush + mouth (active / speaking)
      if (rt.rim.x > 0.6) {
        ctx.fillStyle = rgba(accent, 0.10 * clamp((rt.rim.x - 0.6) / 0.4, 0, 1));
        ctx.beginPath(); ctx.ellipse(-10, bodyCy + 1, 4, 3, 0, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.ellipse(10, bodyCy + 1, 4, 3, 0, 0, Math.PI * 2); ctx.fill();
      }
      var speaking = rt.speaking && (!isNova || mgr.speaking);
      if (speaking) {
        var open = 0.5 + 0.5 * Math.sin((isNova ? mgr.speakPh : rt.mouthPh) * 12);
        ctx.fillStyle = col('#0A0B0E');
        ctx.beginPath(); ctx.ellipse(0, bodyCy + 8, 3, 1.2 + open * 2.4, 0, 0, Math.PI * 2); ctx.fill();
      }
    } else {
      // back of head — a subtle seam
      ctx.strokeStyle = rgba(mulC(bodyBase, 0.6), 0.6); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, bodyCy - 10); ctx.lineTo(0, bodyCy - 2); ctx.stroke();
    }

    // ---- Nova antenna bead ----
    if (isNova) {
      ctx.strokeStyle = col(PAL.propWood); ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(0, bodyCy - b); ctx.lineTo(0, bodyCy - b - 7); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, bodyCy - b - 8.5, 2.4, 0, Math.PI * 2); ctx.fillStyle = col(lighten(accent, 0.1)); ctx.fill();
    }
  }

  function drawVisor(id, rt, bodyCy, isNova) {
    var vw = 17, vh = 8.5, vy = bodyCy - 6;
    roundRect(-vw / 2, vy - vh / 2, vw, vh, vh / 2); ctx.fillStyle = col(PAL.visor); ctx.fill();
    ctx.save(); roundRect(-vw / 2, vy - vh / 2, vw, vh, vh / 2); ctx.clip();
    var vg = ctx.createLinearGradient(0, vy - vh / 2, 0, vy + vh / 2);
    vg.addColorStop(0, rgba('#FFFFFF', 0.5)); vg.addColorStop(1, rgba('#9FB6D6', 0));
    ctx.fillStyle = vg; ctx.fillRect(-vw / 2, vy - vh / 2, vw, vh);
    var closed = rt.blinkT > 0 ? Math.sin((1 - Math.abs(rt.blinkT / 0.06 - 0.5) * 2) * Math.PI / 2) : 0;
    var gx = rt.gaze.x, gy = rt.gaze.y, ph = 1 - closed;
    ctx.fillStyle = col(PAL.pupil);
    ctx.beginPath(); ctx.ellipse(gx, vy + gy, 3.4, 3.2 * Math.max(0.08, ph), 0, 0, Math.PI * 2); ctx.fill();
    if (ph > 0.4) { ctx.fillStyle = rgba('#FFFFFF', 0.9 * ph); ctx.beginPath(); ctx.ellipse(gx - 1.3, vy + gy - 1.1, 1, 1, 0, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
    roundRect(-vw / 2, vy - vh / 2, vw, vh, vh / 2); ctx.lineWidth = 1; ctx.strokeStyle = rgba(PAL.pupil, 0.18); ctx.stroke();
  }

  /* ---- props ---- */
  function drawProp(kind, x, y, S, accent, lit, rt) {
    ctx.save(); ctx.translate(x, y);
    var alpha = lit ? 1 : 0.4;
    var glow = lit && rt && (rt.state === 'working' || rt.state === 'searching');
    if (glow) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.beginPath(); ctx.arc(0, 0, 10 * S, 0, Math.PI * 2); ctx.fillStyle = rgba(accent, 0.18); ctx.fill(); ctx.restore(); }
    ctx.lineWidth = 1.6 * S; ctx.strokeStyle = rgba(accent, alpha); ctx.fillStyle = rgba(accent, alpha);
    if (kind === 'magnifier') {
      var sweep = rt ? Math.sin(rt.propPh * 2) * 0.4 : 0; ctx.save(); ctx.rotate(sweep);
      if (rt && rt.state === 'searching') { ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.beginPath(); ctx.moveTo(0, 6 * S); ctx.lineTo(-9 * S, 22 * S); ctx.lineTo(9 * S, 22 * S); ctx.closePath(); ctx.fillStyle = rgba(accent, 0.12); ctx.fill(); ctx.restore(); }
      ctx.beginPath(); ctx.arc(0, 0, 5 * S, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = col(PAL.propWood); ctx.lineWidth = 2.2 * S; ctx.beginPath(); ctx.moveTo(3.5 * S, 3.5 * S); ctx.lineTo(9 * S, 9 * S); ctx.stroke(); ctx.restore();
    } else if (kind === 'document') {
      ctx.fillStyle = rgba(PAL.paper, alpha); roundRect(-6 * S, -8 * S, 12 * S, 16 * S, 1.5 * S); ctx.fill();
      ctx.strokeStyle = rgba(accent, alpha * 0.5); ctx.lineWidth = 1 * S;
      for (var i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(-4 * S, (-4 + i * 3.5) * S); ctx.lineTo(4 * S, (-4 + i * 3.5) * S); ctx.stroke(); }
      var tap = rt && rt.state === 'working' ? Math.abs(Math.sin(rt.propPh * 5)) * 2 * S : 0;
      ctx.strokeStyle = rgba(accent, alpha); ctx.lineWidth = 2 * S; ctx.beginPath(); ctx.moveTo(7 * S, -6 * S); ctx.lineTo(4 * S, 2 * S + tap); ctx.stroke();
    } else if (kind === 'megaphone') {
      ctx.beginPath(); ctx.moveTo(-2 * S, -5 * S); ctx.lineTo(8 * S, -9 * S); ctx.lineTo(8 * S, 9 * S); ctx.lineTo(-2 * S, 5 * S); ctx.closePath(); ctx.fill();
      ctx.fillStyle = rgba(PAL.paper, alpha); roundRect(-6 * S, -4 * S, 5 * S, 8 * S, 1.5 * S); ctx.fill();
      if (glow) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = rgba(accent, 0.5); for (var w = 0; w < 2; w++) { var rr = (10 + w * 5 + (time * 20) % 6) * S; ctx.beginPath(); ctx.arc(9 * S, 0, rr, -0.6, 0.6); ctx.stroke(); } ctx.restore(); }
    } else if (kind === 'envelope') {
      ctx.fillStyle = rgba(PAL.paper, alpha); roundRect(-8 * S, -6 * S, 16 * S, 12 * S, 1.5 * S); ctx.fill();
      ctx.strokeStyle = rgba(accent, alpha); ctx.lineWidth = 1.5 * S; roundRect(-8 * S, -6 * S, 16 * S, 12 * S, 1.5 * S); ctx.stroke();
      var flut = rt && rt.state === 'working' ? Math.sin(rt.propPh * 5) * 2 * S : 0; ctx.beginPath(); ctx.moveTo(-8 * S, -6 * S); ctx.lineTo(0, 2 * S + flut); ctx.lineTo(8 * S, -6 * S); ctx.stroke();
    } else if (kind === 'plug') {
      var rot = rt ? rt.propPh * 2 : 0; drawGear(2 * S, -1 * S, 6 * S, 8, rot, accent, alpha);
      ctx.strokeStyle = rgba(accent, alpha); ctx.lineWidth = 2 * S;
      ctx.beginPath(); ctx.moveTo(-8 * S, -3 * S); ctx.lineTo(-3 * S, -3 * S); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-8 * S, 1 * S); ctx.lineTo(-3 * S, 1 * S); ctx.stroke();
    }
    ctx.restore();
  }
  function drawGear(cx, cy, r, teeth, rot, color, alpha) {
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot); ctx.fillStyle = rgba(color, alpha); ctx.beginPath();
    for (var i = 0; i < teeth; i++) { var a0 = i / teeth * Math.PI * 2, a1 = (i + 0.5) / teeth * Math.PI * 2; ctx.lineTo(Math.cos(a0) * r, Math.sin(a0) * r); ctx.lineTo(Math.cos(a0 + 0.18) * r * 1.35, Math.sin(a0 + 0.18) * r * 1.35); ctx.lineTo(Math.cos(a1) * r, Math.sin(a1) * r); }
    ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, r * 0.4, 0, Math.PI * 2); ctx.fillStyle = rgba(darken(color, 0.3), alpha); ctx.fill(); ctx.restore();
  }
  function drawRestProp(id, t, z) {
    var A = AGENTS[id];
    var s = iso(t.wx - 0.35, t.wy - 0.05, z + 0.5);
    drawProp(A.prop, s.x, s.y, zoom * 0.85, A.accent, false, RT[id]);
  }
  function drawResultGlyph(x, y, S, accent) {
    ctx.save(); ctx.translate(x, y);
    ctx.globalCompositeOperation = 'lighter';
    ctx.beginPath(); ctx.arc(0, 0, 6 * S, 0, Math.PI * 2); ctx.fillStyle = rgba(accent, 0.25); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath(); ctx.arc(0, 0, 3.2 * S, 0, Math.PI * 2); ctx.fillStyle = rgba('#FFFDF5', 0.95); ctx.fill();
    ctx.lineWidth = 1.4 * S; ctx.strokeStyle = rgba(accent, 0.9); ctx.stroke();
    ctx.restore();
  }

  /* ==========================================================
     23. FREE-STANDING FURNITURE
     ========================================================== */
  function drawPlanter(tx, ty, tall) {
    var cx = tx + 0.5, cy = ty + 0.5;
    var base = iso(cx, cy, 0);
    if (!onScreen(base.x, base.y, 60 * zoom)) return;
    contactShadow(base.x + 3 * zoom, base.y + 2 * zoom, 34 * zoom, 13 * zoom, 0.2);
    isoBox(cx, cy, 0, 0.24, 0.24, 0.36, PAL.planterPot, darken(PAL.planterPot, 0.1), darken(PAL.planterPot, 0.18));
    ctx.save(); ctx.translate(base.x, base.y - 12 * zoom);
    var sway = reduced ? 0 : Math.sin(time * 0.5 + tx) * 0.04;
    var n = 6;
    for (var i = 0; i < n; i++) {
      var ang = -Math.PI / 2 + (i - n / 2) * 0.42 + sway * (1 + i * 0.1);
      ctx.save(); ctx.rotate(ang);
      ctx.fillStyle = col(i % 2 ? PAL.leafLit : PAL.leafDark);
      ctx.beginPath(); ctx.ellipse(0, -9 * zoom, 2.6 * zoom, 8 * zoom, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  function drawMonstera(tx, ty) {
    var cx = tx + 0.5, cy = ty + 0.5;
    var base = iso(cx, cy, 0);
    if (!onScreen(base.x, base.y, 90 * zoom)) return;
    contactShadow(base.x + 4 * zoom, base.y + 3 * zoom, 42 * zoom, 16 * zoom, 0.22);
    isoBox(cx, cy, 0, 0.26, 0.26, 0.44, PAL.planterPot, darken(PAL.planterPot, 0.1), darken(PAL.planterPot, 0.18));
    ctx.save(); ctx.translate(base.x, base.y - 14 * zoom);
    var sway = reduced ? 0 : Math.sin(time * 0.5) * 0.05;
    var leaves = [{ a: -1.9, l: 40 }, { a: -1.2, l: 48 }, { a: -0.55, l: 40 }, { a: -2.5, l: 36 }, { a: -1.55, l: 54 }];
    for (var i = 0; i < leaves.length; i++) {
      var lf = leaves[i], ang = lf.a + sway * (1 + i * 0.15);
      var ex = Math.cos(ang) * lf.l * zoom, ey = Math.sin(ang) * lf.l * zoom;
      ctx.strokeStyle = col(PAL.leafDark); ctx.lineWidth = 2 * zoom; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(ex * 0.4, ey * 0.5, ex, ey); ctx.stroke();
      ctx.save(); ctx.translate(ex, ey); ctx.rotate(ang + Math.PI / 2);
      var g = ctx.createLinearGradient(0, -16 * zoom, 0, 6 * zoom);
      g.addColorStop(0, col(PAL.leafLit)); g.addColorStop(1, col(PAL.leafDark)); ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(0, -6 * zoom, 9 * zoom, 15 * zoom, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = rgba(darken(PAL.leafDark, 0.2), 0.6); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, 6 * zoom); ctx.lineTo(0, -18 * zoom); ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  function drawSofa() {
    var base = iso(5, 24, 0);
    if (!onScreen(base.x, base.y, 200 * zoom)) return;
    contactShadow(iso(5, 25, 0).x, iso(5, 25, 0).y, 220 * zoom, 70 * zoom, 0.18);
    // long run x3..7 at y23..24
    isoBox(5, 23.5, 0, 2.0, 0.9, 0.28, PAL.sofa, darken(PAL.sofa, 0.1), darken(PAL.sofa, 0.18));
    isoBox(5, 23.1, 0.28, 2.0, 0.5, 0.35, PAL.sofaSeat, darken(PAL.sofaSeat, 0.12), darken(PAL.sofaSeat, 0.2)); // backrest
    // short arm x3..4 at y25..27
    isoBox(3.5, 26, 0, 0.9, 1.5, 0.28, PAL.sofa, darken(PAL.sofa, 0.1), darken(PAL.sofa, 0.18));
    isoBox(3.1, 26, 0.28, 0.5, 1.5, 0.35, PAL.sofaSeat, darken(PAL.sofaSeat, 0.12), darken(PAL.sofaSeat, 0.2));
    // seat cushions
    for (var i = 0; i < 3; i++) { var cx = 3.6 + i * 1.2; isoBox(cx, 23.6, 0.28, 0.5, 0.42, 0.12, PAL.sofaSeat, darken(PAL.sofaSeat, 0.1), darken(PAL.sofaSeat, 0.16)); }
  }
  function drawLowTable() {
    var cx = 8.5, cy = 26.5, s = iso(cx, cy, 0);
    if (!onScreen(s.x, s.y, 70 * zoom)) return;
    contactShadow(s.x, s.y + 3 * zoom, 46 * zoom, 20 * zoom, 0.2);
    var rx = 0.7 * HALF_W * zoom, ry = rx * (HALF_H / HALF_W);
    ctx.beginPath(); ctx.ellipse(s.x, s.y + 7 * zoom, rx, ry, 0, 0, Math.PI * 2); ctx.fillStyle = col(PAL.deskRight); ctx.fill();
    ctx.beginPath(); ctx.ellipse(s.x, s.y, rx, ry, 0, 0, Math.PI * 2); ctx.fillStyle = col(PAL.deskTop); ctx.fill();
    ctx.lineWidth = 1.2 * zoom; ctx.strokeStyle = rgba(ACCENTS.manager, 0.2); ctx.stroke();
  }
  function drawCushion() {
    var s = iso(10.5, 29.5, 0);
    if (!onScreen(s.x, s.y, 60 * zoom)) return;
    contactShadow(s.x + 3 * zoom, s.y + 3 * zoom, 40 * zoom, 15 * zoom, 0.18);
    ctx.save(); ctx.translate(s.x, s.y - 5 * zoom); ctx.scale(1, 0.6);
    superPath(0, 0, 18 * zoom, 16 * zoom, 3.2);
    var g = ctx.createRadialGradient(-4 * zoom, -4 * zoom, 2, 0, 0, 20 * zoom);
    g.addColorStop(0, col(lighten(PAL.sofaSeat, 0.08))); g.addColorStop(1, col(darken(PAL.sofaSeat, 0.06)));
    ctx.fillStyle = g; ctx.fill(); ctx.restore();
  }
  function drawCounter() {
    var base = iso(34, 30, 0);
    if (!onScreen(base.x, base.y, 220 * zoom)) return;
    contactShadow(iso(34, 30.4, 0).x, iso(34, 30.4, 0).y, 240 * zoom, 60 * zoom, 0.2);
    isoBox(34, 30, 0, 3.0, 0.4, 0.62, PAL.counter, darken(PAL.counter, 0.12), darken(PAL.counter, 0.2));
    isoBox(38, 26.5, 0, 0.4, 3.6, 0.62, PAL.counter, darken(PAL.counter, 0.12), darken(PAL.counter, 0.2));
    // top hairline
    ctx.strokeStyle = PAL.wallEdge; ctx.lineWidth = 1; line(iso(31, 29.6, 0.62), iso(37, 29.6, 0.62));
  }
  function drawCoffeeMachine() {
    var cx = POI_COFFEE[0] + 0.2, cy = 29.9, s = iso(cx, cy, 0.62);
    if (!onScreen(s.x, s.y, 60 * zoom)) return;
    isoBox(cx, cy, 0.62, 0.24, 0.2, 0.4, darken(PAL.counter, 0.2), darken(PAL.counter, 0.3), darken(PAL.counter, 0.38));
    // warm amber dot (the one warm point in the room)
    var d = iso(cx + 0.05, cy + 0.2, 0.9);
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.beginPath(); ctx.arc(d.x, d.y, 2.2 * zoom, 0, Math.PI * 2); ctx.fillStyle = rgba(PAL.amber, 0.9); ctx.fill();
    ctx.restore();
  }
  function drawStool(tx, ty) { drawStoolDisc(tx + 0.5, ty + 0.5, 0.26); }
  function drawStoolDisc(cx, cy, r) {
    var s = iso(cx, cy, 0);
    if (!onScreen(s.x, s.y, 40 * zoom)) return;
    isoBox(cx, cy, 0, r, r, 0.42, PAL.chair, darken(PAL.chair, 0.1), darken(PAL.chair, 0.18));
    var t = iso(cx, cy, 0.42);
    ctx.beginPath(); ctx.ellipse(t.x, t.y, r * HALF_W * zoom, r * HALF_H * zoom, 0, 0, Math.PI * 2); ctx.fillStyle = col(lighten(PAL.chair, 0.05)); ctx.fill();
  }
  function drawPrinter(tx, ty) {
    var cx = tx + 0.5, cy = ty + 0.5, base = iso(cx, cy, 0);
    if (!onScreen(base.x, base.y, 70 * zoom)) return;
    contactShadow(base.x, base.y + 2 * zoom, 54 * zoom, 22 * zoom, 0.2);
    isoBox(cx, cy, 0, 0.34, 0.32, 0.7, PAL.counter, darken(PAL.counter, 0.12), darken(PAL.counter, 0.2));
    // output tray hairline
    ctx.strokeStyle = PAL.wallEdge; ctx.lineWidth = 1; line(iso(cx - 0.3, cy + 0.32, 0.5), iso(cx + 0.3, cy + 0.32, 0.5));
    // occasional Echo-pink blink when Echo works here
    var echo = RT.inbox;
    if (echo && (echo.state === 'working' || echo.state === 'searching')) {
      var d = iso(cx - 0.15, cy - 0.1, 0.76);
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.beginPath(); ctx.arc(d.x, d.y, 1.8 * zoom, 0, Math.PI * 2); ctx.fillStyle = rgba(ACCENTS.inbox, 0.4 + 0.5 * (0.5 + 0.5 * Math.sin(time * 6))); ctx.fill();
      ctx.restore();
    }
  }

  /* ==========================================================
     24. ORB (single, sortable) + Nova halo / thought / particles
     ========================================================== */
  function drawOrb(o) {
    var e = easeOrb(clamp(o.t, 0, 1));
    var p0 = iso(o.from.wx, o.from.wy, o.from.wz), pc = iso(o.ctrl.wx, o.ctrl.wy, o.ctrl.wz), p1 = iso(o.to.wx, o.to.wy, o.to.wz);
    var p = quad(p0, pc, p1, e);
    var fp = iso(quadW(o.from, o.ctrl, o.to, e, 'wx'), quadW(o.from, o.ctrl, o.to, e, 'wy'), 0);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    var pg = ctx.createRadialGradient(fp.x, fp.y, 1, fp.x, fp.y, 24 * zoom); pg.addColorStop(0, rgba(o.accent, 0.16)); pg.addColorStop(1, rgba(o.accent, 0));
    ctx.fillStyle = pg; ctx.save(); ctx.translate(fp.x, fp.y); ctx.scale(1, 0.5); ctx.beginPath(); ctx.arc(0, 0, 24 * zoom, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    var gg = ctx.createRadialGradient(p.x, p.y, 1, p.x, p.y, 13 * zoom);
    gg.addColorStop(0, rgba(lighten(o.accent, 0.3), 0.9)); gg.addColorStop(0.4, rgba(o.accent, 0.5)); gg.addColorStop(1, rgba(o.accent, 0));
    ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(p.x, p.y, 13 * zoom, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.beginPath(); ctx.arc(p.x, p.y, 3.6 * zoom, 0, Math.PI * 2); ctx.fillStyle = rgba('#FFFDF5', 0.98); ctx.fill();
    if (o.type === 'deliver') { ctx.beginPath(); ctx.arc(p.x, p.y, 5 * zoom, 0, Math.PI * 2); ctx.lineWidth = 1.5 * zoom; ctx.strokeStyle = rgba(o.accent, 0.9); ctx.stroke(); }
  }

  function drawHalo(feetX, feetY) {
    var hx = feetX, hy = feetY - 34 * zoom * 1.12;
    var pulse = mgr.state === 'thinking' ? (0.7 + 0.3 * Math.sin(time * (Math.PI * 2 / 1.4))) : 1;
    var k = mgr.halo.x * pulse; if (k < 0.02) return;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    var R = 26 * zoom;
    var g = ctx.createRadialGradient(hx, hy, 2, hx, hy, R);
    g.addColorStop(0, rgba(lighten(ACCENTS.manager, 0.3), 0.5 * k)); g.addColorStop(0.6, rgba(ACCENTS.manager, 0.2 * k)); g.addColorStop(1, rgba(ACCENTS.manager, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(hx, hy, R, 0, Math.PI * 2); ctx.fill();
    if (mgr.state === 'thinking' && !reduced) {
      for (var i = 0; i < 5; i++) { var ang = time * 0.8 + i * (Math.PI * 2 / 5); var rr = (1 - ((time * 0.5 + i * 0.2) % 1)) * R * 1.6; ctx.beginPath(); ctx.arc(hx + Math.cos(ang) * rr, hy + Math.sin(ang) * rr, 1.3 * zoom, 0, Math.PI * 2); ctx.fillStyle = rgba(ACCENTS.manager, 0.4 * (1 - rr / (R * 1.6))); ctx.fill(); }
    }
    ctx.restore();
  }
  function drawThoughtBubble(feetX, feetY) {
    var hx = feetX - 22 * zoom, hy = feetY - 58 * zoom;
    ctx.save(); ctx.translate(hx, hy);
    ctx.fillStyle = PAL.pill; ctx.strokeStyle = rgba(PAL.textS, 0.15); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(10 * zoom, 14 * zoom, 2.2 * zoom, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(15 * zoom, 20 * zoom, 1.5 * zoom, 0, Math.PI * 2); ctx.fill();
    roundRect(-16 * zoom, -8 * zoom, 34 * zoom, 20 * zoom, 9 * zoom); ctx.fill(); ctx.stroke();
    for (var i = 0; i < 3; i++) { var a = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(time * 4 - i * 1.1)); ctx.beginPath(); ctx.arc((-8 + i * 8) * zoom, 2 * zoom, 2.2 * zoom, 0, Math.PI * 2); ctx.fillStyle = rgba(ACCENTS.manager, a); ctx.fill(); }
    ctx.restore();
  }

  function drawParts() {
    ctx.save();
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i], t = clamp(p.life / p.max, 0, 1);
      if (p.type === 'trail') { var s = iso(p.wx, p.wy, p.wz); ctx.globalCompositeOperation = 'lighter'; ctx.beginPath(); ctx.arc(s.x, s.y, p.r * zoom * (1 - t * 0.5), 0, Math.PI * 2); ctx.fillStyle = rgba(p.accent, 0.4 * (1 - t)); ctx.fill(); ctx.globalCompositeOperation = 'source-over'; }
      else if (p.type === 'ring') { var sr = iso(p.wx, p.wy, p.wz); ctx.beginPath(); ctx.arc(sr.x, sr.y, (4 + t * 16) * zoom, 0, Math.PI * 2); ctx.lineWidth = 2 * zoom * (1 - t); ctx.strokeStyle = rgba(p.accent, 0.7 * (1 - t)); ctx.stroke(); }
      else if (p.type === 'sonar') { var sc = iso(p.wx, p.wy, p.wz); ctx.save(); ctx.globalCompositeOperation = 'lighter'; for (var k = 0; k < 3; k++) { var tt = clamp((p.life - k * 0.12) / (p.max - 0.24), 0, 1); if (tt <= 0) continue; ctx.beginPath(); ctx.arc(sc.x, sc.y, (6 + tt * 46) * zoom, 0, Math.PI * 2); ctx.lineWidth = 2.2 * zoom * (1 - tt); ctx.strokeStyle = rgba(PAL.keyGlow, 0.4 * (1 - tt)); ctx.stroke(); } ctx.restore(); }
      else if (p.type === 'thought') { var st = iso(p.wx, p.wy, p.wz); ctx.globalCompositeOperation = 'lighter'; ctx.beginPath(); ctx.arc(st.x, st.y, p.r * zoom, 0, Math.PI * 2); ctx.fillStyle = rgba(p.accent, 0.5 * (1 - t)); ctx.fill(); ctx.globalCompositeOperation = 'source-over'; }
      else if (p.type === 'glyph') { var sg = iso(p.wx, p.wy, p.wz); ctx.font = (10 * zoom | 0) + 'px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = rgba(p.accent, 0.55 * (1 - t)); ctx.fillText(p.ch, sg.x, sg.y); }
      else if (p.type === 'sparkle') { var ss = iso(p.wx, p.wy, p.wz); drawStar(ss.x, ss.y, p.sz * zoom * (1 - t * 0.4), p.rot + t * 1.5, rgba(p.accent, 0.9 * (1 - t))); }
      else if (p.type === 'check') { var scK = iso(p.wx, p.wy, p.wz); var ca = t < 0.3 ? t / 0.3 : (1 - (t - 0.3) / 0.7); ctx.save(); ctx.translate(scK.x, scK.y); ctx.strokeStyle = rgba(p.accent, clamp(ca, 0, 1)); ctx.lineWidth = 2.6 * zoom; ctx.lineCap = 'round'; var dr = clamp(t / 0.3, 0, 1); ctx.beginPath(); ctx.moveTo(-5 * zoom, 0); ctx.lineTo(-1 * zoom, 4 * zoom * dr); ctx.lineTo((6 * dr) * zoom, -5 * dr * zoom); ctx.stroke(); ctx.restore(); }
    }
    ctx.restore();
  }
  function drawStar(x, y, r, rot, color) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.fillStyle = color; ctx.beginPath();
    for (var i = 0; i < 4; i++) { var a = i / 4 * Math.PI * 2; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); ctx.lineTo(Math.cos(a + Math.PI / 4) * r * 0.34, Math.sin(a + Math.PI / 4) * r * 0.34); }
    ctx.closePath(); ctx.fill(); ctx.restore();
  }
  function drawPing(id, k, feetX, baseY) {
    var s = { x: feetX, y: baseY - 52 * zoom };
    var t = 1 - k / 0.9, pop = t < 0.3 ? easeOut(t / 0.3) : 1, up = -6 * t * zoom;
    ctx.save(); ctx.translate(s.x, s.y + up); ctx.globalAlpha = clamp(k / 0.3, 0, 1); ctx.scale(pop, pop);
    roundRect(-6 * zoom, -12 * zoom, 12 * zoom, 16 * zoom, 4 * zoom); ctx.fillStyle = col(AGENTS[id].accent); ctx.fill();
    ctx.fillStyle = col('#FFFFFF'); roundRect(-1.2 * zoom, -9 * zoom, 2.4 * zoom, 7 * zoom, 1 * zoom); ctx.fill(); ctx.beginPath(); ctx.arc(0, 1 * zoom, 1.3 * zoom, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  /* ==========================================================
     25. FOCUS NAME LABELS
     ========================================================== */
  function drawLabels() {
    for (var i = 0; i < IDS.length; i++) {
      var id = IDS[i], rt = RT[id], A = AGENTS[id], mv = MV[id];
      var fa = (focusId === id) ? 1 : 0;
      var aa = clamp((rt.rim.x - 0.18) / 0.82, 0, 1);
      var alpha = Math.max(fa, aa * (focusId ? 0.4 : 0.65));
      if (alpha < 0.03) continue;
      var s = iso(mv.wx, mv.wy + 0.35, mv.z || 0);
      if (!onScreen(s.x, s.y, 60 * zoom)) continue;
      var name = A.name;
      ctx.save();
      ctx.font = '600 ' + (11 * Math.max(1, zoom * 0.9) | 0) + 'px ' + FONT;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var w = ctx.measureText(name).width + 16 * zoom, h = 16 * zoom;
      ctx.globalAlpha = alpha;
      roundRect(s.x - w / 2, s.y - h / 2, w, h, h / 2); ctx.fillStyle = PAL.pill; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = rgba(A.accent, 0.5); ctx.stroke();
      ctx.fillStyle = col(PAL.textP); ctx.fillText(name, s.x, s.y + 0.5 * zoom);
      ctx.restore();
    }
  }

  /* ==========================================================
     26. OVERLAYS: hint, minimap, grading, bg, boot
     ========================================================== */
  function drawBg() {
    var g = ctx.createLinearGradient(0, 0, 0, cssH);
    g.addColorStop(0, col(PAL.voidTop)); g.addColorStop(1, col(PAL.voidBot));
    ctx.fillStyle = g; ctx.fillRect(0, 0, cssW, cssH);
  }
  function drawGrading() {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    var kx = cssW * 0.42, ky = cssH * 0.10;
    var kg = ctx.createRadialGradient(kx, ky, 10, kx, ky, Math.max(cssW, cssH) * 0.85);
    kg.addColorStop(0, rgba(PAL.keyGlow, 0.05)); kg.addColorStop(1, rgba(PAL.keyGlow, 0));
    ctx.fillStyle = kg; ctx.fillRect(0, 0, cssW, cssH);
    var fx = cssW * 0.7, fy = cssH * 0.98;
    var fg = ctx.createRadialGradient(fx, fy, 10, fx, fy, Math.max(cssW, cssH) * 0.7);
    fg.addColorStop(0, rgba(PAL.moonPane, 0.05)); fg.addColorStop(1, rgba(PAL.moonPane, 0));
    ctx.fillStyle = fg; ctx.fillRect(0, 0, cssW, cssH);
    ctx.restore();
    // strong vignette (sells "office at night")
    var vg = ctx.createRadialGradient(cssW / 2, cssH * 0.46, Math.min(cssW, cssH) * 0.32, cssW / 2, cssH * 0.5, Math.max(cssW, cssH) * 0.8);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.42)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, cssW, cssH);
  }
  function drawHint() {
    if (hintAlpha <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = hintAlpha;
    ctx.font = '400 13px ' + FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = col(PAL.textS);
    ctx.fillText('drag to look around', 22, cssH - 22);
    ctx.restore();
  }

  function minimapRect() {
    var mw = 140, mh = 112, pad = 16;
    var mx = cssW - mw - pad, my = cssH - mh - pad;
    var wsW = worldScreenW(), wsH = worldScreenH();
    var s = Math.min((mw - 18) / wsW, (mh - 18) / wsH);
    var ox = mx + mw / 2, oy = my + mh / 2 - ((WORLD_W + WORLD_D) / 2) * 0 + 0;
    return { x: mx, y: my, w: mw, h: mh, s: s, ox: ox, oy: oy };
  }
  function mm(pt, wx, wy) {
    return { x: pt.ox + ((wx - wy) - (WORLD_W - WORLD_D) / 2) * HALF_W * pt.s, y: pt.oy + ((wx + wy) - (WORLD_W + WORLD_D) / 2) * HALF_H * pt.s };
  }
  function drawMinimap() {
    if (cssW < 560) return;
    var pt = minimapRect();
    ctx.save();
    roundRect(pt.x, pt.y, pt.w, pt.h, 10); ctx.fillStyle = PAL.pill; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = PAL.wallEdge; ctx.stroke();
    roundRect(pt.x, pt.y, pt.w, pt.h, 10); ctx.clip();
    // world diamond outline
    var c0 = mm(pt, 0, 0), c1 = mm(pt, WORLD_W, 0), c2 = mm(pt, WORLD_W, WORLD_D), c3 = mm(pt, 0, WORLD_D);
    ctx.beginPath(); ctx.moveTo(c0.x, c0.y); ctx.lineTo(c1.x, c1.y); ctx.lineTo(c2.x, c2.y); ctx.lineTo(c3.x, c3.y); ctx.closePath();
    ctx.fillStyle = rgba('#000000', 0.25); ctx.fill();
    ctx.strokeStyle = PAL.seamZone; ctx.lineWidth = 1; ctx.stroke();
    // viewport footprint (inverse-project 4 corners)
    var v0 = screenToWorld(0, 0), v1 = screenToWorld(cssW, 0), v2 = screenToWorld(cssW, cssH), v3 = screenToWorld(0, cssH);
    var m0 = mm(pt, v0.wx, v0.wy), m1 = mm(pt, v1.wx, v1.wy), m2 = mm(pt, v2.wx, v2.wy), m3 = mm(pt, v3.wx, v3.wy);
    ctx.beginPath(); ctx.moveTo(m0.x, m0.y); ctx.lineTo(m1.x, m1.y); ctx.lineTo(m2.x, m2.y); ctx.lineTo(m3.x, m3.y); ctx.closePath();
    ctx.strokeStyle = rgba('#ffffff', 0.35); ctx.lineWidth = 1; ctx.stroke();
    // agent dots
    for (var i = 0; i < IDS.length; i++) { var id = IDS[i], mv = MV[id]; var d = mm(pt, mv.wx, mv.wy); ctx.beginPath(); ctx.arc(d.x, d.y, id === 'manager' ? 2.6 : 2, 0, Math.PI * 2); ctx.fillStyle = AGENTS[id].accent; ctx.fill(); }
    ctx.restore();
  }

  function drawBootFade() {
    if (bootT >= 0.7) return;
    var p = easeOut(clamp(bootT / 0.7, 0, 1));
    ctx.save(); ctx.globalAlpha = 1 - p; drawBg(); ctx.restore();
  }

  /* ==========================================================
     27. UPDATE (springs, timers, gaze, behaviors)
     ========================================================== */
  function updateAgents(dt) {
    for (var i = 0; i < IDS.length; i++) {
      var id = IDS[i], rt = RT[id], mv = MV[id];
      stepSpring(rt.rim, dt); stepSpring(rt.lamp, dt); stepSpring(rt.mon, dt);
      stepSpring(rt.desat, dt); stepSpring(rt.lift, dt); stepSpring(rt.arm, dt);
      stepSpring(rt.pop, dt); stepSpring(rt.bounce, dt);

      // focus emphasis
      if (focusId) { rt.desat.t = (focusId === id) ? 0 : 0.5; rt.lift.t = (focusId === id) ? 3 : 0; }
      else { rt.desat.t = 0; rt.lift.t = 0; }

      // arm target: typing at work-spot
      var workPose = !mv.moving && (rt.state === 'working' || rt.state === 'searching') && (mv.task === 'atwork' || mv.task === 'workstep');
      rt.arm.t = workPose ? 1 : 0;

      if (!reduced) rt.breath += dt * (2 * Math.PI / (3.6 + i * 0.22));
      if (workPose) rt.work += dt * 4.2;
      rt.propPh += dt * (workPose ? 3.5 : 0.6);

      if (!reduced) { if (rt.blinkT > 0) rt.blinkT -= dt; else { rt.blinkNext -= dt; if (rt.blinkNext <= 0) { rt.blinkT = 0.12; rt.blinkNext = 2.8 + Math.random() * 3.4; } } }
      if (rt.ping > 0) rt.ping -= dt;
      if (rt.speaking) rt.mouthPh += dt;

      // done -> auto return to idle after the beat (queue walk home if away)
      if (rt.doneT >= 0) {
        rt.doneT += dt;
        if (rt.state === 'done') { var kk = clamp((rt.doneT - 0.4) / 0.4, 0, 1); rt.rim.t = lerp(1, 0.18, kk); rt.lamp.t = lerp(0.4, 0, kk); }
        if (rt.doneT >= DONE_DUR) { rt.doneT = -1; if (rt.state === 'done') { rt.state = 'idle'; applyAgentState(id, 'idle'); } }
      }

      // walking + behaviors
      updateBehavior(id, dt);

      updateGaze(id, rt, dt);
    }

    stepSpring(mgr.halo, dt); stepSpring(mgr.pop, dt);
    if (mgr.state === 'thinking') mgr.think += dt;
    if (mgr.speaking) { mgr.speakPh += dt; mgr.sonarT -= dt; if (mgr.sonarT <= 0 && parts.length < PART_CAP) { spawnSonar(); mgr.sonarT = 0.9; } }
  }

  function updateGaze(id, rt, dt) {
    var mv = MV[id], target = null;
    if (mv.moving) { rt.gazeT.x = clamp((mv.facing === 'SE' || mv.facing === 'NE') ? 1.6 : -1.6, -2.2, 2.2); rt.gazeT.y = -0.2; }
    else if (id === 'manager') { if (activeAgent && MV[activeAgent]) target = MV[activeAgent]; }
    else { if (mgr.state !== 'idle') target = MV.manager; else if (activeAgent && activeAgent !== id && MV[activeAgent]) target = MV[activeAgent]; }
    if (target) {
      var dx = (target.wx - target.wy) - (mv.wx - mv.wy), dy = (target.wx + target.wy) - (mv.wx + mv.wy);
      var len = Math.hypot(dx, dy) || 1; rt.gazeT.x = (dx / len) * 2.2; rt.gazeT.y = (dy / len) * 1.6 - 0.5;
    } else if (!mv.moving) { rt.gazeT.x = Math.sin(time * 0.4 + rt.breath) * 1.2; rt.gazeT.y = 0; }
    var s = reduced ? 1 : clamp(dt * 6, 0, 1);
    rt.gaze.x += (rt.gazeT.x - rt.gaze.x) * s; rt.gaze.y += (rt.gazeT.y - rt.gaze.y) * s;
  }

  /* ==========================================================
     28. MAIN LOOP + RENDER
     ========================================================== */
  function frame(ts) {
    if (!running) return;
    try {
      if (!lastTS) lastTS = ts;
      var dt = (ts - lastTS) / 1000; lastTS = ts;
      if (!(dt >= 0)) dt = 0;
      if (dt > 0.05) dt = 0.05;
      time += dt; bootT += dt;

      var hidden = false; try { hidden = document.hidden; } catch (e) {}

      updateCamera(dt);
      updateAgents(dt);
      updateOrbs(dt);
      updateParts(dt);
      if (!hidden) updateMotes(dt);

      render();
    } catch (err) { /* never break the loop */ }
    requestAnimationFrame(frame);
  }

  function computeVisibleRange() {
    var c0 = screenToWorld(0, 0), c1 = screenToWorld(cssW, 0), c2 = screenToWorld(cssW, cssH), c3 = screenToWorld(0, cssH);
    var minx = Math.min(c0.wx, c1.wx, c2.wx, c3.wx), maxx = Math.max(c0.wx, c1.wx, c2.wx, c3.wx);
    var miny = Math.min(c0.wy, c1.wy, c2.wy, c3.wy), maxy = Math.max(c0.wy, c1.wy, c2.wy, c3.wy);
    return {
      x0: clamp(Math.floor(minx) - 4, 0, WORLD_W - 1), x1: clamp(Math.ceil(maxx) + 4, 0, WORLD_W - 1),
      y0: clamp(Math.floor(miny) - 4, 0, WORLD_D - 1), y1: clamp(Math.ceil(maxy) + 4, 0, WORLD_D - 1)
    };
  }

  function render() {
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    drawBg();

    // static layer: cache blit (fast path) or culled direct draw (fallback)
    if (USE_CACHE && cacheReady && Math.abs(cacheZoom - zoom) < 1e-4) {
      blitCache();
    } else {
      drawStaticScene(computeVisibleRange());
    }

    // dynamic floor overlay (under actors)
    drawFloorOverlay();

    // sortable entities (desks, actors, furniture, orbs) — painter's algorithm
    var list = buildDrawList();
    for (var i = 0; i < list.length; i++) drawEntity(list[i]);

    // overlays
    drawParts();
    drawLabels();
    drawGrading();
    drawHint();
    drawMinimap();
    drawBootFade();
  }

  /* ==========================================================
     29. PUBLIC API (never throws)
     ========================================================== */
  function init(el) {
    canvas = el || document.getElementById('stage');
    if (!canvas || !canvas.getContext) return;
    ctx = canvas.getContext('2d');
    if (!ctx) return;
    readEnv();
    buildGrid();
    buildLayout();
    resize();
    setManager('idle');
    bindInput();

    try {
      var rm = window.matchMedia('(prefers-reduced-motion: reduce)');
      var addR = rm.addEventListener ? rm.addEventListener.bind(rm, 'change') : (rm.addListener && rm.addListener.bind(rm));
      if (addR) addR(function () { readEnv(); seedMotes(); });
    } catch (e) {}
    try { window.addEventListener('resize', resize); } catch (e2) {}

    started = true;
    if (!running) { running = true; lastTS = 0; requestAnimationFrame(frame); }
  }

  function guard(fn) {
    return function () { try { return fn.apply(null, arguments); } catch (e) { /* swallow — never throw */ } };
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