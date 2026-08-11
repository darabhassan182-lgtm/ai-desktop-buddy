/* NEXUS — voice-ui.js · the Voice settings modal (ElevenLabs).
   Lets the user paste their key, pick a voice + style, and Test.
   Uses window.nexus.voice.*  (key value never leaves the main process).
   Pure vanilla, guarded — never throws if an element is missing. */
(function () {
  'use strict';
  var nx = (window && window.nexus) ? window.nexus : {};
  var V = nx.voice || {};
  function $(id) { return document.getElementById(id); }
  function on(el, ev, fn) { if (el && el.addEventListener) el.addEventListener(ev, fn); }

  // Fallback list if we can't fetch the account's voices (offline / no key yet).
  var FALLBACK = [
    { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', labels: { accent: 'british', description: 'composed broadcaster' } },
    { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', labels: { accent: 'british', description: 'warm storyteller' } }
  ];
  var curVoice = 'onwK4e9ZLuTAKqWW03F9', curModel = 'eleven_multilingual_v2';

  function open() {
    var m = $('voiceModal'); if (!m) return;
    m.classList.add('show'); m.setAttribute('aria-hidden', 'false');
    load(); vidRefresh();
  }
  function close() { var m = $('voiceModal'); if (m) { m.classList.remove('show'); m.setAttribute('aria-hidden', 'true'); } }

  function state(msg, ok) {
    var s = $('voiceKeyState'); if (!s) return;
    s.textContent = msg || ''; s.className = 'voice-state' + (ok === true ? ' ok' : ok === false ? ' err' : '');
  }

  function load() {
    if (typeof V.get !== 'function') { state('Reinstall the app to enable the cinematic voice.', false); return; }
    Promise.resolve(V.get()).then(function (cfg) {
      cfg = cfg || {};
      curVoice = cfg.voice || curVoice; curModel = cfg.model || curModel;
      var ms = $('voiceModelSelect'); if (ms) ms.value = curModel;
      var k = $('voiceKey'); if (k) k.value = '';
      if (cfg.hasElevenKey) { state('Key saved ✓ — cinematic voice active.', true); if (k) k.placeholder = 'sk_… (a key is saved; paste to replace)'; }
      else { state('No key yet — using the built-in Mac voice.', null); }
      populate(cfg.hasElevenKey);
    }).catch(function () { populate(false); });
  }

  function populate(hasKey) {
    var sel = $('voiceSelect'); if (!sel) return;
    function render(list) {
      sel.innerHTML = '';
      // British first, then the rest — Jarvis is British.
      list.sort(function (a, b) {
        var ab = /brit/i.test((a.labels || {}).accent || '') ? 0 : 1;
        var bb = /brit/i.test((b.labels || {}).accent || '') ? 0 : 1;
        return ab - bb || String(a.name).localeCompare(String(b.name));
      });
      list.forEach(function (v) {
        var o = document.createElement('option');
        o.value = v.id;
        var lab = v.labels || {};
        var bits = [lab.accent, lab.gender, lab.description].filter(Boolean).join(', ');
        o.textContent = v.name + (bits ? '  ·  ' + bits : '');
        if (v.id === curVoice) o.selected = true;
        sel.appendChild(o);
      });
      if (!sel.value && list[0]) { sel.value = list[0].id; }
    }
    if (hasKey && typeof V.listVoices === 'function') {
      render(FALLBACK.slice());                         // instant, replaced when the fetch returns
      Promise.resolve(V.listVoices()).then(function (r) {
        if (r && r.ok && r.voices && r.voices.length) render(r.voices);
      }).catch(function () {});
    } else {
      render(FALLBACK.slice());
    }
  }

  function saveKey() {
    var k = $('voiceKey'); if (!k) return Promise.resolve();
    var val = (k.value || '').trim();
    if (!val) return Promise.resolve();
    state('Saving…', null);
    return Promise.resolve(V.setKey(val)).then(function (r) {
      if (r && r.hasElevenKey) { state('Key saved ✓ — cinematic voice active.', true); k.value = ''; k.placeholder = 'sk_… (a key is saved; paste to replace)'; populate(true); }
      else state('That didn’t look valid — check and paste again.', false);
    }).catch(function () { state('Couldn’t save the key.', false); });
  }

  /* ---------- voice-ID (speaker verification) ---------- */
  var PHRASES = ['Hello Sea, this is my voice.', 'Sea, remember how I sound.', 'It is me — your only user.'];
  function vidStatus(msg, ok) {
    var s = $('vidState'); if (!s) return;
    s.textContent = msg || ''; s.className = 'voice-state' + (ok === true ? ' ok' : ok === false ? ' err' : '');
  }
  function vidRefresh() {
    var vid = window.NexusVoiceID; if (!vid) { vidStatus('Reinstall the app to enable voice-ID.', false); return; }
    var en = $('vidEnable'); if (en) en.checked = vid.isEnabled();
    var sl = $('vidStrict'); if (sl) sl.value = Math.round(vid.getThreshold() * 100);
    var sv = $('vidStrictVal'); if (sv) sv.textContent = '(' + Math.round(vid.getThreshold() * 100) + ')';
    if (vid.isEnrolled()) vidStatus(vid.isEnabled() ? ('Active — Sea obeys only you (' + vid.sampleCount() + ' samples).') : ('Your voice is saved (' + vid.sampleCount() + ' samples). Turn it on above.'), vid.isEnabled() ? true : null);
    else vidStatus('Not set up — press “Teach Sea my voice”.', null);
  }
  function recordClip(stream, ms) {
    return new Promise(function (resolve, reject) {
      var rec; try { rec = new MediaRecorder(stream); } catch (e) { reject(e); return; }
      var chunks = []; rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = function () { resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' })); };
      rec.start(); setTimeout(function () { try { rec.stop(); } catch (e) {} }, ms);
    });
  }
  function teach() {
    var vid = window.NexusVoiceID; if (!vid) return;
    var btn = $('vidTeach'); if (btn) btn.disabled = true;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var i = 0;
      function next() {
        if (i >= PHRASES.length) {
          try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
          var en = $('vidEnable'); if (en) { en.checked = true; vid.setEnabled(true); }
          vidRefresh(); if (btn) btn.disabled = false; return;
        }
        vidStatus('Say: “' + PHRASES[i] + '”  (' + (i + 1) + '/' + PHRASES.length + ')', null);
        setTimeout(function () {
          recordClip(stream, 4200).then(function (blob) {
            vidStatus('Learning your voice… (first time downloads ~100MB, one time)', null);
            return vid.enroll(blob, function (p) {
              if (p && p.status === 'progress' && typeof p.progress === 'number') vidStatus('Downloading voice model… ' + Math.round(p.progress) + '%', null);
            });
          }).then(function () { i++; next(); })
            .catch(function (e) { vidStatus('That clip failed (' + ((e && e.message) || e) + ') — try again.', false); if (btn) btn.disabled = false; try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (x) {} });
        }, 700);
      }
      next();
    }).catch(function () { vidStatus('Microphone blocked — allow it in System Settings → Privacy → Microphone.', false); if (btn) btn.disabled = false; });
  }
  function bootVoiceId() {
    on($('vidTeach'), 'click', teach);
    on($('vidForget'), 'click', function () { if (window.NexusVoiceID) window.NexusVoiceID.clear(); vidRefresh(); });
    on($('vidEnable'), 'change', function () {
      var vid = window.NexusVoiceID; if (!vid) return;
      if (this.checked && !vid.isEnrolled()) { this.checked = false; vidStatus('Teach Sea your voice first.', false); return; }
      vid.setEnabled(this.checked); vidRefresh();
    });
    on($('vidStrict'), 'input', function () {
      if (window.NexusVoiceID) window.NexusVoiceID.setThreshold((+this.value) / 100);
      var sv = $('vidStrictVal'); if (sv) sv.textContent = '(' + this.value + ')';
    });
  }

  function boot() {
    on($('voiceBtn'), 'click', open);
    on($('voiceDone'), 'click', close);
    bootVoiceId();
    on($('voiceKey'), 'change', saveKey);
    on($('voiceKey'), 'keydown', function (e) { if (e && (e.key === 'Enter' || e.keyCode === 13)) { e.preventDefault(); saveKey(); } });
    on($('voiceSelect'), 'change', function () { curVoice = this.value; if (V.setVoice) V.setVoice(curVoice); });
    on($('voiceModelSelect'), 'change', function () { curModel = this.value; if (V.setModel) V.setModel(curModel); });
    on($('voiceTest'), 'click', function () {
      var btn = this; btn.disabled = true; var old = btn.textContent; btn.textContent = '♪ Speaking…';
      saveKey().then(function () {
        return V.test ? V.test() : null;
      }).catch(function () {}).then(function () {
        setTimeout(function () { btn.disabled = false; btn.textContent = old; }, 2600);
      });
    });
    on($('voiceModal'), 'click', function (e) { if (e && e.target === this) close(); });
    document.addEventListener('keydown', function (e) { if (e && (e.key === 'Escape' || e.keyCode === 27)) close(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
