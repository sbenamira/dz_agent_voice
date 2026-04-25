const { synthesize } = require('./services/tts');
const logger = require('./utils/logger');

const FILLER_TEXTS = ['آه...', 'واه...', 'استنى شوية'];
const fillerAudioChunks = {};

// Pré-génère les fillers audio au démarrage (mulaw 8kHz, format Twilio)
async function initFillers() {
  for (const text of FILLER_TEXTS) {
    try {
      fillerAudioChunks[text] = await synthesize(text);
      logger.info('Filler préchargé', { text, bytes: fillerAudioChunks[text].length });
    } catch (err) {
      logger.warn('Filler init échec', { text, error: err.message });
    }
  }
}

function getRandomFiller() {
  const keys = Object.keys(fillerAudioChunks);
  if (keys.length === 0) return null;
  return fillerAudioChunks[keys[Math.floor(Math.random() * keys.length)]];
}

module.exports = { initFillers, getRandomFiller };
