process.env.GROQ_API_KEY = 'test';
process.env.TWILIO_ACCOUNT_SID = 'test';
process.env.TWILIO_AUTH_TOKEN = 'test';
process.env.TWILIO_PHONE_NUMBER = '+1234567890';
process.env.DEEPGRAM_API_KEY = 'test';
process.env.ELEVENLABS_API_KEY = 'sk_test';
process.env.ELEVENLABS_VOICE_ID = 'voice_test';
process.env.OPENAI_API_KEY = 'test';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test';

jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));

// Construit un faux response.body stream qui émet les chunks donnés
function makeStreamResponse(chunks, ok = true) {
  let i = 0;
  const reader = {
    read: jest.fn().mockImplementation(async () => {
      if (i < chunks.length) return { done: false, value: chunks[i++] };
      return { done: true, value: undefined };
    }),
    releaseLock: jest.fn()
  };
  return {
    ok,
    status: ok ? 200 : 401,
    headers: { get: jest.fn().mockReturnValue('audio/basic') },
    body: { getReader: jest.fn().mockReturnValue(reader) },
    text: jest.fn().mockResolvedValue(ok ? '' : 'Unauthorized')
  };
}

const mockChunk = Buffer.from([0x7f, 0x80]);

const { synthesize, synthesizeStream, clearCache } = require('../src/services/tts');

describe('tts service (ElevenLabs)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearCache();
    global.fetch = jest.fn().mockResolvedValue(makeStreamResponse([mockChunk]));
  });

  describe('synthesize', () => {
    it('retourne un Buffer mulaw pour du texte', async () => {
      const result = await synthesize('السلام عليكم سيدي');
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });

    it('appelle ElevenLabs avec le bon voice_id', async () => {
      await synthesize('Bonjour');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('voice_test'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('envoie le bon model_id et output_format', async () => {
      await synthesize('test');
      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.model_id).toBe('eleven_turbo_v2_5');
      expect(body.output_format).toBe('ulaw_8000');
    });

    it('utilise le cache pour le même texte', async () => {
      await synthesize('texte test');
      await synthesize('texte test');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('retourne Buffer vide pour texte vide', async () => {
      const result = await synthesize('');
      expect(result.length).toBe(0);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('lève une erreur si ElevenLabs retourne une erreur HTTP', async () => {
      global.fetch = jest.fn().mockResolvedValue(makeStreamResponse([], false));
      await expect(synthesize('test erreur')).rejects.toThrow('ElevenLabs 401');
    });
  });

  describe('synthesizeStream', () => {
    it('appelle onChunk avec des chunks Buffer', async () => {
      const chunks = [];
      await synthesizeStream('Bonjour', chunk => chunks.push(chunk));
      expect(chunks.length).toBeGreaterThan(0);
      expect(Buffer.isBuffer(chunks[0])).toBe(true);
    });

    it('ne fait rien pour texte vide', async () => {
      const chunks = [];
      await synthesizeStream('', chunk => chunks.push(chunk));
      expect(chunks.length).toBe(0);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('utilise le cache pour le même texte', async () => {
      await synthesizeStream('texte cache', () => {});
      await synthesizeStream('texte cache', () => {});
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('lève une erreur sur réponse HTTP non-OK', async () => {
      global.fetch = jest.fn().mockResolvedValue(makeStreamResponse([], false));
      await expect(synthesizeStream('test', () => {})).rejects.toThrow('ElevenLabs 401');
    });
  });
});
