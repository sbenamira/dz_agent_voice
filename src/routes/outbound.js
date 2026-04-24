const express = require('express');
const multer = require('multer');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');
const db = require('../services/database');
const campaign = require('../services/campaign');
const { parseContactsExcel, validatePhoneNumber } = require('../utils/excel');
const { initiateCall, getCallStatus } = require('../services/telephony');

const router = express.Router();

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

// POST /outbound/call — Lance un appel unique vers un numéro donné (test ad hoc)
router.post('/call', async (req, res) => {
  try {
    const { telephone, nom } = req.body;
    if (!telephone) return res.status(400).json({ error: 'telephone requis' });
    if (!validatePhoneNumber(telephone)) {
      return res.status(400).json({ error: 'Numéro invalide — format E.164 requis, ex: +21361234567' });
    }

    const baseUrl = config.server.baseUrl || `https://${req.headers.host}`;
    const webhookUrl = `${baseUrl}/inbound`;

    const call = await initiateCall(telephone, webhookUrl);

    logger.info('Appel ad hoc initié', { telephone, nom: nom || '—', callSid: call.sid });
    res.json({ success: true, callSid: call.sid, status: call.status });
  } catch (err) {
    logger.error('POST /outbound/call', { error: err.message });
    res.status(500).json({ error: err.message });
  }
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

module.exports = router;
