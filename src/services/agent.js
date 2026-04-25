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

    let ragContext = '';
    if (subjectId) {
      ragContext = await rag.searchContext(subjectId, userMessage);
    }

    const REMINDER = '\n\nIMPORTANT: Si tu ne sais pas quoi dire, réponds UNIQUEMENT: "واش تحب؟" Jamais de mot inventé. Jamais d\'arabe standard.';
    const systemPrompt = (langueDetectee === 'ar' ? promptDarija : promptFr) + REMINDER +
      (ragContext ? `\n\n## CONTEXTE DISPONIBLE\n${ragContext}` : '');

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
      stop: ['.', '؟', '!', '،\n'],
      stream: true
    });

    let fullResponse = '';
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) {
        fullResponse += text;
        if (onChunk) onChunk(text);
      }
    }

    await db.insertTranscript({ call_id: callId, role: 'agent', message: fullResponse, langue: langueDetectee });

    logger.info('Réponse agent générée', { callId, langue: langueDetectee, chars: fullResponse.length });
    return fullResponse;
  } catch (err) {
    logger.error('streamResponse', { error: err.message, callId });
    throw err;
  }
}

module.exports = { streamResponse, isArabic, selectPrompt };
