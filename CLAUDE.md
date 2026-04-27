# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## CONTEXTE

Agent vocal IA pour le marché algérien (darija algérienne + français). Twilio reçoit l'appel outbound et ouvre un WebSocket audio mulaw 8kHz vers ce serveur, qui bridge vers Gemini Live API.

**Stack (2026-04) — Pipeline OUTBOUND Gemini Live :**
- STT + LLM + TTS : **Gemini Live API** `gemini-3.1-flash-live-preview` — tout en un, WebSocket bidirectionnel
- Conversion audio : mulaw 8kHz ↔ PCM 16/24kHz en pur JS (`src/services/gemini-live.js`)
- Function calling : `confirm_order`, `cancel_order`, `request_human_callback` → `src/functions/outbound-functions.js`
- Produit : chargé depuis table Supabase `products` via `loadProduct()` — 1 seul appel DB avant la session Gemini
- Timers : silence décroché 5s, silence appel 10s (reset sur chaque audio client), timeout global 2mn

**Commun :**
- DB : Supabase (PostgreSQL)
- Hébergement : Render.com (deploy auto sur push `main`)

## COMMANDES

```bash
npm start              # production
npm run dev            # nodemon watch
npm test               # jest --forceExit --detectOpenHandles
npm run test:coverage  # avec rapport coverage
npm run lint           # eslint src/
```

## ARCHITECTURE

### Pipeline d'un appel outbound (confirmation commande)

```
POST /outbound/call → pendingOrders.set(callSid, order) → initiateCall() Twilio
  → webhook POST /outbound/webhook → TwiML WebSocket → /outbound-stream
WebSocket start event → pendingOrders.get(callSid) → loadProduct() → buildOutboundPrompt()
  → createGeminiLiveSession(autoTrigger=true) → Gemini parle en premier
Client parle → mulaw 8kHz → PCM 16kHz → Gemini Live
Gemini répond → PCM 24kHz → mulaw 8kHz → Twilio WebSocket
Function call (confirm/cancel/callback) → endCall() après phrase de clôture
```

Fichier central : `src/routes/outbound.js` — exporte `{ router, setupOutboundStream }`.

### Points d'architecture critiques

**Session Gemini Live** (`services/gemini-live.js`) : `createGeminiLiveSession(wsClient, systemPrompt, functions, onFunctionCall, autoTrigger=false)` — ouvre WebSocket Gemini, bridge audio, émet `gemini-audio`/`gemini-turn-complete`/`gemini-interrupted` sur `wsClient`. Retourne `{ sendAudio, close }`. Conversion audio en pur JS : mulaw 8kHz ↔ PCM 16/24kHz. Ne jamais appeler `sendAudio` avant `setupComplete` — silencieusement ignoré sinon.

**autoTrigger** (`gemini-live.js`) : après `setupComplete`, envoie `client_content` avec `"Démarre la conversation."` pour forcer Gemini à parler en premier (obligatoire pour les appels outbound). Clés snake_case (`client_content`, `turn_complete`).

**`pendingOrders`** (`outbound.js`) : Map module-level `CallSid → {callId, productId, price, address, deliveryDelay}` entre `POST /outbound/call` et l'ouverture du WebSocket `/outbound-stream`. Nettoyé via `.delete()` au `start` event. Utilisé aussi par `/outbound/webhook/status` pour le no-answer.

**Produit** (`services/product.js`) : `loadProduct(productId)` — 1 seul appel Supabase. `buildOutboundPrompt(template, product, orderData)` — injecte les tokens `{shopName}`, `{productName}`, `{price}`, `{address}`, `{deliveryDelay}`, `{guarantee}`, `{faq_ar}`, `{faq_fr}`. `product.delivery_delay` est prioritaire sur `orderData.deliveryDelay`.

**Flags de fin d'appel** (`outbound.js`) : `ended` empêche double exécution de `endCall`. `outcomeRegistered` empêche double `updateCallStatus`. `outcomeFunctionCalled` déclenche `endCall(null)` après la phrase de clôture Gemini.

**Pipeline inbound** (`inbound.js`) : désactivé — le webhook POST /inbound répond avec TwiML valide mais `/media-stream` ferme immédiatement toute connexion WebSocket.

### Services

| Fichier | Rôle |
|---|---|
| `services/gemini-live.js` | Bridge WebSocket Twilio ↔ Gemini Live, conversion audio mulaw↔PCM, function calling |
| `services/product.js` | `loadProduct(id)` Supabase + `buildOutboundPrompt(template, product, order)` |
| `services/database.js` | CRUD Supabase. `updateCallStatus`, `updateCall`, `createCall` sur table `calls` |
| `services/campaign.js` | Campagnes outbound séquentielles |
| `services/telephony.js` | Client Twilio singleton + `generateTwiMLStream()` + `initiateCall(to, url, extra)` |
| `functions/outbound-functions.js` | Handlers function calling Gemini : confirm_order, cancel_order, request_human_callback |

### Routes

| Route | Description |
|---|---|
| `POST /inbound` | Webhook Twilio → TwiML (pipeline désactivé) |
| `POST /outbound/call` | Appel ad-hoc : crée enregistrement DB + lance Twilio |
| `POST /outbound/webhook` | Webhook Twilio → TwiML outbound |
| `WS /outbound-stream` | Pipeline audio outbound (Gemini Live v5) |
| `POST /outbound/webhook/status` | StatusCallback Twilio : no-answer/busy/failed → `aucune_réponse` en DB |
| `GET /outbound/status/:callSid` | Statut Twilio en temps réel |
| `POST /outbound/start` | Lance campagne outbound existante |
| `GET /dashboard` | Dashboard monitoring (Basic Auth optionnel) |
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

Darija algérienne : تاع (pas ديال), درك (pas دابا), بزاف (pas برشا), مليح/لاباس (pas مزيان), صحيح (pas مزبوط).

### Base de données

La table `calls` a un champ `resultat` mis à jour via `updateCallStatus` et les colonnes v5 `language`, `outcome`, `product_id`. Valeurs `outcome` : `confirmé`, `annulé_client`, `aucune_réponse`, `rappel_humain`, `timeout`. La table `products` stocke les données produit + FAQ (`shop_name`, `product_name`, `price`, `delivery_delay`, `guarantee`, `faq_ar`, `faq_fr`). Migration : `sql/migration_v5.sql`.

## VARIABLES D'ENVIRONNEMENT REQUISES

```
# Outbound v5 (Gemini Live)
GOOGLE_API_KEY
GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview   # optionnel, défaut ci-contre

# Twilio
TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER

# Base de données
SUPABASE_URL / SUPABASE_ANON_KEY
```

Optionnelles :
```
DASHBOARD_PASSWORD      # Basic Auth sur /dashboard (sans = accès libre)
BASE_URL                # URL publique Render (ex: https://dz-agent-voice.onrender.com)
TWILIO_API_KEY / TWILIO_API_SECRET / TWILIO_TWIML_APP_SID  # test-call navigateur
```

## RÈGLES DE DÉVELOPPEMENT

- Commenter le code **en français**
- `async/await` partout, `try/catch` sur chaque await
- Logs via `logger` (Winston)
- Tests dans `tests/` — mocker `@supabase/supabase-js`, `dotenv`, et les services externes
- `outbound.js` exporte `{ router, setupOutboundStream }` — ne pas changer en export unique
