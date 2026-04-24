# DZ Agent Vocal — Instructions Claude Code

## CONTEXTE
Agent vocal IA pour le marché algérien.
- Langue : darija algérienne formelle + français
- Stack : Node.js 24, Express, WebSocket
- Téléphonie : Twilio
- STT : Deepgram Nova-2 (streaming)
- LLM : Claude Haiku 4.5 (streaming)
- TTS : ElevenLabs Turbo v2 (streaming)
- DB : Supabase (PostgreSQL)
- Hébergement : Render.com

## RÈGLES ABSOLUES
- Ne jamais t'arrêter pour demander confirmation
- Ne jamais demander "tu veux que je continue ?"
- Corriger les bugs automatiquement sans demander
- Écrire les tests automatiquement
- Si un test échoue → corriger et relancer
- Commenter le code en français
- Toujours utiliser async/await
- Toujours gérer les erreurs avec try/catch

## STRUCTURE DU PROJET
dz_agent_voice/
├── src/
│   ├── index.js
│   ├── config.js
│   ├── routes/
│   │   ├── inbound.js
│   │   └── outbound.js
│   ├── services/
│   │   ├── agent.js
│   │   ├── stt.js
│   │   ├── tts.js
│   │   ├── telephony.js
│   │   ├── campaign.js
│   │   ├── rag.js
│   │   └── database.js
│   ├── prompts/
│   │   ├── karim_darija.txt
│   │   └── karim_fr.txt
│   └── utils/
│       ├── audio.js
│       ├── excel.js
│       └── logger.js
├── tests/
├── .env
├── .env.example
├── .gitignore
├── package.json
├── render.yaml
└── README.md

## VARIABLES D'ENVIRONNEMENT
ANTHROPIC_API_KEY=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=+12296335468
DEEPGRAM_API_KEY=
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=jpofSqItAIlT4TLP5CrK
OPENAI_API_KEY=
SUPABASE_URL=
SUPABASE_ANON_KEY=
PORT=3000
BASE_URL=
MAX_CONCURRENT_CALLS=10
CALL_DELAY_MS=2000

## BASE DE DONNÉES SUPABASE
Créer ces tables :

### workspaces
id uuid PRIMARY KEY DEFAULT gen_random_uuid()
nom text NOT NULL
email text UNIQUE
created_at timestamptz DEFAULT now()

### subjects
id uuid PRIMARY KEY DEFAULT gen_random_uuid()
workspace_id uuid REFERENCES workspaces
nom text NOT NULL
langue text DEFAULT 'auto'
voice_id_darija text
voice_id_fr text
script_accueil text
script_conclusion text
created_at timestamptz DEFAULT now()

### subject_documents
id uuid PRIMARY KEY DEFAULT gen_random_uuid()
subject_id uuid REFERENCES subjects
fichier_nom text
fichier_type text
contenu_chunk text
embedding vector(1536)
created_at timestamptz DEFAULT now()

### campaigns
id uuid PRIMARY KEY DEFAULT gen_random_uuid()
workspace_id uuid REFERENCES workspaces
subject_id uuid REFERENCES subjects
nom text NOT NULL
type text CHECK (type IN ('inbound','outbound'))
statut text DEFAULT 'brouillon'
numero_twilio text
schedule_at timestamptz
created_at timestamptz DEFAULT now()

### contact_lists
id uuid PRIMARY KEY DEFAULT gen_random_uuid()
campaign_id uuid REFERENCES campaigns
telephone text NOT NULL
nom text
donnees_custom jsonb
statut text DEFAULT 'en_attente'
created_at timestamptz DEFAULT now()

### calls
id uuid PRIMARY KEY DEFAULT gen_random_uuid()
campaign_id uuid REFERENCES campaigns
contact_id uuid REFERENCES contact_lists
direction text CHECK (direction IN ('inbound','outbound'))
statut text DEFAULT 'en_cours'
duree_secondes int DEFAULT 0
resultat text
created_at timestamptz DEFAULT now()

### transcripts
id uuid PRIMARY KEY DEFAULT gen_random_uuid()
call_id uuid REFERENCES calls
role text CHECK (role IN ('agent','client'))
message text
langue text
created_at timestamptz DEFAULT now()

## PIPELINE STREAMING — LATENCE CIBLE < 600ms
1. Deepgram STT stream → 150ms
2. Claude Haiku stream → 200ms
3. ElevenLabs Turbo stream → 150ms
4. Réseau → 80ms

## PROMPT KARIM — DARIJA ALGÉRIENNE
L'agent s'appelle Karim.
Il parle arabe algérien formel mélangé avec du français.
Style centre d'appel professionnel algérien.
Exemple :
"السلام عليكم سيدي، نشالله تكون بخير.
أنا كريم من شركة Konfident.
عندنا كتاب TCF Canada بـ 15 دولار فقط.
واش عندك أسئلة سيدي؟"
Réponses courtes 2-3 phrases max car c'est vocal.
Jamais de bullet points.

## TASKS À EXÉCUTER DANS L'ORDRE

### TASK 1 — Setup projet
- Créer toute la structure de fichiers
- Installer toutes les dépendances npm
- Créer .env.example
- Créer .gitignore

### TASK 2 — Config centralisée
- src/config.js avec toutes les variables
- Validation au démarrage — arrêt si clé manquante

### TASK 3 — Base de données Supabase
- Créer toutes les tables SQL
- Activer pgvector extension
- src/services/database.js avec fonctions CRUD
- Tests unitaires

### TASK 4 — RAG Service
- Upload PDF/Word/Excel/TXT
- Extraction texte avec pdf-parse, mammoth, xlsx
- Chunking 500 tokens
- Embeddings OpenAI text-embedding-3-small
- Stockage Supabase pgvector
- Recherche sémantique top 3
- Tests unitaires

### TASK 5 — Agent Claude
- src/services/agent.js
- Streaming Claude Haiku 4.5
- Injection RAG dans prompt
- Détection langue auto (darija/français)
- Historique conversation par appel
- Tests unitaires

### TASK 6 — STT Deepgram
- src/services/stt.js
- WebSocket Deepgram streaming
- Conversion audio mulaw 8kHz → wav
- Détection fin de phrase (endpointing 300ms)
- Tests unitaires

### TASK 7 — TTS ElevenLabs
- src/services/tts.js
- Streaming Turbo v2
- Conversion mp3 → mulaw 8kHz pour Twilio
- Via ffmpeg
- Cache audio réponses fréquentes
- Tests unitaires

### TASK 8 — Inbound Twilio
- src/routes/inbound.js
- POST /inbound → TwiML WebSocket
- WebSocket /media-stream
- Pipeline complet STT → Claude → TTS → Twilio
- Message accueil automatique
- Log appel + transcript dans Supabase
- Tests intégration

### TASK 9 — Outbound Twilio
- src/routes/outbound.js
- Lecture fichier Excel contacts
- Validation numéros de téléphone
- Appels séquentiels avec délai configurable
- Retry si pas répondu (max 2x)
- Détection résultat (intéressé/rappel/refus/pas répondu)
- Log résultats dans Supabase
- Tests intégration

### TASK 10 — API REST
- CRUD Workspaces
- CRUD Subjects + upload documents
- CRUD Campaigns
- CRUD Contacts
- Stats appels par campagne
- Authentification basique

### TASK 11 — Déploiement Render
- render.yaml configuré
- Variables env documentées
- Health check endpoint /health
- Logs structurés

### TASK 12 — Tests E2E
- Simuler appel inbound complet
- Simuler campagne outbound
- Vérifier logs Supabase
- Rapport final

## DÉPENDANCES NPM
express
ws
@anthropic-ai/sdk
twilio
@deepgram/sdk
elevenlabs
@supabase/supabase-js
openai
pdf-parse
mammoth
xlsx
multer
dotenv
winston
jest
node-fetch

## QUALITÉ CODE
- ESLint configuré
- Tests Jest avec 80% coverage minimum
- Logs structurés avec Winston
- Gestion erreurs complète
- Pas de console.log → utiliser logger

## RENDER.YAML
services:
  - type: web
    name: dz-agent-vocal
    env: node
    buildCommand: npm install
    startCommand: node src/index.js
    healthCheckPath: /health