/* NEXUS — smartlead-ui.js · Connect-Smartlead modal. Uses window.nexus.smartlead.*
   (API key stays in the main process / local config). Guarded, never throws. */
(function () {
  'use strict';
  var nx = window.nexus || {};
  var SL = nx.smartlead || {};
  function $(id) { return document.getElementById(id); }
  function on(el, ev, fn) { if (el && el.addEventListener) el.addEventListener(ev, fn); }
  function state(msg, ok) { var s = $('smartleadState'); if (!s) return; s.textContent = msg || ''; s.className = 'voice-state' + (ok === true ? ' ok' : ok === false ? ' err' : ''); }

  function open() { var m = $('smartleadModal'); if (!m) return; m.classList.add('show'); m.setAttribute('aria-hidden', 'false'); load(); }
  function close() { var m = $('smartleadModal'); if (m) { m.classList.remove('show'); m.setAttribute('aria-hidden', 'true'); } }

  function load() {
    if (typeof SL.get !== 'function') { state('Reinstall the app to enable Smartlead.', false); return; }
    Promise.resolve(SL.get()).then(function (c) {
      var k = $('smartleadKey'); if (k) { k.value = ''; k.placeholder = (c && c.connected) ? 'A key is saved — paste to replace' : 'your Smartlead API key'; }
      state((c && c.connected) ? 'Key saved ✓ — press “Check connection” to verify.' : 'Not connected yet.', null);
    }).catch(function () {});
  }
  function save() {
    var k = ($('smartleadKey') && $('smartleadKey').value || '').trim();
    if (!k) { state('Paste your Smartlead API key.', false); return Promise.resolve(false); }
    state('Saving…', null);
    return Promise.resolve(SL.set(k)).then(function (r) {
      if (r && r.connected) { state('Saved ✓ — press “Check connection” to confirm it works.', true); var kk = $('smartleadKey'); if (kk) { kk.value = ''; kk.placeholder = 'A key is saved — paste to replace'; } return true; }
      state('Couldn’t save.', false); return false;
    }).catch(function () { state('Couldn’t save.', false); return false; });
  }
  function boot() {
    on($('smartleadBtn'), 'click', open);
    on($('smartleadDone'), 'click', function () { save().then(function (ok) { if (ok) close(); }); });
    on($('smartleadKey'), 'keydown', function (e) { if (e && (e.key === 'Enter' || e.keyCode === 13)) { e.preventDefault(); save(); } });
    on($('smartleadTest'), 'click', function () {
      var btn = this; btn.disabled = true; var old = btn.textContent; btn.textContent = 'Checking…';
      save().then(function () { return SL.test ? SL.test() : null; }).then(function (r) {
        if (r && r.ok) state('Connected ✓ — ' + (r.count || 0) + ' campaign(s) found.', true);
        else if (r) state('Not working: ' + (r.error || 'unknown') + '. Check the key.', false);
      }).catch(function () { state('Check failed.', false); }).then(function () { setTimeout(function () { btn.disabled = false; btn.textContent = old; }, 900); });
    });
    on($('smartleadModal'), 'click', function (e) { if (e && e.target === this) close(); });
    document.addEventListener('keydown', function (e) { if (e && e.key === 'Escape') close(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
