const express = require('express');
const multer = require('multer');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');
const db = require('../services/database');
const campaign = require('../services/campaign');
const { parseContactsExcel, validatePhoneNumber } = require('../utils/excel');

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
