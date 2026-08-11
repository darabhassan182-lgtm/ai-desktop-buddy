/* ============================================================
   NEXUS — game.js · WORLD 4.0 "Nexus Town" (2D pixel-art, top-down)
   A cute Kenney "Tiny Town" (CC0) pixel world: five specialist
   offices (houses) around Agent Sea's stone HQ, with little pixel
   employees that walk around, stay by their own office, and only
   cross the field to hand a result to Agent Sea. Pan/zoom camera.

   Pure Canvas 2D — no WebGL, no libraries. The tile atlas is a
   data-URI in window.NEXUS_TILES_B64 (12x11 grid of 16px tiles).
   Characters are drawn procedurally in matching pixel style.

   window.World is set at the end. Never throws on unknown agentId.
     World.init(canvasEl)  setManager(state)  setAgent(id,state)
     dispatch(id)  deliver(id)  speak(id,on)  focus(id|null)  resize()
   ============================================================ */
(function () {
  'use strict';

  /* ---------- atlas ---------- */
  var TILE = 16, COLS = 12;
  var atlas = new Image();
  var atlasReady = false;
  atlas.onload = function () { atlasReady = true; };
  atlas.onerror = function () { try { console.warn('[World] tile atlas failed to load'); } catch (e) {} };
  try { atlas.src = window.NEXUS_TILES_B64 || ''; } catch (e) {}

  /* ---------- tile ids (from the validated atlas map) ---------- */
  var GRASS = [0, 0, 0, 0, 1, 2];          // weighted grass fill
  var TREES = [3, 4, 8, 6, 7];
  var FENCE_H = 45, FENCE_L = 47, FENCE_R = 46;
  // house stamps (peaked): [roofPeak]/[roof]/[wall with door+windows]
  var HOUSE_RED  = [[null, 67, null], [52, 53, 54], [84, 85, 88]];
  var HOUSE_GREY = [[null, 63, null], [48, 49, 50], [72, 74, 73]];
  // Agent Sea HQ (stone keep)
  var HQ = [[96, 97, 98, 97, 98], [108, 109, 110, 109, 110], [120, 121, 123, 122, 122]];

  /* ---------- agents ---------- */
  var ACCENTS = {
    manager: '#7c9cff', research: '#4f6bff', docs: '#34d399',
    marketing: '#f59e0b', inbox: '#ec4899', api: '#22d3ee'
  };
  // building top-left tile coords + house style; door tile is bottom-center.
  var AGENTS = {
    manager:   { name: 'Agent Sea', accent: ACCENTS.manager,   bx: 19, by: 12, stamp: HQ,        w: 5, h: 3 },
    research:  { name: 'Scout',     accent: ACCENTS.research,   bx: 6,  by: 5,  stamp: HOUSE_GREY, w: 3, h: 3 },
    inbox:     { name: 'Echo',      accent: ACCENTS.inbox,      bx: 35, by: 5,  stamp: HOUSE_RED,  w: 3, h: 3 },
    docs:      { name: 'Quill',     accent: ACCENTS.docs,       bx: 6,  by: 23, stamp: HOUSE_RED,  w: 3, h: 3 },
    marketing: { name: 'Spark',     accent: ACCENTS.marketing,  bx: 35, by: 23, stamp: HOUSE_GREY, w: 3, h: 3 },
    api:       { name: 'Wire',      accent: ACCENTS.api,        bx: 20, by: 24, stamp: HOUSE_GREY, w: 3, h: 3 }
  };
  var SPECIALISTS = ['research', 'inbox', 'docs', 'marketing', 'api'];

  var MAPW = 44, MAPH = 32;

  /* ---------- state ---------- */
  var canvas, ctx, dpr = 1;
  var cssW = 0, cssH = 0;
  var running = false;
  var ground = null, decor = [];
  var chars = {};             // id -> character
  var effects = [];           // flying orbs / bubbles
  var cam = { x: 0, y: 0, z: 3, tx: 0, ty: 0, tz: 3, follow: null };
  var keys = {};
  var lastT = 0;

  function rnd(a, b) { return a + Math.random() * (b - a); }
  function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function typingInField() {
    var el = document.activeElement;
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }
  function doorWorld(a) { // world px of the tile just below the building's door (bottom-center)
    return { x: (a.bx + a.w / 2) * TILE, y: (a.by + a.h + 0.6) * TILE };
  }

  /* ---------- draw a tile from the atlas ---------- */
  function drawTile(idx, dx, dy) {
    if (idx == null) return;
    var sx = (idx % COLS) * TILE, sy = ((idx / COLS) | 0) * TILE;
    ctx.drawImage(atlas, sx, sy, TILE, TILE, dx, dy, TILE, TILE);
  }
  function drawStamp(stamp, bx, by) {
    for (var y = 0; y < stamp.length; y++)
      for (var x = 0; x < stamp[y].length; x++)
        drawTile(stamp[y][x], (bx + x) * TILE, (by + y) * TILE);
  }

  /* ---------- procedural pixel character sprites ---------- */
  function makeCharSprite(accent, frame) {
    var c = document.createElement('canvas'); c.width = 16; c.height = 16;
    var g = c.getContext('2d');
    function R(x0, y0, w, h, col) { g.fillStyle = col; g.fillRect(x0, y0, w, h); }
    var skin = '#f0c596', hair = '#5a3c23', legs = '#3a2b1b';
    R(6, 3, 4, 4, hair);            // hair
    R(6, 5, 4, 3, skin);           // face
    R(7, 6, 1, 1, '#222'); R(8, 6, 1, 1, '#222'); // eyes
    R(5, 8, 6, 4, accent);         // shirt
    R(4, 8, 1, 3, skin); R(11, 8, 1, 3, skin); // arms
    if (frame === 1) { R(5, 12, 2, 3, legs); R(9, 11, 2, 3, legs); }
    else if (frame === 2) { R(5, 11, 2, 3, legs); R(9, 12, 2, 3, legs); }
    else { R(5, 12, 2, 2, legs); R(9, 12, 2, 2, legs); }
    return c;
  }

  function makeChar(id) {
    var a = AGENTS[id];
    var home = doorWorld(a);
    chars[id] = {
      id: id, accent: a.accent, isMgr: id === 'manager',
      x: home.x, y: home.y + (id === 'manager' ? 8 : 4),
      hx: home.x, hy: home.y + (id === 'manager' ? 8 : 4),
      tx: home.x, ty: home.y, state: 'idle', face: 1, moving: false,
      gait: 0, bob: 0, wait: rnd(0.5, 3), speed: 34,
      spr: [makeCharSprite(a.accent, 0), makeCharSprite(a.accent, 1), makeCharSprite(a.accent, 2)],
      bubble: null, hop: 0
    };
  }

  /* ---------- build the town once ---------- */
  function buildTown() {
    ground = new Array(MAPH);
    for (var y = 0; y < MAPH; y++) { ground[y] = new Array(MAPW); for (var x = 0; x < MAPW; x++) ground[y][x] = pick(GRASS); }
    decor = [];
    // scatter trees around the edges, avoiding building footprints
    for (var i = 0; i < 60; i++) {
      var tx = (Math.random() * MAPW) | 0, ty = (Math.random() * MAPH) | 0;
      if (nearAnyBuilding(tx, ty, 2)) continue;
      decor.push({ t: pick(TREES), x: tx, y: ty });
    }
    decor.sort(function (a, b) { return a.y - b.y; });
    // characters
    Object.keys(AGENTS).forEach(makeChar);
  }
  function nearAnyBuilding(tx, ty, pad) {
    for (var id in AGENTS) { var a = AGENTS[id];
      if (tx >= a.bx - pad && tx < a.bx + a.w + pad && ty >= a.by - pad && ty < a.by + a.h + pad) return true; }
    return false;
  }

  /* ============================================================
     UPDATE
     ============================================================ */
  function update(dt) {
    // camera keyboard pan
    if (!typingInField()) {
      var pan = 300 * dt / cam.z;
      if (keys['w'] || keys['arrowup']) cam.ty -= pan;
      if (keys['s'] || keys['arrowdown']) cam.ty += pan;
      if (keys['a'] || keys['arrowleft']) cam.tx -= pan;
      if (keys['d'] || keys['arrowright']) cam.tx += pan;
    }
    // camera follow (focus)
    if (cam.follow && chars[cam.follow]) { cam.tx = chars[cam.follow].x; cam.ty = chars[cam.follow].y; }
    // ease camera
    cam.x += (cam.tx - cam.x) * Math.min(1, dt * 6);
    cam.y += (cam.ty - cam.y) * Math.min(1, dt * 6);
    cam.z += (cam.tz - cam.z) * Math.min(1, dt * 8);
    clampCam();

    for (var id in chars) updateChar(chars[id], dt);

    for (var i = effects.length - 1; i >= 0; i--) {
      var e = effects[i]; e.t += dt;
      if (e.t >= e.dur) { if (e.onEnd) e.onEnd(); effects.splice(i, 1); }
    }
  }

  function updateChar(c, dt) {
    // choose a wander target when idle-ish
    if (!c.moving && c.state !== 'delivering') {
      c.wait -= dt;
      if (c.wait <= 0) {
        c.wait = rnd(1.2, 4);
        var rad = c.isMgr ? 10 : (c.state === 'working' || c.state === 'searching' ? 20 : 26);
        // wander within a small radius of home (stay by own office)
        c.tx = clamp(c.hx + rnd(-rad, rad), TILE, (MAPW - 1) * TILE);
        c.ty = clamp(c.hy + rnd(-rad, rad), TILE, (MAPH - 1) * TILE);
        c.moving = true;
      }
    }
    // move toward target
    var dx = c.tx - c.x, dy = c.ty - c.y, d = Math.hypot(dx, dy);
    if (d > 1.5) {
      var sp = c.speed * dt;
      c.x += dx / d * Math.min(sp, d); c.y += dy / d * Math.min(sp, d);
      c.face = dx < -0.5 ? -1 : (dx > 0.5 ? 1 : c.face);
      c.moving = true; c.gait += dt * 9; c.bob = Math.abs(Math.sin(c.gait)) * 2;
    } else {
      c.moving = false; c.bob = 0;
      if (c.state === 'delivering' && c.deliverPhase === 'out') {
        // arrived at Agent Sea → hand off, then head home
        c.deliverPhase = 'back'; c.tx = c.hx; c.ty = c.hy; c.moving = true;
        spawnOrb(c.x, c.y - 10, chars.manager.x, chars.manager.y - 12, c.accent, null);
      } else if (c.state === 'delivering' && c.deliverPhase === 'back') {
        c.state = 'idle'; c.deliverPhase = null;
      }
    }
    if (c.hop > 0) c.hop = Math.max(0, c.hop - dt * 2);
    if (c.bubbleT > 0) c.bubbleT -= dt; else c.bubble = null;
  }

  function startDeliver(c) {
    if (!chars.manager) return;
    c.state = 'delivering'; c.deliverPhase = 'out';
    var d = doorWorld(AGENTS.manager);
    c.tx = d.x + rnd(-14, 14); c.ty = d.y + 12; c.moving = true;
  }

  function spawnOrb(x0, y0, x1, y1, color, onEnd) {
    effects.push({ kind: 'orb', x0: x0, y0: y0, x1: x1, y1: y1, color: color, t: 0, dur: 0.7, onEnd: onEnd });
  }
  function bubble(c, txt) { c.bubble = txt; c.bubbleT = 1.6; }

  /* ============================================================
     RENDER
     ============================================================ */
  function clampCam() {
    var halfW = cssW / 2 / cam.z, halfH = cssH / 2 / cam.z;
    cam.tz = clamp(cam.tz, 1.6, 6); cam.z = clamp(cam.z, 1.6, 6);
    cam.tx = clamp(cam.tx, halfW, MAPW * TILE - halfW);
    cam.ty = clamp(cam.ty, halfH, MAPH * TILE - halfH);
    cam.x = clamp(cam.x, halfW, MAPW * TILE - halfW);
    cam.y = clamp(cam.y, halfH, MAPH * TILE - halfH);
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    // sky/grass void
    ctx.fillStyle = '#5a9e4a'; ctx.fillRect(0, 0, cssW, cssH);
    if (!atlasReady) { drawLoading(); return; }

    ctx.save();
    ctx.translate(cssW / 2, cssH / 2);
    ctx.scale(cam.z, cam.z);
    ctx.translate(-cam.x, -cam.y);

    // visible tile range (culling)
    var halfW = cssW / 2 / cam.z, halfH = cssH / 2 / cam.z;
    var x0 = Math.max(0, ((cam.x - halfW) / TILE | 0) - 1);
    var x1 = Math.min(MAPW - 1, ((cam.x + halfW) / TILE | 0) + 1);
    var y0 = Math.max(0, ((cam.y - halfH) / TILE | 0) - 1);
    var y1 = Math.min(MAPH - 1, ((cam.y + halfH) / TILE | 0) + 1);
    for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) drawTile(ground[y][x], x * TILE, y * TILE);

    // depth-sorted drawables: buildings, trees, characters — by baseline y
    var draw = [];
    for (var id in AGENTS) { var a = AGENTS[id]; draw.push({ y: (a.by + a.h) * TILE, fn: (function (a) { return function () { drawStamp(a.stamp, a.bx, a.by); }; })(a) }); }
    for (var i = 0; i < decor.length; i++) { var dd = decor[i]; draw.push({ y: dd.y * TILE + 12, fn: (function (dd) { return function () { drawTile(dd.t, dd.x * TILE, dd.y * TILE); }; })(dd) }); }
    for (var cid in chars) { var c = chars[cid]; draw.push({ y: c.y, fn: (function (c) { return function () { drawChar(c); }; })(c) }); }
    draw.sort(function (p, q) { return p.y - q.y; });
    for (var k = 0; k < draw.length; k++) draw[k].fn();

    // effects (orbs)
    for (var e = 0; e < effects.length; e++) drawEffect(effects[e]);
    ctx.restore();
  }

  function drawChar(c) {
    var frame = c.moving ? (((c.gait * 1.1) | 0) % 2 === 0 ? 1 : 2) : 0;
    var spr = c.spr[frame] || c.spr[0];
    var scale = c.isMgr ? 1.25 : 1.0;
    var w = 16 * scale, h = 16 * scale;
    var px = c.x - w / 2, py = c.y - h - c.bob - c.hop * 6;
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath(); ctx.ellipse(c.x, c.y, 6 * scale, 2.4 * scale, 0, 0, 6.283); ctx.fill();
    ctx.save();
    if (c.face === -1) { ctx.translate(c.x, 0); ctx.scale(-1, 1); ctx.translate(-c.x, 0); }
    ctx.drawImage(spr, px, py, w, h);
    ctx.restore();
    // accent ring for the manager, and state bubbles
    if (c.bubble) drawBubble(c, c.bubble);
    if (c.state === 'assigned') drawBubble(c, '!');
    if (c.state === 'working') drawBubble(c, '⚙');
    if (c.state === 'searching') drawBubble(c, '⌕');
  }

  function drawBubble(c, txt) {
    var bx = c.x, by = c.y - (c.isMgr ? 22 : 20) - c.bob;
    ctx.fillStyle = 'rgba(15,18,26,0.9)';
    ctx.strokeStyle = c.accent; ctx.lineWidth = 0.6;
    roundRect(bx - 5, by - 6, 10, 9, 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#eaf0ff'; ctx.font = '7px -apple-system, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(txt, bx, by - 1);
  }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  function drawEffect(e) {
    var t = e.t / e.dur, tt = 1 - (1 - t) * (1 - t);
    var x = e.x0 + (e.x1 - e.x0) * tt, y = e.y0 + (e.y1 - e.y0) * tt - Math.sin(t * Math.PI) * 14;
    ctx.fillStyle = e.color; ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 6.283); ctx.fill();
    ctx.globalAlpha = 0.3; ctx.beginPath(); ctx.arc(x, y, 5, 0, 6.283); ctx.fill();
    ctx.globalAlpha = 1;
  }

  function drawLoading() {
    ctx.fillStyle = '#eaf0ff'; ctx.font = '14px -apple-system, sans-serif';
    ctx.textAlign = 'center'; ctx.fillText('Loading Nexus Town…', cssW / 2, cssH / 2);
  }

  /* ============================================================
     LOOP / RESIZE / INPUT
     ============================================================ */
  function frame(now) {
    if (!running) return;
    var dt = Math.min(0.05, (now - lastT) / 1000 || 0); lastT = now;
    try { update(dt); render(); } catch (e) { /* never die */ }
    requestAnimationFrame(frame);
  }

  function doResize() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssW = canvas.clientWidth || window.innerWidth;
    cssH = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.max(1, (cssW * dpr) | 0);
    canvas.height = Math.max(1, (cssH * dpr) | 0);
    clampCam();
  }

  function bindInput() {
    var dragging = false, lx = 0, ly = 0;
    canvas.addEventListener('mousedown', function (e) { dragging = true; lx = e.clientX; ly = e.clientY; cam.follow = null; canvas.style.cursor = 'grabbing'; });
    window.addEventListener('mouseup', function () { dragging = false; if (canvas) canvas.style.cursor = 'grab'; });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      cam.tx -= (e.clientX - lx) / cam.z; cam.ty -= (e.clientY - ly) / cam.z;
      cam.x = cam.tx; cam.y = cam.ty; lx = e.clientX; ly = e.clientY; clampCam();
    });
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      cam.tz = clamp(cam.tz * (e.deltaY < 0 ? 1.12 : 0.9), 1.6, 6);
    }, { passive: false });
    window.addEventListener('keydown', function (e) { keys[(e.key || '').toLowerCase()] = true; });
    window.addEventListener('keyup', function (e) { keys[(e.key || '').toLowerCase()] = false; });
    canvas.style.cursor = 'grab';
  }

  /* ============================================================
     PUBLIC API (window.World) — never throws
     ============================================================ */
  var API = {
    init: function (el) {
      try {
        canvas = el || document.getElementById('stage');
        if (!canvas) return;
        ctx = canvas.getContext('2d');
        doResize();
        buildTown();
        // start camera on Agent Sea's HQ
        var d = doorWorld(AGENTS.manager); cam.x = cam.tx = d.x; cam.y = cam.ty = d.y - 10; cam.z = cam.tz = 3;
        clampCam();
        bindInput();
        window.addEventListener('resize', doResize);
        running = true; lastT = performance.now(); requestAnimationFrame(frame);
      } catch (e) { try { console.warn('[World] init failed', e); } catch (_) {} }
    },
    setManager: function (state) {
      var c = chars.manager; if (!c) return;
      c.state = state === 'thinking' || state === 'speaking' ? state : 'idle';
      if (state === 'thinking') bubble(c, '…');
      if (state === 'speaking') { c.hop = 1; }
    },
    setAgent: function (id, state) {
      var c = chars[id]; if (!c || id === 'manager') return;
      if (state === 'delivering') { startDeliver(c); return; }
      c.state = state || 'idle';
      if (state === 'assigned') { c.hop = 1; }
      if (state === 'done') { c.hop = 1; bubble(c, '✓'); c.state = 'idle'; }
    },
    dispatch: function (id) {
      var a = AGENTS[id], m = chars.manager; if (!a || !m || id === 'manager') return;
      var d = doorWorld(a);
      spawnOrb(m.x, m.y - 12, d.x, d.y - 8, a.accent, null);
    },
    deliver: function (id) {
      var c = chars[id]; if (!c || id === 'manager') return;
      // handled by the walking hand-off; if not walking, fly an orb
      if (c.state !== 'delivering' && chars.manager) spawnOrb(c.x, c.y - 10, chars.manager.x, chars.manager.y - 12, c.accent, null);
    },
    speak: function (id, on) {
      var c = chars[id === 'manager' ? 'manager' : id]; if (!c) return;
      if (on) { c.hop = 1; bubble(c, '♪'); }
    },
    focus: function (id) {
      if (id && chars[id]) { cam.follow = id; cam.tz = 4.2; }
      else { cam.follow = null; cam.tz = 3; var d = doorWorld(AGENTS.manager); cam.tx = d.x; cam.ty = d.y - 10; }
    },
    resize: function () { doResize(); }
  };

  window.World = API;
})();
