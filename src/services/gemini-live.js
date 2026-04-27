const WebSocket = require('ws');
const logger = require('../utils/logger');

const GEMINI_WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';

// ── Conversion audio ──────────────────────────────────────────────────────────

// Décode un octet mu-law 8-bit en sample PCM 16-bit signé
function mulawDecode(ulaw) {
  ulaw = ~ulaw & 0xFF;
  const sign = ulaw & 0x80;
  const exp  = (ulaw >> 4) & 0x07;
  const mant = ulaw & 0x0F;
  let s = ((mant << 1) | 0x21) << exp;
  s -= 33;
  return sign ? -s : s;
}

// Encode un sample PCM 16-bit signé en octet mu-law
function mulawEncode(sample) {
  const BIAS = 132;
  const CLIP = 32635;
  const sign = (sample < 0) ? 0x80 : 0;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exp = 7;
  for (let mask = 0x4000; exp > 0 && !(sample & mask); exp--, mask >>= 1);
  const mant = (sample >> (exp + 3)) & 0x0F;
  return (~(sign | (exp << 4) | mant)) & 0xFF;
}

// Buffer mulaw 8kHz → Buffer PCM 16-bit LE 16kHz (upsample ×2 par duplication)
function mulawToPcm16k(buf) {
  const out = Buffer.alloc(buf.length * 4); // 1 octet mulaw → 2 samples × 2 octets = 4
  for (let i = 0; i < buf.length; i++) {
    const s = mulawDecode(buf[i]);
    out.writeInt16LE(s, i * 4);
    out.writeInt16LE(s, i * 4 + 2);
  }
  return out;
}

// Buffer PCM 16-bit LE 24kHz → Buffer mulaw 8kHz (downsample ÷3 : garder 1 sample sur 3)
function pcm24kToMulaw(buf) {
  const sampleCount = Math.floor(buf.length / 2);
  const outCount = Math.floor(sampleCount / 3);
  const out = Buffer.alloc(outCount);
  for (let i = 0; i < outCount; i++) {
    const s = buf.readInt16LE(i * 6);
    out[i] = mulawEncode(s);
  }
  return out;
}

// ── Déclarations de fonctions pour Gemini ────────────────────────────────────

const FUNCTION_SCHEMAS = {
  confirm_order: {
    name: 'confirm_order',
    description: 'Enregistre la confirmation de la commande par le client.',
    parameters: {
      type: 'OBJECT',
      properties: {
        notes: { type: 'STRING', description: 'Notes optionnelles' }
      },
      required: []
    }
  },
  cancel_order: {
    name: 'cancel_order',
    description: "Enregistre le refus ou l'annulation de la commande par le client.",
    parameters: {
      type: 'OBJECT',
      properties: {
        reason: { type: 'STRING', description: 'Raison du refus' }
      },
      required: ['reason']
    }
  },
  request_human_callback: {
    name: 'request_human_callback',
    description: 'Le client souhaite parler à un agent humain.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reason: { type: 'STRING', description: 'Raison de la demande' }
      },
      required: []
    }
  }
};

// ── Session Gemini Live ───────────────────────────────────────────────────────

/**
 * Ouvre une session Gemini Live et bridge l'audio avec le WebSocket Twilio.
 *
 * Émet sur l'emitter courant :
 *   'gemini-audio'         Buffer mulaw 8kHz produit par Gemini
 *   'gemini-turn-complete' Gemini a fini de parler
 *   'gemini-interrupted'   Le client a coupé la parole
 *
 * Retourne { sendAudio(mulawBuf), close(), isReady(), rebind(newEmitter, newFnHandler, triggerNow) }
 */
function createGeminiLiveSession(wsClient, systemPrompt, functions, onFunctionCall, autoTrigger = false) {
  const apiKey = process.env.GOOGLE_API_KEY;
  const model  = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';
  const url    = `${GEMINI_WS_BASE}?key=${apiKey}`;

  const geminiWs = new WebSocket(url);
  let setupDone  = false;
  let closed     = false;
  let emitter    = wsClient;       // remplaçable via rebind()
  let fnHandler  = onFunctionCall; // remplaçable via rebind()

  function sendAutoTrigger() {
    logger.info('[GEMINI] autoTrigger envoyé');
    geminiWs.send(JSON.stringify({
      client_content: {
        turns: [{ role: 'user', parts: [{ text: 'Démarre la conversation.' }] }],
        turn_complete: true
      }
    }));
  }

  geminiWs.on('open', () => {
    logger.info('[GEMINI] Connexion établie', { model });

    const functionDeclarations = Object.keys(functions)
      .map(name => FUNCTION_SCHEMAS[name])
      .filter(Boolean);

    const setupMsg = {
      setup: {
        model: `models/${model}`,
        generation_config: {
          response_modalities: ['AUDIO']
        },
        system_instruction: {
          parts: [{ text: systemPrompt }]
        },
        tools: functionDeclarations.length > 0
          ? [{ function_declarations: functionDeclarations }]
          : []
      }
    };

    geminiWs.send(JSON.stringify(setupMsg));
  });

  geminiWs.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // Confirmation setup — Gemini prêt à recevoir de l'audio
      if (msg.setupComplete) {
        setupDone = true;
        logger.info('[GEMINI] Setup complet');
        if (autoTrigger) sendAutoTrigger();
        return;
      }

      // Audio produit par Gemini → PCM 24kHz → mulaw 8kHz → émettre vers Twilio
      if (msg.serverContent?.modelTurn?.parts) {
        for (const part of msg.serverContent.modelTurn.parts) {
          if (part.inlineData?.data) {
            const pcm   = Buffer.from(part.inlineData.data, 'base64');
            const mulaw = pcm24kToMulaw(pcm);
            if (mulaw.length > 0) {
              emitter.emit('gemini-audio', mulaw);
            }
          }
        }
      }

      // Fin de tour Gemini
      if (msg.serverContent?.turnComplete) {
        logger.info('[GEMINI] Tour terminé');
        emitter.emit('gemini-turn-complete');
      }

      // Interruption par le client
      if (msg.serverContent?.interrupted) {
        logger.info('[GEMINI] Interrompu par client');
        emitter.emit('gemini-interrupted');
      }

      // Function calling : exécuter le handler et renvoyer le résultat à Gemini
      if (msg.toolCall?.functionCalls?.length > 0) {
        for (const call of msg.toolCall.functionCalls) {
          logger.info('[GEMINI] Function call', { name: call.name });
          let result = { success: false };
          try {
            result = await fnHandler(call.name, call.args || {});
          } catch (err) {
            logger.error('[GEMINI] Erreur function call', { name: call.name, error: err.message });
          }
          geminiWs.send(JSON.stringify({
            toolResponse: {
              functionResponses: [{ id: call.id, response: { output: result } }]
            }
          }));
        }
      }
    } catch (err) {
      logger.error('[GEMINI] Erreur parsing message', { error: err.message });
    }
  });

  geminiWs.on('error', err => {
    logger.error('[GEMINI] Erreur WebSocket', { error: err.message });
  });

  geminiWs.on('close', (code, reason) => {
    logger.info('[GEMINI] WebSocket fermé', { code, reason: reason.toString() });
    closed = true;
  });

  // Envoie l'audio Twilio (mulaw 8kHz) vers Gemini (PCM 16kHz)
  function sendAudio(mulawBuf) {
    if (!setupDone || geminiWs.readyState !== WebSocket.OPEN) return;
    const pcm = mulawToPcm16k(mulawBuf);
    geminiWs.send(JSON.stringify({
      realtime_input: {
        audio: {
          data: pcm.toString('base64'),
          mime_type: 'audio/pcm;rate=16000'
        }
      }
    }));
  }

  function close() {
    closed = true;
    if (geminiWs.readyState === WebSocket.OPEN || geminiWs.readyState === WebSocket.CONNECTING) {
      geminiWs.close();
    }
  }

  // Rebrancher l'émetteur et le handler (pré-chauffe → vrai wsClient Twilio)
  function rebind(newEmitter, newFnHandler, triggerNow = false) {
    emitter = newEmitter;
    if (newFnHandler) fnHandler = newFnHandler;
    if (triggerNow) {
      if (setupDone) {
        sendAutoTrigger();
      } else {
        autoTrigger = true; // déclenchera au prochain setupComplete
      }
    }
  }

  return { sendAudio, close, isReady: () => setupDone, rebind };
}

module.exports = { createGeminiLiveSession, mulawToPcm16k, pcm24kToMulaw };
