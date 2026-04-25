const express = require('express');
const WebSocket = require('ws');
const config = require('../config');
const logger = require('../utils/logger');
const db = require('../services/database');
const agent = require('../services/agent');
const { createDeepgramSession } = require('../services/stt');
const { synthesizeStream } = require('../services/tts');
const fillers = require('../fillers');
fillers.initFillers().catch(err => logger.warn('Fillers init', { error: err.message }));

// Stocke le numéro appelant entre le webhook POST et le WebSocket start
const pendingCallers = new Map();
const { generateTwiMLStream } = require('../services/telephony');

const router = express.Router();

// POST /inbound — webhook Twilio pour appel entrant, retourne TwiML WebSocket
router.post('/', (req, res) => {
  const callSid = req.body.CallSid || req.query.CallSid || 'unknown';
  const callerFrom = req.body.From || req.body.from || 'unknown';
  pendingCallers.set(callSid, callerFrom);
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
    let turnCount = 0;
    let callerNumber = 'unknown';
    let llmDurations = [];
    let ttsDurations = [];
    let totalDurations = [];
    let isTTSPlaying = false;    // true uniquement pendant synthesizeStream (pas filler, pas LLM)
    let isBargingIn = false;
    let activeTurnId = 0;
    const transcriptQueue = []; // transcripts reçus pendant traitement LLM — jamais perdus

    function sendAudio(mulawBuffer) {
      if (ws.readyState !== WebSocket.OPEN || !streamSid) return;
      ws.send(JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: mulawBuffer.toString('base64') }
      }));
    }

    // Reçoit chaque transcript final STT : log + file d'attente si LLM occupé
    function enqueueOrProcess(transcript) {
      if (!transcript.trim()) return;
      const sendingToLLM = !isProcessing ? 'oui' : 'file';
      logger.info('[STT FINAL]', { transcript: transcript.slice(0, 60), sendingToLLM, queue: transcriptQueue.length });
      if (isProcessing) {
        transcriptQueue.push(transcript);
      } else {
        handleTranscript(transcript);
      }
    }

    async function handleTranscript(transcript) {
      if (!transcript.trim()) return;
      isProcessing = true;
      isBargingIn = false;
      isTTSPlaying = false;
      const myTurnId = ++activeTurnId;
      turnCount++;

      // FIX 2 : filler immédiat pour masquer la latence LLM
      const fillerChunk = fillers.getRandomFiller();
      if (fillerChunk && fillerChunk.length) sendAudio(fillerChunk);
      const turnStart = Date.now();
      let ttsDurationTurn = 0;
      let ttsOutputBytesTurn = 0;

      try {
        let buffer = '';
        const spokenParts = [];

        const llmStart = Date.now();
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
                const t0 = Date.now();
                isTTSPlaying = true;
                await synthesizeStream(phrase, mulawChunk => {
                  if (mulawChunk.length) { sendAudio(mulawChunk); ttsOutputBytesTurn += mulawChunk.length; }
                }).catch(err => logger.error('TTS chunk', { error: err.message }))
                  .finally(() => { isTTSPlaying = false; });
                ttsDurationTurn += Date.now() - t0;
                spokenParts.push(phrase);
              }
            }
          }
        });
        const llmDuration = Date.now() - llmStart;

        if (buffer.trim()) {
          const t0 = Date.now();
          isTTSPlaying = true;
          await synthesizeStream(buffer.trim(), mulawChunk => {
            if (mulawChunk.length) { sendAudio(mulawChunk); ttsOutputBytesTurn += mulawChunk.length; }
          }).catch(() => {}).finally(() => { isTTSPlaying = false; });
          ttsDurationTurn += Date.now() - t0;
          spokenParts.push(buffer.trim());
        }

        const fullResponse = spokenParts.join(' ');
        const totalLatency = Date.now() - turnStart;

        conversationHistory.push({ role: 'user', content: transcript });
        conversationHistory.push({ role: 'assistant', content: fullResponse });
        if (conversationHistory.length > 20) conversationHistory = conversationHistory.slice(-20);

        llmDurations.push(llmDuration);
        ttsDurations.push(ttsDurationTurn);
        totalDurations.push(totalLatency);

        db.insertCallTurn({
          call_id: callId,
          turn_number: turnCount,
          stt_output_text: transcript,
          llm_input_text: transcript,
          llm_output_text: fullResponse,
          llm_duration_ms: llmDuration,
          tts_input_text: fullResponse,
          tts_output_bytes: ttsOutputBytesTurn,
          tts_duration_ms: ttsDurationTurn,
          total_latency_ms: totalLatency
        }).catch(err => logger.warn('insertCallTurn', { error: err.message }));

        logger.info('Tour complété', { callId, turn: turnCount, llm: llmDuration + 'ms', tts: ttsDurationTurn + 'ms', total: totalLatency + 'ms' });
      } catch (err) {
        logger.error('handleTranscript', { error: err.message, callId });
      } finally {
        if (activeTurnId === myTurnId) {
          isProcessing = false;
          if (transcriptQueue.length > 0) {
            handleTranscript(transcriptQueue.shift()); // traiter le suivant en file
          }
        }
      }
    }

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data);

        // Log chaque type d'événement WS pour diagnostic
        if (msg.event !== 'media') {
          logger.info('WS event', { event: msg.event, callId });
        }

        if (msg.event === 'start') {
          streamSid = msg.streamSid;
          const twilioCallSid = msg.start?.callSid || msg.start?.customParameters?.callSid || 'unknown';

          callerNumber = pendingCallers.get(twilioCallSid) || 'unknown';
          pendingCallers.delete(twilioCallSid);

          const callRecord = await db.createCall({ campaign_id: null, contact_id: null, direction: 'inbound' });
          callId = callRecord.id;
          callStartTime = Date.now();

          dgSession = createDeepgramSession(
            (transcript) => enqueueOrProcess(transcript),
            (err) => logger.error('Deepgram erreur', { error: err.message, callId }),
            // FIX 4 : barge-in — interim transcript pendant que Karim parle
            (interimText) => {
              if (isTTSPlaying && !isBargingIn && ws.readyState === WebSocket.OPEN && streamSid) {
                isBargingIn = true;
                ws.send(JSON.stringify({ event: 'clear', streamSid }));
                logger.info('Barge-in détecté', { callId, text: interimText.slice(0, 30) });
              }
            }
          );

          logger.info('Appel inbound démarré', { callId, twilioCallSid });

          const accueil = 'أهلاً وسهلاً سيدي، معك كريم من Konfident. كيفاش نقدر نعاونك اليوم؟';
          isTTSPlaying = true;
          synthesizeStream(accueil, sendAudio)
            .catch(err => logger.error('Accueil TTS', { error: err.message }))
            .finally(() => { isTTSPlaying = false; });
        }

        if (msg.event === 'media' && dgSession) {
          if (!isTTSPlaying) {
            dgSession.send(Buffer.from(msg.media.payload, 'base64'));
          }
        }

        if (msg.event === 'stop') {
          if (dgSession) dgSession.close();
          const dureeSecondes = Math.round((Date.now() - callStartTime) / 1000);
          if (callId) {
            await db.updateCall(callId, { statut: 'terminé', duree_secondes: dureeSecondes }).catch(() => {});
            const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
            db.updateCallMonitoring(callId, {
              caller_number: callerNumber,
              turns: turnCount,
              avg_llm_ms: avg(llmDurations),
              avg_tts_ms: avg(ttsDurations),
              avg_total_ms: avg(totalDurations)
            }).catch(err => logger.warn('updateCallMonitoring', { error: err.message }));
          }
          logger.info('Appel inbound terminé', { callId, dureeSecondes, turns: turnCount });
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
