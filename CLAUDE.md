# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## CONTEXTE

Agent vocal IA pour le marché algérien (darija algérienne + français). Twilio reçoit l'appel et ouvre un WebSocket audio mulaw 8kHz vers ce serveur, qui pipe STT → LLM → TTS en streaming.

**Stack actuelle (2026-04) :**
- STT : Deepgram **nova-3**, `language=ar`, `encoding=mulaw`, `endpointing=500ms`, `utterance_end_ms=1500`
- LLM : Groq `llama-3.3-70b-versatile` (~400ms) — répond en JSON `{"speak":"...","display":"..."}`
- TTS : **ElevenLabs** `eleven_turbo_v2_5`, `output_format=ulaw_8000` (URL param + body), `speaking_rate` à la **racine** du JSON (pas dans `voice_settings` — ignoré sinon). ElevenLabs retourne parfois `audio/mpeg` → fallback ffmpeg MP3→mulaw automatique
- Fillers audio : `src/fillers.js` — 3 clips mulaw pré-générés au démarrage, joués avant le LLM pour masquer la latence
- Barge-in : uniquement sur `speech_final=true` Deepgram + délai minimum 1s → event Twilio `clear`
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
node scripts/seed-knowledge.js --check   # compter les chunks RAG en base
node scripts/seed-knowledge.js           # insérer les chunks de test
```

## ARCHITECTURE

### Pipeline d'un appel inbound

```
Twilio appelle → POST /inbound → TwiML WebSocket → /media-stream
WebSocket reçoit audio mulaw → Deepgram STT (streaming, endpointing 500ms)
is_final transcript → enqueueOrProcess() → handleTranscript()
  → filler audio immédiat → agent.streamResponse() → Groq LLM
  → speakText extrait du JSON → nettoyerTexte() → synthesizeStream() → ElevenLabs ulaw_8000
  → (si MP3 reçu → pipeMP3ToMulaw ffmpeg → mulaw)
  → chunks mulaw → sendAudio() → Twilio WebSocket
```

Fichier central : `src/routes/inbound.js` — gère tout le cycle de vie d'un appel via `setupMediaStream(server)`.

### Points d'architecture critiques

**`enqueueOrProcess` + `transcriptQueue`** (`inbound.js`) : les transcripts finaux STT ne sont jamais perdus. Si `isProcessing=true`, le transcript est mis en file dans `transcriptQueue`. Le bloc `finally` de `handleTranscript` dépile et traite le suivant. Log `[STT FINAL]` sur chaque transcript avec `sendingToLLM: 'oui'|'file'`.

**`isTTSPlaying` + `ttsStartTime`** (`inbound.js`) : `isTTSPlaying` mis à `true` uniquement pendant `synthesizeStream()` — pas pendant le filler, pas pendant l'appel LLM. `ttsStartTime = Date.now()` enregistré à chaque début de TTS. Sert à : (1) bloquer l'envoi audio à Deepgram pendant que Karim parle (anti-écho), (2) enforcer le délai minimum de 1s avant barge-in.

**Barge-in** (`inbound.js`) : déclenché uniquement quand `speechFinal === true` sur le callback `onTranscript` (pas sur les interims). Condition : `speechFinal && isTTSPlaying && !isBargingIn && (Date.now() - ttsStartTime) > 1000`. Le version counter `activeTurnId` empêche le `finally` d'un tour interrompu de remettre `isProcessing=false` après qu'un nouveau tour a démarré.

**TTS ElevenLabs** (`services/tts.js`) :
- `nettoyerTexte(text)` supprime les fillers vocaux (واه/آه/مم etc.) avant tout envoi à ElevenLabs
- `speaking_rate` doit être à la **racine** du body JSON, pas dans `voice_settings`
- Si `Content-Type: audio/mpeg` → `pipeMP3ToMulaw()` via ffmpeg ; sinon passthrough direct
- Cache mulaw en mémoire (50 entrées max). Les `console.log` sont intentionnels pour diagnostic Render

**Format JSON agent** (`services/agent.js`) : le LLM génère `{"speak":"...","display":"..."}`. `streamResponse` accumule le stream complet sans stop tokens (évite de tronquer le JSON), parse, extrait `speak`, appelle `onChunk(speakText)` une seule fois.

**RAG** (`services/agent.js`) : actuellement **désactivé** — `rag.searchContext()` commenté, `ragContext=''`. Les infos produit (TCF Canada, prix, livraison) sont directement dans `src/prompts/karim_darija.txt`. Pour réactiver : décommenter les 2 lignes dans `streamResponse()` et définir `DEFAULT_SUBJECT_ID`. Seed via `scripts/seed-knowledge.js`.

**Deepgram session** (`services/stt.js`) : `createDeepgramSession(onTranscript, onError)` — 2 paramètres. `onTranscript(transcript, speechFinal)` passe le flag `speech_final` en 2e argument, utilisé par `inbound.js` pour le barge-in. KeepAlive toutes les 5s. Max 3 reconnexions sur 1006.

**Fillers** (`src/fillers.js`) : `initFillers()` appelé en module-scope dans `inbound.js` (fire-and-forget). `getRandomFiller()` retourne `null` si pas encore prêt — `handleTranscript` vérifie avant d'appeler `sendAudio`.

**pendingCallers** (`inbound.js`) : Map `CallSid → numéro appelant` entre le POST webhook Twilio et l'ouverture du WebSocket `/media-stream`.

### Services

| Fichier | Rôle |
|---|---|
| `services/stt.js` | Session Deepgram WebSocket streaming, retourne `{send, close}` |
| `services/tts.js` | `synthesizeStream(text, onChunk)` — filtre fillers + ElevenLabs + fallback ffmpeg + cache mulaw |
| `services/agent.js` | `streamResponse({userMessage, history, onChunk})` Groq + parse JSON speak |
| `services/database.js` | CRUD Supabase : calls, transcripts, call_turns, monitoring |
| `services/rag.js` | Chunking + embeddings OpenAI + recherche pgvector (désactivé en prod actuellement) |
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

La table `call_turns` stocke chaque tour avec `llm_duration_ms`, `tts_duration_ms`, `total_latency_ms`. Le dashboard lit via `GET /api/calls` et `GET /api/calls/:id`.

## VARIABLES D'ENVIRONNEMENT REQUISES

```
GROQ_API_KEY
TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER
DEEPGRAM_API_KEY
ELEVENLABS_API_KEY
ELEVENLABS_VOICE_ID
OPENAI_API_KEY          # embeddings RAG uniquement (inutile si RAG désactivé)
SUPABASE_URL / SUPABASE_ANON_KEY
```

Optionnelles :
```
TTS_SPEED=0.7           # speaking_rate ElevenLabs (1.0=normal, 0.7=ralenti) — défaut 0.7
DEFAULT_SUBJECT_ID=     # subject_id RAG pour appels inbound (requis si RAG réactivé)
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
- Prompts Karim dans `src/prompts/karim_darija.txt` — format JSON `{"speak":"...","display":"..."}`, 1-2 phrases, darija algérienne (تاع pas ديال, درك pas دابا, بزاف pas برشا, مليح/لاباس pas مزيان). Infos produit TCF Canada incluses directement dans le prompt (RAG désactivé)
- `onTranscript` dans `stt.js` a la signature `(transcript, speechFinal)` — ne pas modifier sans mettre à jour `inbound.js` et `tests/stt.test.js`
