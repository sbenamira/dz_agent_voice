const { spawn } = require('child_process');
const config = require('../config');
const logger = require('../utils/logger');

const audioCache = new Map();
const CACHE_MAX = 50;

function cacheKey(text) {
  return text.slice(0, 100);
}

// Fallback : pipe un stream MP3 → ffmpeg → chunks mulaw 8kHz
function pipeMP3ToMulaw(responseBody, onChunk) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-fflags', 'nobuffer',
      '-i', 'pipe:0',
      '-ar', '8000', '-ac', '1',
      '-acodec', 'pcm_mulaw',
      '-f', 'mulaw', 'pipe:1'
    ]);

    ffmpeg.stdin.on('error', () => {}); // ignorer EPIPE si ffmpeg quitte tôt
    ffmpeg.stderr.on('data', () => {});

    ffmpeg.stdout.on('data', chunk => onChunk(chunk));
    ffmpeg.stdout.on('end', resolve);
    ffmpeg.on('error', err => reject(err));

    // Pipe ElevenLabs response body → ffmpeg stdin
    (async () => {
      try {
        for await (const value of responseBody) {
          ffmpeg.stdin.write(Buffer.from(value));
        }
        ffmpeg.stdin.end();
      } catch (err) {
        ffmpeg.kill();
        reject(err);
      }
    })();
  });
}

// Supprime les fillers sonores en début de texte avant envoi TTS
function nettoyerTexte(text) {
  return text
    .replace(/^[\s،,]*(واه|آه|أوه|مم|أممم|واو|آآآ|اوه|آآ|اه)\s*[،,]?\s*/i, '')
    .replace(/^[\s،,]*(وآه|ومم|وأوه)\s*[،,]?\s*/i, '')
    .trim();
}

// ElevenLabs → onChunk(Buffer mulaw) pour chaque chunk reçu
async function synthesizeStream(text, onChunk) {
  text = nettoyerTexte(text);
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

  // output_format dans URL (authoritative) ET dans le body (compat SDK)
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${config.elevenlabs.voiceId}/stream?output_format=ulaw_8000`,
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
          stability: 0.55,
          similarity_boost: 0.85,
          style: 0.20,
          use_speaker_boost: true,
          speaking_rate: parseFloat(process.env.TTS_SPEED || '0.5')
        },
        output_format: 'ulaw_8000'
      })
    }
  );

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`ElevenLabs ${response.status}: ${errText.slice(0, 200)}`);
  }

  const contentType = response.headers?.get?.('content-type') || '';
  console.log('[TTS ElevenLabs] Content-Type:', contentType);

  const chunks = [];

  const trackChunk = (chunk) => {
    if (firstChunkMs === null) firstChunkMs = Date.now() - t0;
    chunks.push(chunk);
    totalBytes += chunk.length;
    onChunk(chunk);
  };

  if (contentType.includes('audio/mpeg')) {
    // ElevenLabs ignore le param ulaw_8000 → conversion MP3→mulaw via ffmpeg
    logger.warn('TTS ElevenLabs retourne MP3 malgré ulaw_8000 — conversion ffmpeg activée');
    await pipeMP3ToMulaw(response.body, trackChunk);
  } else {
    // Passthrough direct : raw mulaw bytes
    for await (const value of response.body) {
      trackChunk(Buffer.from(value));
    }
  }

  const full = Buffer.concat(chunks);
  if (full.length) {
    if (audioCache.size >= CACHE_MAX) audioCache.delete(audioCache.keys().next().value);
    audioCache.set(key, full);
  }

  console.log(`[TTS ElevenLabs] total: ${totalBytes} bytes, first_chunk: ${firstChunkMs}ms`);
  logger.info('TTS stream terminé', { chars: text.length, first_chunk_ms: firstChunkMs, bytes: totalBytes });
}

// Synthèse complète — pour fillers.js (pré-génération au démarrage)
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
