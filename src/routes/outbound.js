const express = require('express');
const WebSocket = require('ws');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const config = require('../config');
const logger = require('../utils/logger');
const db = require('../services/database');
const campaign = require('../services/campaign');
const { parseContactsExcel, validatePhoneNumber } = require('../utils/excel');
const { initiateCall, getCallStatus, generateTwiMLStream } = require('../services/telephony');
const { createGeminiLiveSession } = require('../services/gemini-live');
const { loadProduct, buildOutboundPrompt } = require('../services/product');
const outboundFunctions = require('../functions/outbound-functions');

const router = express.Router();

// Contexte des appels outbound en cours : CallSid Twilio → { callId, productId, price, address, deliveryDelay }
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
    const { telephone, nom, productId, price, address, deliveryDelay } = req.body;
    if (!telephone) return res.status(400).json({ error: 'telephone requis' });
    if (!validatePhoneNumber(telephone)) {
      return res.status(400).json({ error: 'Numéro invalide — format E.164 requis, ex: +21361234567' });
    }

    const baseUrl = config.server.baseUrl || process.env.BASE_URL || `https://${req.headers.host}`;
    const webhookUrl = `${baseUrl}/outbound/webhook`;
    const statusCallbackUrl = `${baseUrl}/outbound/webhook/status`;

    const call = await initiateCall(telephone, webhookUrl, {
      statusCallback: statusCallbackUrl,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['no-answer', 'busy', 'failed', 'completed']
    });

    const callRecord = await db.createCall({ campaign_id: null, contact_id: null, direction: 'outbound' });

    // Charger le shop name pour la salutation Twilio Say
    let shopName = '';
    if (productId) {
      try { shopName = (await loadProduct(productId))?.shop_name || ''; }
      catch (_) {}
    }

    pendingOrders.set(call.sid, {
      callId: callRecord.id,
      telephone,
      nom: nom || '',
      productId: productId || null,
      price: price || '',
      address: address || '',
      deliveryDelay: deliveryDelay || '',
      shopName
    });

    logger.info('Appel outbound initié', { telephone, callSid: call.sid, callId: callRecord.id, productId });
    res.json({ success: true, callSid: call.sid, callId: callRecord.id, status: call.status });
  } catch (err) {
    logger.error('POST /outbound/call', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /outbound/webhook/status — StatusCallback Twilio : met à jour DB si pas de réponse
router.post('/webhook/status', async (req, res) => {
  try {
    const { CallSid, CallStatus } = req.body;
    const statusMap = {
      'no-answer': 'aucune_réponse',
      'busy':      'aucune_réponse',
      'failed':    'aucune_réponse',
      'completed': null  // géré par la session Gemini, on ne surécrit pas
    };
    const status = statusMap[CallStatus];
    if (status) {
      const order = pendingOrders.get(CallSid);
      if (order?.callId) {
        await db.updateCallStatus(order.callId, status);
        pendingOrders.delete(CallSid);
        logger.info('Statut no-answer enregistré', { CallSid, status, callId: order.callId });
      }
    }
  } catch (err) {
    logger.error('POST /outbound/webhook/status', { error: err.message });
  }
  res.sendStatus(200);
});

// POST /outbound/webhook — Webhook Twilio pour appels outbound sortants, retourne TwiML WebSocket
router.post('/webhook', (req, res) => {
  const callSid = req.body.CallSid || req.query.CallSid || 'unknown';
  const streamUrl = `wss://${req.headers.host}/outbound-stream`;
  const shopName = pendingOrders.get(callSid)?.shopName || '';
  const twiml = generateTwiMLStream(streamUrl, callSid, shopName);
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

// ── WebSocket /outbound-stream — pipeline Gemini Live ────────────────────────

function setupOutboundStream(server) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    if (request.url === '/outbound-stream') {
      wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
    }
  });

  wss.on('connection', ws => {
    logger.info('WebSocket outbound connecté');

    let callId        = null;
    let streamSid     = null;
    let geminiSession = null;
    let callStartTime = Date.now();
    let order         = null;

    // Timers de silence et timeout global
    let timerSilencePickup = null;
    let timerSilenceCall   = null;
    let timerGlobal        = null;

    // Verrous : éviter double exécution de endCall et double update du statut
    let ended                 = false;
    let outcomeRegistered     = false;
    let outcomeFunctionCalled = false;

    function clearAllTimers() {
      clearTimeout(timerSilencePickup);
      clearTimeout(timerSilenceCall);
      clearTimeout(timerGlobal);
    }

    // Réinitialise le timer de silence pendant l'appel (10s)
    function resetSilenceDuringCall() {
      clearTimeout(timerSilenceCall);
      timerSilenceCall = setTimeout(() => {
        logger.info('[OUTBOUND] Timeout silence appel', { callId });
        endCall('aucune_réponse').catch(() => {});
      }, 10000);
    }

    function sendAudioToTwilio(mulawBuf) {
      if (ws.readyState !== WebSocket.OPEN || !streamSid) return;
      ws.send(JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: mulawBuf.toString('base64') }
      }));
    }

    // Termine l'appel : met à jour DB, ferme Gemini et Twilio WS
    async function endCall(outcome) {
      if (ended) return;
      ended = true;
      clearAllTimers();

      // Enregistrer le statut métier uniquement s'il n'a pas déjà été mis à jour
      if (callId && outcome && !outcomeRegistered) {
        outcomeRegistered = true;
        await db.updateCallStatus(callId, outcome).catch(err =>
          logger.error('endCall updateCallStatus', { error: err.message })
        );
      }

      if (geminiSession) geminiSession.close();

      const dur = Math.round((Date.now() - callStartTime) / 1000);
      if (callId) {
        await db.updateCall(callId, { statut: 'terminé', duree_secondes: dur }).catch(() => {});
      }

      // Laisser le temps à Twilio de recevoir le dernier audio avant de raccrocher
      await new Promise(r => setTimeout(r, 1500));

      if (ws.readyState === WebSocket.OPEN && streamSid) {
        ws.send(JSON.stringify({ event: 'hangup', streamSid }));
      }
      if (ws.readyState !== WebSocket.CLOSED) ws.close();

      logger.info('Appel outbound terminé', { callId, outcome: outcome || '(via fonction)', dur });
    }

    // Audio produit par Gemini → transmettre à Twilio
    ws.on('gemini-audio', (mulawBuf) => {
      clearTimeout(timerSilencePickup); // annuler le timer silence décroché dès que Gemini parle
      sendAudioToTwilio(mulawBuf);
    });

    // Raccrocher après la phrase de clôture si une fonction terminale a été appelée
    // Délai 2s : laisser Twilio finir de streamer l'audio de clôture avant de raccrocher
    ws.on('gemini-turn-complete', () => {
      if (outcomeFunctionCalled) {
        setTimeout(() => endCall(null).catch(() => {}), 2000);
      }
    });

    // Barge-in : Gemini interrompu par le client → vider le buffer audio Twilio
    ws.on('gemini-interrupted', () => {
      if (ws.readyState === WebSocket.OPEN && streamSid) {
        ws.send(JSON.stringify({ event: 'clear', streamSid }));
      }
    });

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data);

        if (msg.event === 'start') {
          streamSid     = msg.streamSid;
          const callSid = msg.start?.callSid || msg.start?.customParameters?.callSid || 'unknown';

          order  = pendingOrders.get(callSid) || null;
          pendingOrders.delete(callSid);
          callId = order?.callId || null;
          callStartTime = Date.now();

          logger.info('Appel outbound démarré', { callId, callSid });

          // Silence mulaw 1s envoyé immédiatement pour signaler la connexion
          // pendant l'initialisation Gemini (évite le timeout silence décroché)
          const silencePayload = Buffer.alloc(8000, 0x7f).toString('base64');
          ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: silencePayload } }));

          // Callback déclenché quand Gemini appelle une fonction métier
          const handleFunctionCall = async (name, args) => {
            const handler = outboundFunctions[name];
            if (!handler) return { success: false, error: 'Fonction inconnue' };
            const result = await handler(args, callId);
            outcomeRegistered     = true;
            outcomeFunctionCalled = true;
            return result;
          };

          // Charger le produit et créer la session Gemini Live
          let product = null;
          if (order?.productId) {
            try {
              product = await loadProduct(order.productId);
            } catch (err) {
              logger.error('Erreur chargement produit', { error: err.message, productId: order.productId });
            }
          }
          const promptTemplate = fs.readFileSync(
            path.join(__dirname, '../prompts/karim_live_outbound.txt'), 'utf8'
          );
          const systemPrompt = product
            ? buildOutboundPrompt(promptTemplate, product, order)
            : promptTemplate;
          geminiSession = createGeminiLiveSession(ws, systemPrompt, outboundFunctions, handleFunctionCall, true);

          // Timer 1 : silence au décroché — 15s sans audio Gemini → aucune_réponse
          timerSilencePickup = setTimeout(async () => {
            logger.info('[OUTBOUND] Timeout silence décroché', { callId });
            await endCall('aucune_réponse');
          }, 15000);

          // Timer 2 : silence pendant appel — 10s sans audio client → aucune_réponse
          resetSilenceDuringCall();

          // Timer 3 : timeout global 2 minutes
          timerGlobal = setTimeout(async () => {
            logger.info('[OUTBOUND] Timeout global 2mn', { callId });
            await endCall('timeout');
          }, 120000);
        }

        if (msg.event === 'media' && geminiSession) {
          const mulawBuf = Buffer.from(msg.media.payload, 'base64');
          resetSilenceDuringCall(); // réinitialiser le timer silence sur chaque audio client
          geminiSession.sendAudio(mulawBuf);
        }

        if (msg.event === 'stop') {
          clearAllTimers();
          if (geminiSession) geminiSession.close();
          const dur = Math.round((Date.now() - callStartTime) / 1000);
          if (callId) {
            await db.updateCall(callId, { statut: 'terminé', duree_secondes: dur }).catch(() => {});
          }
          logger.info('Appel outbound stop event', { callId });
        }
      } catch (err) {
        logger.error('WebSocket outbound message', { error: err.message });
      }
    });

    ws.on('close', async () => {
      clearAllTimers();
      if (geminiSession) geminiSession.close();
      if (!ended && callId) {
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
