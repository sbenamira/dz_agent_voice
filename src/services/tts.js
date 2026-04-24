const { mp3ToMulaw } = require('../utils/audio');
const config = require('../config');
const logger = require('../utils/logger');

// Cache en mémoire pour les réponses audio fréquentes
const audioCache = new Map();
const CACHE_MAX = 50;

function cacheKey(text) {
  return `${config.elevenlabs.voiceId}:${text.slice(0, 100)}`;
}

// Synthétise du texte en audio mulaw 8kHz via ElevenLabs Turbo v2
async function synthesize(text) {
  if (!text || !text.trim()) return Buffer.alloc(0);

  const key = cacheKey(text);
  if (audioCache.has(key)) {
    logger.info('TTS cache hit', { chars: text.length });
    return audioCache.get(key);
  }

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${config.elevenlabs.voiceId}/stream`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': config.elevenlabs.apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg'
        },
        body: JSON.stringify({
          text,
          model_id: config.elevenlabs.model,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            use_speaker_boost: true
          },
          optimize_streaming_latency: 3
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`ElevenLabs ${response.status}: ${errText}`);
    }

    const mp3Buffer = Buffer.from(await response.arrayBuffer());
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
