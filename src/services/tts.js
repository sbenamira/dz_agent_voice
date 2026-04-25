const config = require('../config');
const logger = require('../utils/logger');

const audioCache = new Map();
const CACHE_MAX = 50;

function cacheKey(text) {
  return text.slice(0, 100);
}

// Retourne l'offset des données audio dans un buffer WAV, ou 0 si pas de header RIFF,
// ou null si le header est incomplet (il faut accumuler plus de données).
function wavDataOffset(buf) {
  if (buf.length === 0) return null;
  if (buf[0] !== 0x52) return 0;  // pas 'R' → certainement pas RIFF, données raw
  if (buf.length < 4) return null; // commence par 'R', attendre 4 bytes pour confirmer
  if (buf.slice(0, 4).toString('ascii') !== 'RIFF') return 0; // pas de WAV header
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.slice(pos, pos + 4).toString('ascii');
    if (id === 'data') return pos + 8; // sauter 'data' (4) + taille (4)
    pos += 8 + buf.readUInt32LE(pos + 4);
  }
  return null; // header RIFF incomplet, attendre plus de données
}

// Streaming ElevenLabs → onChunk(Buffer mulaw) pour chaque chunk reçu
async function synthesizeStream(text, onChunk) {
  if (!text || !text.trim()) return;

  const key = cacheKey(text);
  if (audioCache.has(key)) {
    logger.info('TTS cache hit (stream)', { chars: text.length });
    onChunk(audioCache.get(key));
    return;
  }

  const t0 = Date.now();
  let firstChunkMs = null;
  let totalBytes = 0;

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${config.elevenlabs.voiceId}/stream`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': config.elevenlabs.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.85,
          style: 0.35,
          use_speaker_boost: true
        },
        output_format: 'ulaw_8000'
      })
    }
  );

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`ElevenLabs ${response.status}: ${errText.slice(0, 200)}`);
  }

  const chunks = [];
  const reader = response.body.getReader();
  let headerParsed = false;
  let accum = Buffer.alloc(0);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.length) continue;

      let chunk = Buffer.from(value);

      if (!headerParsed) {
        accum = Buffer.concat([accum, chunk]);
        const offset = wavDataOffset(accum);
        if (offset === null) continue;        // header RIFF incomplet, accumuler
        headerParsed = true;
        chunk = accum.slice(offset);          // données PCM mulaw après le header
      }

      if (chunk.length > 0) {
        if (firstChunkMs === null) firstChunkMs = Date.now() - t0;
        chunks.push(chunk);
        totalBytes += chunk.length;
        onChunk(chunk);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const full = Buffer.concat(chunks);
  if (full.length) {
    if (audioCache.size >= CACHE_MAX) audioCache.delete(audioCache.keys().next().value);
    audioCache.set(key, full);
  }

  console.log(`[TTS ElevenLabs] first_chunk: ${firstChunkMs}ms, total: ${totalBytes} bytes`);
  logger.info('TTS stream terminé', { chars: text.length, first_chunk_ms: firstChunkMs, bytes: totalBytes });
}

// Synthèse complète — utilisée par fillers.js pour pré-générer des clips mulaw
async function synthesize(text) {
  if (!text || !text.trim()) return Buffer.alloc(0);

  const key = cacheKey(text);
  if (audioCache.has(key)) {
    logger.info('TTS cache hit', { chars: text.length });
    return audioCache.get(key);
  }

  try {
    const chunks = [];
    await synthesizeStream(text, chunk => chunks.push(chunk));
    const buf = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
    logger.info('TTS synthèse terminée', { chars: text.length, bytes: buf.length });
    return buf;
  } catch (err) {
    logger.error('TTS synthesize', { error: err.message });
    throw err;
  }
}

function clearCache() {
  audioCache.clear();
}

module.exports = { synthesize, synthesizeStream, clearCache };
