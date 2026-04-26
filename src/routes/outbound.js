const express = require('express');
const WebSocket = require('ws');
const multer = require('multer');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');
const db = require('../services/database');
const campaign = require('../services/campaign');
const { parseContactsExcel, validatePhoneNumber } = require('../utils/excel');
const { initiateCall, getCallStatus, generateTwiMLStream } = require('../services/telephony');
const { createDeepgramSession } = require('../services/stt');
const { synthesizeStream } = require('../services/tts');
const agent = require('../services/agent');

const router = express.Router();

// Contexte des appels outbound en cours : CallSid Twilio → { callId, productName, price, address, deliveryDelay }
const pendingOrders = new Map();

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.xlsx', '.xls'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  }
});

// POST /outbound/start — Lance une campagne outbound existante
router.post('/start', async (req, res) => {
  try {
    const { campaignId } = req.body;
    if (!campaignId) return res.status(400).json({ error: 'campaignId requis' });

    const baseUrl = config.server.baseUrl || `https://${req.headers.host}`;
    campaign.runCampaign(campaignId, baseUrl).catch(err => {
      logger.error('Campagne erreur background', { campaignId, error: err.message });
    });

    logger.info('Campagne lancée', { campaignId });
    res.json({ success: true, campaignId, message: 'Campagne lancée en arrière-plan' });
  } catch (err) {
    logger.error('POST /outbound/start', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /outbound/upload — Upload Excel + insertion contacts + lancement campagne
router.post('/upload', upload.single('contacts'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Fichier Excel requis (champ: contacts)' });

    const { campaignId } = req.body;
    if (!campaignId) return res.status(400).json({ error: 'campaignId requis' });

    const contacts = parseContactsExcel(req.file.path);
    const valid = contacts.filter(c => validatePhoneNumber(c.telephone));
    const skipped = contacts.length - valid.length;

    if (valid.length === 0) {
      return res.status(400).json({ error: 'Aucun numéro valide trouvé dans le fichier' });
    }

    await db.insertContacts(valid.map(c => ({
      campaign_id: campaignId,
      telephone: c.telephone,
      nom: c.nom,
      donnees_custom: c.donnees_custom,
      statut: 'en_attente'
    })));

    logger.info('Contacts importés', { campaignId, total: valid.length, skipped });

    const baseUrl = config.server.baseUrl || `https://${req.headers.host}`;
    campaign.runCampaign(campaignId, baseUrl).catch(err => {
      logger.error('Campagne erreur background', { campaignId, error: err.message });
    });

    res.json({ success: true, campaignId, imported: valid.length, skipped });
  } catch (err) {
    logger.error('POST /outbound/upload', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /outbound/call — Lance un appel de confirmation commande
router.post('/call', async (req, res) => {
  try {
    const { telephone, nom, productName, price, address, deliveryDelay } = req.body;
    if (!telephone) return res.status(400).json({ error: 'telephone requis' });
    if (!validatePhoneNumber(telephone)) {
      return res.status(400).json({ error: 'Numéro invalide — format E.164 requis, ex: +21361234567' });
    }

    const baseUrl = config.server.baseUrl || `https://${req.headers.host}`;
    const webhookUrl = `${baseUrl}/outbound/webhook`;

    const call = await initiateCall(telephone, webhookUrl);

    // Créer l'enregistrement DB maintenant pour avoir le callId dès la réponse
    const callRecord = await db.createCall({ campaign_id: null, contact_id: null, direction: 'outbound' });
    pendingOrders.set(call.sid, {
      callId: callRecord.id,
      telephone,
      nom: nom || '',
      productName: productName || '',
      price: price || '',
      address: address || '',
      deliveryDelay: deliveryDelay || ''
    });

    logger.info('Appel outbound initié', { telephone, callSid: call.sid, callId: callRecord.id });
    res.json({ success: true, callSid: call.sid, callId: callRecord.id, status: call.status });
  } catch (err) {
    logger.error('POST /outbound/call', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /outbound/webhook — Webhook Twilio pour appels outbound sortants, retourne TwiML WebSocket
router.post('/webhook', (req, res) => {
  const callSid = req.body.CallSid || req.query.CallSid || 'unknown';
  const streamUrl = `wss://${req.headers.host}/outbound-stream`;
  const twiml = generateTwiMLStream(streamUrl, callSid);
  res.type('text/xml').send(twiml);
});

// GET /outbound/status/:callSid — Statut Twilio en temps réel
router.get('/status/:callSid', async (req, res) => {
  try {
    const status = await getCallStatus(req.params.callSid);
    res.json({ callSid: req.params.callSid, status });
  } catch (err) {
    logger.error('GET /outbound/status', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /outbound/stats/:campaignId — Résumé des résultats d'une campagne
router.get('/stats/:campaignId', async (req, res) => {
  try {
    const stats = await db.getCallStats(req.params.campaignId);
    const summary = stats.reduce((acc, call) => {
      acc.total++;
      const key = call.resultat || 'inconnu';
      acc[key] = (acc[key] || 0) + 1;
      acc.duree_totale += call.duree_secondes || 0;
      return acc;
    }, { total: 0, duree_totale: 0 });

    res.json(summary);
  } catch (err) {
    logger.error('GET /outbound/stats', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Machine à états ────────────────────────────────────────────────────────────

// Prompts injectés dynamiquement selon l'étape courante
// Le code gère l'état, le LLM reçoit une seule instruction précise par tour
const STEP_PROMPTS = {
  1: (o) => `قول للعميل سلام وعرف روحك من TCF Academy واسأله: "مازال مهتم بـ ${o.productName} بـ ${o.price} دينار؟"`,
  2: (o) => `العميل أكد اهتمامه. اسأله فقط على العنوان: "العنوان تاعك: ${o.address} — صحيح؟"`,
  3: ()  => `العنوان تأكد. اسأل فقط: "واش عندك أي سؤال آخر؟"`,
  4: ()  => `قول: "شكراً على ثقتك، نتمنالك يوم مليح. مع السلامة." وأعد JSON مع "hangup":true,"status":"confirmé"`,
  cancel: () => `قول: "واخا، نلغيو الطلبية. شكراً." وأعد JSON مع "hangup":true,"status":"annulé"`
};

// Détection d'une réponse positive (oui, accord)
function isPositive(text) {
  return /إيه|واه|واخا|نعم|صح|مليح|بلاش|أكيد/.test(text);
}

// Détection d'une réponse négative (non, refus)
function isNegative(text) {
  return /لا|ما نبيه|ما نبيش|ما نريد/.test(text);
}

// Message d'accueil — demande uniquement l'intérêt (étape 1)
function buildGreeting(order) {
  if (!order || !order.productName) return 'سلام، أنا كريم من TCF Academy.';
  return `سلام، أنا كريم من TCF Academy. راني نعيطلك على الطلبية تاعك. مازال مهتم بـ ${order.productName} بـ ${order.price}؟`;
}

// Attache le handler WebSocket /outbound-stream au serveur HTTP
function setupOutboundStream(server) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    if (request.url === '/outbound-stream') {
      wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
    }
  });

  wss.on('connection', ws => {
    logger.info('WebSocket outbound connecté');

    let callId = null;
    let streamSid = null;
    let dgSession = null;
    let callStartTime = Date.now();
    let conversationHistory = [];
    let isProcessing = false;
    let order = null;
    let isTTSPlaying = false;
    let ttsStartTime = 0;

    // État de la machine : step 1→2→3→4 ou cancel
    const state = {
      step: 1,
      confirmed: { interest: false, address: false }
    };

    function sendAudio(mulawBuffer) {
      if (ws.readyState !== WebSocket.OPEN || !streamSid) return;
      ws.send(JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: mulawBuffer.toString('base64') }
      }));
    }

    async function handleTranscript(transcript) {
      if (!transcript.trim() || isProcessing) return;
      isProcessing = true;

      try {
        const positive = isPositive(transcript);
        const negative = isNegative(transcript);

        // Avancer l'état selon la réponse du client AVANT d'appeler le LLM
        if (state.step === 1) {
          if (positive) { state.step = 2; state.confirmed.interest = true; }
          else if (negative) { state.step = 'cancel'; }
        } else if (state.step === 2) {
          if (positive) { state.step = 3; state.confirmed.address = true; }
          // Si négatif ou correction adresse → rester step 2, LLM gère
        } else if (state.step === 3) {
          if (negative) state.step = 4;
          // Si question → rester step 3, LLM répond librement
        }

        const promptFn = STEP_PROMPTS[state.step];
        if (!promptFn) return; // étape invalide ou déjà terminée

        const stepPrompt = promptFn(order);
        logger.info('Outbound step', { callId, step: state.step, transcript: transcript.slice(0, 40) });

        await agent.streamOutboundResponse({
          callId,
          stepPrompt,
          userMessage: transcript,
          history: conversationHistory,
          onChunk: async (speakText) => {
            if (!speakText) return;
            isTTSPlaying = true; ttsStartTime = Date.now();
            await synthesizeStream(speakText, mulawChunk => {
              if (mulawChunk.length) sendAudio(mulawChunk);
            }).catch(err => logger.error('TTS outbound chunk', { error: err.message }))
              .finally(() => { isTTSPlaying = false; });
            conversationHistory.push({ role: 'user', content: transcript });
            conversationHistory.push({ role: 'assistant', content: speakText });
            if (conversationHistory.length > 20) conversationHistory = conversationHistory.slice(-20);
          },
          // Met à jour le statut de commande en DB
          onStatusUpdate: async (status) => {
            const statusMap = { 'confirmé': 'adresse_confirmée', 'annulé': 'annulé_client' };
            if (callId) await db.updateCallStatus(callId, statusMap[status] || status);
          },
          // Délai fixe de 4s pour laisser le dernier TTS se terminer, puis raccroche
          onHangup: async () => {
            await new Promise(r => setTimeout(r, 4000));
            if (ws.readyState === WebSocket.OPEN && streamSid) {
              ws.send(JSON.stringify({ event: 'hangup', streamSid }));
            }
            if (ws.readyState !== WebSocket.CLOSED) ws.close();
            logger.info('Raccrochage automatique', { callId });
          }
        });
      } catch (err) {
        logger.error('handleTranscript outbound', { error: err.message, callId });
      } finally {
        isProcessing = false;
      }
    }

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data);

        if (msg.event === 'start') {
          streamSid = msg.streamSid;
          const callSidTwilio = msg.start?.callSid || msg.start?.customParameters?.callSid || 'unknown';

          order = pendingOrders.get(callSidTwilio) || null;
          callId = order?.callId || null;
          callStartTime = Date.now();

          dgSession = createDeepgramSession(
            (transcript, speechFinal) => {
              // barge-in si le client parle pendant le TTS (après 1s minimum)
              if (speechFinal && isTTSPlaying && (Date.now() - ttsStartTime) > 1000 &&
                  ws.readyState === WebSocket.OPEN && streamSid) {
                ws.send(JSON.stringify({ event: 'clear', streamSid }));
                isTTSPlaying = false;
              }
              handleTranscript(transcript).catch(() => {});
            },
            (err) => logger.error('Deepgram outbound erreur', { error: err.message, callId })
          );

          logger.info('Appel outbound démarré', { callId, callSidTwilio });

          // Message d'accueil — pose la question step 1 (intérêt pour le produit)
          const greeting = buildGreeting(order);
          isTTSPlaying = true; ttsStartTime = Date.now();
          synthesizeStream(greeting, sendAudio)
            .catch(err => logger.error('Accueil outbound TTS', { error: err.message }))
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
          }
          logger.info('Appel outbound terminé', { callId, dureeSecondes });
        }
      } catch (err) {
        logger.error('WebSocket outbound message', { error: err.message });
      }
    });

    ws.on('close', async () => {
      if (dgSession) dgSession.close();
      if (callId) {
        const dur = Math.round((Date.now() - callStartTime) / 1000);
        await db.updateCall(callId, { statut: 'terminé', duree_secondes: dur }).catch(() => {});
      }
      logger.info('WebSocket outbound déconnecté', { callId });
    });

    ws.on('error', err => logger.error('WebSocket outbound erreur', { error: err.message }));
  });

  logger.info('WebSocket /outbound-stream configuré');
}

module.exports = { router, setupOutboundStream };
