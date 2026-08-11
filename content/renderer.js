/* ============================================================
   NEXUS — renderer.js  ·  the wiring layer
   Boots the app, drives window.World (the isometric office scene)
   and the glass HUD overlays from window.nexus backend events.
   Pure vanilla JS. Guards every lookup — never crashes if an
   element, the World, the nexus bridge, or an agent is missing.
   NEVER references window.buddy.
   ============================================================ */
(function () {
  'use strict';

  /* ---------- Fixed agent roster (ids from the contract) ---------- */
  var AGENT_IDS = ['manager', 'research', 'docs', 'marketing', 'inbox', 'api'];
  var SPECIALISTS = ['research', 'docs', 'marketing', 'inbox', 'api'];

  var reduceMotion = false;
  try {
    reduceMotion = !!(window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (_) {}

  /* ---------- Tiny DOM helpers (never throw) ---------- */
  function $(id) {
    try { return document.getElementById(id); } catch (_) { return null; }
  }
  function on(el, evt, fn, opts) {
    if (el && el.addEventListener) {
      try { el.addEventListener(evt, fn, opts); } catch (_) {}
    }
  }
  function addClass(el, c) { if (el && el.classList) { try { el.classList.add(c); } catch (_) {} } }
  function removeClass(el, c) { if (el && el.classList) { try { el.classList.remove(c); } catch (_) {} } }

  /* ---------- Safe bridges ---------- */
  var nx = (window && window.nexus) ? window.nexus : {};

  // Call a nexus method that returns a promise; resolve safely.
  function nxCall(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    try {
      if (nx && typeof nx[name] === 'function') {
        return Promise.resolve(nx[name].apply(nx, args));
      }
    } catch (e) {
      return Promise.reject(e);
    }
    return Promise.reject(new Error('nexus.' + name + ' unavailable'));
  }

  // Drive the scene without ever throwing (World may lag-load / miss a method).
  function W(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    try {
      var world = window.World;
      if (world && typeof world[name] === 'function') {
        world[name].apply(world, args);
      }
    } catch (_) {}
  }

  /* ============================================================
     Toast
     ============================================================ */
  var toastTimer = null;
  function toast(msg, isError) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg == null ? '' : String(msg);
    if (isError) addClass(t, 'error'); else removeClass(t, 'error');
    addClass(t, 'show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { removeClass(t, 'show'); }, 2800);
  }

  /* ============================================================
     Subtitle (user transcript, auto-fades)
     ============================================================ */
  var subtitleTimer = null;
  function showSubtitle(text) {
    var s = $('subtitle');
    if (!s) return;
    s.textContent = text == null ? '' : String(text);
    addClass(s, 'show');
    if (subtitleTimer) clearTimeout(subtitleTimer);
    subtitleTimer = setTimeout(function () { removeClass(s, 'show'); }, 3200);
  }

  /* ============================================================
     Answer card + smooth typewriter reveal
     ------------------------------------------------------------
     Deltas append to `target`; a delta-time rAF loop eases the
     revealed length toward the target so streaming reads smooth.
     On `answer` we lock the final text and, once fully revealed,
     run Nova's speaking beat, then settle to idle.
     ============================================================ */
  var tw = {
    target: '',        // full accumulated text so far
    shown: 0,          // chars currently rendered
    raf: 0,            // active rAF id (0 = stopped)
    last: 0,           // last frame timestamp
    finalizePending: false // true once `answer` locked the text
  };

  function answerCardEl() { return $('answerCard'); }
  function answerTextEl() { return $('answerText'); }

  function revealAnswerCard() {
    addClass(answerCardEl(), 'show');
  }
  function hideAnswerCard() {
    removeClass(answerCardEl(), 'show');
  }

  function resetAnswer() {
    tw.target = '';
    tw.shown = 0;
    tw.finalizePending = false;
    var el = answerTextEl();
    if (el) el.textContent = '';
    hideAnswerCard();
    stopTypewriter();
  }

  function scrollAnswerToEnd() {
    var card = answerCardEl();
    if (card) { try { card.scrollTop = card.scrollHeight; } catch (_) {} }
  }

  function renderShown() {
    var el = answerTextEl();
    if (el) el.textContent = tw.target.slice(0, tw.shown);
    scrollAnswerToEnd();
  }

  function stopTypewriter() {
    if (tw.raf) { try { cancelAnimationFrame(tw.raf); } catch (_) {} tw.raf = 0; }
  }

  function startTypewriter() {
    if (tw.raf) return;
    tw.last = (window.performance && performance.now) ? performance.now() : Date.now();
    tw.raf = requestAnimationFrame(twTick);
  }

  function twTick(now) {
    tw.raf = 0;
    var t = (typeof now === 'number') ? now : Date.now();
    var dt = (t - tw.last) / 1000;
    if (!(dt >= 0)) dt = 0;
    if (dt > 0.1) dt = 0.1; // clamp after tab-switch stalls
    tw.last = t;

    if (tw.shown < tw.target.length) {
      var remaining = tw.target.length - tw.shown;
      // Base pace ~ 260 chars/s; accelerate hard when far behind so
      // long bursts never feel laggy, but individual chars still flow.
      var add = Math.max(1, Math.ceil(260 * dt));
      if (remaining > 90) add = Math.max(add, Math.ceil(remaining * dt * 3));
      tw.shown = Math.min(tw.target.length, tw.shown + add);
      renderShown();
    }

    if (tw.shown < tw.target.length) {
      tw.raf = requestAnimationFrame(twTick);
    } else if (tw.finalizePending) {
      tw.finalizePending = false;
      runSpeakingBeat();
    }
    // else: caught up, nothing pending -> loop parks (zero cost)
  }

  // Per user preference: Sea SPEAKS its reply and does not display the text.
  // The HUD's "SPEAKING" state (driven by the manager events) is the only cue.
  var SHOW_REPLY_TEXT = false;

  function appendDelta(text) {
    if (!SHOW_REPLY_TEXT) return;
    if (!text) return;
    revealAnswerCard();
    tw.target += String(text);
    if (reduceMotion) {
      tw.shown = tw.target.length;
      renderShown();
    } else {
      startTypewriter();
    }
  }

  function finalizeAnswer(text) {
    revealAnswerCard();
    if (typeof text === 'string' && text.length) {
      // The final text is authoritative. If deltas already produced a
      // longer/different string, prefer the finalized answer.
      tw.target = text;
      if (tw.shown > tw.target.length) tw.shown = 0; // re-reveal if shorter
    }
    if (reduceMotion) {
      tw.shown = tw.target.length;
      renderShown();
      runSpeakingBeat();
      return;
    }
    if (tw.shown >= tw.target.length) {
      renderShown();
      runSpeakingBeat();
    } else {
      tw.finalizePending = true;
      startTypewriter();
    }
  }

  /* Nova speaks the result, then the room settles back to calm. */
  var speakTimer = null;
  function runSpeakingBeat() {
    W('setManager', 'speaking');
    W('speak', 'manager', true);
    W('focus', null);
    if (speakTimer) clearTimeout(speakTimer);
    var dwell = reduceMotion ? 400 : Math.min(4200, 1400 + tw.target.length * 12);
    speakTimer = setTimeout(function () {
      W('speak', 'manager', false);
      W('setManager', 'idle');
    }, dwell);
  }

  /* ============================================================
     Reset everyone to calm (used on error / new request start)
     ============================================================ */
  function resetSceneToIdle() {
    if (speakTimer) { clearTimeout(speakTimer); speakTimer = null; }
    W('speak', 'manager', false);
    W('setManager', 'idle');
    for (var i = 0; i < SPECIALISTS.length; i++) {
      W('setAgent', SPECIALISTS[i], 'idle');
    }
    W('focus', null);
  }

  /* ============================================================
     Sending a request
     ============================================================ */
  var lastAgent = null;   // last delegated specialist (for deliver targeting)
  var busy = false;       // a request is in flight

  function submit(rawText) {
    var text = (rawText == null ? '' : String(rawText)).trim();
    if (!text) return;

    // Stop any prior speech and clear the previous answer for a fresh reveal.
    try { nxCall('stopSpeaking'); } catch (_) {}
    if (speakTimer) { clearTimeout(speakTimer); speakTimer = null; }
    resetAnswer();

    lastAgent = null;
    busy = true;

    showSubtitle(text);
    W('setManager', 'thinking');

    var cmd = $('command');
    if (cmd) cmd.value = '';

    nxCall('ask', text).catch(function (err) {
      // Backend rejected the ask outright — surface it, calm the room.
      busy = false;
      toast('Couldn’t reach the Director: ' + friendlyErr(err), true);
      resetSceneToIdle();
    });
  }

  function friendlyErr(err) {
    if (!err) return 'unknown error';
    if (typeof err === 'string') return err;
    if (err.message) return err.message;
    try { return String(err); } catch (_) { return 'unknown error'; }
  }

  /* ============================================================
     Voice capture (MediaRecorder -> NexusVoice.transcribe -> ask)
     ============================================================ */
  var recorder = null;
  var chunks = [];
  var recording = false;

  function micEl() { return $('mic'); }

  function setMicListening(active) {
    var m = micEl();
    if (!m) return;
    if (active) addClass(m, 'listening'); else removeClass(m, 'listening');
  }

  function toggleMic() {
    if (recording) stopRecording();
    else startRecording();
  }

  function startRecording() {
    if (recording) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia ||
        typeof window.MediaRecorder === 'undefined') {
      toast('Voice capture isn’t available on this device.', true);
      return;
    }
    try { nxCall('stopSpeaking'); } catch (_) {}

    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      try {
        recorder = new MediaRecorder(stream);
      } catch (e) {
        stopStream(stream);
        toast('Couldn’t start recording: ' + friendlyErr(e), true);
        return;
      }
      chunks = [];
      recorder.ondataavailable = function (e) {
        if (e && e.data && e.data.size) chunks.push(e.data);
      };
      recorder.onstop = function () {
        stopStream(stream);
        recording = false;
        setMicListening(false);
        var type = (recorder && recorder.mimeType) ? recorder.mimeType : 'audio/webm';
        var blob;
        try { blob = new Blob(chunks, { type: type }); } catch (_) { blob = null; }
        chunks = [];
        if (!blob || !blob.size) { return; }
        handleTranscribe(blob);
      };
      try {
        recorder.start();
      } catch (e) {
        stopStream(stream);
        recording = false;
        setMicListening(false);
        toast('Couldn’t start recording: ' + friendlyErr(e), true);
        return;
      }
      recording = true;
      setMicListening(true);
    }).catch(function () {
      recording = false;
      setMicListening(false);
      toast('Microphone blocked — allow it in System Settings › Privacy → Microphone, then reopen.', true);
    });
  }

  function stopRecording() {
    if (recorder && recording) {
      try { recorder.stop(); } catch (_) { recording = false; setMicListening(false); }
    }
  }

  function stopStream(stream) {
    try {
      var tracks = stream && stream.getTracks ? stream.getTracks() : [];
      for (var i = 0; i < tracks.length; i++) { try { tracks[i].stop(); } catch (_) {} }
    } catch (_) {}
  }

  function handleTranscribe(blob) {
    var voice = window.NexusVoice;
    if (!voice || typeof voice.transcribe !== 'function') {
      toast('Voice engine still loading — try again in a moment.', true);
      return;
    }
    showSubtitle('Transcribing…');
    Promise.resolve(voice.transcribe(blob, function (p) {
      if (p) showSubtitle(p);
    })).then(function (text) {
      var t = (text == null ? '' : String(text)).trim();
      if (t) submit(t);
      else toast('Didn’t catch that — tap the mic and try again.', false);
    }).catch(function (e) {
      toast('Voice failed: ' + friendlyErr(e), true);
    });
  }

  /* ============================================================
     Setup overlay (API key flow)
     ============================================================ */
  function showSetup() { addClass($('setup'), 'show'); var k = $('keyInput'); if (k) { try { k.focus(); } catch (_) {} } }
  function hideSetup() { removeClass($('setup'), 'show'); }

  function saveKey() {
    var input = $('keyInput');
    var errEl = $('keyError');
    if (errEl) errEl.textContent = '';
    var val = input ? input.value : '';
    if (!val || !val.trim()) {
      if (errEl) errEl.textContent = 'Paste a key to continue.';
      return;
    }
    nxCall('saveKey', val.trim()).then(function (ok) {
      if (ok || ok === undefined) {
        if (input) input.value = '';
        hideSetup();
      } else if (errEl) {
        errEl.textContent = 'That key looks invalid — double-check and try again.';
      }
    }).catch(function (e) {
      if (errEl) errEl.textContent = 'Couldn’t save the key: ' + friendlyErr(e);
    });
  }

  /* ============================================================
     Update flow
     ============================================================ */
  function hasUpdateFrom(r) {
    if (!r) return false;
    if (r === true) return true;
    if (typeof r === 'object') {
      if (r.hasUpdate === true) return true;
      if (r.ok === false) return false;
      // fall back to a version comparison if present
      if (r.latest && r.current && r.latest !== r.current) return true;
    }
    return false;
  }

  function checkUpdate() {
    var btn = $('updateBtn');
    addClass(btn, 'spinning');
    toast('Checking for updates…', false);
    nxCall('checkUpdate').then(function (r) {
      if (r && typeof r === 'object' && r.ok === false) {
        removeClass(btn, 'spinning');
        toast('Update check failed' + (r.error ? ': ' + r.error : ' (offline?).'), true);
        return;
      }
      if (hasUpdateFrom(r)) {
        var latest = (r && r.latest) ? (' v' + r.latest) : '';
        toast('Updating' + latest + '…', false);
        nxCall('applyUpdate').then(function (a) {
          // On success the app window reloads itself.
          if (a && typeof a === 'object' && a.ok === false) {
            removeClass(btn, 'spinning');
            toast('Update failed' + (a.error ? ': ' + a.error : '.'), true);
          }
        }).catch(function (e) {
          removeClass(btn, 'spinning');
          toast('Update failed: ' + friendlyErr(e), true);
        });
      } else {
        removeClass(btn, 'spinning');
        var cur = (r && r.current) ? (' (v' + r.current + ')') : '';
        toast('You’re up to date' + cur + '.', false);
      }
    }).catch(function (e) {
      removeClass(btn, 'spinning');
      toast('Update check failed: ' + friendlyErr(e), true);
    });
  }

  /* ============================================================
     nexus event subscriptions
     ============================================================ */
  function subscribe() {
    if (!nx || typeof nx.on !== 'function') return;

    var sub = function (evt, fn) {
      try { nx.on(evt, fn); } catch (_) {}
    };

    // Backend listening cue (mirrors on the mic ring).
    sub('listening', function (p) {
      var isOn = p && typeof p.on === 'boolean' ? p.on : !!p;
      // Don't fight the local record indicator while we're capturing.
      if (!recording) setMicListening(isOn);
    });

    // The offline transcript, echoed back from the backend.
    sub('transcript', function (p) {
      var text = p && p.text != null ? p.text : (typeof p === 'string' ? p : '');
      if (text) showSubtitle(text);
    });

    // Director's own state.
    sub('manager', function (p) {
      var state = p && p.state ? p.state : (typeof p === 'string' ? p : 'idle');
      W('setManager', state);
      if (state === 'speaking') { W('speak', 'manager', true); }
      else if (state === 'idle') { W('speak', 'manager', false); }
    });

    // Nova delegates a task to a specialist.
    sub('route', function (p) {
      if (!p) return;
      var id = p.agentId;
      if (!id) return;
      lastAgent = id;
      W('dispatch', id);
      W('setAgent', id, 'assigned');
      W('focus', id);
    });

    // A specialist changes state.
    sub('agent', function (p) {
      if (!p) return;
      var id = p.agentId || lastAgent;
      var state = p.state || 'idle';
      if (!id) return;
      if (state === 'assigned') lastAgent = id;
      W('setAgent', id, state);
      if (state === 'delivering') {
        // Fly the result orb back to Nova from the right desk.
        W('deliver', id);
      }
    });

    // Sea pulls up a visual on the holographic HUD (map / info panel).
    sub('display', function (p) {
      if (!p) return;
      try { if (window.Holo && typeof window.Holo.show === 'function') window.Holo.show(p); } catch (_) {}
    });

    // Streaming answer text.
    sub('delta', function (p) {
      var text = p && p.text != null ? p.text : (typeof p === 'string' ? p : '');
      appendDelta(text);
    });

    // Final answer.
    sub('answer', function (p) {
      busy = false;
      var text = p && p.text != null ? p.text : (typeof p === 'string' ? p : '');
      finalizeAnswer(text);
    });

    // Something went wrong — calm the room, no red flash (amber toast).
    sub('error', function (p) {
      busy = false;
      var msg = p && p.message ? p.message : (typeof p === 'string' ? p : 'Something went wrong.');
      toast(msg, true);
      if (tw.finalizePending) { tw.finalizePending = false; stopTypewriter(); }
      resetSceneToIdle();
    });
  }

  /* ============================================================
     Wire DOM controls
     ============================================================ */
  function wireControls() {
    var cmd = $('command');
    on(cmd, 'keydown', function (e) {
      if (e && (e.key === 'Enter' || e.keyCode === 13)) {
        e.preventDefault();
        submit(cmd ? cmd.value : '');
      }
    });

    on($('send'), 'click', function () {
      var c = $('command');
      submit(c ? c.value : '');
    });

    on($('mic'), 'click', function () { toggleMic(); });

    on($('updateBtn'), 'click', function () { checkUpdate(); });

    on($('settingsBtn'), 'click', function () { showSetup(); });

    on($('keySave'), 'click', function () { saveKey(); });
    on($('keyInput'), 'keydown', function (e) {
      if (e && (e.key === 'Enter' || e.keyCode === 13)) {
        e.preventDefault();
        saveKey();
      }
    });

    // Dismiss the answer card on an outside click.
    on(document, 'pointerdown', function (e) {
      var card = answerCardEl();
      if (!card || !card.classList || !card.classList.contains('show')) return;
      var t = e && e.target;
      if (t && (card.contains(t))) return;
      var bar = $('commandBar');
      if (bar && t && bar.contains(t)) return; // typing shouldn't dismiss
      hideAnswerCard();
    });

    // Keep the scene fit to the window.
    on(window, 'resize', function () { W('resize'); });
  }

  /* ============================================================
     Boot
     ============================================================ */
  function boot() {
    // 1. Stand up the world scene.
    var stage = $('stage');
    if (stage) W('init', stage);
    // Ensure an initial fit even if init ran before layout settled.
    W('resize');

    // 2. Wire controls + subscribe to backend events.
    wireControls();
    subscribe();

    // 3. Show setup if there's no key yet.
    nxCall('hasKey').then(function (has) {
      if (!has) showSetup();
    }).catch(function () {
      // If we can't tell, show setup so the user can provide a key.
      showSetup();
    });

    // 4. Version tag.
    nxCall('contentVersion').then(function (v) {
      var tag = $('verTag');
      if (tag && v != null) tag.textContent = 'v' + v;
    }).catch(function () {});

    // 5. Start at rest.
    W('setManager', 'idle');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();