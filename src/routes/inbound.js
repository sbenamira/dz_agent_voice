const express = require('express');
const WebSocket = require('ws');
const logger = require('../utils/logger');
const { generateTwiMLStream } = require('../services/telephony');

const pendingCallers = new Map();
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

// Pipeline inbound désactivé — seul le pipeline outbound Gemini Live est actif
function setupMediaStream(server) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    if (request.url === '/media-stream') {
      wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
    }
  });

  wss.on('connection', ws => {
    logger.warn('Pipeline inbound désactivé — connexion /media-stream rejetée');
    ws.close();
  });

  logger.info('WebSocket /media-stream configuré (pipeline désactivé)');
}

module.exports = { router, setupMediaStream };
