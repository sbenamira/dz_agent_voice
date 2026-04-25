const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const config = require('../config');
const logger = require('../utils/logger');

// Crée une session Deepgram en streaming avec KeepAlive et reconnexion automatique
function createDeepgramSession(onTranscript, onError) {
  let keepAliveTimer = null;
  let activeConnection = null;
  let closed = false; // évite la reconnexion si close() est appelé volontairement

  function initConnection() {
    if (closed) return;

    const deepgram = createClient(config.deepgram.apiKey);
    const connection = deepgram.listen.live({
      model: 'nova-2',
      language: 'ar',
      encoding: 'mulaw',
      sample_rate: 8000,
      channels: 1,
      endpointing: 300,
      interim_results: false
    });
    activeConnection = connection;

    // Handler d'erreur avant Open pour éviter ERR_UNHANDLED_ERROR
    connection.on(LiveTranscriptionEvents.Error, err => {
      const msg = err?.message || err?.description || err?.reason
        || (err ? JSON.stringify(err) : 'unknown');
      logger.error('Deepgram erreur', { error: msg, type: err?.type, code: err?.code });
      if (onError) onError(err);
    });

    connection.on(LiveTranscriptionEvents.Close, evt => {
      clearInterval(keepAliveTimer);
      const code = evt?.code ?? evt;
      if (code && code !== 1000) {
        logger.warn('Deepgram connexion fermée anormalement', { code, reason: evt?.reason });
        if (code === 1006 && !closed) {
          logger.info('Deepgram 1006 — reconnexion dans 1s');
          setTimeout(initConnection, 1000);
        }
      } else {
        logger.info('Deepgram connexion fermée', { code });
      }
    });

    connection.on(LiveTranscriptionEvents.Open, () => {
      logger.info('Deepgram connexion ouverte');

      // KeepAlive toutes les 5s pour maintenir le WebSocket ouvert
      keepAliveTimer = setInterval(() => {
        try {
          if (connection.getReadyState() === 1) {
            connection.send(JSON.stringify({ type: 'KeepAlive' }));
          }
        } catch (err) {
          logger.warn('Deepgram keepAlive', { error: err.message });
        }
      }, 5000);

      connection.on(LiveTranscriptionEvents.Transcript, data => {
        try {
          const alt = data?.channel?.alternatives?.[0];
          const transcript = alt?.transcript || '';

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
  }

  initConnection();

  return {
    send(audioBuffer) {
      try {
        if (activeConnection && activeConnection.getReadyState() === 1) {
          activeConnection.send(audioBuffer);
        }
      } catch (err) {
        logger.error('Deepgram send', { error: err.message });
      }
    },
    close() {
      closed = true;
      clearInterval(keepAliveTimer);
      try {
        if (activeConnection) activeConnection.finish();
      } catch (err) {
        logger.error('Deepgram close', { error: err.message });
      }
    }
  };
}

module.exports = { createDeepgramSession };
