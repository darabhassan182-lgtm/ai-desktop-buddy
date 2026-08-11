/* NEXUS — display.js · the holographic display layer (window.Holo)
   Sea calls the `show` tool → main emits `display` → renderer calls
   window.Holo.show(payload). Renders a cinematic holo panel: a real
   map that flies to a place (Leaflet + dark tiles, styled as a hologram),
   or a readable info card. Self-contained, never throws. */
(function () {
  'use strict';

  var root, frame, titleEl, subEl, mapEl, infoEl, footEl, closeBtn;
  var map = null, tiles = null, marker = null, ring = null;
  var geoCache = {};
  var built = false, hideTimer = 0;

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function build() {
    if (built) return;
    root = document.getElementById('holo');
    if (!root) { root = el('div'); root.id = 'holo'; document.body.appendChild(root); }
    root.innerHTML = '';

    frame = el('div', 'holo-frame');
    frame.appendChild(el('span', 'holo-corner tl'));
    frame.appendChild(el('span', 'holo-corner tr'));
    frame.appendChild(el('span', 'holo-corner bl'));
    frame.appendChild(el('span', 'holo-corner br'));
    frame.appendChild(el('span', 'holo-scan'));

    var head = el('div', 'holo-head');
    var titles = el('div', 'holo-titles');
    titleEl = el('div', 'holo-title', 'HOLO');
    subEl = el('div', 'holo-sub', '');
    titles.appendChild(titleEl); titles.appendChild(subEl);
    closeBtn = el('button', 'holo-close', '✕');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', hide);
    head.appendChild(titles); head.appendChild(closeBtn);

    var body = el('div', 'holo-body');
    mapEl = el('div', 'holo-map');
    mapEl.appendChild(el('span', 'holo-grid'));
    mapEl.appendChild(el('span', 'holo-vignette'));
    var reticle = el('div', 'holo-reticle');
    reticle.appendChild(el('span', 'r-ring'));
    reticle.appendChild(el('span', 'r-cross-h'));
    reticle.appendChild(el('span', 'r-cross-v'));
    mapEl.appendChild(reticle);
    infoEl = el('div', 'holo-info');
    body.appendChild(mapEl); body.appendChild(infoEl);

    footEl = el('div', 'holo-foot', '<span class="holo-dot"></span><span class="holo-foot-txt">STANDBY</span>');

    frame.appendChild(head); frame.appendChild(body); frame.appendChild(footEl);
    root.appendChild(frame);
    built = true;
  }

  function foot(txt) {
    if (!footEl) return;
    var t = footEl.querySelector('.holo-foot-txt');
    if (t) t.textContent = txt;
  }

  function reveal() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
    root.classList.add('show');
    document.body.classList.add('holo-open');
    // retrigger the scan-in animation
    frame.classList.remove('anim'); void frame.offsetWidth; frame.classList.add('anim');
  }

  function hide() {
    if (!root) return;
    root.classList.remove('show');
    document.body.classList.remove('holo-open');
  }

  /* ---------- map ---------- */
  function ensureMap() {
    if (map) return map;
    if (!window.L) return null;
    try {
      map = window.L.map(mapEl, {
        zoomControl: false, attributionControl: false,
        fadeAnimation: true, zoomAnimation: true, markerZoomAnimation: true,
        inertia: true, worldCopyJump: true, keyboard: false,
      });
      tiles = window.L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        { maxZoom: 19, subdomains: 'abcd', crossOrigin: true }
      ).addTo(map);
      map.setView([20, 0], 2);
    } catch (e) { map = null; }
    return map;
  }

  function fmtCoord(v, pos, neg) {
    var d = Math.abs(v).toFixed(4);
    return d + '°' + (v >= 0 ? pos : neg);
  }

  function geocode(q) {
    var key = q.toLowerCase();
    if (geoCache[key]) return Promise.resolve(geoCache[key]);
    var url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q);
    return fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (a) {
        if (a && a[0]) {
          var hit = { lat: +a[0].lat, lon: +a[0].lon, name: a[0].display_name || q, type: a[0].addresstype || a[0].type || '' };
          geoCache[key] = hit; return hit;
        }
        return null;
      })
      .catch(function () { return null; });
  }

  function zoomFor(type, explicit) {
    if (explicit) return explicit;
    if (/country/.test(type)) return 5;
    if (/state|region|province/.test(type)) return 7;
    if (/city|town|county|municipality/.test(type)) return 11;
    if (/village|suburb|neighbourhood|quarter/.test(type)) return 13;
    if (/building|amenity|tourism|shop|house|road|square/.test(type)) return 16;
    return 12;
  }

  function placeMarker(lat, lon) {
    if (!window.L || !map) return;
    if (marker) { try { map.removeLayer(marker); } catch (e) {} }
    var icon = window.L.divIcon({
      className: 'holo-pin',
      html: '<span class="holo-pin-core"></span><span class="holo-pin-pulse"></span><span class="holo-pin-pulse d2"></span>',
      iconSize: [26, 26], iconAnchor: [13, 13],
    });
    try { marker = window.L.marker([lat, lon], { icon: icon, interactive: false }).addTo(map); } catch (e) {}
  }

  function showMap(p) {
    mapEl.style.display = '';
    infoEl.style.display = 'none';
    var q = (p.query || p.title || '').trim();
    titleEl.textContent = ('◈ ' + (p.title || q || 'LOCATION')).toUpperCase();
    subEl.textContent = 'LOCATING…';
    foot('ACQUIRING SIGNAL');
    reveal();

    requestAnimationFrame(function () {
      var m = ensureMap();
      if (m) { try { m.invalidateSize(false); } catch (e) {} }
      if (!q) { subEl.textContent = ''; foot('ONLINE'); return; }
      if (!m) { // no Leaflet — degrade to an info card
        subEl.textContent = q;
        renderInfoBody(p.title || q, 'Map engine unavailable on this device.');
        return;
      }
      geocode(q).then(function (hit) {
        if (!hit) { subEl.textContent = 'SIGNAL LOST'; foot('COULD NOT LOCATE “' + q + '”'); return; }
        var z = zoomFor(hit.type, p.zoom);
        subEl.textContent = fmtCoord(hit.lat, 'N', 'S') + '  ' + fmtCoord(hit.lon, 'E', 'W');
        foot('LOCK · ' + (hit.name.split(',')[0] || q).toUpperCase());
        try {
          map.flyTo([hit.lat, hit.lon], z, { duration: 2.4, easeLinearity: 0.22 });
          map.once('moveend', function () { placeMarker(hit.lat, hit.lon); });
        } catch (e) { map.setView([hit.lat, hit.lon], z); placeMarker(hit.lat, hit.lon); }
      });
    });
  }

  /* ---------- info card ---------- */
  function renderInfoBody(title, body) {
    mapEl.style.display = 'none';
    infoEl.style.display = '';
    titleEl.textContent = ('◈ ' + (title || 'INFO')).toUpperCase();
    subEl.textContent = '';
    var lines = String(body || '').split(/\n+/).filter(function (s) { return s.trim(); });
    infoEl.innerHTML = '';
    if (!lines.length) { infoEl.appendChild(el('p', 'holo-line', title || '')); }
    lines.forEach(function (ln, i) {
      var row = el('p', 'holo-line', '');
      row.style.animationDelay = (0.05 + i * 0.06) + 's';
      row.textContent = ln.trim();
      infoEl.appendChild(row);
    });
    foot('ONLINE');
  }

  function showInfo(p) {
    renderInfoBody(p.title || p.query || 'INFO', p.body || p.query || '');
    reveal();
  }

  /* ---------- public API ---------- */
  var API = {
    show: function (payload) {
      try {
        build();
        var p = payload || {};
        if (p.kind === 'info') showInfo(p);
        else showMap(p);
      } catch (e) { /* never throw into the event pipeline */ }
    },
    hide: hide,
  };
  window.Holo = API;

  // Esc closes the panel.
  document.addEventListener('keydown', function (e) {
    if (e && (e.key === 'Escape' || e.keyCode === 27)) hide();
  });
})();
