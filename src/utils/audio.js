const { spawn } = require('child_process');
const logger = require('./logger');

// Convertit un buffer mp3 en mulaw 8kHz mono (format Twilio)
async function mp3ToMulaw(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-ar', '8000',
      '-ac', '1',
      '-f', 'mulaw',
      '-loglevel', 'quiet',
      'pipe:1'
    ]);

    const chunks = [];
    ffmpeg.stdout.on('data', chunk => chunks.push(chunk));
    ffmpeg.stderr.on('data', () => {});

    ffmpeg.on('close', code => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`ffmpeg mp3ToMulaw a échoué avec le code ${code}`));
      }
    });

    ffmpeg.on('error', err => {
      logger.error('Erreur ffmpeg mp3ToMulaw', { error: err.message });
      reject(err);
    });

    ffmpeg.stdin.write(mp3Buffer);
    ffmpeg.stdin.end();
  });
}

// Convertit un buffer mulaw 8kHz en wav PCM (pour analyse ou debug)
async function mulawToWav(mulawBuffer) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-f', 'mulaw',
      '-ar', '8000',
      '-ac', '1',
      '-i', 'pipe:0',
      '-f', 'wav',
      '-loglevel', 'quiet',
      'pipe:1'
    ]);

    const chunks = [];
    ffmpeg.stdout.on('data', chunk => chunks.push(chunk));
    ffmpeg.stderr.on('data', () => {});

    ffmpeg.on('close', code => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`ffmpeg mulawToWav a échoué avec le code ${code}`));
      }
    });

    ffmpeg.on('error', err => {
      logger.error('Erreur ffmpeg mulawToWav', { error: err.message });
      reject(err);
    });

    ffmpeg.stdin.write(mulawBuffer);
    ffmpeg.stdin.end();
  });
}

// Convertit mulaw 8kHz → linear16 PCM (G.711 µ-law decode, pur JS, synchrone)
// Nécessaire pour Deepgram language=ar qui n'accepte pas mulaw
function mulawToLinear16(mulawBuffer) {
  const out = Buffer.alloc(mulawBuffer.length * 2);
  for (let i = 0; i < mulawBuffer.length; i++) {
    let u = (~mulawBuffer[i]) & 0xFF;
    const sign = u & 0x80;
    const exp  = (u >> 4) & 0x07;
    const mant = u & 0x0F;
    let sample = ((mant << 1) + 33) << (exp + 1);
    sample -= 33;
    out.writeInt16LE(sign ? -sample : sample, i * 2);
  }
  return out;
}

module.exports = { mp3ToMulaw, mulawToWav, mulawToLinear16 };
