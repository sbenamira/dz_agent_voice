const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const config = require('../config');
const logger = require('../utils/logger');

// Crée une session de transcription Deepgram en streaming pour un appel Twilio
function createDeepgramSession(onTranscript, onError) {
  const deepgram = createClient(config.deepgram.apiKey);

  const connection = deepgram.listen.live({
    model: 'nova-2',
    language: 'ar',
    encoding: 'mulaw',
    sample_rate: 8000,
    channels: 1,
    endpointing: 300,
    interim_results: false,
    punctuate: true,
    smart_format: true
  });

  // Enregistrer l'handler d'erreur avant Open pour éviter ERR_UNHANDLED_ERROR si Deepgram échoue avant l'ouverture
  connection.on(LiveTranscriptionEvents.Error, err => {
    logger.error('Deepgram erreur', { error: err.message });
    if (onError) onError(err);
  });

  connection.on(LiveTranscriptionEvents.Open, () => {
    logger.info('Deepgram connexion ouverte');

    connection.on(LiveTranscriptionEvents.Transcript, data => {
      try {
        const alt = data?.channel?.alternatives?.[0];
        const transcript = alt?.transcript || '';

        if (data.is_final && transcript.trim()) {
          logger.info('Transcript reçu', { transcript: transcript.slice(0, 50) });
          onTranscript(transcript.trim());
        }
      } catch (err) {
        logger.error('Erreur traitement transcript', { error: err.message });
      }
    });

    connection.on(LiveTranscriptionEvents.Close, () => {
      logger.info('Deepgram connexion fermée');
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
