-- Activer l'extension pgvector pour les embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- Workspaces
CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nom text NOT NULL,
  email text UNIQUE,
  created_at timestamptz DEFAULT now()
);

-- Subjects (sujets/agents configurés)
CREATE TABLE IF NOT EXISTS subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  nom text NOT NULL,
  langue text DEFAULT 'auto',
  voice_id_darija text,
  voice_id_fr text,
  script_accueil text,
  script_conclusion text,
  created_at timestamptz DEFAULT now()
);

-- Documents RAG indexés par subject
CREATE TABLE IF NOT EXISTS subject_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id uuid REFERENCES subjects(id) ON DELETE CASCADE,
  fichier_nom text,
  fichier_type text,
  contenu_chunk text,
  embedding vector(1536),
  created_at timestamptz DEFAULT now()
);

-- Campaigns
CREATE TABLE IF NOT EXISTS campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_id uuid REFERENCES subjects(id),
  nom text NOT NULL,
  type text CHECK (type IN ('inbound','outbound')),
  statut text DEFAULT 'brouillon',
  numero_twilio text,
  schedule_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- Contacts des campagnes
CREATE TABLE IF NOT EXISTS contact_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  telephone text NOT NULL,
  nom text,
  donnees_custom jsonb,
  statut text DEFAULT 'en_attente',
  created_at timestamptz DEFAULT now()
);

-- Appels
CREATE TABLE IF NOT EXISTS calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid REFERENCES campaigns(id),
  contact_id uuid REFERENCES contact_lists(id),
  direction text CHECK (direction IN ('inbound','outbound')),
  statut text DEFAULT 'en_cours',
  duree_secondes int DEFAULT 0,
  resultat text,
  created_at timestamptz DEFAULT now()
);

-- Transcripts des appels
CREATE TABLE IF NOT EXISTS transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid REFERENCES calls(id) ON DELETE CASCADE,
  role text CHECK (role IN ('agent','client')),
  message text,
  langue text,
  created_at timestamptz DEFAULT now()
);

-- Fonction de recherche sémantique RAG
CREATE OR REPLACE FUNCTION match_documents(
  p_subject_id uuid,
  query_embedding vector(1536),
  match_count int DEFAULT 3
)
RETURNS TABLE (id uuid, contenu_chunk text, similarity float)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT sd.id, sd.contenu_chunk,
    1 - (sd.embedding <=> query_embedding) AS similarity
  FROM subject_documents sd
  WHERE sd.subject_id = p_subject_id
  ORDER BY sd.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Index ivfflat pour la recherche vectorielle rapide
CREATE INDEX IF NOT EXISTS subject_documents_embedding_idx
  ON subject_documents USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
