// Offline speech-to-text using Whisper via transformers.js.
// The model is downloaded once from a public CDN (no account, no audio sent),
// cached locally, then runs fully on-device — your voice never leaves the Mac.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';

env.allowLocalModels = false; // fetch the model from the hub, then cache it

let asrPromise = null;
function getASR(onProgress) {
  if (!asrPromise) {
    asrPromise = pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
      progress_callback: (d) => {
        if (onProgress && d.status === 'progress' && typeof d.progress === 'number') {
          onProgress(`Downloading voice model… ${Math.round(d.progress)}%`);
        }
      },
    });
  }
  return asrPromise;
}

async function transcribe(blob, onProgress) {
  const asr = await getASR(onProgress);           // loads model on first use
  onProgress && onProgress('Transcribing…');

  // Decode the recording and resample to the 16 kHz mono Whisper expects.
  const buf = await blob.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx({ sampleRate: 16000 });
  const decoded = await ctx.decodeAudioData(buf);
  const audio = decoded.getChannelData(0);
  await ctx.close();

  const out = await asr(audio);
  return (out && out.text ? out.text : '').trim();
}

// Warm the model in the background so the first click is faster (optional).
window.NexusVoice = { transcribe, warmup: () => getASR() };
