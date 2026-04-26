const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');

const supabase = createClient(config.supabase.url, config.supabase.anonKey);

// ── Workspaces ────────────────────────────────────────────────────────────────

async function createWorkspace({ nom, email }) {
  try {
    const { data, error } = await supabase
      .from('workspaces').insert({ nom, email }).select().single();
    if (error) throw error;
    return data;
  } catch (err) {
    logger.error('createWorkspace', { error: err.message });
    throw err;
  }
}

async function getWorkspace(id) {
  try {
    const { data, error } = await supabase
      .from('workspaces').select('*').eq('id', id).single();
    if (error) throw error;
    return data;
  } catch (err) {
    logger.error('getWorkspace', { error: err.message });
    throw err;
  }
}

async function listWorkspaces() {
  try {
    const { data, error } = await supabase
      .from('workspaces').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  } catch (err) {
    logger.error('listWorkspaces', { error: err.message });
    throw err;
  }
}

// ── Subjects ──────────────────────────────────────────────────────────────────

async function createSubject({ workspace_id, nom, langue = 'auto', voice_id_darija, voice_id_fr, script_accueil, script_conclusion }) {
  try {
    const { data, error } = await supabase
      .from('subjects').insert({ workspace_id, nom, langue, voice_id_darija, voice_id_fr, script_accueil, script_conclusion }).select().single();
    if (error) throw error;
    return data;
  } catch (err) {
    logger.error('createSubject', { error: err.message });
    throw err;
  }
}

async function getSubject(id) {
  try {
    const { data, error } = await supabase
      .from('subjects').select('*').eq('id', id).single();
    if (error) throw error;
    return data;
  } catch (err) {
    logger.error('getSubject', { error: err.message });
    throw err;
  }
}

async function listSubjects(workspace_id) {
  try {
    const { data, error } = await supabase
      .from('subjects').select('*').eq('workspace_id', workspace_id).order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  } catch (err) {
    logger.error('listSubjects', { error: err.message });
    throw err;
  }
}

async function updateSubject(id, updates) {
  try {
    const { data, error } = await supabase
      .from('subjects').update(updates).eq('id', id).select().single();
    if (error) throw error;
    return data;
  } catch (err) {
    logger.error('updateSubject', { error: err.message });
    throw err;
  }
}

// ── Subject Documents (RAG) ───────────────────────────────────────────────────

async function insertDocument({ subject_id, fichier_nom, fichier_type, contenu_chunk, embedding }) {
  try {
    const { data, error } = await supabase
      .from('subject_documents').insert({ subject_id, fichier_nom, fichier_type, contenu_chunk, embedding }).select().single();
    if (error) throw error;
    return data;
  } catch (err) {
    logger.error('insertDocument', { error: err.message });
    throw err;
  }
}

async function searchDocuments(subject_id, queryEmbedding, topK = 3) {
  try {
    const { data, error } = await supabase.rpc('match_documents', {
      p_subject_id: subject_id,
      query_embedding: queryEmbedding,
      match_count: topK
    });
    if (error) throw error;
    return data || [];
  } catch (err) {
    logger.error('searchDocuments', { error: err.message });
    throw err;
  }
}

async function deleteDocumentsBySubject(subject_id) {
  try {
    const { error } = await supabase
      .from('subject_documents').delete().eq('subject_id', subject_id);
    if (error) throw error;
  } catch (err) {
    logger.error('deleteDocumentsBySubject', { error: err.message });
    throw err;
  }
}

// ── Campaigns ─────────────────────────────────────────────────────────────────

async function createCampaign({ workspace_id, subject_id, nom, type, numero_twilio, schedule_at }) {
  try {
    const { data, error } = await supabase
      .from('campaigns').insert({ workspace_id, subject_id, nom, type, numero_twilio, schedule_at }).select().single();
    if (error) throw error;
    return data;
  } catch (err) {
    logger.error('createCampaign', { error: err.message });
    throw err;
  }
}

async function getCampaign(id) {
  try {
    const { data, error } = await supabase
      .from('campaigns').select('*, subjects(*)').eq('id', id).single();
    if (error) throw error;
    return data;
  } catch (err) {
    logger.error('getCampaign', { error: err.message });
    throw err;
  }
}

async function updateCampaignStatus(id, statut) {
  try {
    const { data, error } = await supabase
      .from('campaigns').update({ statut }).eq('id', id).select().single();
    if (error) throw error;
    return data;
  } catch (err) {
    logger.error('updateCampaignStatus', { error: err.message });
    throw err;
  }
}

async function listCampaigns(workspace_id) {
  try {
    const { data, error } = await supabase
      .from('campaigns').select('*').eq('workspace_id', workspace_id).order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  } catch (err) {
    logger.error('listCampaigns', { error: err.message });
    throw err;
  }
}

// ── Contact Lists ─────────────────────────────────────────────────────────────

async function insertContacts(contacts) {
  try {
    const { data, error } = await supabase
      .from('contact_lists').insert(contacts).select();
    if (error) throw error;
    return data;
  } catch (err) {
    logger.error('insertContacts', { error: err.message });
    throw err;
  }
}

async function getContactsByStatus(campaign_id, statut = 'en_attente') {
  try {
    const { data, error } = await supabase
      .from('contact_lists').select('*').eq('campaign_id', campaign_id).eq('statut', statut);
    if (error) throw error;
    return data || [];
  } catch (err) {
    logger.error('getContactsByStatus', { error: err.message });
    throw err;
  }
}

async function updateContactStatus(id, statut) {
  try {
    const { error } = await supabase
      .from('contact_lists').update({ statut }).eq('id', id);
    if (error) throw error;
  } catch (err) {
    logger.error('updateContactStatus', { error: err.message });
    throw err;
  }
}

// ── Calls ─────────────────────────────────────────────────────────────────────

async function createCall({ campaign_id, contact_id, direction }) {
  try {
    const { data, error } = await supabase
      .from('calls').insert({ campaign_id, contact_id, direction }).select().single();
    if (error) throw error;
    return data;
  } catch (err) {
    logger.error('createCall', { error: err.message });
    throw err;
  }
}

async function updateCall(id, { statut, duree_secondes, resultat }) {
  try {
    const updates = {};
    if (statut !== undefined) updates.statut = statut;
    if (duree_secondes !== undefined) updates.duree_secondes = duree_secondes;
    if (resultat !== undefined) updates.resultat = resultat;
    const { data, error } = await supabase
      .from('calls').update(updates).eq('id', id).select().single();
    if (error) throw error;
    return data;
  } catch (err) {
    logger.error('updateCall', { error: err.message });
    throw err;
  }
}

async function getCallStats(campaign_id) {
  try {
    const { data, error } = await supabase
      .from('calls').select('statut, resultat, duree_secondes').eq('campaign_id', campaign_id);
    if (error) throw error;
    return data || [];
  } catch (err) {
    logger.error('getCallStats', { error: err.message });
    throw err;
  }
}

// ── Transcripts ───────────────────────────────────────────────────────────────

async function insertTranscript({ call_id, role, message, langue }) {
  try {
    const { data, error } = await supabase
      .from('transcripts').insert({ call_id, role, message, langue }).select().single();
    if (error) throw error;
    return data;
  } catch (err) {
    logger.error('insertTranscript', { error: err.message });
    throw err;
  }
}

async function getTranscripts(call_id) {
  try {
    const { data, error } = await supabase
      .from('transcripts').select('*').eq('call_id', call_id).order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
  } catch (err) {
    logger.error('getTranscripts', { error: err.message });
    throw err;
  }
}

// ── Monitoring ────────────────────────────────────────────────────────────────

async function insertCallTurn(data) {
  try {
    const { data: row, error } = await supabase
      .from('call_turns').insert(data).select().single();
    if (error) throw error;
    return row;
  } catch (err) {
    logger.error('insertCallTurn', { error: err.message });
    throw err;
  }
}

async function updateCallMonitoring(id, updates) {
  try {
    const { data, error } = await supabase
      .from('calls').update(updates).eq('id', id).select().single();
    if (error) throw error;
    return data;
  } catch (err) {
    logger.error('updateCallMonitoring', { error: err.message });
    throw err;
  }
}

async function getCallsMonitoring(limit = 50) {
  try {
    const { data, error } = await supabase
      .from('calls')
      .select('id, created_at, caller_number, statut, duree_secondes, turns, avg_llm_ms, avg_tts_ms, avg_total_ms')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  } catch (err) {
    logger.error('getCallsMonitoring', { error: err.message });
    throw err;
  }
}

async function getCallDetail(id) {
  try {
    const [{ data: call, error: callErr }, { data: turns, error: turnsErr }] = await Promise.all([
      supabase.from('calls').select('*').eq('id', id).single(),
      supabase.from('call_turns').select('*').eq('call_id', id).order('turn_number', { ascending: true })
    ]);
    if (callErr) throw callErr;
    if (turnsErr) logger.warn('getCallDetail turns', { error: turnsErr.message });
    return { ...call, turns_detail: turns || [] };
  } catch (err) {
    logger.error('getCallDetail', { error: err.message });
    throw err;
  }
}

async function getMonitoringStats() {
  try {
    const { data, error } = await supabase
      .from('calls')
      .select('avg_llm_ms, avg_tts_ms, avg_total_ms, statut, created_at')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    const rows = data || [];
    const valid = rows.filter(c => c.avg_total_ms);
    const avg = key => valid.length
      ? Math.round(valid.reduce((s, c) => s + (c[key] || 0), 0) / valid.length) : 0;
    const today = new Date().toISOString().slice(0, 10);
    return {
      avg_llm_ms: avg('avg_llm_ms'),
      avg_tts_ms: avg('avg_tts_ms'),
      avg_total_ms: avg('avg_total_ms'),
      calls_today: rows.filter(c => c.created_at?.startsWith(today)).length,
      total_calls: rows.length
    };
  } catch (err) {
    logger.error('getMonitoringStats', { error: err.message });
    throw err;
  }
}

// Met à jour le statut métier d'un appel outbound (utilise l'id DB, pas le callSid Twilio)
async function updateCallStatus(callId, status) {
  try {
    const { data, error } = await supabase
      .from('calls').update({ resultat: status }).eq('id', callId).select().single();
    if (error) throw error;
    return data;
  } catch (err) {
    logger.error('updateCallStatus', { error: err.message });
    throw err;
  }
}

module.exports = {
  createWorkspace, getWorkspace, listWorkspaces,
  createSubject, getSubject, listSubjects, updateSubject,
  insertDocument, searchDocuments, deleteDocumentsBySubject,
  createCampaign, getCampaign, updateCampaignStatus, listCampaigns,
  insertContacts, getContactsByStatus, updateContactStatus,
  createCall, updateCall, getCallStats,
  insertTranscript, getTranscripts,
  insertCallTurn, updateCallMonitoring, getCallsMonitoring, getCallDetail, getMonitoringStats,
  updateCallStatus,
  supabase
};
