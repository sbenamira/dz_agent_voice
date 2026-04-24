const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const { mp3ToMulaw } = require('../utils/audio');
const logger = require('../utils/logger');

const VOICE = 'ar-DZ-IsmaelNeural';

// Cache en mémoire pour les réponses audio fréquentes
const audioCache = new Map();
const CACHE_MAX = 50;

function cacheKey(text) {
  return `${VOICE}:${text.slice(0, 100)}`;
}

// Synthétise du texte en audio mulaw 8kHz via Microsoft Edge TTS (gratuit, sans API key)
async function synthesize(text) {
  if (!text || !text.trim()) return Buffer.alloc(0);

  const key = cacheKey(text);
  if (audioCache.has(key)) {
    logger.info('TTS cache hit', { chars: text.length });
    return audioCache.get(key);
  }

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

    const { audioStream } = await tts.toStream(text);

    const chunks = [];
    await new Promise((resolve, reject) => {
      audioStream.on('data', chunk => chunks.push(chunk));
      audioStream.on('end', resolve);
      audioStream.on('error', reject);
    });

    const mp3Buffer = Buffer.concat(chunks);
    const mulawBuffer = await mp3ToMulaw(mp3Buffer);

    if (audioCache.size >= CACHE_MAX) {
      audioCache.delete(audioCache.keys().next().value);
    }
    audioCache.set(key, mulawBuffer);

    logger.info('TTS synthèse terminée', { chars: text.length, bytes: mulawBuffer.length });
    return mulawBuffer;
  } catch (err) {
    logger.error('TTS synthesize', { error: err.message });
    throw err;
  }
}

function clearCache() {
  audioCache.clear();
}

module.exports = { synthesize, clearCache };
