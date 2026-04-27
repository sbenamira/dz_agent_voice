/**
 * Génère src/audio/greeting.ulaw via Gemini Live (voix Charon).
 * À lancer une seule fois : npm run generate-greeting
 */
require('dotenv').config();
const WebSocket = require('ws');
const fs        = require('fs');
const path      = require('path');
const { pcm24kToMulaw } = require('../src/services/gemini-live');

const GREETING_TEXT = 'أهلاً، تواصلوا بالفرنسية أو بالعربية';
const OUTPUT_PATH   = path.join(__dirname, '../src/audio/greeting.ulaw');
const WS_BASE       = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';
const model         = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';
const url           = `${WS_BASE}?key=${process.env.GOOGLE_API_KEY}`;

const ws         = new WebSocket(url);
const audioParts = [];
let   done       = false;

ws.on('open', () => {
  console.log('Connecté à Gemini Live...');
  ws.send(JSON.stringify({
    setup: {
      model: `models/${model}`,
      generation_config: {
        response_modalities: ['AUDIO'],
        speech_config: {
          voice_config: { prebuilt_voice_config: { voice_name: 'Charon' } }
        }
      },
      system_instruction: {
        parts: [{ text: 'Tu es une voix de synthèse. Prononce exactement le texte donné, sans aucun ajout ni modification.' }]
      }
    }
  }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.setupComplete) {
    console.log('Setup complet, envoi du texte...');
    ws.send(JSON.stringify({
      client_content: {
        turns: [{ role: 'user', parts: [{ text: GREETING_TEXT }] }],
        turn_complete: true
      }
    }));
  }

  if (msg.serverContent?.modelTurn?.parts) {
    for (const part of msg.serverContent.modelTurn.parts) {
      if (part.inlineData?.data) {
        audioParts.push(Buffer.from(part.inlineData.data, 'base64'));
      }
    }
  }

  if (msg.serverContent?.turnComplete && !done) {
    done = true;
    if (audioParts.length === 0) {
      console.error('Aucun audio reçu — vérifie GOOGLE_API_KEY et le modèle');
      ws.close();
      return;
    }
    const pcm   = Buffer.concat(audioParts);
    const mulaw = pcm24kToMulaw(pcm);
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, mulaw);
    console.log(`✓ Fichier sauvegardé : ${OUTPUT_PATH}`);
    console.log(`  Durée : ~${(mulaw.length / 8000).toFixed(1)}s — ${mulaw.length} octets`);
    ws.close();
  }
});

ws.on('error', err => {
  console.error('Erreur WebSocket :', err.message);
  process.exit(1);
});

ws.on('close', (code, reason) => {
  if (code !== 1000 && !done) {
    console.error(`Connexion fermée avec erreur ${code} : ${reason.toString()}`);
    console.error('Si erreur 1008 : essaie GEMINI_LIVE_MODEL=gemini-2.0-flash-live-001 dans .env');
    process.exit(1);
  }
});
