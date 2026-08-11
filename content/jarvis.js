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

  /* ---------- mic meter → HUD core ---------- */
  var audioCtx = null, analyser = null, freqData = null, rafId = 0, windowPeak = 0;
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
    if (amp > windowPeak) windowPeak = amp;      // track loudest moment this window
    W('setLevel', amp);
  }
  function stopMeter() { if (rafId) cancelAnimationFrame(rafId); rafId = 0; try { audioCtx && audioCtx.close(); } catch (e) {} audioCtx = null; analyser = null; W('setLevel', 0); }

  /* ---------- hands-free wake word ---------- */
  var listening = false, rec = null, recording = false, chunks = [], loopStream = null;
  function stripWake(text) {
    var t = String(text || '').trim().replace(/^[,.\s"']+/, '');
    var m = /^(hey\s+|ok\s+)?(sea|jarvis|cea|see)\b[\s,.:!?-]*/i.exec(t);
    if (!m) return null;
    return t.slice(m[0].length).trim();
  }
  function toggleHandsFree() { if (listening) stopHandsFree(); else startHandsFree(); }
  function startHandsFree() {
    if (!window.NexusVoice || !window.NexusVoice.transcribe) { toast('Voice engine still loading — try again in a moment.'); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      loopStream = stream; listening = true;
      var btn = $('jarvisBtn'); if (btn) btn.classList.add('active');
      W('setListening', true); startMeter(loopStream);
      toast('Hands-free on — say “Sea, …”');
      try { window.NexusVoice.warmup && window.NexusVoice.warmup(); } catch (e) {}
      listenLoop();
    }).catch(function () { toast('Microphone blocked — allow it in System Settings → Privacy → Microphone.'); });
  }
  function stopHandsFree() {
    listening = false;
    var btn = $('jarvisBtn'); if (btn) btn.classList.remove('active');
    try { if (rec && recording) { recording = false; rec.stop(); } } catch (e) {}
    try { loopStream && loopStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    loopStream = null; stopMeter(); W('setListening', false);
  }
  function listenLoop() {
    if (!listening || !loopStream) return;
    chunks = []; windowPeak = 0;
    try { rec = new MediaRecorder(loopStream); } catch (e) { stopHandsFree(); return; }
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = function () {
      if (!listening) return;
      // Skip silent windows — don't spend a cloud transcription on background noise.
      if (windowPeak < 0.045) { if (listening) listenLoop(); return; }
      var blob = new Blob(chunks, { type: (rec && rec.mimeType) || 'audio/webm' });
      Promise.resolve(window.NexusVoice.transcribe(blob)).then(function (text) {
        if (text) handleHeard(text);
      }).catch(function () {}).then(function () { if (listening) listenLoop(); });
    };
    recording = true; rec.start();
    setTimeout(function () { try { if (rec && recording) { recording = false; rec.stop(); } } catch (e) {} }, 5000);
  }
  function handleHeard(text) {
    var cmd = stripWake(text);
    if (cmd === null) return;
    if (!cmd) { toast('Yes? — say “Sea, …”'); return; }
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
