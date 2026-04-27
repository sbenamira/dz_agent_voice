# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## CONTEXTE

Agent vocal IA pour le marché algérien (darija algérienne + français). Twilio reçoit l'appel et ouvre un WebSocket audio mulaw 8kHz vers ce serveur, qui pipe STT → LLM → TTS en streaming.

**Stack actuelle (2026-04) :**

**Pipeline OUTBOUND (v5 — Gemini Live) :**
- STT + LLM + TTS : **Gemini Live API** `gemini-3.1-flash-live-preview` — tout en un, WebSocket bidirectionnel
- Conversion audio : mulaw 8kHz ↔ PCM 16/24kHz en pur JS (`src/services/gemini-live.js`)
- Function calling : `confirm_order`, `cancel_order`, `request_human_callback` → `src/functions/outbound-functions.js`
- Produit : chargé depuis table Supabase `products` via `loadProduct()` — 1 seul appel DB avant la session Gemini
- Timers : silence décroché 5s, silence appel 10s (reset sur chaque audio client), timeout global 2mn

**Pipeline INBOUND (legacy — Deepgram + Groq + ElevenLabs) :**
- STT : Deepgram **nova-3**, `language=ar`, `encoding=mulaw`, `endpointing=500ms`, `utterance_end_ms=1500`
- LLM : Groq `llama-3.3-70b-versatile` (~400ms) — répond en JSON `{"speak":"...","display":"..."}`
- TTS : **ElevenLabs** `eleven_turbo_v2_5`, `output_format=ulaw_8000`. `speaking_rate` à la **racine** du JSON (pas dans `voice_settings`). Fallback ffmpeg MP3→mulaw si `audio/mpeg`
- Fillers audio : `src/fillers.js` — 3 clips mulaw pré-générés au démarrage
- Barge-in : uniquement sur `speech_final=true` Deepgram + délai minimum 1s → event Twilio `clear`

**Commun :**
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

### Pipeline d'un appel outbound (confirmation commande)

```
POST /outbound/call → initiateCall() Twilio → webhook POST /outbound/webhook → TwiML WebSocket → /outbound-stream
WebSocket start event → pendingOrders.get(callSid) → buildGreeting() → synthesizeStream() (TTS direct, pas de LLM)
Client répond → Deepgram STT → handleTranscript()
  → transitions état (code, pas LLM) → agent.streamOutboundResponse() → Groq LLM
  → doTTS() → synthesizeStream() → Twilio WebSocket
Raccrochage : JSON {hangup:true} → onHangup() → 4s delay → ws.close()
```

Fichier central : `src/routes/outbound.js` — exporte `{ router, setupOutboundStream }`.

### Points d'architecture critiques

**`enqueueOrProcess` + `transcriptQueue`** (`inbound.js`) : les transcripts finaux STT ne sont jamais perdus. Si `isProcessing=true`, le transcript est mis en file dans `transcriptQueue`. Le bloc `finally` de `handleTranscript` dépile et traite le suivant.

**`isTTSPlaying` + `ttsStartTime`** (`inbound.js` et `outbound.js`) : `isTTSPlaying` mis à `true` uniquement pendant `synthesizeStream()` — pas pendant le filler, pas pendant l'appel LLM. Sert à : (1) bloquer l'envoi audio à Deepgram pendant que Karim parle (anti-écho), (2) enforcer le délai minimum de 1s avant barge-in.

**Barge-in** (`inbound.js`) : déclenché uniquement quand `speechFinal === true` sur le callback `onTranscript`. Condition : `speechFinal && isTTSPlaying && !isBargingIn && (Date.now() - ttsStartTime) > 1000`. Le version counter `activeTurnId` empêche le `finally` d'un tour interrompu de remettre `isProcessing=false` après qu'un nouveau tour a démarré.

**Machine à états outbound** (`outbound.js`) : le code (pas le LLM) gère les transitions d'étape. `STEP_PROMPTS` injecte une instruction précise par étape dans `streamOutboundResponse`. `isPositive`/`isNegative` sur le transcript détermine la transition avant d'appeler le LLM.

- Étape 2 → confirmée : **bypass LLM total** — phrase de délai construite en code (`التوصيل يكون خلال يومين إن شاء الله.`) jouée directement via `synthesizeStream`, puis step 3 enchaîné sans transcript client. Ne jamais repasser ce chemin par le LLM — il ignore ou réorganise le texte.
- JSON `{hangup:true, status:"confirmé"|"annulé"}` déclenche `onStatusUpdate` puis `onHangup` dans `streamOutboundResponse`.

**`pendingOrders`** (`outbound.js`) : Map module-level `CallSid → {callId, productId, price, address, deliveryDelay}` entre `POST /outbound/call` et l'ouverture du WebSocket `/outbound-stream`. Nettoyé via `.delete()` au `start` event. Utilisé aussi par `/outbound/webhook/status` pour le no-answer.

**Session Gemini Live** (`services/gemini-live.js`) : `createGeminiLiveSession(wsClient, systemPrompt, functions, onFunctionCall)` — ouvre WebSocket Gemini, bridge audio, émet `gemini-audio`/`gemini-turn-complete`/`gemini-interrupted` sur `wsClient`. Retourne `{ sendAudio, close }`. Conversion audio en pur JS : mulaw 8kHz ↔ PCM 16/24kHz. Ne jamais appeler `sendAudio` avant `setupComplete` — silencieusement ignoré sinon.

**Produit** (`services/product.js`) : `loadProduct(productId)` — 1 seul appel Supabase. `buildOutboundPrompt(template, product, orderData)` — injecte les tokens `{shopName}`, `{productName}`, `{price}`, `{address}`, `{deliveryDelay}`, `{guarantee}`, `{faq_ar}`, `{faq_fr}`. `product.delivery_delay` est prioritaire sur `orderData.deliveryDelay`.

**`pendingCallers`** (`inbound.js`) : Map `CallSid → numéro appelant` entre le POST webhook Twilio et l'ouverture du WebSocket `/media-stream`.

**TTS ElevenLabs** (`services/tts.js`) :
- `nettoyerTexte(text)` supprime les fillers vocaux (واه/آه/مم etc.) avant tout envoi à ElevenLabs
- `speaking_rate` doit être à la **racine** du body JSON, pas dans `voice_settings`
- Si `Content-Type: audio/mpeg` → `pipeMP3ToMulaw()` via ffmpeg ; sinon passthrough direct
- Cache mulaw en mémoire (50 entrées max). Les `console.log` sont intentionnels pour diagnostic Render

**Format JSON agent** (`services/agent.js`) : le LLM génère `{"speak":"...","display":"..."}`. `streamResponse` (inbound) et `streamOutboundResponse` (outbound) accumulent le stream complet sans stop tokens (évite de tronquer le JSON), parsent, extraient `speak`. `streamOutboundResponse` attend `onChunk` (TTS) avant de déclencher `onHangup`/`onStatusUpdate`.

**RAG** (`services/agent.js`) : actuellement **désactivé** — `rag.searchContext()` commenté, `ragContext=''`. Les infos produit sont directement dans les prompts. Pour réactiver : décommenter les 2 lignes dans `streamResponse()` et définir `DEFAULT_SUBJECT_ID`.

**Deepgram session** (`services/stt.js`) : `createDeepgramSession(onTranscript, onError)` — 2 paramètres. `onTranscript(transcript, speechFinal)` passe le flag `speech_final` en 2e argument. KeepAlive toutes les 5s. Max 3 reconnexions sur 1006.

**Fillers** (`src/fillers.js`) : `initFillers()` appelé en module-scope dans `inbound.js` (fire-and-forget). `getRandomFiller()` retourne `null` si pas encore prêt.

### Services

| Fichier | Rôle |
|---|---|
| `services/gemini-live.js` | Bridge WebSocket Twilio ↔ Gemini Live, conversion audio mulaw↔PCM, function calling |
| `services/product.js` | `loadProduct(id)` Supabase + `buildOutboundPrompt(template, product, order)` |
| `services/stt.js` | Session Deepgram WebSocket streaming (inbound uniquement), retourne `{send, close}` |
| `services/tts.js` | `synthesizeStream(text, onChunk)` ElevenLabs (inbound uniquement) + fallback ffmpeg + cache mulaw |
| `services/agent.js` | `streamResponse()` inbound ; `streamOutboundResponse()` — LEGACY (non utilisé par outbound v5) |
| `services/database.js` | CRUD Supabase. `updateCallStatus`, `updateCallLanguage`, `updateCallOutcome` sur table `calls` |
| `services/rag.js` | Chunking + embeddings OpenAI + recherche pgvector (désactivé en prod) |
| `services/campaign.js` | Campagnes outbound séquentielles |
| `services/telephony.js` | Client Twilio singleton + `generateTwiMLStream()` + `initiateCall(to, url, extra)` |
| `functions/outbound-functions.js` | Handlers function calling Gemini : confirm_order, cancel_order, request_human_callback |

### Routes

| Route | Description |
|---|---|
| `POST /inbound` | Webhook Twilio → TwiML inbound |
| `WS /media-stream` | Pipeline audio inbound temps réel |
| `POST /outbound/call` | Appel ad-hoc : crée enregistrement DB + lance Twilio |
| `POST /outbound/webhook` | Webhook Twilio → TwiML outbound |
| `WS /outbound-stream` | Pipeline audio outbound (Gemini Live v5) |
| `POST /outbound/webhook/status` | StatusCallback Twilio : no-answer/busy/failed → `aucune_réponse` en DB |
| `GET /outbound/status/:callSid` | Statut Twilio en temps réel |
| `POST /outbound/start` | Lance campagne outbound existante |
| `GET /dashboard` | Dashboard monitoring (Basic Auth optionnel) |
| `GET /test-call` | Test navigateur Twilio Client JS SDK v2 |
| `GET /test-outbound` | Test UI appel sortant |
| `GET /health` | Health check Render |
| `GET /api/calls/:id` | Détail appel avec champ `resultat` |
| `PATCH /api/calls/:id/status` | Met à jour `resultat` manuellement |
| `GET /api/calls/:id/transcripts` | Transcripts d'un appel |
| `/api/*` | CRUD workspaces, subjects, campaigns, contacts |

### Prompts

| Fichier | Utilisé par | Notes |
|---|---|---|
| `src/prompts/karim_live_outbound.txt` | `setupOutboundStream()` outbound v5 | Tokens `{shopName}`, `{productName}`, `{price}`, `{address}`, `{deliveryDelay}`, `{guarantee}`, `{faq_ar}`, `{faq_fr}` |
| `src/prompts/karim_darija.txt` | `streamResponse()` inbound | Contient infos produit (RAG désactivé) |
| `src/prompts/karim_fr.txt` | `streamResponse()` si langue française | |
| `src/prompts/karim_outbound.txt` | LEGACY — plus utilisé par outbound v5 | |

Darija algérienne : تاع (pas ديال), درك (pas دابا), بزاف (pas برشا), مليح/لاباس (pas مزيان), صحيح (pas مزبوط).

### Base de données

La table `call_turns` stocke chaque tour avec `llm_duration_ms`, `tts_duration_ms`, `total_latency_ms`. La table `calls` a un champ `resultat` mis à jour via `updateCallStatus` (inbound) et les colonnes v5 `language`, `outcome`, `product_id` (outbound v5). Valeurs `outcome` : `confirmé`, `annulé_client`, `aucune_réponse`, `rappel_humain`, `timeout`. La table `products` stocke les données produit + FAQ (`shop_name`, `product_name`, `price`, `delivery_delay`, `guarantee`, `faq_ar`, `faq_fr`). Migration : `sql/migration_v5.sql`.

## VARIABLES D'ENVIRONNEMENT REQUISES

```
# Outbound v5 (Gemini Live)
GOOGLE_API_KEY
GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview   # optionnel, défaut ci-contre

# Inbound legacy (Deepgram + Groq + ElevenLabs)
GROQ_API_KEY
DEEPGRAM_API_KEY
ELEVENLABS_API_KEY
ELEVENLABS_VOICE_ID
OPENAI_API_KEY          # embeddings RAG uniquement (inutile si RAG désactivé)

# Twilio (inbound + outbound)
TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER

# Base de données
SUPABASE_URL / SUPABASE_ANON_KEY
```

Optionnelles :
```
TTS_SPEED=0.7           # speaking_rate ElevenLabs (1.0=normal, 0.7=ralenti) — défaut 0.7
DEFAULT_SUBJECT_ID=     # subject_id RAG pour appels inbound (requis si RAG réactivé)
DASHBOARD_PASSWORD      # Basic Auth sur /dashboard (sans = accès libre)
BASE_URL                # URL publique Render (ex: https://dz-agent-voice.onrender.com)
TWILIO_API_KEY / TWILIO_API_SECRET / TWILIO_TWIML_APP_SID  # test-call navigateur
```

## RÈGLES DE DÉVELOPPEMENT

- Commenter le code **en français**
- `async/await` partout, `try/catch` sur chaque await
- Logs via `logger` (Winston) — exception : `tts.js` utilise `console.log` intentionnellement pour les diagnostics TTS visibles dans Render logs
- Tests dans `tests/` — mocker `@supabase/supabase-js`, `dotenv`, `child_process` (spawn/exec pour ffmpeg), et les services externes
- Tous les fichiers de test doivent définir `ELEVENLABS_API_KEY` et `ELEVENLABS_VOICE_ID` dans `process.env` (requis par `config.js validate()`)
- `ffmpeg` doit être disponible sur le serveur (présent sur Render, vérifié au démarrage via `[STARTUP] ffmpeg OK`)
- `onTranscript` dans `stt.js` a la signature `(transcript, speechFinal)` — ne pas modifier sans mettre à jour `inbound.js` et `tests/stt.test.js`
- `outbound.js` exporte `{ router, setupOutboundStream }` — ne pas changer en export unique
