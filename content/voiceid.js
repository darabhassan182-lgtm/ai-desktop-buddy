/* NEXUS — voiceid.js · on-device speaker verification (window.NexusVoiceID)
   Learns the owner's voice (WavLM-SV speaker embeddings via transformers.js),
   then scores each spoken command by cosine similarity so Sea can obey only
   the owner. Runs fully on-device; the ~102MB model is fetched once and cached.
   FAIL-OPEN: any model/error path returns match:true so Sea never goes deaf. */
(function () {
  'use strict';
  var MODEL_ID = 'Xenova/wavlm-base-plus-sv';
  var LS = { ref: 'nexus_vid_ref', enabled: 'nexus_vid_enabled', thresh: 'nexus_vid_thresh', n: 'nexus_vid_n' };

  var modelPromise = null, cosSim = null;
  var ref = null;            // Float32Array(512) — averaged reference embedding
  var samples = [];          // this-session enrollment embeddings (for averaging)
  var enabled = false, threshold = 0.72, nSamples = 0;   // forgiving default — avoids false-rejecting the owner

  try {
    var r = localStorage.getItem(LS.ref); if (r) ref = Float32Array.from(JSON.parse(r));
    enabled = localStorage.getItem(LS.enabled) === '1';
    var t = parseFloat(localStorage.getItem(LS.thresh)); if (!isNaN(t)) threshold = t;
    nSamples = parseInt(localStorage.getItem(LS.n) || '0', 10) || 0;
  } catch (e) {}

  function loadModel(onProgress) {
    if (!modelPromise) {
      modelPromise = (async function () {
        var T = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3');
        cosSim = T.cos_sim;
        var processor = await T.AutoProcessor.from_pretrained(MODEL_ID, { progress_callback: onProgress });
        var model = await T.AutoModel.from_pretrained(MODEL_ID, { dtype: 'q8', progress_callback: onProgress });
        return { processor: processor, model: model };
      })().catch(function (e) { modelPromise = null; throw e; });
    }
    return modelPromise;
  }

  async function blobTo16k(blob) {
    var buf = await blob.arrayBuffer();
    var AC = window.AudioContext || window.webkitAudioContext;
    var ctx = new AC({ sampleRate: 16000 });
    var dec = await ctx.decodeAudioData(buf);
    var a = new Float32Array(dec.getChannelData(0));
    await ctx.close();
    return a;
  }

  async function embed(blob, onProgress) {
    var m = await loadModel(onProgress);
    var audio = await blobTo16k(blob);
    if (audio.length < 16000 * 0.6) throw new Error('too-short'); // ~<0.6s is unreliable
    var inputs = await m.processor(audio);
    var out = await m.model(inputs);
    return out.embeddings.data;   // Float32Array(512)
  }

  function meanVec(list) {
    var d = list[0].length, out = new Float32Array(d), i, j;
    for (i = 0; i < list.length; i++) for (j = 0; j < d; j++) out[j] += list[i][j];
    for (j = 0; j < d; j++) out[j] /= list.length;
    return out;
  }

  var API = {
    isEnabled: function () { return enabled && !!ref; },
    isEnrolled: function () { return !!ref; },
    isReady: function () { return !!modelPromise; },
    sampleCount: function () { return nSamples; },
    getThreshold: function () { return threshold; },
    setThreshold: function (v) {
      threshold = Math.max(0.55, Math.min(0.97, +v || 0.80));
      try { localStorage.setItem(LS.thresh, String(threshold)); } catch (e) {}
      return threshold;
    },
    setEnabled: function (b) {
      enabled = !!b;
      try { localStorage.setItem(LS.enabled, enabled ? '1' : '0'); } catch (e) {}
      if (enabled) API.warmup();
      return API.isEnabled();
    },
    warmup: function (onProgress) { return loadModel(onProgress).then(function () { return true; }).catch(function () { return false; }); },

    // Record one enrollment clip → update the averaged reference.
    enroll: async function (blob, onProgress) {
      var e = await embed(blob, onProgress);
      samples.push(e);
      ref = meanVec(samples);
      nSamples = samples.length;
      try { localStorage.setItem(LS.ref, JSON.stringify(Array.from(ref))); localStorage.setItem(LS.n, String(nSamples)); } catch (x) {}
      return { count: nSamples };
    },

    // Score a spoken command against the owner's voice. Fail-open on any error.
    verify: async function (blob) {
      if (!ref) return { match: true, score: 1, reason: 'not-enrolled' };
      try {
        var e = await embed(blob);
        var score = cosSim(e, ref);
        return { match: score >= threshold, score: score };
      } catch (err) { return { match: true, score: 0, reason: 'error' }; }
    },

    clear: function () {
      ref = null; samples = []; nSamples = 0; enabled = false;
      try { localStorage.removeItem(LS.ref); localStorage.removeItem(LS.n); localStorage.setItem(LS.enabled, '0'); } catch (e) {}
    }
  };
  window.NexusVoiceID = API;
})();
