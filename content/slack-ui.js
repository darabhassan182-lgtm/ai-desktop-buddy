/* NEXUS — slack-ui.js · Connect-Slack modal. Uses window.nexus.slack.*
   (token stays in the main process / local config). Guarded, never throws. */
(function () {
  'use strict';
  var nx = window.nexus || {};
  var S = nx.slack || {};
  function $(id) { return document.getElementById(id); }
  function on(el, ev, fn) { if (el && el.addEventListener) el.addEventListener(ev, fn); }
  function state(msg, ok) { var s = $('slackState'); if (!s) return; s.textContent = msg || ''; s.className = 'voice-state' + (ok === true ? ' ok' : ok === false ? ' err' : ''); }

  function open() { var m = $('slackModal'); if (!m) return; m.classList.add('show'); m.setAttribute('aria-hidden', 'false'); load(); }
  function close() { var m = $('slackModal'); if (m) { m.classList.remove('show'); m.setAttribute('aria-hidden', 'true'); } }

  function load() {
    if (typeof S.get !== 'function') { state('Reinstall the app to enable Slack.', false); return; }
    Promise.resolve(S.get()).then(function (c) {
      var t = $('slackToken'); if (t) { t.value = ''; t.placeholder = (c && c.connected) ? 'A token is saved — paste to replace' : 'xoxp-… (stored only on this Mac)'; }
      state((c && c.connected) ? 'Token saved ✓ — press “Check connection” to verify.' : 'Not connected yet.', (c && c.connected) ? null : null);
    }).catch(function () {});
  }
  function save() {
    var t = ($('slackToken') && $('slackToken').value || '').trim();
    if (!t) { state('Paste your Slack token.', false); return Promise.resolve(false); }
    state('Saving…', null);
    return Promise.resolve(S.set(t)).then(function (r) {
      if (r && r.connected) { state('Saved ✓ — press “Check connection” to confirm it works.', true); var tt = $('slackToken'); if (tt) { tt.value = ''; tt.placeholder = 'A token is saved — paste to replace'; } return true; }
      state('Couldn’t save.', false); return false;
    }).catch(function () { state('Couldn’t save.', false); return false; });
  }
  function boot() {
    on($('slackBtn'), 'click', open);
    on($('slackDone'), 'click', function () { save().then(function (ok) { if (ok) close(); }); });
    on($('slackToken'), 'keydown', function (e) { if (e && (e.key === 'Enter' || e.keyCode === 13)) { e.preventDefault(); save(); } });
    on($('slackTest'), 'click', function () {
      var btn = this; btn.disabled = true; var old = btn.textContent; btn.textContent = 'Checking…';
      save().then(function () { return S.test ? S.test() : null; }).then(function (r) {
        if (r && r.ok) state('Connected to ' + (r.team || 'Slack') + ' as ' + (r.user || 'you') + ' ✓', true);
        else if (r) state('Not working: ' + (r.error || 'unknown') + '. Check the token/scopes.', false);
      }).catch(function () { state('Check failed.', false); }).then(function () { setTimeout(function () { btn.disabled = false; btn.textContent = old; }, 900); });
    });
    on($('slackModal'), 'click', function (e) { if (e && e.target === this) close(); });
    document.addEventListener('keydown', function (e) { if (e && e.key === 'Escape') close(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
