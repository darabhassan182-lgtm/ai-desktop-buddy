/* NEXUS — make-ui.js · Connect-Make.com modal. Uses window.nexus.make.*
   (token stays in the main process / local config). Guarded, never throws. */
(function () {
  'use strict';
  var nx = window.nexus || {};
  var M = nx.make || {};
  function $(id) { return document.getElementById(id); }
  function on(el, ev, fn) { if (el && el.addEventListener) el.addEventListener(ev, fn); }
  function state(msg, ok) { var s = $('makeState'); if (!s) return; s.textContent = msg || ''; s.className = 'voice-state' + (ok === true ? ' ok' : ok === false ? ' err' : ''); }

  function open() { var m = $('makeModal'); if (!m) return; m.classList.add('show'); m.setAttribute('aria-hidden', 'false'); load(); }
  function close() { var m = $('makeModal'); if (m) { m.classList.remove('show'); m.setAttribute('aria-hidden', 'true'); } }

  function load() {
    if (typeof M.get !== 'function') { state('Reinstall the app to enable Make.', false); return; }
    Promise.resolve(M.get()).then(function (c) {
      c = c || {};
      var z = $('makeZone'); if (z && c.zone) z.value = c.zone;
      var k = $('makeToken'); if (k) { k.value = ''; k.placeholder = c.connected ? 'A token is saved — paste to replace' : 'your Make API token'; }
      state(c.connected ? 'Token saved ✓ — press “Check connection” to verify.' : 'Not connected yet.', null);
    }).catch(function () {});
  }
  function save() {
    var k = ($('makeToken') && $('makeToken').value || '').trim();
    var z = ($('makeZone') && $('makeZone').value) || 'eu1';
    if (!k) { state('Paste your Make API token.', false); return Promise.resolve(false); }
    state('Saving…', null);
    return Promise.resolve(M.set(k, z)).then(function (r) {
      if (r && r.connected) { state('Saved ✓ — press “Check connection”.', true); var kk = $('makeToken'); if (kk) { kk.value = ''; kk.placeholder = 'A token is saved — paste to replace'; } return true; }
      state('Couldn’t save.', false); return false;
    }).catch(function () { state('Couldn’t save.', false); return false; });
  }
  function boot() {
    on($('makeBtn'), 'click', open);
    on($('makeDone'), 'click', function () { save().then(function (ok) { if (ok) close(); }); });
    on($('makeToken'), 'keydown', function (e) { if (e && (e.key === 'Enter' || e.keyCode === 13)) { e.preventDefault(); save(); } });
    on($('makeZone'), 'change', function () { save(); });
    on($('makeTest'), 'click', function () {
      var btn = this; btn.disabled = true; var old = btn.textContent; btn.textContent = 'Checking…';
      save().then(function () { return M.test ? M.test() : null; }).then(function (r) {
        if (r && r.ok) state('Connected ✓ — ' + (r.total != null ? r.total + ' scenario(s) found.' : 'ready.'), true);
        else if (r) state('Not working: ' + (r.error || 'unknown') + '. Check token + region.', false);
      }).catch(function () { state('Check failed.', false); }).then(function () { setTimeout(function () { btn.disabled = false; btn.textContent = old; }, 900); });
    });
    on($('makeModal'), 'click', function (e) { if (e && e.target === this) close(); });
    document.addEventListener('keydown', function (e) { if (e && e.key === 'Escape') close(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
