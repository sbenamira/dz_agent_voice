# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## CONTEXTE

Agent vocal IA pour le marché algérien (darija algérienne + français). Twilio reçoit l'appel et ouvre un WebSocket audio mulaw 8kHz vers ce serveur, qui pipe STT → LLM → TTS en streaming.

**Stack actuelle (2026-04) :**
- STT : Deepgram **nova-3**, `language=ar`, `encoding=mulaw`, `endpointing=150ms` ✅
- LLM : Groq `llama-3.3-70b-versatile` (~400ms) — répond en JSON `{"speak":"...","display":"..."}`
- TTS : Microsoft Edge TTS `ar-DZ-IsmaelNeural` via `msedge-tts` + ffmpeg pipe → mulaw streaming ✅
- Fillers audio : `src/fillers.js` — 3 clips pré-générés au démarrage, joués avant le LLM ✅
- Barge-in : interim Deepgram → event Twilio `clear` pour couper Karim ✅
- DB : Supabase (PostgreSQL + pgvector)
- Hébergement : Render.com (deploy auto sur push `main`)

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
WebSocket reçoit audio mulaw → Deepgram STT (streaming)
Transcript → agent.streamResponse() → Groq LLM (streaming)
Chunks LLM → synthesizeStream() → ffmpeg pipe → mulaw chunks → Twilio
```

Fichier central : `src/routes/inbound.js` — gère tout le cycle de vie d'un appel via `setupMediaStream(server)`.

### Points d'architecture critiques

**isKarimSpeaking** (`inbound.js`) : flag booléen qui coupe l'envoi audio à Deepgram pendant que Karim parle, pour éviter que le TTS soit re-transcrit. `track:'inbound_track'` dans le TwiML fait la même chose côté Twilio.

**TTS streaming** (`services/tts.js`) : `synthesizeStream(text, onChunk)` pipe msedge-tts → ffmpeg avec `-fflags nobuffer` pour envoyer le premier chunk mulaw sans attendre la fin de la synthèse.

**Deepgram KeepAlive** (`services/stt.js`) : ping JSON `{type:'KeepAlive'}` toutes les 5s. Max 3 reconnexions sur 1006. Nova-3 + `language=ar` fonctionne (nova-2 + `language=ar` donnait 1006).

**Fillers** (`src/fillers.js`) : `initFillers()` appelé au chargement du module `inbound.js`. `getRandomFiller()` retourne un Buffer mulaw aléatoire ou `null` si pas encore prêt.

**Barge-in** (`inbound.js`) : flag `isBargingIn` + version counter `activeTurnId`. Interim transcript → `ws.send({event:'clear', streamSid})`. Le tour suivant force `isProcessing=false` si `isBargingIn=true`.

**Format JSON agent** (`services/agent.js`) : le LLM répond `{"speak":"...","display":"..."}`. `streamResponse` parse le JSON, extrait `speak`, appelle `onChunk(speakText)` une seule fois après le stream complet (pas de stop tokens).

**pendingCallers** (`inbound.js`) : Map `CallSid → numéro appelant` entre le POST Twilio et l'ouverture du WebSocket.

**conversationHistory** : tableau limité à 20 messages, `.slice(-6)` envoyé au LLM.

### Services

| Fichier | Rôle |
|---|---|
| `services/stt.js` | Session Deepgram WebSocket, retourne `{send, close}` |
| `services/tts.js` | `synthesizeStream(text, onChunk)` + cache mulaw |
| `services/agent.js` | `streamResponse({userMessage, history, onChunk})` via Groq |
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

La table `call_turns` (migration `sql/monitoring.sql`) stocke chaque tour de conversation avec `llm_duration_ms`, `tts_duration_ms`, `total_latency_ms`. Le dashboard lit via `GET /api/calls` et `GET /api/calls/:id`.

## VARIABLES D'ENVIRONNEMENT REQUISES

```
GROQ_API_KEY
TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER
DEEPGRAM_API_KEY
OPENAI_API_KEY          # embeddings RAG uniquement
SUPABASE_URL / SUPABASE_ANON_KEY
```

Optionnelles :
```
DASHBOARD_PASSWORD      # Basic Auth sur /dashboard (sans clé = accès libre)
TWILIO_API_KEY / TWILIO_API_SECRET / TWILIO_TWIML_APP_SID  # test-call navigateur
```

## RÈGLES DE DÉVELOPPEMENT

- Commenter le code **en français**
- `async/await` partout, `try/catch` sur chaque await
- Logs via `logger` (Winston) — jamais `console.log`
- Tests dans `tests/` — mocker `@supabase/supabase-js`, `dotenv`, et les services externes
- `ffmpeg` doit être disponible sur le serveur (présent sur Render)
- Prompts Karim dans `src/prompts/karim_darija.txt` et `karim_fr.txt` — réponses 2-3 phrases max, jamais de bullet points
