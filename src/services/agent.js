const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const logger = require('../utils/logger');
const rag = require('./rag');
const db = require('./database');

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

const promptDarija = fs.readFileSync(path.join(__dirname, '../prompts/karim_darija.txt'), 'utf8');
const promptFr = fs.readFileSync(path.join(__dirname, '../prompts/karim_fr.txt'), 'utf8');

// Détecte si le texte est majoritairement en arabe (darija)
function isArabic(text) {
  const arabicChars = (text.match(/[؀-ۿ]/g) || []).length;
  return arabicChars > text.length * 0.2;
}

// Sélectionne le prompt selon la langue détectée
function selectPrompt(text) {
  return isArabic(text) ? promptDarija : promptFr;
}

// Stream une réponse Claude Haiku et appelle onChunk pour chaque fragment
async function streamResponse({ callId, subjectId, userMessage, history = [], onChunk }) {
  try {
    const langue = isArabic(userMessage) ? 'ar' : 'fr';

    await db.insertTranscript({ call_id: callId, role: 'client', message: userMessage, langue });

    let ragContext = '';
    if (subjectId) {
      ragContext = await rag.searchContext(subjectId, userMessage);
    }

    const systemPrompt = selectPrompt(userMessage) +
      (ragContext ? `\n\n## CONTEXTE DISPONIBLE\n${ragContext}` : '');

    const messages = [
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: userMessage }
    ];

    let fullResponse = '';

    const stream = await anthropic.messages.stream({
      model: config.anthropic.model,
      max_tokens: 300,
      system: systemPrompt,
      messages
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const chunk = event.delta.text;
        fullResponse += chunk;
        if (onChunk) onChunk(chunk);
      }
    }

    await db.insertTranscript({ call_id: callId, role: 'agent', message: fullResponse, langue });

    logger.info('Réponse agent générée', { callId, langue, chars: fullResponse.length });
    return fullResponse;
  } catch (err) {
    logger.error('streamResponse', { error: err.message, callId });
    throw err;
  }
}

module.exports = { streamResponse, isArabic, selectPrompt };
