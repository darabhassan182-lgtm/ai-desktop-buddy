// Speech-to-text for Nexus.
//
// Primary path: ElevenLabs "Scribe" cloud STT via the main process
// (window.nexus.transcribe) — fast and accurate, uses the same key as the voice.
// Fallback path: offline Whisper (transformers.js from a CDN) if there is no
// ElevenLabs key or the cloud call fails.
//
// The CDN import is now LAZY (inside getASR) so this module ALWAYS defines
// window.NexusVoice even if the CDN is unreachable — the cloud path still works.

let asrPromise = null;
function getASR(onProgress) {
  if (!asrPromise) {
    asrPromise = (async () => {
      const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3');
      env.allowLocalModels = false;
      return pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
        progress_callback: (d) => {
          if (onProgress && d.status === 'progress' && typeof d.progress === 'number') {
            onProgress(`Downloading voice model… ${Math.round(d.progress)}%`);
          }
        },
      });
    })();
  }
  return asrPromise;
}

function blobToBase64(blob) {
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  });
}

async function transcribeWhisper(blob, onProgress) {
  const asr = await getASR(onProgress);
  onProgress && onProgress('Transcribing…');
  const buf = await blob.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx({ sampleRate: 16000 });
  const decoded = await ctx.decodeAudioData(buf);
  const audio = decoded.getChannelData(0);
  await ctx.close();
  const out = await asr(audio);
  return (out && out.text ? out.text : '').trim();
}

async function transcribe(blob, onProgress) {
  if (!blob || !blob.size) return '';
  // 1) Cloud STT (ElevenLabs Scribe) — reliable, no model download.
  try {
    if (window.nexus && typeof window.nexus.transcribe === 'function') {
      onProgress && onProgress('Transcribing…');
      const b64 = await blobToBase64(blob);
      const r = await window.nexus.transcribe(b64, blob.type || 'audio/webm');
      if (r && r.ok) return (r.text || '').trim();      // ok+empty = heard silence
      // r.ok === false (no key / network) → fall through to offline Whisper
    }
  } catch (e) { /* fall through to Whisper */ }
  // 2) Offline Whisper fallback.
  return transcribeWhisper(blob, onProgress);
}

// Cloud STT needs no warmup; keep warmup as a safe no-op (avoids the 40MB
// Whisper download unless the fallback is actually needed).
window.NexusVoice = { transcribe, warmup: () => {} };
