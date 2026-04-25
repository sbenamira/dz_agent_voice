const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const { spawn } = require('child_process');
const { mp3ToMulaw } = require('../utils/audio');
const logger = require('../utils/logger');

const VOICE = 'ar-DZ-IsmaelNeural';

const audioCache = new Map();
const CACHE_MAX = 50;

function cacheKey(text) {
  return `${VOICE}:${text.slice(0, 100)}`;
}

// Synthèse complète (utilisée pour le cache) — retourne un Buffer mulaw
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

    if (audioCache.size >= CACHE_MAX) audioCache.delete(audioCache.keys().next().value);
    audioCache.set(key, mulawBuffer);

    logger.info('TTS synthèse terminée', { chars: text.length, bytes: mulawBuffer.length });
    return mulawBuffer;
  } catch (err) {
    logger.error('TTS synthesize', { error: err.message });
    throw err;
  }
}

// Streaming direct Edge TTS → ffmpeg → onChunk(mulawBuffer) — latence réduite
async function synthesizeStream(text, onChunk) {
  if (!text || !text.trim()) return;

  const key = cacheKey(text);
  if (audioCache.has(key)) {
    logger.info('TTS cache hit (stream)', { chars: text.length });
    onChunk(audioCache.get(key));
    return;
  }

  const tts = new MsEdgeTTS();
  await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = await tts.toStream(text);

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-f', 'mp3', '-i', 'pipe:0',
      '-ar', '8000', '-ac', '1',
      '-acodec', 'pcm_mulaw',
      '-f', 'mulaw', 'pipe:1'
    ]);

    const mulawChunks = [];
    audioStream.pipe(ffmpeg.stdin);
    ffmpeg.stdin.on('error', () => {});
    ffmpeg.stderr.on('data', () => {});

    ffmpeg.stdout.on('data', chunk => {
      mulawChunks.push(chunk);
      onChunk(chunk);
    });

    ffmpeg.stdout.on('end', () => {
      const full = Buffer.concat(mulawChunks);
      if (full.length) {
        if (audioCache.size >= CACHE_MAX) audioCache.delete(audioCache.keys().next().value);
        audioCache.set(key, full);
      }
      logger.info('TTS stream terminé', { chars: text.length, bytes: full.length });
      resolve();
    });

    ffmpeg.on('error', err => {
      logger.error('TTS ffmpeg', { error: err.message });
      reject(err);
    });

    audioStream.on('error', err => {
      ffmpeg.kill();
      reject(err);
    });
  });
}

function clearCache() {
  audioCache.clear();
}

module.exports = { synthesize, synthesizeStream, clearCache };
