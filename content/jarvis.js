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
  var capturing = false, captureStart = 0, silenceStart = 0, aborted = false, captureDuringSpeech = false;

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
  // While Sea is speaking we still listen (higher gate) but only act on "stop".
  function handleVAD(amp) {
    if (!listening) return;
    var now = Date.now();
    var duringSpeech = seaBusy();
    var startT = duringSpeech ? START_AMP * 2.2 : START_AMP;  // avoid triggering on Sea's own bleed
    if (!capturing) {
      if (amp >= startT) beginCapture(duringSpeech);
    } else {
      if (amp >= SILENCE_AMP) silenceStart = 0;
      else if (!silenceStart) silenceStart = now;
      var dur = now - captureStart, sil = silenceStart ? now - silenceStart : 0;
      var maxU = captureDuringSpeech ? 2600 : MAX_UTTER;   // mid-speech we only need a short "stop"
      if ((sil >= SILENCE_HANG && dur >= MIN_UTTER) || dur >= maxU) endCapture(false);
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

  function beginCapture(duringSpeech) {
    if (!loopStream) return;
    try { rec = new MediaRecorder(loopStream); } catch (e) { return; }
    chunks = []; aborted = false; capturing = true; captureDuringSpeech = !!duringSpeech; captureStart = Date.now(); silenceStart = 0;
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = function () {
      capturing = false;
      var during = captureDuringSpeech;
      if (aborted || !listening) return;
      var blob = new Blob(chunks, { type: (rec && rec.mimeType) || 'audio/webm' });
      if (!blob.size) return;
      gateAndHandle(blob, during);
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

  // "stop" barge-in words (with an optional leading "Sea").
  function isStop(text) {
    var t = String(text || '').trim().toLowerCase().replace(/^[,.\s"']+/, '');
    t = t.replace(/^(hey\s+|ok\s+|okay\s+)?(sea|jarvis|cea|see|sia)\b[\s,.:!?-]*/, '');
    return /^(stop|stop it|stop talking|stop please|please stop|quiet|be quiet|silence|shush|shut up|enough|that'?s enough|cancel|halt|pause)\b/.test(t.trim());
  }
  function doStop() {
    try { nx.stopSpeaking && nx.stopSpeaking(); } catch (e) {}
    W('setManager', 'idle');
    keepAwake();                 // stay in the conversation so a new command can follow
    toast('Stopped.');
  }

  // Speaker gate: if "only obey my voice" is on, verify the utterance is the
  // owner before acting. During Sea's speech we skip the gate for a fast "stop".
  function gateAndHandle(blob, duringSpeech) {
    if (duringSpeech) { transcribeAndHandle(blob, true); return; }
    var vid = window.NexusVoiceID;
    if (vid && vid.isEnabled && vid.isEnabled()) {
      Promise.resolve(vid.verify(blob)).then(function (res) {
        if (!res || res.match) transcribeAndHandle(blob, false);   // owner (or fail-open)
        // else: not the owner's voice → ignore silently
      }).catch(function () { transcribeAndHandle(blob, false); });
    } else {
      transcribeAndHandle(blob, false);
    }
  }
  function transcribeAndHandle(blob, duringSpeech) {
    Promise.resolve(window.NexusVoice.transcribe(blob)).then(function (text) {
      if (!text) return;
      if (duringSpeech) { if (isStop(text)) doStop(); return; }   // mid-speech: only "stop" acts
      handleHeard(text);
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
    if (isStop(cmd)) { doStop(); return; }                   // "Sea, stop" with nothing playing is harmless
    var sub = $('subtitle'); if (sub) { sub.textContent = cmd; sub.classList.add('show'); }
    if (/\b(screen|see this|look at|on my screen|what'?s on|read this)\b/i.test(cmd)) askVision(cmd);
    else { try { nx.stopSpeaking && nx.stopSpeaking(); } catch (e) {} try { nx.ask(cmd); } catch (e) {} }
  }

  /* ---------- vision: keep the screen open, grab frames on demand ---------- */
  var visionStream = null, visionVideo = null, visionOn = false;

  function startVision() {
    if (visionOn && visionVideo) return Promise.resolve(true);
    return navigator.mediaDevices.getDisplayMedia({ video: { width: 1280 }, audio: false }).then(function (stream) {
      visionStream = stream; visionOn = true;
      visionVideo = document.createElement('video'); visionVideo.srcObject = stream; visionVideo.muted = true;
      // If the user stops the share via macOS, reflect that in the app.
      try { stream.getVideoTracks().forEach(function (t) { t.onended = function () { stopVision(); toast('Screen vision off.'); }; }); } catch (e) {}
      var vb = $('visionBtn'); if (vb) vb.classList.add('active');
      return visionVideo.play().then(function () { return true; }).catch(function () { return true; });
    }).catch(function () {
      visionOn = false; var vb = $('visionBtn'); if (vb) vb.classList.remove('active');
      toast('Screen capture was blocked or cancelled.'); return false;
    });
  }
  function stopVision() {
    visionOn = false;
    try { visionStream && visionStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    visionStream = null; visionVideo = null;
    var vb = $('visionBtn'); if (vb) { vb.classList.remove('active'); vb.classList.remove('busy'); }
  }
  function grabFrame() {
    if (!visionVideo) return null;
    var w = visionVideo.videoWidth || 0, h = visionVideo.videoHeight || 0;
    if (!w || !h) return null;
    var scale = Math.min(1, 1280 / w), cw = Math.round(w * scale), ch = Math.round(h * scale);
    var cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
    try { cv.getContext('2d').drawImage(visionVideo, 0, 0, cw, ch); return cv.toDataURL('image/jpeg', 0.7); }
    catch (e) { return null; }
  }
  function askVision(prompt) {
    if (!nx.askVision) { toast('Reinstall the app to enable vision.'); return; }
    var vb = $('visionBtn');
    var run = (visionOn && visionVideo) ? Promise.resolve(true) : startVision();
    run.then(function (ok) {
      if (!ok) return;
      if (vb) vb.classList.add('busy');
      setTimeout(function () {
        var data = grabFrame();
        if (vb) vb.classList.remove('busy');
        if (!data) { toast('Could not read the screen — try again.'); return; }
        nx.askVision(prompt || 'What do you see on my screen?', data);
      }, 220);   // let a just-opened stream paint its first frame
    });
  }

  var jbtn = $('jarvisBtn'); if (jbtn) jbtn.addEventListener('click', toggleHandsFree);
  var vbtn = $('visionBtn'); if (vbtn) vbtn.addEventListener('click', function () {
    if (visionOn) { stopVision(); toast('Screen vision off.'); }
    else { askVision('What do you see on my screen?'); }   // opens the share (stays on) + asks
  });
})();
