/* NEXUS — Jarvis controls: hands-free wake word ("Sea, …"), screen vision,
   and feeding the mic level into the HUD core (window.World). Uses
   window.nexus + window.NexusVoice + window.World. Self-contained. */
(function () {
  'use strict';
  var nx = window.nexus || {};
  function $(id) { return document.getElementById(id); }
  function W(m) { var w = window.World; if (w && typeof w[m] === 'function') { try { w[m].apply(w, [].slice.call(arguments, 1)); } catch (e) {} } }
  function toast(msg) {
    var t = $('toast'); if (!t || !msg) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 3200);
  }

  /* ---------- mic level + voice-activity detection (VAD) ---------- */
  var audioCtx = null, analyser = null, freqData = null, rafId = 0;
  // VAD thresholds (amp is 0..1). Tuned for close talking.
  var START_AMP = 0.075, SILENCE_AMP = 0.05, SILENCE_HANG = 750, MIN_UTTER = 350, MAX_UTTER = 12000;
  var capturing = false, captureStart = 0, silenceStart = 0, aborted = false;

  function startMeter(stream) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var src = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser(); analyser.fftSize = 256;
      freqData = new Uint8Array(analyser.frequencyBinCount);
      src.connect(analyser); loopMeter();
    } catch (e) {}
  }
  function loopMeter() {
    rafId = requestAnimationFrame(loopMeter);
    if (!analyser) return;
    analyser.getByteFrequencyData(freqData);
    var sum = 0; for (var i = 0; i < freqData.length; i++) sum += freqData[i];
    var amp = sum / freqData.length / 255;
    W('setLevel', amp);
    handleVAD(amp);
  }
  function stopMeter() { if (rafId) cancelAnimationFrame(rafId); rafId = 0; try { audioCtx && audioCtx.close(); } catch (e) {} audioCtx = null; analyser = null; W('setLevel', 0); }

  // Detect an utterance: start when you begin talking, stop after a short pause.
  function handleVAD(amp) {
    if (!listening) return;
    var now = Date.now();
    if (seaBusy()) { if (capturing) endCapture(true); return; }  // don't hear Sea's own voice
    if (!capturing) {
      if (amp >= START_AMP) beginCapture();
    } else {
      if (amp >= SILENCE_AMP) silenceStart = 0;
      else if (!silenceStart) silenceStart = now;
      var dur = now - captureStart, sil = silenceStart ? now - silenceStart : 0;
      if ((sil >= SILENCE_HANG && dur >= MIN_UTTER) || dur >= MAX_UTTER) endCapture(false);
    }
  }

  /* ---------- hands-free engine ---------- */
  var listening = false, rec = null, chunks = [], loopStream = null;

  // While Sea is speaking, DON'T listen — otherwise its own voice loops back
  // through the mic and it interrupts itself. Resume shortly after it finishes.
  var seaSpeaking = false, speakCooldownUntil = 0;
  try {
    if (nx && typeof nx.on === 'function') nx.on('manager', function (p) {
      var st = p && p.state;
      if (st === 'speaking') seaSpeaking = true;
      else { if (seaSpeaking) speakCooldownUntil = Date.now() + 700; seaSpeaking = false; }
    });
  } catch (e) {}
  function seaBusy() { return seaSpeaking || Date.now() < speakCooldownUntil; }

  // Conversation mode: say "Sea" once → awake for follow-ups (no wake word) until idle.
  var AWAKE_MS = 30000, awakeUntil = 0;
  function isAwake() { return Date.now() < awakeUntil; }
  function keepAwake() { awakeUntil = Date.now() + AWAKE_MS; }
  function sleep() { awakeUntil = 0; }

  function stripWake(text) {
    var t = String(text || '').trim().replace(/^[,.\s"']+/, '');
    var m = /^(hey\s+|ok\s+|okay\s+)?(sea|jarvis|cea|see|sia|c)\b[\s,.:!?-]*/i.exec(t);
    if (!m) return null;
    return t.slice(m[0].length).trim();
  }

  function beginCapture() {
    if (!loopStream) return;
    try { rec = new MediaRecorder(loopStream); } catch (e) { return; }
    chunks = []; aborted = false; capturing = true; captureStart = Date.now(); silenceStart = 0;
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = function () {
      capturing = false;
      if (aborted || !listening) return;
      var blob = new Blob(chunks, { type: (rec && rec.mimeType) || 'audio/webm' });
      if (!blob.size) return;
      gateAndHandle(blob);
    };
    try { rec.start(); } catch (e) { capturing = false; }
  }
  function endCapture(discard) {
    aborted = !!discard;
    try { if (rec && rec.state !== 'inactive') rec.stop(); } catch (e) { capturing = false; }
  }

  function toggleHandsFree() { if (listening) stopHandsFree(); else startHandsFree(); }
  function startHandsFree() {
    if (!window.NexusVoice || !window.NexusVoice.transcribe) { toast('Voice engine still loading — try again in a moment.'); return; }
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(function (stream) {
      loopStream = stream; listening = true; sleep();
      var btn = $('jarvisBtn'); if (btn) btn.classList.add('active');
      W('setListening', true); startMeter(loopStream);
      try { if (window.NexusVoiceID && window.NexusVoiceID.isEnabled()) window.NexusVoiceID.warmup(); } catch (e) {}
      toast('Hands-free on — say “Sea”, then just keep talking.');
    }).catch(function () { toast('Microphone blocked — allow it in System Settings → Privacy → Microphone.'); });
  }
  function stopHandsFree() {
    listening = false; sleep();
    var btn = $('jarvisBtn'); if (btn) btn.classList.remove('active');
    endCapture(true);
    try { loopStream && loopStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    loopStream = null; stopMeter(); W('setListening', false);
  }

  // Speaker gate: if "only obey my voice" is on, verify the utterance is the
  // owner before transcribing/acting. Fail-open (verify returns match on error).
  function gateAndHandle(blob) {
    var vid = window.NexusVoiceID;
    if (vid && vid.isEnabled && vid.isEnabled()) {
      Promise.resolve(vid.verify(blob)).then(function (res) {
        if (!res || res.match) transcribeAndHandle(blob);   // owner (or fail-open)
        // else: not the owner's voice → ignore silently
      }).catch(function () { transcribeAndHandle(blob); });
    } else {
      transcribeAndHandle(blob);
    }
  }
  function transcribeAndHandle(blob) {
    Promise.resolve(window.NexusVoice.transcribe(blob)).then(function (text) {
      if (text) handleHeard(text);
    }).catch(function () {});
  }

  function handleHeard(text) {
    var raw = String(text || '').trim();
    if (!raw) return;
    // Sleep phrases end the conversation → require "Sea" again.
    if (isAwake() && /\b(go to sleep|stop listening|that'?s all|that is all|never mind|stand down|dismiss)\b/i.test(raw)) {
      sleep(); toast('Standing by — say “Sea” to wake me.'); return;
    }
    var cmd;
    if (isAwake()) {
      var s = stripWake(raw); cmd = (s !== null) ? s : raw;   // wake word optional while awake
    } else {
      cmd = stripWake(raw);
      if (cmd === null) return;                               // not addressed to Sea
    }
    keepAwake();
    if (!cmd) { toast('Yes?'); return; }                     // just "Sea" → wait for the command
    var sub = $('subtitle'); if (sub) { sub.textContent = cmd; sub.classList.add('show'); }
    if (/\b(screen|see this|look at|on my screen|what'?s on|read this)\b/i.test(cmd)) askVision(cmd);
    else { try { nx.stopSpeaking && nx.stopSpeaking(); } catch (e) {} try { nx.ask(cmd); } catch (e) {} }
  }

  /* ---------- vision: capture the screen, ask Sea ---------- */
  function askVision(prompt) {
    if (!nx.askVision) { toast('Reinstall the app to enable vision.'); return; }
    var vb = $('visionBtn'); if (vb) vb.classList.add('busy');
    navigator.mediaDevices.getDisplayMedia({ video: { width: 1280 }, audio: false }).then(function (stream) {
      var video = document.createElement('video'); video.srcObject = stream; video.muted = true;
      video.play().then(function () {
        setTimeout(function () {
          try {
            var w = video.videoWidth || 1280, h = video.videoHeight || 720;
            var scale = Math.min(1, 1280 / w), cw = Math.round(w * scale), ch = Math.round(h * scale);
            var cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
            cv.getContext('2d').drawImage(video, 0, 0, cw, ch);
            var data = cv.toDataURL('image/jpeg', 0.7);
            stream.getTracks().forEach(function (t) { t.stop(); });
            if (vb) vb.classList.remove('busy');
            nx.askVision(prompt || 'What do you see on my screen?', data);
          } catch (e) { cleanup(stream, vb); toast('Vision failed: ' + ((e && e.message) || e)); }
        }, 280);
      }).catch(function () { cleanup(stream, vb); });
    }).catch(function () { if (vb) vb.classList.remove('busy'); toast('Screen capture cancelled.'); });
  }
  function cleanup(stream, vb) { try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} if (vb) vb.classList.remove('busy'); }

  var jbtn = $('jarvisBtn'); if (jbtn) jbtn.addEventListener('click', toggleHandsFree);
  var vbtn = $('visionBtn'); if (vbtn) vbtn.addEventListener('click', function () { askVision('What do you see on my screen?'); });
})();
