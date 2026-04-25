const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');
const logger = require('../utils/logger');
const rag = require('./rag');
const db = require('./database');

const genAI = new GoogleGenerativeAI(config.google.apiKey);

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

// Stream une réponse Gemini 2.5 Flash et appelle onChunk pour chaque fragment
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

    const model = genAI.getGenerativeModel({
      model: config.google.model,
      systemInstruction: systemPrompt,
      generationConfig: { maxOutputTokens: 300 }
    });

    // Convertir l'historique : 'assistant' → 'model' pour l'API Gemini
    const geminiHistory = history.map(h => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }]
    }));

    const chat = model.startChat({ history: geminiHistory });
    const result = await chat.sendMessageStream(userMessage);

    let fullResponse = '';
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        fullResponse += text;
        if (onChunk) onChunk(text);
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
