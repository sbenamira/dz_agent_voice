process.env.GOOGLE_API_KEY = 'test';
process.env.TWILIO_ACCOUNT_SID = 'test';
process.env.TWILIO_AUTH_TOKEN = 'test';
process.env.TWILIO_PHONE_NUMBER = '+1234567890';
process.env.DEEPGRAM_API_KEY = 'test';
process.env.ELEVENLABS_API_KEY = 'test';
process.env.ELEVENLABS_VOICE_ID = 'test';
process.env.OPENAI_API_KEY = 'test';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test';

jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  embeddings: {
    create: jest.fn().mockResolvedValue({
      data: [{ embedding: new Array(1536).fill(0.1) }]
    })
  }
})));
jest.mock('../src/services/database', () => ({
  insertDocument: jest.fn().mockResolvedValue({ id: 'doc-uuid' }),
  searchDocuments: jest.fn().mockResolvedValue([
    { id: 'doc-1', contenu_chunk: 'Le TCF Canada est un test de français.' }
  ])
}));

const { chunkText, extractText, searchContext } = require('../src/services/rag');
const path = require('path');
const fs = require('fs');
const os = require('os');

describe('rag service', () => {
  describe('chunkText', () => {
    it('retourne un chunk pour un texte court', () => {
      const chunks = chunkText('mot '.repeat(100).trim());
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });

    it('découpe un texte long en plusieurs chunks', () => {
      const chunks = chunkText('mot '.repeat(2000).trim());
      expect(chunks.length).toBeGreaterThan(1);
      chunks.forEach(c => expect(c.trim()).toBeTruthy());
    });

    it('retourne tableau vide pour texte vide', () => {
      expect(chunkText('   ')).toHaveLength(0);
    });
  });

  describe('extractText', () => {
    it('extrait le texte d\'un fichier TXT', async () => {
      const tmpFile = path.join(os.tmpdir(), 'test-rag.txt');
      fs.writeFileSync(tmpFile, 'Bonjour, ceci est un test RAG.');
      const text = await extractText(tmpFile, 'text/plain');
      expect(text).toContain('test RAG');
      fs.unlinkSync(tmpFile);
    });

    it('lève une erreur pour extension non supportée', async () => {
      const tmpFile = path.join(os.tmpdir(), 'test.unknown');
      fs.writeFileSync(tmpFile, 'data');
      await expect(extractText(tmpFile, 'unknown/type')).rejects.toThrow();
      fs.unlinkSync(tmpFile);
    });
  });

  describe('searchContext', () => {
    it('retourne les chunks pertinents concaténés', async () => {
      const context = await searchContext('subject-uuid', 'TCF Canada');
      expect(typeof context).toBe('string');
      expect(context).toContain('TCF Canada');
    });

    it('retourne chaîne vide si aucun résultat', async () => {
      const { searchDocuments } = require('../src/services/database');
      searchDocuments.mockResolvedValueOnce([]);
      const context = await searchContext('subject-uuid', 'query inconnue');
      expect(context).toBe('');
    });
  });
});
