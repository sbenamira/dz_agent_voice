const express = require('express');
const WebSocket = require('ws');
const config = require('../config');
const logger = require('../utils/logger');
const db = require('../services/database');
const agent = require('../services/agent');
const { createDeepgramSession } = require('../services/stt');
const { synthesizeStream } = require('../services/tts');
const { generateTwiMLStream } = require('../services/telephony');

const router = express.Router();

// POST /inbound — webhook Twilio pour appel entrant, retourne TwiML WebSocket
router.post('/', (req, res) => {
  const callSid = req.body.CallSid || req.query.CallSid || 'unknown';
  const streamUrl = `wss://${req.headers.host}/media-stream`;
  logger.info('Appel entrant reçu', { callSid });
  const twiml = generateTwiMLStream(streamUrl, callSid);
  res.type('text/xml').send(twiml);
});

// Attache le handler WebSocket /media-stream au serveur HTTP
function setupMediaStream(server) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    if (request.url === '/media-stream') {
      wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
    }
  });

  wss.on('connection', ws => {
    logger.info('WebSocket media stream connecté');

    let callId = null;
    let streamSid = null;
    let dgSession = null;
    let callStartTime = Date.now();
    let conversationHistory = [];
    let isProcessing = false;
    let callLanguage = 'ar'; // darija par défaut — marché algérien

    function sendAudio(mulawBuffer) {
      if (ws.readyState !== WebSocket.OPEN || !streamSid) return;
      ws.send(JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: mulawBuffer.toString('base64') }
      }));
    }

    async function handleTranscript(transcript) {
      if (isProcessing || !transcript.trim()) return;
      isProcessing = true;


      try {
        let buffer = '';
        const spokenParts = [];

        await agent.streamResponse({
          callId,
          subjectId: null,
          userMessage: transcript,
          history: conversationHistory,
          langue: callLanguage,
          onChunk: async (chunk) => {
            buffer += chunk;
            if (/[.!?،؟]\s*$/.test(buffer) || buffer.length > 100) {
              const phrase = buffer.trim();
              buffer = '';
              if (phrase) {
                await synthesizeStream(phrase, chunk => { if (chunk.length) sendAudio(chunk); })
                  .catch(err => logger.error('TTS chunk', { error: err.message }));
                spokenParts.push(phrase);
              }
            }
          }
        });

        if (buffer.trim()) {
          await synthesizeStream(buffer.trim(), chunk => { if (chunk.length) sendAudio(chunk); }).catch(() => {});
          spokenParts.push(buffer.trim());
        }

        const fullResponse = spokenParts.join(' ');
        conversationHistory.push({ role: 'user', content: transcript });
        conversationHistory.push({ role: 'assistant', content: fullResponse });
        if (conversationHistory.length > 20) conversationHistory = conversationHistory.slice(-20);
      } catch (err) {
        logger.error('handleTranscript', { error: err.message, callId });
      } finally {
        isProcessing = false;
      }
    }

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data);

        if (msg.event === 'start') {
          streamSid = msg.streamSid;
          const twilioCallSid = msg.start?.callSid || msg.start?.customParameters?.callSid || 'unknown';

          const callRecord = await db.createCall({ campaign_id: null, contact_id: null, direction: 'inbound' });
          callId = callRecord.id;
          callStartTime = Date.now();

          dgSession = createDeepgramSession(
            (transcript) => handleTranscript(transcript),
            (err) => logger.error('Deepgram erreur', { error: err.message, callId })
          );

          logger.info('Appel inbound démarré', { callId, twilioCallSid });

          const accueil = 'السلام عليكم سيدي، نشالله تكون بخير. أنا كريم، كيفاش نقدر نعاونك اليوم؟';
          synthesizeStream(accueil, sendAudio).catch(err => logger.error('Accueil TTS', { error: err.message }));
        }

        if (msg.event === 'media' && dgSession) {
          dgSession.send(Buffer.from(msg.media.payload, 'base64'));
        }

        if (msg.event === 'stop') {
          if (dgSession) dgSession.close();
          const dureeSecondes = Math.round((Date.now() - callStartTime) / 1000);
          if (callId) await db.updateCall(callId, { statut: 'terminé', duree_secondes: dureeSecondes }).catch(() => {});
          logger.info('Appel inbound terminé', { callId, dureeSecondes });
        }
      } catch (err) {
        logger.error('WebSocket message', { error: err.message });
      }
    });

    ws.on('close', async () => {
      if (dgSession) dgSession.close();
      if (callId) {
        const dur = Math.round((Date.now() - callStartTime) / 1000);
        await db.updateCall(callId, { statut: 'terminé', duree_secondes: dur }).catch(() => {});
      }
      logger.info('WebSocket déconnecté', { callId });
    });

    ws.on('error', err => logger.error('WebSocket erreur', { error: err.message }));
  });

  logger.info('WebSocket /media-stream configuré');
}

module.exports = { router, setupMediaStream };
