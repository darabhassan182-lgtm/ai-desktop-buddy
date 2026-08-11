/* ============================================================
   NEXUS — game.js  ·  WORLD 3.0  "Nexus Tower, Night Shift"
   A ground-up rewrite from Canvas-2D isometric to real 3D
   (WebGL via Three.js r0.185). Dark, premium, stylized low-poly
   office complex: closed offices + corridors around a central
   Director atrium, dynamic lighting + soft shadows + UnrealBloom
   + ACES tone mapping + fog, low-poly "bean" characters that WALK
   between rooms through doorways, an orbit/pan/zoom camera with a
   focus(id) dolly tween, and calm ambient life.

   Three.js is a global bundle loaded BEFORE this classic <script>.
   Everything is read from window.NEXUS3D — no import/export, no
   CDN, no <script> tags. If THREE is missing or WebGL is
   unavailable, the file warns ONCE and every World method becomes
   a safe no-op. window.World is set synchronously at the end.

   Public API (never throws):
     World.init(canvasEl)                         // <canvas id="stage">
     World.setManager('idle'|'thinking'|'speaking')
     World.setAgent(id,'idle'|'assigned'|'working'|
                       'searching'|'delivering'|'done')
     World.dispatch(id)     // task orb  Agent Sea -> office
     World.deliver(id)      // result orb office -> Agent Sea (debounced)
     World.speak(id, on)    // id may be 'manager'
     World.focus(id|null)   // dolly camera to office / release
     World.resize()         // camera + renderer + composer only
   ============================================================ */
(function () {
  'use strict';

  /* ==========================================================
     0. THREE via window.NEXUS3D  (fail-silent contract)
     ========================================================== */
  var NX = window.NEXUS3D || {};
  var THREE = NX.THREE,
      OrbitControls = NX.OrbitControls,
      EffectComposer = NX.EffectComposer,
      RenderPass = NX.RenderPass,
      UnrealBloomPass = NX.UnrealBloomPass,
      OutputPass = NX.OutputPass;

  var warned = false;
  function warnOnce(msg) { if (warned) return; warned = true; try { console.warn(msg); } catch (e) {} }

  /* ==========================================================
     1. AGENTS (fixed ids, names, accents — never remap)
        5 specialist offices ring a central Director atrium.
        Room center (cx,cz), 9x8 interior (half 4.5 x 4), one
        1.6m doorway per room, in-room desk/work/home anchors.
        Coordinates match the design spec verbatim.
     ========================================================== */
  var ACCENTS = {
    manager: '#7c9cff', research: '#4f6bff', docs: '#34d399',
    marketing: '#f59e0b', inbox: '#ec4899', api: '#22d3ee'
  };

  var AGENTS = {
    manager:   { name: 'Agent Sea', accent: ACCENTS.manager,   cx: 0,   cz: 0 },
    research:  { name: 'Scout',     accent: ACCENTS.research,   cx: -14, cz: -11, door: 'E',
                 deskPos: [-14, -13], workPos: [-17.5, -13], homePos: [-11, -8.5],
                 fixFace: [1, 0], ext: ['W', 'N'] },
    docs:      { name: 'Quill',     accent: ACCENTS.docs,      cx: -14, cz: 11,  door: 'E',
                 deskPos: [-14, 13],  workPos: [-17.5, 13],  homePos: [-11, 8.5],
                 fixFace: [1, 0], ext: ['W', 'S'] },
    inbox:     { name: 'Echo',      accent: ACCENTS.inbox,     cx: 14,  cz: -11, door: 'W',
                 deskPos: [14, -13],  workPos: [17.5, -13],  homePos: [11, -8.5],
                 fixFace: [-1, 0], ext: ['E', 'N'] },
    marketing: { name: 'Spark',     accent: ACCENTS.marketing, cx: 14,  cz: 11,  door: 'W',
                 deskPos: [14, 13],   workPos: [17.5, 13],   homePos: [11, 8.5],
                 fixFace: [-1, 0], ext: ['E', 'S'] },
    api:       { name: 'Wire',      accent: ACCENTS.api,       cx: 0,   cz: 16,  door: 'N',
                 deskPos: [0, 18],    workPos: [0, 20],      homePos: [0, 13],
                 fixFace: [0, -1], ext: ['E', 'W', 'S'] }
  };
  var IDS = ['manager', 'research', 'inbox', 'docs', 'marketing', 'api'];
  var SPECIALISTS = ['research', 'inbox', 'docs', 'marketing', 'api'];
  var AGENT_STATES = { idle: 1, assigned: 1, working: 1, searching: 1, delivering: 1, done: 1 };

  /* ==========================================================
     2. CONSTANTS
     ========================================================== */
  var WALL_H = 3.2;
  var HALF_X = 4.5, HALF_Z = 4.0;      // room interior half-extents
  var STEP_FREQ = 6.5;                 // gait cadence
  var MAX_AMBIENT = 2;                 // keep the tower calm
  var DELIVER_MAX = 60;                // world-units cap for walking a hand-off
  var ORB_DUR = 0.6;                   // orb travel seconds
  var DONE_DUR = 0.9;                  // "done" beat length
  var SPARK_CAP = 90;                  // transient point-particle ceiling
  var MOTE_COUNT = 140;                // dust motes

  var COL = {
    bg: '#0a0c11', floor: '#14171d', corridor: '#0f1218', atrium: '#181c24',
    wallExt: '#0c0e13', wallInt: '#16191f', ceiling: '#0b0d12', base: '#080a0e',
    glass: '#8fb0d8', desk: '#1b1f27', chair: '#171a21', monitor: '#0a0b0e',
    prop: '#2a303b', pot: '#14171d', leaf: '#243029', leafLit: '#31463a',
    pool: '#cdd8ec', warm: '#e0a040', neutral: '#cdd8ec'
  };

  /* ==========================================================
     3. MATH / EASING / SPRINGS
     ========================================================== */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function faceY(fx, fz, tx, tz) { return Math.atan2(tx - fx, tz - fz); }
  function shortAngle(from, to) {
    var d = to - from;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }
  function hex01(h) {
    h = (h || '#000').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  // overshoot spring (for pop punch / hop)
  function spring(x, k, d) { return { x: x, t: x, v: 0, k: k == null ? 180 : k, d: d == null ? 18 : d }; }
  function stepSpring(s, dt) {
    var steps = dt > 0.02 ? Math.ceil(dt / 0.016) : 1, h = dt / steps, i, a;
    for (i = 0; i < steps; i++) { a = s.k * (s.t - s.x) - s.d * s.v; s.v += a * h; s.x += s.v * h; }
  }
  // critically-damped scalar ease {x,t}
  function ez(s, dt, rate) { s.x += (s.t - s.x) * Math.min(1, dt * rate); }
  function cubicBezier(x1, y1, x2, y2) {
    function A(a, b) { return 1 - 3 * b + 3 * a; }
    function B(a, b) { return 3 * b - 6 * a; }
    function C(a) { return 3 * a; }
    function calc(t, a, b) { return ((A(a, b) * t + B(a, b)) * t + C(a)) * t; }
    function slope(t, a, b) { return 3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a); }
    return function (x) {
      if (x <= 0) return 0; if (x >= 1) return 1;
      var t = x, i, cx, dd;
      for (i = 0; i < 6; i++) { cx = calc(t, x1, x2) - x; dd = slope(t, x1, x2); if (Math.abs(dd) < 1e-6) break; t = clamp(t - cx / dd, 0, 1); }
      return calc(t, y1, y2);
    };
  }
  var easeOrb = cubicBezier(0.34, 1.2, 0.64, 1);

  /* ==========================================================
     4. WAYPOINT NAV GRAPH  (hand-authored, wall-free edges)
        Nodes are room anchors + doorways + corridor elbows +
        the atrium hub + coffee. Edges run only along corridor
        centrelines and straight in-room runs.
     ========================================================== */
  var NODES = {
    HUB: [0, 0], coffee: [3.5, 7.5],
    elbowNW: [-9.5, -1.5], elbowSW: [-9.5, 1.5], elbowNE: [9.5, -1.5], elbowSE: [9.5, 1.5],
    research_door: [-9.5, -11], research_home: [-11, -8.5], research_desk: [-14, -13], research_work: [-17.5, -13],
    docs_door: [-9.5, 11], docs_home: [-11, 8.5], docs_desk: [-14, 13], docs_work: [-17.5, 13],
    inbox_door: [9.5, -11], inbox_home: [11, -8.5], inbox_desk: [14, -13], inbox_work: [17.5, -13],
    marketing_door: [9.5, 11], marketing_home: [11, 8.5], marketing_desk: [14, 13], marketing_work: [17.5, 13],
    api_door: [0, 12], api_home: [0, 13], api_desk: [0, 18], api_work: [0, 20]
  };
  var EDGES = [
    ['HUB', 'elbowNW'], ['HUB', 'elbowSW'], ['HUB', 'elbowNE'], ['HUB', 'elbowSE'],
    ['HUB', 'api_door'], ['HUB', 'coffee'],
    ['elbowNW', 'elbowSW'], ['elbowNE', 'elbowSE'], ['elbowNW', 'elbowNE'], ['elbowSW', 'elbowSE'],
    ['elbowNW', 'research_door'], ['research_door', 'research_home'], ['research_home', 'research_desk'], ['research_desk', 'research_work'],
    ['elbowSW', 'docs_door'], ['docs_door', 'docs_home'], ['docs_home', 'docs_desk'], ['docs_desk', 'docs_work'],
    ['elbowNE', 'inbox_door'], ['inbox_door', 'inbox_home'], ['inbox_home', 'inbox_desk'], ['inbox_desk', 'inbox_work'],
    ['elbowSE', 'marketing_door'], ['marketing_door', 'marketing_home'], ['marketing_home', 'marketing_desk'], ['marketing_desk', 'marketing_work'],
    ['api_door', 'api_home'], ['api_home', 'api_desk'], ['api_desk', 'api_work']
  ];
  var NODE_NAMES = [];
  var ADJ = {};
  function buildGraph() {
    var k;
    for (k in NODES) { if (NODES.hasOwnProperty(k)) { NODE_NAMES.push(k); ADJ[k] = []; } }
    for (var i = 0; i < EDGES.length; i++) {
      var a = EDGES[i][0], b = EDGES[i][1];
      var pa = NODES[a], pb = NODES[b];
      var d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
      ADJ[a].push({ n: b, d: d }); ADJ[b].push({ n: a, d: d });
    }
  }
  function nearestNode(x, z) {
    var best = null, bd = 1e18;
    for (var i = 0; i < NODE_NAMES.length; i++) {
      var nm = NODE_NAMES[i], p = NODES[nm], d = (p[0] - x) * (p[0] - x) + (p[1] - z) * (p[1] - z);
      if (d < bd) { bd = d; best = nm; }
    }
    return best;
  }
  function shortestPath(start, goal) {
    if (start === goal) return [start];
    var dist = {}, prev = {}, done = {}, i, nm;
    for (i = 0; i < NODE_NAMES.length; i++) dist[NODE_NAMES[i]] = 1e18;
    dist[start] = 0;
    for (;;) {
      var u = null, best = 1e18;
      for (i = 0; i < NODE_NAMES.length; i++) { nm = NODE_NAMES[i]; if (!done[nm] && dist[nm] < best) { best = dist[nm]; u = nm; } }
      if (u === null) break;
      if (u === goal) break;
      done[u] = 1;
      var ns = ADJ[u];
      for (i = 0; i < ns.length; i++) {
        var v = ns[i].n, alt = dist[u] + ns[i].d;
        if (alt < dist[v]) { dist[v] = alt; prev[v] = u; }
      }
    }
    if (dist[goal] >= 1e18) return null;
    var out = [goal], c = goal;
    while (c !== start) { c = prev[c]; if (c == null) return null; out.push(c); }
    out.reverse();
    return out;
  }

  /* ==========================================================
     5. RUNTIME STATE
     ========================================================== */
  var ready = false, built = false, reduced = false;
  var canvas = null, renderer = null, scene = null, camera = null, controls = null;
  var composer = null, bloom = null, clock = null, time = 0;
  var keyLight = null, hemi = null, amb = null;
  var roomLights = {}, atriumAccent = null, coffeeLight = null;
  var screenMat = {}, fixturePanel = {}, ledMats = [];
  var haloMat = null, haloMesh = null, rostrumMat = null;
  var people = {}, RT = {}, MV = {}, LAY = {};
  var activeAgent = null;
  var mgr = { state: 'idle', speaking: false, halo: { x: 0.22, t: 0.22 }, speakPh: 0, thinkT: 0, ringT: 0 };

  var orbs = [], orbPool = [], rings = [], ringPool = [], checks = [], checkPool = [];
  var motes = null, moteData = [];
  var sparks = null, sparkPos = null, sparkColArr = null, sparkState = [];

  // shared geometries / materials (built once)
  var GEO = {}, MAT = {};

  // camera focus tween state
  var cam = { tgt: null, dist: 42, active: false, forcing: false };

  // scratch
  var _v = null, _v2 = null, _from = null, _to = null, _ctrl = null;

  /* ==========================================================
     6. ASSET BUILD (geometries + materials)  — once
     ========================================================== */
  function buildAssets() {
    GEO.body = new THREE.CapsuleGeometry(0.32, 0.7, 6, 12);
    GEO.head = new THREE.SphereGeometry(0.26, 16, 12);
    GEO.visor = new THREE.BoxGeometry(0.34, 0.12, 0.06);
    GEO.rim = new THREE.TorusGeometry(0.3, 0.03, 8, 20);
    GEO.foot = new THREE.BoxGeometry(0.14, 0.1, 0.22);
    GEO.searchOrb = new THREE.SphereGeometry(0.07, 10, 8);
    GEO.orb = new THREE.SphereGeometry(0.14, 12, 10);
    GEO.ring = new THREE.TorusGeometry(1, 0.05, 8, 32);
    GEO.roomFloor = new THREE.PlaneGeometry(HALF_X * 2, HALF_Z * 2);
    GEO.screen = new THREE.PlaneGeometry(0.8, 0.46);
    GEO.pot = new THREE.CylinderGeometry(0.22, 0.26, 0.4, 8);
    GEO.leaf = new THREE.IcosahedronGeometry(0.5, 0);
    GEO.pool = new THREE.CircleGeometry(1.6, 24);

    MAT.floor = new THREE.MeshStandardMaterial({ color: COL.floor, roughness: 0.86, metalness: 0.0 });
    MAT.corridor = new THREE.MeshStandardMaterial({ color: COL.corridor, roughness: 0.9, metalness: 0.0 });
    MAT.atrium = new THREE.MeshStandardMaterial({ color: COL.atrium, roughness: 0.8, metalness: 0.0 });
    MAT.wallExt = new THREE.MeshStandardMaterial({ color: COL.wallExt, roughness: 0.95, metalness: 0.0 });
    MAT.wallInt = new THREE.MeshStandardMaterial({ color: COL.wallInt, roughness: 0.9, metalness: 0.0 });
    MAT.ceiling = new THREE.MeshStandardMaterial({ color: COL.ceiling, roughness: 1.0, metalness: 0.0 });
    MAT.glass = new THREE.MeshStandardMaterial({ color: COL.glass, transparent: true, opacity: 0.12, roughness: 0.05, metalness: 0.0, depthWrite: false });
    MAT.desk = new THREE.MeshStandardMaterial({ color: COL.desk, roughness: 0.7, metalness: 0.1 });
    MAT.chair = new THREE.MeshStandardMaterial({ color: COL.chair, roughness: 0.8 });
    MAT.monitor = new THREE.MeshStandardMaterial({ color: COL.monitor, roughness: 0.4, metalness: 0.1 });
    MAT.prop = new THREE.MeshStandardMaterial({ color: COL.prop, roughness: 0.75 });
    MAT.pot = new THREE.MeshStandardMaterial({ color: COL.pot, roughness: 0.9 });
    MAT.leaf = new THREE.MeshStandardMaterial({ color: COL.leaf, emissive: COL.leafLit, emissiveIntensity: 0.06, roughness: 0.85 });
    MAT.body = new THREE.MeshStandardMaterial({ color: '#20242d', roughness: 0.7, metalness: 0.05 });
    MAT.pool = new THREE.MeshStandardMaterial({ color: COL.pool, emissive: COL.pool, emissiveIntensity: 0.06, roughness: 1.0, transparent: true, opacity: 0.5, depthWrite: false });
    // per-accent orb materials (unlit + bloom)
    MAT.orb = {};
    for (var i = 0; i < IDS.length; i++) {
      var a = AGENTS[IDS[i]].accent;
      MAT.orb[a] = new THREE.MeshBasicMaterial({ color: a });
    }
    MAT.orbCore = new THREE.MeshBasicMaterial({ color: '#fffdf5' });
  }

  /* ==========================================================
     7. MESH HELPERS
     ========================================================== */
  function box(w, h, d, x, y, z, mat, cast, recv) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    if (cast) m.castShadow = true;
    if (recv) m.receiveShadow = true;
    return m;
  }

  /* ==========================================================
     8. SCENE BUILD  — once, in init()
     ========================================================== */
  function buildScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(COL.bg);
    scene.fog = new THREE.Fog(new THREE.Color(COL.bg), 48, 155);

    // ground slab (catches shadows in corridors + atrium)
    var ground = new THREE.Mesh(new THREE.PlaneGeometry(72, 66), MAT.corridor);
    ground.rotation.x = -Math.PI / 2; ground.position.y = 0; ground.receiveShadow = true;
    scene.add(ground);

    buildLights();
    buildCorridors();
    buildAtrium();
    for (var i = 0; i < SPECIALISTS.length; i++) buildRoom(SPECIALISTS[i]);
    buildPlants();
    buildCoffee();
    buildParticles();

    // layout centres (for focus)
    for (var j = 0; j < IDS.length; j++) { var id = IDS[j], A = AGENTS[id]; LAY[id] = { cx: A.cx, cz: A.cz }; }

    buildPeople();
  }

  function buildLights() {
    keyLight = new THREE.DirectionalLight('#aebbd6', 2.7);
    keyLight.position.set(-18, 34, -14);
    keyLight.target.position.set(0, 0, 2);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    var s = keyLight.shadow.camera;
    s.left = -30; s.right = 30; s.top = 30; s.bottom = -30; s.near = 1; s.far = 90;
    keyLight.shadow.bias = -0.0004;
    keyLight.shadow.normalBias = 0.02;
    scene.add(keyLight); scene.add(keyLight.target);

    hemi = new THREE.HemisphereLight('#506588', '#0a0d14', 1.0);
    scene.add(hemi);
    amb = new THREE.AmbientLight('#2c3550', 1.05);
    scene.add(amb);

    // per-office accent point lights (intensity driven by roomGlow)
    for (var i = 0; i < SPECIALISTS.length; i++) {
      var id = SPECIALISTS[i], A = AGENTS[id];
      var p = new THREE.PointLight(A.accent, 0.5, 9, 2.0);
      p.position.set(A.deskPos[0], 2.2, A.deskPos[1]);
      p.castShadow = false;
      scene.add(p); roomLights[id] = p;
    }
    // atrium neutral downlight + Agent Sea accent
    var dl = new THREE.PointLight(COL.neutral, 1.4, 26, 2);
    dl.position.set(0, 6, 0); scene.add(dl);
    atriumAccent = new THREE.PointLight(ACCENTS.manager, 0.7, 16, 2);
    atriumAccent.position.set(0, 3, 0); scene.add(atriumAccent);
    // coffee warm point
    coffeeLight = new THREE.PointLight(COL.warm, 0.35, 5, 2);
    coffeeLight.position.set(3.5, 1.1, 7.5); scene.add(coffeeLight);
  }

  function corridorStrip(w, d, x, z) {
    var m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), MAT.corridor);
    m.rotation.x = -Math.PI / 2; m.position.set(x, 0.012, z); m.receiveShadow = true;
    scene.add(m);
  }
  function buildCorridors() {
    corridorStrip(3, 42, 0, 1);        // N-S spine
    corridorStrip(44, 3, 0, 0);        // E-W spine
    corridorStrip(3, 11.5, -9.5, -7.25); // research branch
    corridorStrip(3, 11.5, -9.5, 7.25);  // docs branch
    corridorStrip(3, 11.5, 9.5, -7.25);  // inbox branch
    corridorStrip(3, 11.5, 9.5, 7.25);   // marketing branch
  }

  function buildAtrium() {
    // raised disc
    var disc = new THREE.Mesh(new THREE.CircleGeometry(7, 48), MAT.atrium);
    disc.rotation.x = -Math.PI / 2; disc.position.y = 0.05; disc.receiveShadow = true;
    scene.add(disc);
    // saturated ring inlay (the one floor accent)
    var ringMat = new THREE.MeshStandardMaterial({ color: ACCENTS.manager, emissive: ACCENTS.manager, emissiveIntensity: 0.35, roughness: 0.5 });
    var ring = new THREE.Mesh(new THREE.TorusGeometry(6.4, 0.06, 8, 64), ringMat);
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.07; scene.add(ring);
    // dais
    var dais = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.8, 0.3, 8), MAT.desk);
    dais.position.set(0, 0.15, 0); dais.castShadow = true; dais.receiveShadow = true; scene.add(dais);
    // rostrum ring prop
    rostrumMat = new THREE.MeshStandardMaterial({ color: ACCENTS.manager, emissive: ACCENTS.manager, emissiveIntensity: 0.5, roughness: 0.4 });
    var rostrum = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.05, 8, 32), rostrumMat);
    rostrum.rotation.x = -Math.PI / 2; rostrum.position.set(0, 0.08, -2.5); scene.add(rostrum);
    // halo above the dais (brightens with mgr.halo)
    haloMat = new THREE.MeshStandardMaterial({ color: ACCENTS.manager, emissive: ACCENTS.manager, emissiveIntensity: 0.22, roughness: 0.4, transparent: true, opacity: 0.85 });
    haloMesh = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.05, 8, 40), haloMat);
    haloMesh.rotation.x = -Math.PI / 2; haloMesh.position.set(0, 2.7, 0); scene.add(haloMesh);
    // glass partitions between the four corridor mouths (encloses but transparent)
    var diag = [Math.PI / 4, 3 * Math.PI / 4, 5 * Math.PI / 4, 7 * Math.PI / 4];
    for (var i = 0; i < diag.length; i++) {
      var a = diag[i], rr = 6.6;
      var pane = new THREE.Mesh(new THREE.BoxGeometry(3.6, WALL_H, 0.1), MAT.glass);
      pane.position.set(Math.cos(a) * rr, WALL_H / 2, Math.sin(a) * rr);
      pane.rotation.y = -a + Math.PI / 2; scene.add(pane);
    }
    // atrium ceiling coffer frame + light pool disc
    cofferFrame(0, 0, 6.6, 6.6);
    var pool = new THREE.Mesh(GEO.pool, MAT.pool);
    pool.rotation.x = -Math.PI / 2; pool.position.set(0, 0.06, 0); pool.scale.setScalar(1.6); scene.add(pool);
  }

  function cofferFrame(cx, cz, hx, hz) {
    var t = 1.0, y = WALL_H - 0.02;
    scene.add(box(hx * 2, 0.12, t, cx, y, cz - hz + t / 2, MAT.ceiling, false, false));
    scene.add(box(hx * 2, 0.12, t, cx, y, cz + hz - t / 2, MAT.ceiling, false, false));
    scene.add(box(t, 0.12, hz * 2 - t * 2, cx - hx + t / 2, y, cz, MAT.ceiling, false, false));
    scene.add(box(t, 0.12, hz * 2 - t * 2, cx + hx - t / 2, y, cz, MAT.ceiling, false, false));
  }

  function buildRoom(id) {
    var A = AGENTS[id], cx = A.cx, cz = A.cz, hx = HALF_X, hz = HALF_Z, accent = A.accent;

    // floor
    var floor = new THREE.Mesh(GEO.roomFloor, MAT.floor);
    floor.rotation.x = -Math.PI / 2; floor.position.set(cx, 0.02, cz); floor.receiveShadow = true;
    scene.add(floor);

    // ceiling coffer frame (open centre lets the key light rake in for shadows)
    cofferFrame(cx, cz, hx, hz);

    // room downlight pool on the floor
    var pool = new THREE.Mesh(GEO.pool, MAT.pool);
    pool.rotation.x = -Math.PI / 2; pool.position.set(cx, 0.03, cz); pool.scale.setScalar(0.9); scene.add(pool);

    // walls
    var sides = ['E', 'W', 'N', 'S'];
    for (var i = 0; i < sides.length; i++) {
      var side = sides[i];
      if (side === A.door) buildDoorWall(id, side);
      else buildSolidWall(id, side);
    }

    // accent door threshold strip
    buildThreshold(id);
    // desk + monitor
    buildDesk(id);
    // work fixture
    buildFixture(id);
  }

  // fixed coordinate for a side's wall line
  function wallFixed(A, side) {
    if (side === 'E') return A.cx + HALF_X;
    if (side === 'W') return A.cx - HALF_X;
    if (side === 'N') return A.cz - HALF_Z;
    return A.cz + HALF_Z; // S
  }
  function isVert(side) { return side === 'E' || side === 'W'; }

  function buildSolidWall(id, side) {
    var A = AGENTS[id], mat = (A.ext.indexOf(side) >= 0) ? MAT.wallExt : MAT.wallInt;
    var f = wallFixed(A, side), m;
    if (isVert(side)) m = box(0.16, WALL_H, HALF_Z * 2, f, WALL_H / 2, A.cz, mat, false, false);
    else m = box(HALF_X * 2, WALL_H, 0.16, A.cx, WALL_H / 2, f, mat, false, false);
    scene.add(m);
  }

  function buildDoorWall(id, side) {
    var A = AGENTS[id], f = wallFixed(A, side), gapHalf = 0.8, kneeH = 0.9;
    if (isVert(side)) {
      var doorZ = A.cz, z0 = A.cz - HALF_Z, z1 = A.cz + HALF_Z;
      addVertPanel(f, z0, doorZ - gapHalf, kneeH);
      addVertPanel(f, doorZ + gapHalf, z1, kneeH);
      // lintel over the doorway
      scene.add(box(0.16, WALL_H - 2.2, 1.6, f, 2.2 + (WALL_H - 2.2) / 2, doorZ, MAT.wallInt, false, false));
    } else {
      var doorX = A.cx, x0 = A.cx - HALF_X, x1 = A.cx + HALF_X;
      addHorizPanel(f, x0, doorX - gapHalf, kneeH);
      addHorizPanel(f, doorX + gapHalf, x1, kneeH);
      scene.add(box(1.6, WALL_H - 2.2, 0.16, doorX, 2.2 + (WALL_H - 2.2) / 2, f, MAT.wallInt, false, false));
    }
  }
  function addVertPanel(x, z0, z1, kneeH) {
    var len = z1 - z0; if (len <= 0.01) return;
    var cz = (z0 + z1) / 2;
    scene.add(box(0.16, kneeH, len, x, kneeH / 2, cz, MAT.wallInt, false, false));
    scene.add(box(0.16, WALL_H - kneeH, len, x, kneeH + (WALL_H - kneeH) / 2, cz, MAT.glass, false, false));
  }
  function addHorizPanel(z, x0, x1, kneeH) {
    var len = x1 - x0; if (len <= 0.01) return;
    var cx = (x0 + x1) / 2;
    scene.add(box(len, kneeH, 0.16, cx, kneeH / 2, z, MAT.wallInt, false, false));
    scene.add(box(len, WALL_H - kneeH, 0.16, cx, kneeH + (WALL_H - kneeH) / 2, z, MAT.glass, false, false));
  }

  function buildThreshold(id) {
    var A = AGENTS[id], f = wallFixed(A, A.door), accent = A.accent;
    var tMat = new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.25, roughness: 0.6 });
    if (isVert(A.door)) scene.add(box(0.3, 0.04, 1.6, f, 0.03, A.cz, tMat, false, false));
    else scene.add(box(1.6, 0.04, 0.3, A.cx, 0.03, f, tMat, false, false));
  }

  function buildDesk(id) {
    var A = AGENTS[id], dp = A.deskPos;
    scene.add(box(1.6, 0.75, 0.9, dp[0], 0.375, dp[1], MAT.desk, true, false));
    // chair behind desk (toward the wall)
    var back = [dp[0] - A.fixFace[0] * 0.9, dp[1] - A.fixFace[1] * 0.9];
    scene.add(box(0.5, 0.9, 0.5, back[0], 0.45, back[1], MAT.chair, true, false));
    // monitor faces the atrium (so its glow spills into the room)
    var fy = faceY(dp[0], dp[1], 0, 0);
    var mon = new THREE.Group();
    mon.position.set(dp[0], 0.75, dp[1]); mon.rotation.y = fy;
    mon.add(box(0.9, 0.55, 0.06, 0, 0.45, 0.35, MAT.monitor, true, false));
    var sm = new THREE.MeshStandardMaterial({ color: COL.monitor, emissive: A.accent, emissiveIntensity: 0.15, roughness: 0.4 });
    var scr = new THREE.Mesh(GEO.screen, sm);
    scr.position.set(0, 0.45, 0.381); mon.add(scr);
    screenMat[id] = sm;
    scene.add(mon);
  }

  function buildFixture(id) {
    var A = AGENTS[id], wp = A.workPos, fn = A.fixFace;
    if (id === 'api') { buildServerRack(A); return; }
    // cabinet pushed against the wall + emissive accent panel facing the room
    var wallX = wp[0] + fn[0] * 0.35, wallZ = wp[1] + fn[1] * 0.35;
    var horiz = fn[0] !== 0; // fixture normal along X -> panel is wide along Z
    if (horiz) scene.add(box(0.3, 1.9, 1.8, wallX, 1.1, wallZ, MAT.prop, true, false));
    else scene.add(box(1.8, 1.9, 0.3, wallX, 1.1, wallZ, MAT.prop, true, false));
    var pm = new THREE.MeshStandardMaterial({ color: '#0a0b0e', emissive: A.accent, emissiveIntensity: 0.35, roughness: 0.5 });
    var pw = horiz ? 0.02 : 1.4, pd = horiz ? 1.4 : 0.02;
    var panel = new THREE.Mesh(new THREE.BoxGeometry(pw, 1.2, pd), pm);
    panel.position.set(wp[0] - fn[0] * 0.16, 1.25, wp[1] - fn[1] * 0.16);
    scene.add(panel); fixturePanel[id] = pm;
  }

  function buildServerRack(A) {
    var wp = A.workPos; // (0,20) against south wall
    var g = new THREE.Group(); g.position.set(wp[0], 0, wp[1]);
    for (var r = 0; r < 3; r++) g.add(box(1.6, 0.7, 0.7, 0, 0.4 + r * 0.75, 0, MAT.prop, true, false));
    ledMats = [];
    for (var i = 0; i < 4; i++) {
      var lm = new THREE.MeshStandardMaterial({ color: '#06181a', emissive: A.accent, emissiveIntensity: 0.4, roughness: 0.4 });
      var q = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.12), lm);
      q.position.set(-0.5 + i * 0.33, 1.5, -0.36); q.rotation.y = Math.PI; // face -Z (toward room)
      g.add(q); ledMats.push(lm);
    }
    fixturePanel.api = ledMats[0];
    scene.add(g);
  }

  function buildPlants() {
    var spots = [[-6.5, -5], [6.5, -5], [-6.5, 5], [6.5, 5], [4.5, 6.5], [-4.5, 6.5]];
    var n = reduced ? 4 : spots.length;
    for (var i = 0; i < n; i++) {
      var s = spots[i], g = new THREE.Group(); g.position.set(s[0], 0, s[1]);
      var pot = new THREE.Mesh(GEO.pot, MAT.pot); pot.position.y = 0.2; pot.castShadow = true; g.add(pot);
      var b1 = new THREE.Mesh(GEO.leaf, MAT.leaf); b1.position.y = 0.7; b1.scale.setScalar(0.9); b1.castShadow = true; g.add(b1);
      var b2 = new THREE.Mesh(GEO.leaf, MAT.leaf); b2.position.set(0.12, 1.05, 0.05); b2.scale.setScalar(0.6); b2.castShadow = true; g.add(b2);
      scene.add(g);
    }
  }

  function buildCoffee() {
    var g = new THREE.Group(); g.position.set(3.5, 0, 7.5);
    g.add(box(0.5, 0.7, 0.4, 0, 0.62, 0, MAT.prop, true, false)); // counter block
    var mMat = new THREE.MeshStandardMaterial({ color: COL.warm, emissive: COL.warm, emissiveIntensity: 0.6, roughness: 0.5 });
    var bead = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), mMat);
    bead.position.set(0.1, 0.98, 0.18); g.add(bead);
    scene.add(g);
  }

  /* ==========================================================
     9. PARTICLES  (motes + pooled transient sparks)
     ========================================================== */
  function buildParticles() {
    // dust motes
    var n = reduced ? Math.floor(MOTE_COUNT / 2) : MOTE_COUNT;
    var mp = new Float32Array(n * 3); moteData = [];
    for (var i = 0; i < n; i++) {
      var x = (Math.random() - 0.5) * 44, y = 0.4 + Math.random() * 5.6, z = (Math.random() - 0.5) * 36;
      mp[i * 3] = x; mp[i * 3 + 1] = y; mp[i * 3 + 2] = z;
      moteData.push({ x: x, y: y, z: z, sp: 0.15 + Math.random() * 0.3, ph: Math.random() * 6.28 });
    }
    var mg = new THREE.BufferGeometry(); mg.setAttribute('position', new THREE.Float32BufferAttribute(mp, 3));
    var mm = new THREE.PointsMaterial({ size: 0.05, color: COL.pool, transparent: true, opacity: 0.28, depthWrite: false });
    motes = new THREE.Points(mg, mm); motes.frustumCulled = false; scene.add(motes);

    // transient sparks (trails / sparkles / rising columns / steam)
    sparkPos = new Float32Array(SPARK_CAP * 3);
    sparkColArr = new Float32Array(SPARK_CAP * 3);
    for (var j = 0; j < SPARK_CAP; j++) {
      sparkPos[j * 3] = 0; sparkPos[j * 3 + 1] = -100; sparkPos[j * 3 + 2] = 0;
      sparkState.push({ active: false, life: 0, max: 1, x: 0, y: -100, z: 0, vx: 0, vy: 0, vz: 0, r: 0, g: 0, b: 0 });
    }
    var sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(sparkPos, 3));
    sg.setAttribute('color', new THREE.Float32BufferAttribute(sparkColArr, 3));
    var sm = new THREE.PointsMaterial({ size: 0.13, vertexColors: true, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    sparks = new THREE.Points(sg, sm); sparks.frustumCulled = false; scene.add(sparks);
  }

  function emitSpark(x, y, z, hex, vx, vy, vz, max) {
    if (reduced && Math.random() < 0.5) return;
    var slot = -1;
    for (var i = 0; i < SPARK_CAP; i++) { if (!sparkState[i].active) { slot = i; break; } }
    if (slot < 0) return;
    var c = hex01(hex), s = sparkState[slot];
    s.active = true; s.life = 0; s.max = max;
    s.x = x; s.y = y; s.z = z; s.vx = vx; s.vy = vy; s.vz = vz;
    s.r = c[0]; s.g = c[1]; s.b = c[2];
  }
  function updateSparks(dt) {
    if (!sparks) return;
    for (var i = 0; i < SPARK_CAP; i++) {
      var s = sparkState[i], o = i * 3;
      if (!s.active) { sparkColArr[o] = 0; sparkColArr[o + 1] = 0; sparkColArr[o + 2] = 0; continue; }
      s.life += dt;
      if (s.life >= s.max) { s.active = false; sparkPos[o + 1] = -100; sparkColArr[o] = 0; sparkColArr[o + 1] = 0; sparkColArr[o + 2] = 0; continue; }
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      var f = 1 - s.life / s.max;
      sparkPos[o] = s.x; sparkPos[o + 1] = s.y; sparkPos[o + 2] = s.z;
      sparkColArr[o] = s.r * f; sparkColArr[o + 1] = s.g * f; sparkColArr[o + 2] = s.b * f;
    }
    sparks.geometry.attributes.position.needsUpdate = true;
    sparks.geometry.attributes.color.needsUpdate = true;
  }
  function updateMotes(dt) {
    if (!motes) return;
    var pos = motes.geometry.attributes.position.array;
    for (var i = 0; i < moteData.length; i++) {
      var m = moteData[i];
      m.y += m.sp * dt; m.ph += dt;
      if (m.y > 6) { m.y = 0.4; }
      pos[i * 3] = m.x + Math.sin(time * 0.3 + m.ph) * 0.12;
      pos[i * 3 + 1] = m.y;
      pos[i * 3 + 2] = m.z;
    }
    motes.geometry.attributes.position.needsUpdate = true;
  }

  /* ==========================================================
     10. RINGS + CHECKMARKS (pooled)
     ========================================================== */
  function spawnRing(x, y, z, hex, life) {
    var mesh = ringPool.pop();
    if (!mesh) {
      if (rings.length > 18) return;
      mesh = new THREE.Mesh(GEO.ring, new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }));
      mesh.rotation.x = -Math.PI / 2; scene.add(mesh);
    }
    mesh.material.color.set(hex); mesh.material.opacity = 0.8; mesh.visible = true;
    mesh.position.set(x, y, z); mesh.scale.setScalar(0.3);
    rings.push({ mesh: mesh, life: 0, max: life });
  }
  function updateRings(dt) {
    for (var i = rings.length - 1; i >= 0; i--) {
      var r = rings[i]; r.life += dt;
      var k = r.life / r.max;
      if (k >= 1) { r.mesh.visible = false; ringPool.push(r.mesh); rings.splice(i, 1); continue; }
      var sc = 0.3 + k * 2.7; r.mesh.scale.setScalar(sc);
      r.mesh.material.opacity = 0.8 * (1 - k);
    }
  }

  function spawnCheck(x, y, z, hex) {
    var grp = checkPool.pop();
    if (!grp) {
      if (checks.length > 6) return;
      var m = new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
      grp = new THREE.Group();
      var b1 = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.08, 0.08), m); b1.position.set(-0.12, -0.02, 0); b1.rotation.z = 0.9;
      var b2 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.08), m); b2.position.set(0.12, 0.06, 0); b2.rotation.z = -0.6;
      grp.add(b1); grp.add(b2); grp.userData.mat = m; scene.add(grp);
    }
    grp.userData.mat.color.set(hex); grp.userData.mat.opacity = 1; grp.visible = true;
    grp.position.set(x, y, z);
    checks.push({ grp: grp, life: 0, max: 0.9 });
  }
  function updateChecks(dt) {
    for (var i = checks.length - 1; i >= 0; i--) {
      var c = checks[i]; c.life += dt;
      var k = c.life / c.max;
      if (k >= 1) { c.grp.visible = false; checkPool.push(c.grp); checks.splice(i, 1); continue; }
      c.grp.position.y += dt * 0.5;
      c.grp.userData.mat.opacity = k < 0.3 ? (k / 0.3) : (1 - (k - 0.3) / 0.7);
    }
  }

  /* ==========================================================
     11. PEOPLE  (shared bean build, per-accent tint)
     ========================================================== */
  function makePerson(id) {
    var A = AGENTS[id], accent = A.accent, isMgr = id === 'manager';
    var group = new THREE.Group();
    var rig = new THREE.Group(); group.add(rig);

    var body = new THREE.Mesh(GEO.body, MAT.body); body.position.y = 0.75; body.castShadow = true; rig.add(body);
    var head = new THREE.Mesh(GEO.head, MAT.body); head.position.y = 1.5; head.castShadow = true; rig.add(head);

    var visorMat = new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: isMgr ? 0.8 : 0.6, roughness: 0.4, metalness: 0.2 });
    var visor = new THREE.Mesh(GEO.visor, visorMat); visor.position.set(0, 1.52, 0.22); rig.add(visor);

    var rimMat = new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.35, roughness: 0.5, metalness: 0.2 });
    var rim = new THREE.Mesh(GEO.rim, rimMat); rim.position.y = 1.05; rim.rotation.x = Math.PI / 2; rig.add(rim);

    var footL = new THREE.Mesh(GEO.foot, MAT.body); footL.position.set(-0.14, 0.06, 0.02); footL.castShadow = true; rig.add(footL);
    var footR = new THREE.Mesh(GEO.foot, MAT.body); footR.position.set(0.14, 0.06, 0.02); footR.castShadow = true; rig.add(footR);

    var searchMat = new THREE.MeshBasicMaterial({ color: accent });
    var searchOrb = new THREE.Mesh(GEO.searchOrb, searchMat); searchOrb.position.set(0, 1.75, 0.45); searchOrb.visible = false; rig.add(searchOrb);

    if (isMgr) group.scale.setScalar(1.12);
    group.userData = { rig: rig, body: body, head: head, visor: visor, visorMat: visorMat, rim: rim, rimMat: rimMat, footL: footL, footR: footR, searchOrb: searchOrb };
    return group;
  }

  function makeRT(id) {
    return {
      state: 'idle', prev: 'idle',
      rim: { x: 0.35, t: 0.35 }, roomGlow: { x: 0.15, t: 0.15 }, screen: { x: 0.15, t: 0.15 },
      pop: spring(1, 190, 16), bounce: spring(0, 220, 12),
      breath: Math.random() * 6.28, work: Math.random() * 6.28, orbitAngle: Math.random() * 6.28,
      speaking: false, mouthPh: 0, doneT: -1, hash: Math.random() * 10,
      lastDeliver: -1, walkDeliver: false
    };
  }
  function makeMV(id) {
    var hp = (id === 'manager') ? [0, 0] : AGENTS[id].homePos;
    var fa = faceY(hp[0], hp[1], 0, 0);
    return {
      pos: new THREE.Vector3(hp[0], 0, hp[1]), path: null, pi: 0, moving: false, speed: 2.3,
      faceAngle: fa, targetAngle: fa, stepPhase: 0, task: 'idle', dwellT: 0,
      ambientT: 8 + Math.random() * 12, wdT: 0, wdPhase: 0, workLoopT: 0,
      daisY: (id === 'manager') ? 0.3 : 0
    };
  }
  function buildPeople() {
    for (var i = 0; i < IDS.length; i++) {
      var id = IDS[i];
      RT[id] = makeRT(id); MV[id] = makeMV(id);
      var g = makePerson(id);
      var mv = MV[id];
      g.position.set(mv.pos.x, mv.daisY, mv.pos.z); g.rotation.y = mv.faceAngle;
      people[id] = g; scene.add(g);
    }
  }

  /* ==========================================================
     12. NAV / WALKING
     ========================================================== */
  function homeNode(id) { return id === 'manager' ? 'HUB' : id + '_home'; }
  function workNode(id) { return id + '_work'; }
  function deskNode(id) { return id + '_desk'; }

  function goToNode(id, goal, task) {
    var mv = MV[id];
    var start = nearestNode(mv.pos.x, mv.pos.z);
    var names = shortestPath(start, goal);
    if (!names || !names.length) { mv.moving = false; mv.task = 'idle'; return false; }
    mv.path = [];
    for (var i = 0; i < names.length; i++) { var p = NODES[names[i]]; mv.path.push(new THREE.Vector3(p[0], 0, p[1])); }
    mv.pi = 0; mv.task = task; mv.moving = true; mv.wdT = 0; mv.wdPhase = mv.stepPhase;
    if (mv.path.length && Math.hypot(mv.path[0].x - mv.pos.x, mv.path[0].z - mv.pos.z) < 0.3) mv.pi = 1;
    if (mv.pi >= mv.path.length) mv.moving = false;
    return mv.moving;
  }
  function pathLen(id, goal) {
    var mv = MV[id], start = nearestNode(mv.pos.x, mv.pos.z);
    var names = shortestPath(start, goal);
    if (!names) return -1;
    var p0 = NODES[names[0]], d = Math.hypot(mv.pos.x - p0[0], mv.pos.z - p0[1]);
    for (var i = 1; i < names.length; i++) { var a = NODES[names[i - 1]], b = NODES[names[i]]; d += Math.hypot(a[0] - b[0], a[1] - b[1]); }
    return d;
  }
  function goHome(id) { goToNode(id, homeNode(id), 'return'); }
  function atHome(id) {
    var mv = MV[id], hp = (id === 'manager') ? [0, 0] : AGENTS[id].homePos;
    return Math.hypot(mv.pos.x - hp[0], mv.pos.z - hp[1]) < 0.35;
  }

  function integrateMove(id, dt) {
    var mv = MV[id];
    var tgt = mv.path ? mv.path[mv.pi] : null;
    if (!tgt) { arrive(id); return; }
    var dx = tgt.x - mv.pos.x, dz = tgt.z - mv.pos.z, d = Math.hypot(dx, dz), step = mv.speed * dt;
    if (d <= 1e-4 || step >= d) {
      mv.pos.x = tgt.x; mv.pos.z = tgt.z; mv.pi++;
      if (mv.pi >= mv.path.length) arrive(id);
    } else {
      var ux = dx / d, uz = dz / d;
      mv.pos.x += ux * step; mv.pos.z += uz * step;
      if (!reduced) mv.stepPhase += step * STEP_FREQ;
      mv.targetAngle = Math.atan2(ux, uz);
    }
    mv.wdT += dt;
    if (mv.wdT > 2 && Math.abs(mv.stepPhase - mv.wdPhase) < 0.01) {
      var last = mv.path[mv.path.length - 1]; if (last) { mv.pos.x = last.x; mv.pos.z = last.z; } arrive(id);
    } else if (mv.wdT > 2) { mv.wdT = 0; mv.wdPhase = mv.stepPhase; }
  }

  function arrive(id) {
    var mv = MV[id], rt = RT[id], A = AGENTS[id];
    mv.moving = false; mv.path = null; mv.pi = 0;
    if (mv.task === 'deliver') {
      mv.targetAngle = faceY(mv.pos.x, mv.pos.z, 0, 0);
      mgr.halo.x = Math.min(1.3, mgr.halo.x + 0.28);
      spawnRing(0, 1.0, 0, COL.neutral, 0.5);
      spawnRing(mv.pos.x, 0.9, mv.pos.z, A.accent, 0.6);
      rt.walkDeliver = false; mv.dwellT = 0.5; mv.task = 'handoff';
    } else if (mv.task === 'ambient') {
      mv.dwellT = 1.5 + Math.random() * 2.5; mv.task = 'dwell';
    } else if (mv.task === 'work') {
      mv.targetAngle = Math.atan2(-A.fixFace[0], -A.fixFace[1]); // face the fixture on the wall
      mv.task = 'atwork';
    } else if (mv.task === 'workstep') {
      goToNode(id, workNode(id), 'work');
    } else if (mv.task === 'return' || mv.task === 'handoff' || mv.task === 'dwell') {
      mv.task = 'idle';
      mv.targetAngle = faceY(mv.pos.x, mv.pos.z, 0, 0);
      if (rt.state === 'idle') mv.ambientT = 9 + Math.random() * 12;
    } else {
      mv.task = 'idle';
    }
  }

  function countAmbientWalkers() {
    var n = 0;
    for (var i = 0; i < IDS.length; i++) {
      var mv = MV[IDS[i]], rt = RT[IDS[i]];
      if (mv.task === 'ambient' || mv.task === 'dwell' || (mv.task === 'return' && rt.state === 'idle')) n++;
    }
    return n;
  }
  function pickAmbientPOI(id) {
    var opts = ['coffee', 'HUB'];
    var others = SPECIALISTS.filter(function (o) { return o !== id; });
    if (id === 'manager') others = SPECIALISTS.slice();
    if (others.length) opts.push(others[(Math.random() * others.length) | 0] + '_home');
    return opts[(Math.random() * opts.length) | 0];
  }

  function updateBehavior(id, dt) {
    var mv = MV[id], rt = RT[id], A = AGENTS[id];
    if (mv.moving) { integrateMove(id, dt); return; }
    if (mv.dwellT > 0) {
      mv.dwellT -= dt;
      if (mv.dwellT <= 0) { if (mv.task === 'dwell' || mv.task === 'handoff') goHome(id); }
      return;
    }
    if ((rt.state === 'working' || rt.state === 'searching') && mv.task === 'atwork') {
      mv.workLoopT -= dt;
      if (mv.workLoopT <= 0) { mv.workLoopT = 4 + Math.random() * 3; goToNode(id, deskNode(id), 'workstep'); }
      return;
    }
    if (rt.state === 'assigned' || rt.state === 'delivering') return; // hold at desk
    if (rt.state === 'idle' && atHome(id)) {
      mv.ambientT -= dt;
      if (mv.ambientT <= 0) {
        var base = (id === 'manager') ? 22 : 10;
        mv.ambientT = base + Math.random() * 14;
        if (id === 'manager' && Math.random() < 0.5) return; // Agent Sea mostly presides
        if (countAmbientWalkers() < MAX_AMBIENT) {
          var poi = pickAmbientPOI(id);
          if (poi) goToNode(id, poi, 'ambient');
        }
      }
    }
  }

  /* ==========================================================
     13. STATE MACHINE  (setAgent / setManager / speak / focus)
     ========================================================== */
  function chestY(id) { return (id === 'manager' ? 0.3 : 0) + 1.05; }

  function applyAgentState(id, st) {
    var rt = RT[id], mv = MV[id], A = AGENTS[id]; if (!rt || !mv) return;
    if (st === 'idle') {
      rt.rim.t = 0.35; rt.roomGlow.t = 0.15; rt.screen.t = 0.15; rt.walkDeliver = false;
      if (!atHome(id) && !mv.moving) goHome(id);
      else if (mv.task === 'work' || mv.task === 'deliver' || mv.task === 'atwork' || mv.task === 'workstep') goHome(id);
      mv.ambientT = 9 + Math.random() * 12;
      if (activeAgent === id) activeAgent = null;
    } else if (st === 'assigned') {
      rt.rim.t = 1.2; rt.roomGlow.t = 0.9; rt.screen.t = 0.25;
      rt.pop.x = 0.86; rt.pop.v = 0;
      activeAgent = id;
      spawnRing(mv.pos.x, chestY(id) + 0.9, mv.pos.z, A.accent, 0.9);
      mv.targetAngle = faceY(mv.pos.x, mv.pos.z, 0, 0);
      if (!atHome(id) && mv.task !== 'return') goHome(id);
    } else if (st === 'working' || st === 'searching') {
      rt.rim.t = 1.2; rt.roomGlow.t = 1.1; rt.screen.t = 1.4;
      activeAgent = id;
      goToNode(id, workNode(id), 'work');
      mv.workLoopT = 4 + Math.random() * 3;
    } else if (st === 'delivering') {
      rt.rim.t = 1.2; rt.roomGlow.t = 1.0; rt.screen.t = 0.6;
      activeAgent = id;
      var len = pathLen(id, 'HUB');
      if (!reduced && len >= 0 && len <= DELIVER_MAX) { rt.walkDeliver = true; goToNode(id, 'HUB', 'deliver'); }
      else rt.walkDeliver = false;
      deliver(id);
    } else if (st === 'done') {
      rt.rim.t = 1.2; rt.roomGlow.t = 0.4; rt.screen.t = 0.3;
      rt.doneT = 0; rt.walkDeliver = false;
      rt.bounce.x = 0; rt.bounce.v = 3.0;
      spawnDone(id);
      if (activeAgent === id) activeAgent = null;
    }
  }

  function setAgent(id, st) {
    var rt = RT[id]; if (!rt) return;
    if (!AGENT_STATES[st]) return;
    rt.prev = rt.state; rt.state = st;
    applyAgentState(id, st);
  }

  function setManager(st) {
    if (st !== 'idle' && st !== 'thinking' && st !== 'speaking') return;
    var prev = mgr.state; mgr.state = st;
    if (st === 'thinking') { mgr.halo.t = 0.85; mgr.thinkT = 0; }
    else if (st === 'speaking') { mgr.halo.t = 1.0; mgr.speakPh = 0; mgr.ringT = 0; }
    else {
      mgr.halo.t = 0.22; mgr.speaking = false;
      if (RT.manager) RT.manager.speaking = false;
      if (prev === 'speaking') resetAgentsDormant();
    }
  }
  function resetAgentsDormant() {
    for (var i = 0; i < SPECIALISTS.length; i++) {
      var id = SPECIALISTS[i], rt = RT[id]; if (!rt) continue;
      if (rt.state !== 'done') { rt.state = 'idle'; applyAgentState(id, 'idle'); }
    }
    activeAgent = null;
  }

  function speak(id, on) {
    var rt = RT[id]; if (!rt) return;
    rt.speaking = !!on; if (on) rt.mouthPh = 0;
    if (id === 'manager') { mgr.speaking = !!on; if (on) mgr.speakPh = 0; }
  }

  function focus(id) {
    if (id && LAY[id]) {
      cam.tgt.set(LAY[id].cx, 1.4, LAY[id].cz);
      cam.dist = (id === 'manager') ? 20 : 16;
      cam.active = true; cam.forcing = true;
    } else {
      cam.tgt.set(0, 1.5, 0); cam.dist = 42; cam.active = false; cam.forcing = true;
    }
  }

  /* ==========================================================
     14. ORBS  (quadratic Bézier arc, pooled)
     ========================================================== */
  function chestVec(id, out) {
    var mv = MV[id];
    out.set(mv.pos.x, (id === 'manager' ? mv.daisY : 0) + 1.15, mv.pos.z);
    return out;
  }
  function spawnOrb(type, accent, from, to) {
    var mesh = orbPool.pop();
    if (!mesh) { if (orbs.length > 10) return; mesh = new THREE.Mesh(GEO.orb, MAT.orbCore); scene.add(mesh); }
    mesh.material = MAT.orb[accent] || MAT.orbCore; mesh.visible = true; mesh.scale.setScalar(1);
    var ctrl = new THREE.Vector3((from.x + to.x) / 2, Math.max(from.y, to.y) + 3.4, (from.z + to.z) / 2);
    orbs.push({ type: type, accent: accent, from: from.clone(), to: to.clone(), ctrl: ctrl, t: 0, dur: reduced ? 0.12 : ORB_DUR, mesh: mesh });
  }
  function dispatch(id) {
    var A = AGENTS[id]; if (!A || id === 'manager') return;
    spawnOrb('dispatch', A.accent, chestVec('manager', new THREE.Vector3()), chestVec(id, new THREE.Vector3()));
    if (RT[id]) RT[id].rim.t = 1.2;
  }
  function deliver(id) {
    var A = AGENTS[id], rt = RT[id];
    if (!A || !rt || id === 'manager') return;
    if (time - rt.lastDeliver < 0.28) return;     // debounce dual-trigger
    rt.lastDeliver = time;
    if (rt.walkDeliver) return;                    // the walking body carries the result
    spawnOrb('deliver', A.accent, chestVec(id, new THREE.Vector3()), chestVec('manager', new THREE.Vector3()));
  }
  function bez(a, b, c, t, out) {
    var u = 1 - t;
    out.x = u * u * a.x + 2 * u * t * b.x + t * t * c.x;
    out.y = u * u * a.y + 2 * u * t * b.y + t * t * c.y;
    out.z = u * u * a.z + 2 * u * t * b.z + t * t * c.z;
  }
  function updateOrbs(dt) {
    for (var i = orbs.length - 1; i >= 0; i--) {
      var o = orbs[i];
      o.t += dt / o.dur;
      var e = easeOrb(clamp(o.t, 0, 1));
      bez(o.from, o.ctrl, o.to, e, o.mesh.position);
      if (!reduced && o.t < 1) emitSpark(o.mesh.position.x, o.mesh.position.y, o.mesh.position.z, o.accent, 0, 0.2, 0, 0.34);
      if (o.t >= 1) { onOrbArrive(o); o.mesh.visible = false; orbPool.push(o.mesh); orbs.splice(i, 1); }
    }
  }
  function onOrbArrive(o) {
    if (o.type === 'dispatch') {
      var rt = null, id = null, i;
      for (i = 0; i < IDS.length; i++) { if (AGENTS[IDS[i]].accent === o.accent && IDS[i] !== 'manager') { id = IDS[i]; break; } }
      if (id) { rt = RT[id]; if (rt) { rt.rim.t = 1.2; rt.pop.x = 0.9; rt.pop.v = 0; } }
      spawnRing(o.to.x, o.to.y - 0.9, o.to.z, o.accent, 0.5);
    } else {
      mgr.halo.x = Math.min(1.3, mgr.halo.x + 0.28);
      spawnRing(0, 1.0, 0, COL.neutral, 0.5);
    }
  }

  function spawnDone(id) {
    var mv = MV[id], A = AGENTS[id], n = reduced ? 3 : 5, y = (id === 'manager' ? mv.daisY : 0);
    for (var i = 0; i < n; i++) {
      emitSpark(mv.pos.x + (Math.random() - 0.5) * 0.6, y + 1.2 + Math.random() * 0.4, mv.pos.z + (Math.random() - 0.5) * 0.4,
        A.accent, (Math.random() - 0.5) * 0.6, 1.0 + Math.random() * 0.7, (Math.random() - 0.5) * 0.6, 0.6 + Math.random() * 0.25);
    }
    spawnCheck(mv.pos.x, y + 1.7, mv.pos.z, A.accent);
  }

  /* ==========================================================
     15. PER-FRAME AGENT ANIMATION
     ========================================================== */
  function updateAgent(id, dt) {
    var rt = RT[id], mv = MV[id], g = people[id], ud = g.userData, A = AGENTS[id];
    var isMgr = id === 'manager';

    // eased scalars
    ez(rt.rim, dt, 6); ez(rt.roomGlow, dt, 5); ez(rt.screen, dt, 6);
    stepSpring(rt.pop, dt); stepSpring(rt.bounce, dt);
    if (!reduced) { rt.breath += dt * (2 * Math.PI / (3.6 + rt.hash * 0.05)); }
    if (rt.speaking) rt.mouthPh += dt;

    // done -> settle back to idle after the beat
    if (rt.doneT >= 0) {
      rt.doneT += dt;
      if (rt.state === 'done') { var kk = clamp((rt.doneT - 0.4) / 0.4, 0, 1); rt.rim.t = 1.2 + (0.35 - 1.2) * kk; rt.roomGlow.t = 0.4 * (1 - kk) + 0.15 * kk; }
      if (rt.doneT >= DONE_DUR) { rt.doneT = -1; if (rt.state === 'done') { rt.state = 'idle'; applyAgentState(id, 'idle'); } }
    }

    // walking + behaviors
    updateBehavior(id, dt);

    // --- transform ---
    // facing ease (turn-to-face travel / target)
    mv.faceAngle += shortAngle(mv.faceAngle, mv.targetAngle) * Math.min(1, dt * 10);
    g.rotation.y = mv.faceAngle;

    // manager rises/steps off the dais smoothly
    var baseY = 0;
    if (isMgr) { var onDais = Math.hypot(mv.pos.x, mv.pos.z) < 1.6; mv.daisY += ((onDais ? 0.3 : 0) - mv.daisY) * Math.min(1, dt * 8); baseY = mv.daisY; }

    var moving = mv.moving;
    var workPose = !moving && (rt.state === 'working' || rt.state === 'searching') && (mv.task === 'atwork' || mv.task === 'workstep');
    var bob = 0, roll = 0, lean = 0, breathScale = 1, headBob = 0;

    if (moving && !reduced) {
      bob = Math.abs(Math.sin(mv.stepPhase)) * 0.06;
      roll = Math.sin(mv.stepPhase) * 0.05;
      lean = 0.05;
      ud.footL.rotation.x = Math.sin(mv.stepPhase) * 0.6;
      ud.footR.rotation.x = -Math.sin(mv.stepPhase) * 0.6;
    } else {
      ud.footL.rotation.x += (0 - ud.footL.rotation.x) * Math.min(1, dt * 8);
      ud.footR.rotation.x += (0 - ud.footR.rotation.x) * Math.min(1, dt * 8);
      if (workPose) {
        if (!reduced) rt.work += dt * 4.5;
        headBob = Math.sin(rt.work * 2) * 0.02;               // typing bob
        lean = 0.08;
      } else {
        breathScale = 1 + (reduced ? 0 : Math.sin(rt.breath) * 0.02);   // calm breathing
        headBob = reduced ? 0 : Math.sin(rt.breath) * 0.01;
        if (isMgr && mgr.state === 'speaking') headBob = Math.sin(mgr.speakPh * 9) * 0.03;
        else if (isMgr && mgr.state === 'thinking') { headBob = Math.sin(time * 1.4) * 0.02; lean = Math.sin(time) * 0.04; }
      }
    }

    g.position.set(mv.pos.x, baseY + bob + Math.max(0, rt.bounce.x), mv.pos.z);
    ud.rig.rotation.z = roll;
    ud.rig.rotation.x = lean;
    var pop = rt.pop.x;
    ud.rig.scale.set(1, pop * breathScale, 1);
    ud.head.position.y = 1.5 + headBob;

    // emissive drivers
    ud.rimMat.emissiveIntensity = rt.rim.x;
    var vBase = isMgr ? 0.8 : 0.6;
    var speakingNow = rt.speaking && (!isMgr || mgr.speaking);
    ud.visorMat.emissiveIntensity = vBase + (speakingNow ? (0.4 * (0.5 + 0.5 * Math.sin((isMgr ? mgr.speakPh : rt.mouthPh) * 12))) : 0);

    if (!isMgr) {
      if (roomLights[id]) roomLights[id].intensity = rt.roomGlow.x;
      if (screenMat[id]) {
        var flick = 0.02 * Math.sin(time * 13 + rt.hash);
        var val = rt.screen.x + flick;
        if (rt.state === 'working' || rt.state === 'searching') val = rt.screen.x * (0.85 + 0.25 * Math.sin(time * 6));
        screenMat[id].emissiveIntensity = Math.max(0, val);
      }
      // searching orbiting indicator
      if (rt.state === 'searching') {
        rt.orbitAngle += dt * 3; ud.searchOrb.visible = true;
        ud.searchOrb.position.set(Math.cos(rt.orbitAngle) * 0.45, 1.75, Math.sin(rt.orbitAngle) * 0.45);
      } else ud.searchOrb.visible = false;
    }
  }

  function updateManager(dt) {
    ez(mgr.halo, dt, 4);
    if (haloMat) haloMat.emissiveIntensity = mgr.halo.x;
    if (atriumAccent) atriumAccent.intensity = 0.35 + mgr.halo.x * 0.9;
    if (mgr.state === 'thinking') {
      mgr.thinkT += dt;
      if (!reduced && mgr.thinkT > 0.12) { mgr.thinkT = 0; emitSpark((Math.random() - 0.5) * 0.8, 0.5, (Math.random() - 0.5) * 0.8, ACCENTS.manager, 0, 1.2 + Math.random() * 0.6, 0, 1.2); }
    }
    if (mgr.speaking) {
      mgr.speakPh += dt; mgr.ringT -= dt;
      if (mgr.ringT <= 0) { mgr.ringT = 0.5; spawnRing(0, 1.0, 0, ACCENTS.manager, 0.9); }
    }
  }

  /* ==========================================================
     16. CAMERA  (OrbitControls + focus dolly tween)
     ========================================================== */
  function updateCameraTween(dt) {
    if (!cam.forcing) return;
    var k = 1 - Math.pow(0.0022, dt);
    controls.target.lerp(cam.tgt, k);
    _v.copy(camera.position).sub(controls.target);
    var curDist = _v.length();
    if (curDist < 1e-3) { _v.set(0.6, 0.5, 1); curDist = _v.length(); }
    _v.normalize();
    var nd = curDist + (cam.dist - curDist) * k;
    camera.position.copy(controls.target).add(_v.multiplyScalar(nd));
    if (!cam.active && controls.target.distanceTo(cam.tgt) < 0.05 && Math.abs(curDist - cam.dist) < 0.25) cam.forcing = false;
  }

  /* ==========================================================
     17. FIXTURES ambient (server LEDs, fixture shimmer)
     ========================================================== */
  function updateFixtures(dt) {
    for (var i = 0; i < ledMats.length; i++) {
      var api = RT.api, on = api && (api.state === 'working' || api.state === 'searching');
      var base = on ? 0.9 : 0.35;
      ledMats[i].emissiveIntensity = base * (0.5 + 0.5 * Math.sin(time * (1.6 + i * 0.5) + i));
    }
    for (var k = 0; k < SPECIALISTS.length; k++) {
      var id = SPECIALISTS[k], pm = fixturePanel[id]; if (!pm || id === 'api') continue;
      var rt = RT[id], act = rt && (rt.state === 'working' || rt.state === 'searching');
      pm.emissiveIntensity = (act ? 0.9 : 0.3) + 0.05 * Math.sin(time * 9 + k);
    }
  }

  /* ==========================================================
     18. MAIN LOOP
     ========================================================== */
  function tick() {
    try {
      var dt = Math.min(clock.getDelta(), 0.05); time += dt;
      updateCameraTween(dt);
      controls.update();
      for (var i = 0; i < IDS.length; i++) updateAgent(IDS[i], dt);
      updateManager(dt);
      updateOrbs(dt); updateRings(dt); updateChecks(dt);
      updateSparks(dt); updateMotes(dt);
      updateFixtures(dt);
      composer.render();
    } catch (e) { /* never break the loop */ }
  }

  /* ==========================================================
     19. INIT / RESIZE
     ========================================================== */
  function canvasSize() {
    var w = (canvas.clientWidth) || (canvas.parentNode && canvas.parentNode.clientWidth) || window.innerWidth || 1024;
    var h = (canvas.clientHeight) || (canvas.parentNode && canvas.parentNode.clientHeight) || window.innerHeight || 768;
    return { w: Math.max(1, w), h: Math.max(1, h) };
  }

  function doInit(el) {
    if (built) return;
    if (!THREE || !OrbitControls || !EffectComposer || !RenderPass || !UnrealBloomPass || !OutputPass) {
      warnOnce('[World] WebGL unavailable — scene disabled'); return;
    }
    canvas = el || (document.getElementById && document.getElementById('stage'));
    if (!canvas || !canvas.getContext) { warnOnce('[World] WebGL unavailable — scene disabled'); return; }

    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: 'high-performance' });
    } catch (e) { renderer = null; }
    if (!renderer) { warnOnce('[World] WebGL unavailable — scene disabled'); return; }
    try { if (!renderer.getContext()) { warnOnce('[World] WebGL unavailable — scene disabled'); return; } } catch (e2) { warnOnce('[World] WebGL unavailable — scene disabled'); return; }

    try { reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e3) { reduced = false; }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.55;

    var sz = canvasSize();
    camera = new THREE.PerspectiveCamera(48, sz.w / sz.h, 0.1, 500);
    camera.position.set(26, 24, 30);

    _v = new THREE.Vector3(); _v2 = new THREE.Vector3();
    cam.tgt = new THREE.Vector3(0, 1.5, 0);

    buildGraph();
    buildAssets();
    buildScene();

    // controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.08;
    controls.enablePan = true;
    controls.minDistance = 10; controls.maxDistance = 70;
    controls.maxPolarAngle = Math.PI * 0.47; controls.minPolarAngle = Math.PI * 0.12;
    controls.target.set(0, 1.5, 0);
    try { controls.keys = {}; } catch (ek) {}          // no keyboard capture (command bar keeps focus)
    controls.addEventListener('start', function () { cam.forcing = false; });   // user grab wins
    controls.update();

    // post chain
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloom = new UnrealBloomPass(new THREE.Vector2(sz.w, sz.h), 0.75, 0.6, 0.85);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    clock = new THREE.Clock();

    built = true; ready = true;
    resize();
    setManager('idle');

    try {
      var rm = window.matchMedia('(prefers-reduced-motion: reduce)');
      var addR = rm.addEventListener ? rm.addEventListener.bind(rm, 'change') : (rm.addListener && rm.addListener.bind(rm));
      if (addR) addR(function () { try { reduced = !!rm.matches; } catch (e) {} });
    } catch (e4) {}
    try { window.addEventListener('resize', resize); } catch (e5) {}

    renderer.setAnimationLoop(tick);
  }

  function resize() {
    if (!ready) return;
    var sz = canvasSize();
    camera.aspect = sz.w / sz.h; camera.updateProjectionMatrix();
    renderer.setSize(sz.w, sz.h, false);
    composer.setSize(sz.w, sz.h);
  }

  /* ==========================================================
     20. PUBLIC API  (never throws; safe no-op until ready)
     ========================================================== */
  function guard(fn) {
    return function () { if (!ready) return; try { return fn.apply(null, arguments); } catch (e) {} };
  }

  window.World = {
    init: function (el) { try { doInit(el); } catch (e) { warnOnce('[World] WebGL unavailable — scene disabled'); } },
    setManager: guard(setManager),
    setAgent: guard(setAgent),
    dispatch: guard(dispatch),
    deliver: guard(deliver),
    speak: guard(speak),
    focus: guard(function (id) { focus(id); }),
    resize: function () { try { resize(); } catch (e) {} }
  };
})();
