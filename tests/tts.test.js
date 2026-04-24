process.env.ANTHROPIC_API_KEY = 'test';
process.env.TWILIO_ACCOUNT_SID = 'test';
process.env.TWILIO_AUTH_TOKEN = 'test';
process.env.TWILIO_PHONE_NUMBER = '+1234567890';
process.env.DEEPGRAM_API_KEY = 'test';
process.env.ELEVENLABS_API_KEY = 'test';
process.env.ELEVENLABS_VOICE_ID = 'testVoiceId';
process.env.OPENAI_API_KEY = 'test';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test';

jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));

const mockMulawBuffer = Buffer.from([0x7f, 0x80]);
jest.mock('../src/utils/audio', () => ({
  mp3ToMulaw: jest.fn().mockResolvedValue(mockMulawBuffer)
}));

const mockMp3 = Buffer.from('mp3data');

const { synthesize, clearCache } = require('../src/services/tts');

describe('tts service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearCache();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: jest.fn().mockResolvedValue(mockMp3.buffer)
    });
  });

  it('retourne un Buffer mulaw pour du texte', async () => {
    const result = await synthesize('السلام عليكم سيدي');
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result).toEqual(mockMulawBuffer);
  });

  it('appelle l\'API ElevenLabs avec le bon voiceId', async () => {
    await synthesize('Bonjour');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('testVoiceId'),
      expect.objectContaining({ method: 'POST' })
    );
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

  it('lève une erreur si ElevenLabs retourne 4xx', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: jest.fn().mockResolvedValue('Unauthorized')
    });
    await expect(synthesize('test erreur')).rejects.toThrow('401');
  });
});
