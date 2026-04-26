# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## CONTEXTE

Agent vocal IA pour le marché algérien (darija algérienne + français). Twilio reçoit l'appel et ouvre un WebSocket audio mulaw 8kHz vers ce serveur, qui pipe STT → LLM → TTS en streaming.

**Stack actuelle (2026-04) :**
- STT : Deepgram **nova-3**, `language=ar`, `encoding=mulaw`, `endpointing=150ms`
- LLM : Groq `llama-3.3-70b-versatile` (~400ms) — répond en JSON `{"speak":"...","display":"..."}`
- TTS : **ElevenLabs** `eleven_turbo_v2_5`, `output_format=ulaw_8000` (URL param + body). ElevenLabs retourne parfois `audio/mpeg` malgré le param → fallback ffmpeg MP3→mulaw automatique
- Fillers audio : `src/fillers.js` — 3 clips mulaw pré-générés au démarrage, joués avant le LLM pour masquer la latence
- Barge-in : interim Deepgram → event Twilio `clear` pour couper Karim
- DB : Supabase (PostgreSQL + pgvector)
- Hébergement : Render.com (deploy auto sur push `main`), ffmpeg disponible

## COMMANDES

```bash
npm start              # production
npm run dev            # nodemon watch
npm test               # jest --forceExit --detectOpenHandles
npm run test:coverage  # avec rapport coverage
npm run lint           # eslint src/
npx jest tests/stt.test.js --forceExit   # test unique
```

## ARCHITECTURE

### Pipeline d'un appel inbound

```
Twilio appelle → POST /inbound → TwiML WebSocket → /media-stream
WebSocket reçoit audio mulaw → Deepgram STT (streaming, endpointing 150ms)
is_final transcript → enqueueOrProcess() → handleTranscript()
  → filler audio immédiat → agent.streamResponse() → Groq LLM
  → speakText extrait du JSON → synthesizeStream() → ElevenLabs ulaw_8000
  → (si MP3 reçu → pipeMP3ToMulaw ffmpeg → mulaw)
  → chunks mulaw → sendAudio() → Twilio WebSocket
```

Fichier central : `src/routes/inbound.js` — gère tout le cycle de vie d'un appel via `setupMediaStream(server)`.

### Points d'architecture critiques

**`enqueueOrProcess` + `transcriptQueue`** (`inbound.js`) : les transcripts finaux STT ne sont jamais perdus. Si `isProcessing=true`, le transcript est mis en file dans `transcriptQueue`. Le bloc `finally` de `handleTranscript` dépile et traite le suivant. Log `[STT FINAL]` sur chaque transcript avec `sendingToLLM: 'oui'|'file'`.

**`isTTSPlaying`** (`inbound.js`) : flag mis à `true` uniquement pendant `synthesizeStream()` — pas pendant le filler, pas pendant l'appel LLM. Sert à : (1) couper l'envoi audio à Deepgram pendant que Karim parle (anti-écho), (2) n'envoyer l'event Twilio `clear` que si le TTS est réellement actif (barge-in). Renommé depuis `isKarimSpeaking`.

**Barge-in** (`inbound.js`) : `isBargingIn=true` + version counter `activeTurnId`. Interim transcript Deepgram → `ws.send({event:'clear', streamSid})`. Le tour suivant override `isProcessing` si `isBargingIn=true`. Le version counter empêche le `finally` d'un tour interrompu de remettre `isProcessing=false` après qu'un nouveau tour a démarré.

**TTS ElevenLabs** (`services/tts.js`) : requête vers `/stream?output_format=ulaw_8000`. Si `Content-Type: audio/mpeg` en réponse → `pipeMP3ToMulaw()` converti via ffmpeg. Sinon passthrough direct. Cache mulaw en mémoire (50 entrées max). Les `console.log` sont intentionnels pour diagnostic Render : `[TTS ElevenLabs] Content-Type: ..., premier_byte: 0x...`.

**Format JSON agent** (`services/agent.js`) : le LLM génère `{"speak":"...","display":"..."}`. `streamResponse` accumule le stream complet (pas de stop tokens — ils tronqueraient le JSON), parse, extrait `speak`, appelle `onChunk(speakText)` une seule fois.

**Deepgram session** (`services/stt.js`) : `createDeepgramSession(onTranscript, onError, onInterim)`. Le 3e paramètre `onInterim` déclenche le barge-in dans `inbound.js`. KeepAlive ping `{type:'KeepAlive'}` toutes les 5s. Max 3 reconnexions sur 1006.

**Fillers** (`src/fillers.js`) : `initFillers()` appelé en module-scope dans `inbound.js` (fire-and-forget). `getRandomFiller()` retourne `null` si pas encore prêt — `handleTranscript` vérifie avant d'appeler `sendAudio`.

**pendingCallers** (`inbound.js`) : Map `CallSid → numéro appelant` entre le POST webhook Twilio et l'ouverture du WebSocket `/media-stream`.

### Services

| Fichier | Rôle |
|---|---|
| `services/stt.js` | Session Deepgram WebSocket streaming, retourne `{send, close}` |
| `services/tts.js` | `synthesizeStream(text, onChunk)` ElevenLabs + fallback ffmpeg + cache mulaw |
| `services/agent.js` | `streamResponse({userMessage, history, onChunk})` Groq + parse JSON speak |
| `services/database.js` | CRUD Supabase : calls, transcripts, call_turns, monitoring |
| `services/rag.js` | Chunking + embeddings OpenAI + recherche pgvector |
| `services/campaign.js` | Campagnes outbound séquentielles |
| `services/telephony.js` | Client Twilio singleton + `generateTwiMLStream()` |

### Routes

| Route | Description |
|---|---|
| `POST /inbound` | Webhook Twilio → TwiML |
| `WS /media-stream` | Pipeline audio temps réel |
| `POST /outbound/start` | Lance campagne outbound |
| `POST /outbound/call` | Appel ad-hoc |
| `GET /dashboard` | Dashboard monitoring (Basic Auth optionnel) |
| `GET /test-call` | Test navigateur Twilio Client JS SDK v2 |
| `GET /test-outbound` | Test UI appel sortant |
| `GET /health` | Health check Render |
| `/api/*` | CRUD workspaces, subjects, campaigns, contacts |

### Base de données (monitoring)

La table `call_turns` (`sql/monitoring.sql`) stocke chaque tour avec `llm_duration_ms`, `tts_duration_ms`, `total_latency_ms`. Le dashboard lit via `GET /api/calls` et `GET /api/calls/:id`.

## VARIABLES D'ENVIRONNEMENT REQUISES

```
GROQ_API_KEY
TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER
DEEPGRAM_API_KEY
ELEVENLABS_API_KEY
ELEVENLABS_VOICE_ID
OPENAI_API_KEY          # embeddings RAG uniquement
SUPABASE_URL / SUPABASE_ANON_KEY
```

Optionnelles :
```
DASHBOARD_PASSWORD      # Basic Auth sur /dashboard (sans = accès libre)
TWILIO_API_KEY / TWILIO_API_SECRET / TWILIO_TWIML_APP_SID  # test-call navigateur
```

## RÈGLES DE DÉVELOPPEMENT

- Commenter le code **en français**
- `async/await` partout, `try/catch` sur chaque await
- Logs via `logger` (Winston) — exception : `tts.js` utilise `console.log` intentionnellement pour les diagnostics TTS visibles dans Render logs
- Tests dans `tests/` — mocker `@supabase/supabase-js`, `dotenv`, `child_process` (spawn/exec pour ffmpeg), et les services externes
- Tous les fichiers de test doivent définir `ELEVENLABS_API_KEY` et `ELEVENLABS_VOICE_ID` dans `process.env` (requis par `config.js validate()`)
- `ffmpeg` doit être disponible sur le serveur (présent sur Render, vérifié au démarrage via `[STARTUP] ffmpeg OK`)
- Prompts Karim dans `src/prompts/karim_darija.txt` — format JSON `{"speak":"...","display":"..."}`, 1-2 phrases, vocabulaire darija algérienne (pas marocain/tunisien : تاع pas ديال, درك pas دابا, بزاف pas برشا, مليح/لاباس pas مزيان)
