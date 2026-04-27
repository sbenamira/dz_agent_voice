/**
 * Génère src/audio/greeting.ulaw via Gemini Live (voix Charon).
 * À lancer une seule fois : npm run generate-greeting
 */
require('dotenv').config();
const WebSocket = require('ws');
const fs        = require('fs');
const path      = require('path');
const { pcm24kToMulaw, mulawToPcm16k } = require('../src/services/gemini-live');

const OUTPUT_PATH = path.join(__dirname, '../src/audio/greeting.ulaw');
const WS_BASE     = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';
const model       = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';
const url         = `${WS_BASE}?key=${process.env.GOOGLE_API_KEY}`;

const SYSTEM_PROMPT = `Tu es une voix de synthèse.
Dès que tu reçois un signal audio, prononce immédiatement et exactement cette phrase, sans aucun ajout :
"أهلاً، تواصلوا بالفرنسية أو بالعربية"
Ne dis rien d'autre.`;

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
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      realtime_input_config: {
        automatic_activity_detection: { disabled: false, silence_duration_ms: 300 }
      }
    }
  }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.setupComplete) {
    console.log('Setup complet, envoi du silence déclencheur...');
    // 500ms de silence PCM 16kHz pour déclencher la VAD
    const silence = Buffer.alloc(16000, 0);
    ws.send(JSON.stringify({
      realtime_input: {
        audio: { data: silence.toString('base64'), mime_type: 'audio/pcm;rate=16000' }
      }
    }));
  }

  if (msg.serverContent?.modelTurn?.parts) {
    for (const part of msg.serverContent.modelTurn.parts) {
      if (part.inlineData?.data) {
        audioParts.push(Buffer.from(part.inlineData.data, 'base64'));
        process.stdout.write('.');
      }
    }
  }

  if (msg.serverContent?.turnComplete && !done) {
    done = true;
    console.log('\nAudio reçu, conversion...');
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
    process.exit(1);
  }
});
