const express = require('express');
const multer = require('multer');
const db = require('../services/database');
const rag = require('../services/rag');
const logger = require('../utils/logger');

const router = express.Router();
const upload = multer({ dest: 'uploads/', limits: { fileSize: 20 * 1024 * 1024 } });

// ── Workspaces ────────────────────────────────────────────────────────────────

router.get('/workspaces', async (req, res) => {
  try { res.json(await db.listWorkspaces()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/workspaces', async (req, res) => {
  try {
    const { nom, email } = req.body;
    if (!nom) return res.status(400).json({ error: 'nom requis' });
    res.status(201).json(await db.createWorkspace({ nom, email }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/workspaces/:id', async (req, res) => {
  try { res.json(await db.getWorkspace(req.params.id)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});

// ── Subjects ──────────────────────────────────────────────────────────────────

router.get('/workspaces/:workspaceId/subjects', async (req, res) => {
  try { res.json(await db.listSubjects(req.params.workspaceId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/workspaces/:workspaceId/subjects', async (req, res) => {
  try {
    const { nom, langue, script_accueil, script_conclusion } = req.body;
    if (!nom) return res.status(400).json({ error: 'nom requis' });
    res.status(201).json(await db.createSubject({
      workspace_id: req.params.workspaceId, nom, langue, script_accueil, script_conclusion
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/subjects/:id', async (req, res) => {
  try { res.json(await db.getSubject(req.params.id)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});

router.patch('/subjects/:id', async (req, res) => {
  try { res.json(await db.updateSubject(req.params.id, req.body)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/subjects/:id/documents', upload.single('document'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Fichier requis (champ: document)' });
    const result = await rag.uploadDocument(req.params.id, req.file.path, req.file.originalname, req.file.mimetype);
    res.status(201).json(result);
  } catch (err) {
    logger.error('Upload document', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Campaigns ─────────────────────────────────────────────────────────────────

router.get('/workspaces/:workspaceId/campaigns', async (req, res) => {
  try { res.json(await db.listCampaigns(req.params.workspaceId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/workspaces/:workspaceId/campaigns', async (req, res) => {
  try {
    const { subject_id, nom, type, numero_twilio, schedule_at } = req.body;
    if (!nom || !type) return res.status(400).json({ error: 'nom et type requis' });
    res.status(201).json(await db.createCampaign({
      workspace_id: req.params.workspaceId, subject_id, nom, type, numero_twilio, schedule_at
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/campaigns/:id', async (req, res) => {
  try { res.json(await db.getCampaign(req.params.id)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});

router.patch('/campaigns/:id/status', async (req, res) => {
  try {
    const { statut } = req.body;
    if (!statut) return res.status(400).json({ error: 'statut requis' });
    res.json(await db.updateCampaignStatus(req.params.id, statut));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Contacts ──────────────────────────────────────────────────────────────────

router.get('/campaigns/:campaignId/contacts', async (req, res) => {
  try {
    const statut = req.query.statut || 'en_attente';
    res.json(await db.getContactsByStatus(req.params.campaignId, statut));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Stats et transcripts ──────────────────────────────────────────────────────

router.get('/campaigns/:campaignId/stats', async (req, res) => {
  try {
    const calls = await db.getCallStats(req.params.campaignId);
    const stats = calls.reduce((acc, c) => {
      acc.total++;
      const key = c.resultat || 'inconnu';
      acc[key] = (acc[key] || 0) + 1;
      acc.duree_totale += c.duree_secondes || 0;
      return acc;
    }, { total: 0, duree_totale: 0 });
    res.json(stats);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/calls/:callId/transcripts', async (req, res) => {
  try { res.json(await db.getTranscripts(req.params.callId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Monitoring Dashboard ───────────────────────────────────────────────────────

router.get('/calls', async (req, res) => {
  try { res.json(await db.getCallsMonitoring(50)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/calls/:id', async (req, res) => {
  try { res.json(await db.getCallDetail(req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/stats', async (req, res) => {
  try { res.json(await db.getMonitoringStats()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
