const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const config = require('../config');
const logger = require('../utils/logger');

// Crée une session de transcription Deepgram en streaming pour un appel Twilio
function createDeepgramSession(onTranscript, onError) {
  const deepgram = createClient(config.deepgram.apiKey);

  const connection = deepgram.listen.live({
    model: 'whisper-large',
    language: 'ar',
    encoding: 'linear16',
    sample_rate: 8000,
    channels: 1,
    endpointing: 300,
    interim_results: false
  });

  // Enregistrer l'handler d'erreur avant Open pour éviter ERR_UNHANDLED_ERROR si Deepgram échoue avant l'ouverture
  connection.on(LiveTranscriptionEvents.Error, err => {
    const msg = err?.message || err?.description || err?.reason
      || (err ? JSON.stringify(err) : 'unknown');
    logger.error('Deepgram erreur', { error: msg, type: err?.type, code: err?.code });
    if (onError) onError(err);
  });

  // Hors de Open pour capturer aussi les closes prématurés (ex: 4000 = unauthorized)
  connection.on(LiveTranscriptionEvents.Close, evt => {
    const code = evt?.code ?? evt;
    if (code && code !== 1000) {
      logger.warn('Deepgram connexion fermée anormalement', { code, reason: evt?.reason });
    } else {
      logger.info('Deepgram connexion fermée', { code });
    }
  });

  connection.on(LiveTranscriptionEvents.Open, () => {
    logger.info('Deepgram connexion ouverte');

    connection.on(LiveTranscriptionEvents.Transcript, data => {
      try {
        const alt = data?.channel?.alternatives?.[0];
        const transcript = alt?.transcript || '';

        // Log tous les events pour diagnostiquer (à retirer une fois stable)
        logger.info('Deepgram transcript event', {
          is_final: data.is_final,
          speech_final: data.speech_final,
          text: transcript.slice(0, 60) || '(vide)'
        });

        if (data.is_final && transcript.trim()) {
          logger.info('Transcript reçu', { transcript: transcript.slice(0, 50) });
          onTranscript(transcript.trim());
        }
      } catch (err) {
        logger.error('Erreur traitement transcript', { error: err.message });
      }
    });
  });

  return {
    send(audioBuffer) {
      try {
        if (connection.getReadyState() === 1) {
          connection.send(audioBuffer);
        }
      } catch (err) {
        logger.error('Deepgram send', { error: err.message });
      }
    },
    close() {
      try {
        connection.finish();
      } catch (err) {
        logger.error('Deepgram close', { error: err.message });
      }
    }
  };
}

module.exports = { createDeepgramSession };
