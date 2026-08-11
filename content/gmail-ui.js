/* NEXUS — gmail-ui.js · Connect-Gmail modal (App Password + SMTP).
   Lets the user connect Gmail so Sea can send email. Uses window.nexus.gmail.*
   (the App Password stays in the main process / local config). Guarded. */
(function () {
  'use strict';
  var nx = window.nexus || {};
  var G = nx.gmail || {};
  function $(id) { return document.getElementById(id); }
  function on(el, ev, fn) { if (el && el.addEventListener) el.addEventListener(ev, fn); }
  function state(msg, ok) { var s = $('gmailState'); if (!s) return; s.textContent = msg || ''; s.className = 'voice-state' + (ok === true ? ' ok' : ok === false ? ' err' : ''); }

  function open() { var m = $('gmailModal'); if (!m) return; m.classList.add('show'); m.setAttribute('aria-hidden', 'false'); load(); }
  function close() { var m = $('gmailModal'); if (m) { m.classList.remove('show'); m.setAttribute('aria-hidden', 'true'); } }

  function load() {
    if (typeof G.get !== 'function') { state('Reinstall the app to enable email.', false); return; }
    Promise.resolve(G.get()).then(function (c) {
      c = c || {};
      var u = $('gmailUser'); if (u) u.value = c.user || '';
      var p = $('gmailPass'); if (p) { p.value = ''; p.placeholder = c.connected ? 'App password saved — paste to replace' : 'e.g. abcd efgh ijkl mnop'; }
      if (c.connected) state('Connected as ' + c.user + ' ✓', true); else state('Not connected yet.', null);
    }).catch(function () {});
  }
  function save() {
    var u = ($('gmailUser') && $('gmailUser').value || '').trim();
    var p = ($('gmailPass') && $('gmailPass').value || '').trim();
    if (!u) { state('Enter your Gmail address.', false); return Promise.resolve(false); }
    state('Saving…', null);
    return Promise.resolve(G.set(u, p)).then(function (r) {
      if (r && r.connected) { state('Saved ✓ — Sea can send email now.', true); var pp = $('gmailPass'); if (pp) { pp.value = ''; pp.placeholder = 'App password saved — paste to replace'; } return true; }
      state(p ? 'Saved, but the App Password looks off — re-check it.' : 'Saved your address. Add the App Password to enable sending.', p ? false : null);
      return false;
    }).catch(function () { state('Couldn’t save.', false); return false; });
  }
  function boot() {
    on($('gmailBtn'), 'click', open);
    on($('gmailDone'), 'click', function () { save().then(function (ok) { if (ok) close(); }); });
    on($('gmailPass'), 'keydown', function (e) { if (e && (e.key === 'Enter' || e.keyCode === 13)) { e.preventDefault(); save(); } });
    on($('gmailTest'), 'click', function () {
      var btn = this; btn.disabled = true; var old = btn.textContent; btn.textContent = 'Sending…';
      save().then(function () { return G.test ? G.test() : null; }).then(function (r) {
        if (r && r.ok) state('Test email sent to yourself ✓ — check your inbox.', true);
        else if (r) state('Test failed: ' + (r.error || 'unknown'), false);
      }).catch(function () { state('Test failed.', false); }).then(function () { setTimeout(function () { btn.disabled = false; btn.textContent = old; }, 900); });
    });
    on($('gmailModal'), 'click', function (e) { if (e && e.target === this) close(); });
    document.addEventListener('keydown', function (e) { if (e && e.key === 'Escape') close(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
