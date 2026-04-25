process.env.GOOGLE_API_KEY = 'test';
process.env.TWILIO_ACCOUNT_SID = 'test';
process.env.TWILIO_AUTH_TOKEN = 'test';
process.env.TWILIO_PHONE_NUMBER = '+1234567890';
process.env.DEEPGRAM_API_KEY = 'test';
process.env.OPENAI_API_KEY = 'test';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test';

jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));

const mockStream = {
  [Symbol.asyncIterator]: async function* () {
    yield { text: () => 'واخا ' };
    yield { text: () => 'سيدي.' };
  }
};

const mockSendMessageStream = jest.fn().mockResolvedValue({ stream: mockStream });
const mockStartChat = jest.fn().mockReturnValue({ sendMessageStream: mockSendMessageStream });
const mockGetGenerativeModel = jest.fn().mockReturnValue({ startChat: mockStartChat });

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: mockGetGenerativeModel
  }))
}));

jest.mock('../src/services/rag', () => ({
  searchContext: jest.fn().mockResolvedValue('Contexte RAG test')
}));

jest.mock('../src/services/database', () => ({
  insertTranscript: jest.fn().mockResolvedValue({ id: 'tr-uuid', created_at: '2026-04-24T11:00:00.000Z' })
}));

const { isArabic, selectPrompt, streamResponse } = require('../src/services/agent');

describe('agent service', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('isArabic', () => {
    it('détecte le texte arabe', () => {
      expect(isArabic('واش عندك أسئلة سيدي')).toBe(true);
    });

    it('détecte le texte français', () => {
      expect(isArabic('Bonjour comment allez-vous')).toBe(false);
    });

    it('retourne false pour chaîne vide', () => {
      expect(isArabic('')).toBe(false);
    });
  });

  describe('selectPrompt', () => {
    it('retourne un prompt non vide pour texte arabe', () => {
      const prompt = selectPrompt('السلام عليكم');
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(10);
    });

    it('retourne un prompt non vide pour texte français', () => {
      const prompt = selectPrompt('Bonjour');
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(10);
    });
  });

  describe('streamResponse', () => {
    it('streame une réponse et appelle onChunk', async () => {
      const chunks = [];
      await streamResponse({
        callId: 'call-uuid',
        subjectId: 'subject-uuid',
        userMessage: 'واش عندك أسئلة',
        history: [],
        onChunk: (chunk) => chunks.push(chunk)
      });
      expect(chunks.length).toBeGreaterThan(0);
    });

    it('insère les transcripts client et agent', async () => {
      const { insertTranscript } = require('../src/services/database');
      await streamResponse({
        callId: 'call-uuid',
        subjectId: null,
        userMessage: 'Bonjour',
        history: [],
        onChunk: () => {}
      });
      expect(insertTranscript).toHaveBeenCalledTimes(2);
      expect(insertTranscript).toHaveBeenCalledWith(expect.objectContaining({ role: 'client' }));
    });

    it('convertit l\'historique assistant→model pour Gemini', async () => {
      await streamResponse({
        callId: 'call-uuid',
        subjectId: null,
        userMessage: 'Bonjour',
        history: [
          { role: 'user', content: 'Salam' },
          { role: 'assistant', content: 'Salam alikoum' }
        ],
        onChunk: () => {}
      });
      expect(mockStartChat).toHaveBeenCalledWith({
        history: [
          { role: 'user', parts: [{ text: 'Salam' }] },
          { role: 'model', parts: [{ text: 'Salam alikoum' }] }
        ]
      });
    });
  });
});
