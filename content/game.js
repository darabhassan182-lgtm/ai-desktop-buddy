/* ============================================================
   NEXUS — game.js · WORLD 4.1 "Nexus Town" (2D pixel-art, top-down)
   A cute Kenney "Tiny Town" (CC0) pixel world: five specialist
   offices around Agent Sea's grand PALACE, joined by dirt ROADS,
   with a pond + animated WATERFALL, extra houses, trees & fences.
   Little pixel employees walk near their own office and only cross
   the roads to hand a result to Agent Sea. Pan/zoom camera.

   Pure Canvas 2D — no WebGL, no libraries. Atlas is a data-URI in
   window.NEXUS_TILES_B64 (12x11 grid of 16px tiles). Characters and
   water are drawn procedurally. window.World set at end; never throws.
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

  /* ---------- tile ids (validated atlas map) ---------- */
  var GRASS = [0, 0, 0, 0, 1, 2];
  var TREES = [3, 4, 5, 6, 7];
  var FENCE_H = 45, FENCE_L = 47, FENCE_R = 46;
  var ROAD = 25;                                   // dirt road
  var STALL = 104;
  var HOUSE_RED  = [[null, 67, null], [52, 53, 54], [84, 85, 88]];
  var HOUSE_GREY = [[null, 63, null], [48, 49, 50], [72, 74, 73]];
  var PALACE = [[96, 97, 98, 97, 98, 97, 98], [108, 109, 110, 109, 110, 109, 110], [120, 121, 113, 123, 114, 121, 122]];

  /* ---------- agents ---------- */
  var ACCENTS = {
    manager: '#7c9cff', research: '#4f6bff', docs: '#34d399',
    marketing: '#f59e0b', inbox: '#ec4899', api: '#22d3ee'
  };
  var AGENTS = {
    manager:   { name: 'Agent Sea', accent: ACCENTS.manager,   bx: 16, by: 12, stamp: PALACE,     w: 7, h: 3 },
    research:  { name: 'Scout',     accent: ACCENTS.research,   bx: 5,  by: 5,  stamp: HOUSE_GREY, w: 3, h: 3 },
    inbox:     { name: 'Echo',      accent: ACCENTS.inbox,      bx: 32, by: 5,  stamp: HOUSE_RED,  w: 3, h: 3 },
    docs:      { name: 'Quill',     accent: ACCENTS.docs,       bx: 5,  by: 23, stamp: HOUSE_RED,  w: 3, h: 3 },
    marketing: { name: 'Spark',     accent: ACCENTS.marketing,  bx: 32, by: 23, stamp: HOUSE_GREY, w: 3, h: 3 },
    api:       { name: 'Wire',      accent: ACCENTS.api,        bx: 18, by: 24, stamp: HOUSE_RED,  w: 3, h: 3 }
  };
  var SPECIALISTS = ['research', 'inbox', 'docs', 'marketing', 'api'];
  var MAPW = 40, MAPH = 30;

  /* ---------- state ---------- */
  var canvas, ctx, dpr = 1, cssW = 0, cssH = 0, running = false, time = 0;
  var ground = null, decor = [], extraHouses = [], roads = [], roadSet = {}, water = null;
  var chars = {}, effects = [];
  var cam = { x: 0, y: 0, z: 3, tx: 0, ty: 0, tz: 3, follow: null };
  var keys = {}, lastT = 0;

  function rnd(a, b) { return a + Math.random() * (b - a); }
  function pick(a) { return a[(Math.random() * a.length) | 0]; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function typingInField() { var el = document.activeElement; return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable); }
  function doorWorld(a) { return { x: (a.bx + a.w / 2) * TILE, y: (a.by + a.h + 0.6) * TILE }; }
  function gateTile(a) { return { x: (a.bx + (a.w >> 1)) | 0, y: (a.by + a.h) | 0 }; }

  /* ---------- atlas draw ---------- */
  function drawTile(idx, dx, dy) {
    if (idx == null) return;
    ctx.drawImage(atlas, (idx % COLS) * TILE, ((idx / COLS) | 0) * TILE, TILE, TILE, dx, dy, TILE, TILE);
  }
  function drawStamp(stamp, bx, by) {
    for (var y = 0; y < stamp.length; y++) for (var x = 0; x < stamp[y].length; x++) drawTile(stamp[y][x], (bx + x) * TILE, (by + y) * TILE);
  }

  /* ---------- procedural pixel employees ---------- */
  function makeCharSprite(accent, frame) {
    var c = document.createElement('canvas'); c.width = 16; c.height = 16;
    var g = c.getContext('2d');
    function R(x, y, w, h, col) { g.fillStyle = col; g.fillRect(x, y, w, h); }
    var skin = '#f0c596', hair = '#5a3c23', legs = '#3a2b1b';
    R(6, 3, 4, 4, hair); R(6, 5, 4, 3, skin);
    R(7, 6, 1, 1, '#222'); R(8, 6, 1, 1, '#222');
    R(5, 8, 6, 4, accent); R(4, 8, 1, 3, skin); R(11, 8, 1, 3, skin);
    if (frame === 1) { R(5, 12, 2, 3, legs); R(9, 11, 2, 3, legs); }
    else if (frame === 2) { R(5, 11, 2, 3, legs); R(9, 12, 2, 3, legs); }
    else { R(5, 12, 2, 2, legs); R(9, 12, 2, 2, legs); }
    return c;
  }
  function makeChar(id) {
    var a = AGENTS[id], home = doorWorld(a);
    chars[id] = {
      id: id, accent: a.accent, isMgr: id === 'manager',
      x: home.x, y: home.y + (id === 'manager' ? 8 : 4), hx: home.x, hy: home.y + (id === 'manager' ? 8 : 4),
      tx: home.x, ty: home.y, state: 'idle', face: 1, moving: false,
      gait: 0, bob: 0, wait: rnd(0.5, 3), speed: 34, hop: 0, bubble: null, bubbleT: 0, deliverPhase: null,
      spr: [makeCharSprite(a.accent, 0), makeCharSprite(a.accent, 1), makeCharSprite(a.accent, 2)]
    };
  }

  /* ---------- build the town ---------- */
  function nearBuilding(tx, ty, pad) {
    var list = []; for (var id in AGENTS) list.push(AGENTS[id]);
    for (var i = 0; i < extraHouses.length; i++) list.push(extraHouses[i]);
    for (var j = 0; j < list.length; j++) { var a = list[j]; if (tx >= a.bx - pad && tx < a.bx + a.w + pad && ty >= a.by - pad && ty < a.by + a.h + pad) return true; }
    return false;
  }
  function inWater(tx, ty) { var w = water; return w && tx >= w.px - 1 && tx < w.px + w.pw + 1 && ty >= w.fy0 - 1 && ty < w.py + w.ph + 1; }
  function addRoad(from, to) {
    var xs = Math.min(from.x, to.x), xe = Math.max(from.x, to.x), yy;
    for (var xx = xs; xx <= xe; xx++) { push(xx, from.y); push(xx, from.y + 1); }
    var ys = Math.min(from.y, to.y), ye = Math.max(from.y, to.y);
    for (yy = ys; yy <= ye; yy++) { push(to.x, yy); push(to.x + 1, yy); }
    function push(x, y) { var k = x + ',' + y; if (x >= 0 && y >= 0 && x < MAPW && y < MAPH && !roadSet[k]) { roadSet[k] = 1; roads.push({ x: x, y: y }); } }
  }
  function buildTown() {
    ground = new Array(MAPH);
    for (var y = 0; y < MAPH; y++) { ground[y] = new Array(MAPW); for (var x = 0; x < MAPW; x++) ground[y][x] = pick(GRASS); }
    // water: pond (left-centre) + waterfall feeding it from above
    water = { px: 2, py: 14, pw: 5, ph: 5, fx: 3, fy0: 10 };
    // extra decorative houses
    extraHouses = [
      { bx: 11, by: 6, stamp: HOUSE_RED, w: 3, h: 3 }, { bx: 26, by: 6, stamp: HOUSE_GREY, w: 3, h: 3 },
      { bx: 28, by: 18, stamp: HOUSE_RED, w: 3, h: 3 }, { bx: 9, by: 26, stamp: HOUSE_GREY, w: 3, h: 3 }
    ];
    // roads: every specialist + extra house → the palace gate
    roads = []; roadSet = {};
    var pg = gateTile(AGENTS.manager);
    SPECIALISTS.forEach(function (id) { addRoad(gateTile(AGENTS[id]), pg); });
    // decor: trees, fences, stalls (avoid buildings, roads, water)
    decor = [];
    for (var i = 0; i < 70; i++) {
      var tx = (Math.random() * MAPW) | 0, ty = (Math.random() * MAPH) | 0;
      if (nearBuilding(tx, ty, 1) || roadSet[tx + ',' + ty] || inWater(tx, ty)) continue;
      decor.push({ t: pick(TREES), x: tx, y: ty });
    }
    decor.sort(function (a, b) { return a.y - b.y; });
    Object.keys(AGENTS).forEach(makeChar);
  }

  /* ---------- update ---------- */
  function update(dt) {
    time += dt;
    if (!typingInField()) {
      var pan = 320 * dt / cam.z;
      if (keys['w'] || keys['arrowup']) cam.ty -= pan;
      if (keys['s'] || keys['arrowdown']) cam.ty += pan;
      if (keys['a'] || keys['arrowleft']) cam.tx -= pan;
      if (keys['d'] || keys['arrowright']) cam.tx += pan;
    }
    if (cam.follow && chars[cam.follow]) { cam.tx = chars[cam.follow].x; cam.ty = chars[cam.follow].y; }
    cam.x += (cam.tx - cam.x) * Math.min(1, dt * 6);
    cam.y += (cam.ty - cam.y) * Math.min(1, dt * 6);
    cam.z += (cam.tz - cam.z) * Math.min(1, dt * 8);
    clampCam();
    for (var id in chars) updateChar(chars[id], dt);
    for (var i = effects.length - 1; i >= 0; i--) { var e = effects[i]; e.t += dt; if (e.t >= e.dur) { if (e.onEnd) e.onEnd(); effects.splice(i, 1); } }
  }
  function updateChar(c, dt) {
    if (!c.moving && c.state !== 'delivering') {
      c.wait -= dt;
      if (c.wait <= 0) {
        c.wait = rnd(1.2, 4);
        var rad = c.isMgr ? 6 : 10;
        c.tx = clamp(c.hx + rnd(-rad, rad), TILE, (MAPW - 1) * TILE);
        c.ty = clamp(c.hy + rnd(-rad, rad), TILE, (MAPH - 1) * TILE);
        c.moving = true;
      }
    }
    var dx = c.tx - c.x, dy = c.ty - c.y, d = Math.hypot(dx, dy);
    if (d > 1.5) {
      var sp = c.speed * dt;
      c.x += dx / d * Math.min(sp, d); c.y += dy / d * Math.min(sp, d);
      c.face = dx < -0.5 ? -1 : (dx > 0.5 ? 1 : c.face);
      c.moving = true; c.gait += dt * 9; c.bob = Math.abs(Math.sin(c.gait)) * 2;
    } else {
      c.moving = false; c.bob = 0;
      if (c.state === 'delivering' && c.deliverPhase === 'out') {
        c.deliverPhase = 'back'; c.tx = c.hx; c.ty = c.hy; c.moving = true;
        if (chars.manager) spawnOrb(c.x, c.y - 10, chars.manager.x, chars.manager.y - 12, c.accent, null);
      } else if (c.state === 'delivering' && c.deliverPhase === 'back') { c.state = 'idle'; c.deliverPhase = null; }
    }
    if (c.hop > 0) c.hop = Math.max(0, c.hop - dt * 2);
    if (c.bubbleT > 0) c.bubbleT -= dt; else c.bubble = null;
  }
  function startDeliver(c) {
    if (!chars.manager) return;
    c.state = 'delivering'; c.deliverPhase = 'out';
    var d = doorWorld(AGENTS.manager); c.tx = d.x + rnd(-16, 16); c.ty = d.y + 14; c.moving = true;
  }
  function spawnOrb(x0, y0, x1, y1, color, onEnd) { effects.push({ x0: x0, y0: y0, x1: x1, y1: y1, color: color, t: 0, dur: 0.75, onEnd: onEnd }); }
  function bubble(c, txt) { c.bubble = txt; c.bubbleT = 1.6; }

  /* ---------- render ---------- */
  function clampCam() {
    var halfW = cssW / 2 / cam.z, halfH = cssH / 2 / cam.z;
    cam.tz = clamp(cam.tz, 2.6, 8); cam.z = clamp(cam.z, 2.6, 8);
    cam.tx = clamp(cam.tx, halfW, MAPW * TILE - halfW); cam.ty = clamp(cam.ty, halfH, MAPH * TILE - halfH);
    cam.x = clamp(cam.x, halfW, MAPW * TILE - halfW); cam.y = clamp(cam.y, halfH, MAPH * TILE - halfH);
  }
  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#5a9e4a'; ctx.fillRect(0, 0, cssW, cssH);
    if (!atlasReady) { drawLoading(); return; }
    ctx.save();
    ctx.translate(cssW / 2, cssH / 2); ctx.scale(cam.z, cam.z); ctx.translate(-cam.x, -cam.y);

    var halfW = cssW / 2 / cam.z, halfH = cssH / 2 / cam.z;
    var x0 = Math.max(0, ((cam.x - halfW) / TILE | 0) - 1), x1 = Math.min(MAPW - 1, ((cam.x + halfW) / TILE | 0) + 1);
    var y0 = Math.max(0, ((cam.y - halfH) / TILE | 0) - 1), y1 = Math.min(MAPH - 1, ((cam.y + halfH) / TILE | 0) + 1);
    for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) drawTile(ground[y][x], x * TILE, y * TILE);
    for (var r = 0; r < roads.length; r++) { var rc = roads[r]; if (rc.x >= x0 && rc.x <= x1 && rc.y >= y0 && rc.y <= y1) drawTile(ROAD, rc.x * TILE, rc.y * TILE); }
    drawWater();

    var draw = [];
    var b, id2;
    for (id2 in AGENTS) { b = AGENTS[id2]; draw.push({ y: (b.by + b.h) * TILE, fn: mkStamp(b) }); }
    for (var h = 0; h < extraHouses.length; h++) { b = extraHouses[h]; draw.push({ y: (b.by + b.h) * TILE, fn: mkStamp(b) }); }
    for (var i = 0; i < decor.length; i++) draw.push({ y: decor[i].y * TILE + 12, fn: mkDecor(decor[i]) });
    for (var cid in chars) { var c = chars[cid]; draw.push({ y: c.y, fn: mkChar(c) }); }
    draw.sort(function (p, q) { return p.y - q.y; });
    for (var k = 0; k < draw.length; k++) draw[k].fn();

    for (var e = 0; e < effects.length; e++) drawEffect(effects[e]);
    ctx.restore();
  }
  function mkStamp(b) { return function () { drawStamp(b.stamp, b.bx, b.by); }; }
  function mkDecor(d) { return function () { drawTile(d.t, d.x * TILE, d.y * TILE); }; }
  function mkChar(c) { return function () { drawChar(c); }; }

  function drawWater() {
    var w = water; if (!w) return;
    var t = time;
    for (var y = 0; y < w.ph; y++) for (var x = 0; x < w.pw; x++) {
      var wx = (w.px + x) * TILE, wy = (w.py + y) * TILE;
      ctx.fillStyle = '#2f6f9e'; ctx.fillRect(wx, wy, TILE, TILE);
      var s = Math.sin(t * 1.4 + x * 0.8 + y * 0.6);
      ctx.fillStyle = s > 0.35 ? '#3f86b8' : (s < -0.35 ? '#26597f' : '#2f6f9e');
      ctx.fillRect(wx, wy + (s > 0 ? 3 : 9), TILE, 3);
      if (((x + y + ((t * 2) | 0)) % 4) === 0) { ctx.fillStyle = 'rgba(210,235,248,0.6)'; ctx.fillRect(wx + ((x * 5 + ((t * 10) | 0)) % TILE), wy + 5, 2, 1); }
    }
    // waterfall (from fy0 down into the pond top)
    var fx = w.fx * TILE, fy = w.fy0 * TILE, fw = 2 * TILE, fh = (w.py - w.fy0) * TILE;
    ctx.fillStyle = '#6b7681'; ctx.fillRect(fx - 3, fy - 5, fw + 6, 6);   // rock lip
    ctx.fillStyle = '#5f9ec6'; ctx.fillRect(fx, fy, fw, fh);
    ctx.fillStyle = 'rgba(225,244,255,0.8)';
    for (var sx = 2; sx < fw; sx += 7) ctx.fillRect(fx + sx, fy, 2, fh);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (var kk = 0; kk < 10; kk++) { var yy = fy + ((t * 130 + kk * 34) % fh); ctx.fillRect(fx + ((kk * 6) % fw), yy, 2, 3); }
    ctx.fillStyle = 'rgba(230,246,255,0.55)'; ctx.fillRect(fx - 5, w.py * TILE - 3, fw + 10, 6);
  }

  function drawChar(c) {
    var frame = c.moving ? ((((c.gait * 1.1) | 0) % 2) === 0 ? 1 : 2) : 0;
    var spr = c.spr[frame] || c.spr[0];
    var scale = c.isMgr ? 1.25 : 1.0, w = 16 * scale, h = 16 * scale;
    var px = c.x - w / 2, py = c.y - h - c.bob - c.hop * 6;
    ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.beginPath(); ctx.ellipse(c.x, c.y, 6 * scale, 2.4 * scale, 0, 0, 6.283); ctx.fill();
    ctx.save();
    if (c.face === -1) { ctx.translate(c.x, 0); ctx.scale(-1, 1); ctx.translate(-c.x, 0); }
    ctx.drawImage(spr, px, py, w, h);
    ctx.restore();
    if (c.bubble) drawBubble(c, c.bubble);
    else if (c.state === 'assigned') drawBubble(c, '!');
    else if (c.state === 'working') drawBubble(c, '⚙');
    else if (c.state === 'searching') drawBubble(c, '⌕');
  }
  function drawBubble(c, txt) {
    var bx = c.x, by = c.y - (c.isMgr ? 24 : 20) - c.bob;
    ctx.fillStyle = 'rgba(15,18,26,0.9)'; ctx.strokeStyle = c.accent; ctx.lineWidth = 0.6;
    roundRect(bx - 5, by - 6, 10, 9, 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#eaf0ff'; ctx.font = '7px -apple-system, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(txt, bx, by - 1);
  }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function drawEffect(e) {
    var t = e.t / e.dur, tt = 1 - (1 - t) * (1 - t);
    var x = e.x0 + (e.x1 - e.x0) * tt, y = e.y0 + (e.y1 - e.y0) * tt - Math.sin(t * Math.PI) * 14;
    ctx.fillStyle = e.color; ctx.globalAlpha = 0.9; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 6.283); ctx.fill();
    ctx.globalAlpha = 0.3; ctx.beginPath(); ctx.arc(x, y, 5, 0, 6.283); ctx.fill(); ctx.globalAlpha = 1;
  }
  function drawLoading() { ctx.fillStyle = '#eaf0ff'; ctx.font = '14px -apple-system, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Loading Nexus Town…', cssW / 2, cssH / 2); }

  /* ---------- loop / resize / input ---------- */
  function frame(now) {
    if (!running) return;
    var dt = Math.min(0.05, (now - lastT) / 1000 || 0); lastT = now;
    try { update(dt); render(); } catch (e) {}
    requestAnimationFrame(frame);
  }
  function doResize() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssW = canvas.clientWidth || window.innerWidth; cssH = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.max(1, (cssW * dpr) | 0); canvas.height = Math.max(1, (cssH * dpr) | 0);
    clampCam();
  }
  function bindInput() {
    var dragging = false, lx = 0, ly = 0;
    canvas.addEventListener('mousedown', function (e) { dragging = true; lx = e.clientX; ly = e.clientY; cam.follow = null; canvas.style.cursor = 'grabbing'; });
    window.addEventListener('mouseup', function () { dragging = false; if (canvas) canvas.style.cursor = 'grab'; });
    window.addEventListener('mousemove', function (e) { if (!dragging) return; cam.tx -= (e.clientX - lx) / cam.z; cam.ty -= (e.clientY - ly) / cam.z; cam.x = cam.tx; cam.y = cam.ty; lx = e.clientX; ly = e.clientY; clampCam(); });
    canvas.addEventListener('wheel', function (e) { e.preventDefault(); cam.tz = clamp(cam.tz * (e.deltaY < 0 ? 1.12 : 0.9), 2.6, 8); }, { passive: false });
    window.addEventListener('keydown', function (e) { keys[(e.key || '').toLowerCase()] = true; });
    window.addEventListener('keyup', function (e) { keys[(e.key || '').toLowerCase()] = false; });
    canvas.style.cursor = 'grab';
  }

  /* ---------- public API ---------- */
  var API = {
    init: function (el) {
      try {
        canvas = el || document.getElementById('stage'); if (!canvas) return;
        ctx = canvas.getContext('2d'); doResize(); buildTown();
        var d = doorWorld(AGENTS.manager); cam.x = cam.tx = d.x; cam.y = cam.ty = d.y - 8; cam.z = cam.tz = 4.4; clampCam();
        bindInput(); window.addEventListener('resize', doResize);
        running = true; lastT = performance.now(); requestAnimationFrame(frame);
      } catch (e) { try { console.warn('[World] init failed', e); } catch (_) {} }
    },
    setManager: function (state) { var c = chars.manager; if (!c) return; c.state = (state === 'thinking' || state === 'speaking') ? state : 'idle'; if (state === 'thinking') bubble(c, '…'); if (state === 'speaking') c.hop = 1; },
    setAgent: function (id, state) {
      var c = chars[id]; if (!c || id === 'manager') return;
      if (state === 'delivering') { startDeliver(c); return; }
      c.state = state || 'idle';
      if (state === 'assigned') c.hop = 1;
      if (state === 'done') { c.hop = 1; bubble(c, '✓'); c.state = 'idle'; }
    },
    dispatch: function (id) { var a = AGENTS[id], m = chars.manager; if (!a || !m || id === 'manager') return; var d = doorWorld(a); spawnOrb(m.x, m.y - 12, d.x, d.y - 8, a.accent, null); },
    deliver: function (id) { var c = chars[id]; if (!c || id === 'manager') return; if (c.state !== 'delivering' && chars.manager) spawnOrb(c.x, c.y - 10, chars.manager.x, chars.manager.y - 12, c.accent, null); },
    speak: function (id, on) { var c = chars[id === 'manager' ? 'manager' : id]; if (!c || !on) return; c.hop = 1; bubble(c, '♪'); },
    focus: function (id) { if (id && chars[id]) { cam.follow = id; cam.tz = 5.4; } else { cam.follow = null; cam.tz = 4.4; var d = doorWorld(AGENTS.manager); cam.tx = d.x; cam.ty = d.y - 8; } },
    resize: function () { doResize(); }
  };
  window.World = API;
})();
