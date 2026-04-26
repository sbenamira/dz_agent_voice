const fs = require('fs');
const path = require('path');
const Groq = require('groq-sdk');
const config = require('../config');
const logger = require('../utils/logger');
const rag = require('./rag');
const db = require('./database');

const groq = new Groq({ apiKey: config.groq.apiKey });

const promptDarija = fs.readFileSync(path.join(__dirname, '../prompts/karim_darija.txt'), 'utf8');
const promptFr = fs.readFileSync(path.join(__dirname, '../prompts/karim_fr.txt'), 'utf8');
const promptOutbound = fs.readFileSync(path.join(__dirname, '../prompts/karim_outbound.txt'), 'utf8');

function isArabic(text) {
  const arabicChars = (text.match(/[؀-ۿ]/g) || []).length;
  return arabicChars > text.length * 0.2;
}

function selectPrompt(text) {
  return isArabic(text) ? promptDarija : promptFr;
}

// Stream une réponse Groq (llama-3.3-70b) et appelle onChunk pour chaque fragment
// langue : 'ar'|'fr' verrouillé au premier tour par inbound.js (null = détection auto)
async function streamResponse({ callId, subjectId, userMessage, history = [], langue = null, onChunk }) {
  try {
    const langueDetectee = langue || (isArabic(userMessage) ? 'ar' : 'fr');

    await db.insertTranscript({ call_id: callId, role: 'client', message: userMessage, langue: langueDetectee });

    // RAG désactivé — infos produit directement dans karim_darija.txt
    // const effectiveSubjectId = subjectId || process.env.DEFAULT_SUBJECT_ID || null;
    // if (effectiveSubjectId) { ragContext = await rag.searchContext(effectiveSubjectId, userMessage); }
    let ragContext = '';
    logger.info('[RAG]', { disabled: true });

    const REMINDER = '\n\nIMPORTANT: Réponds UNIQUEMENT avec le JSON demandé, sans texte avant ou après. Exemple: {"speak":"واش تحب؟","display":"واش تحب؟"}';
    const systemPrompt = (langueDetectee === 'ar' ? promptDarija : promptFr) + REMINDER +
      (ragContext ? `\n\nInformations disponibles :\n${ragContext}` : '');

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-6).map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: userMessage }
    ];

    const stream = await groq.chat.completions.create({
      model: config.groq.model,
      messages,
      max_tokens: 120,
      temperature: 0.3,
      stream: true
      // Pas de stop tokens — évite de tronquer le JSON avant la fermeture d'accolade
    });

    let fullResponse = '';
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) fullResponse += text;
    }

    // Extraire le texte parlé du JSON ; fallback sur la réponse brute
    let speakText = fullResponse.trim();
    try {
      const parsed = JSON.parse(fullResponse.trim());
      if (parsed && parsed.speak) speakText = parsed.speak.trim();
    } catch (_) {}

    if (onChunk) onChunk(speakText);

    await db.insertTranscript({ call_id: callId, role: 'agent', message: speakText, langue: langueDetectee });

    logger.info('Réponse agent générée', { callId, langue: langueDetectee, chars: speakText.length });
    return speakText;
  } catch (err) {
    logger.error('streamResponse', { error: err.message, callId });
    throw err;
  }
}

// Appels outbound — confirmation de commande avec contexte produit injecté dans le prompt
async function streamOutboundResponse({ callId, productName, price, address, deliveryDelay, userMessage, history = [], onChunk }) {
  try {
    await db.insertTranscript({ call_id: callId, role: 'client', message: userMessage, langue: 'ar' });

    const REMINDER = '\n\nIMPORTANT: Réponds UNIQUEMENT avec le JSON demandé, sans texte avant ou après. Exemple: {"speak":"واكاش سيدي","display":"واكاش سيدي"}';
    const systemPrompt = promptOutbound
      .replace(/{productName}/g, productName || '')
      .replace(/{price}/g, price || '')
      .replace(/{address}/g, address || '')
      .replace(/{deliveryDelay}/g, deliveryDelay || '')
      + REMINDER;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-6).map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: userMessage }
    ];

    const stream = await groq.chat.completions.create({
      model: config.groq.model,
      messages,
      max_tokens: 120,
      temperature: 0.3,
      stream: true
    });

    let fullResponse = '';
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) fullResponse += text;
    }

    let speakText = fullResponse.trim();
    try {
      const parsed = JSON.parse(fullResponse.trim());
      if (parsed && parsed.speak) speakText = parsed.speak.trim();
    } catch (_) {}

    if (onChunk) onChunk(speakText);

    await db.insertTranscript({ call_id: callId, role: 'agent', message: speakText, langue: 'ar' });
    logger.info('Réponse outbound générée', { callId, chars: speakText.length });
    return speakText;
  } catch (err) {
    logger.error('streamOutboundResponse', { error: err.message, callId });
    throw err;
  }
}

module.exports = { streamResponse, streamOutboundResponse, isArabic, selectPrompt };
