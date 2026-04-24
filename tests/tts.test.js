process.env.ANTHROPIC_API_KEY = 'test';
process.env.TWILIO_ACCOUNT_SID = 'test';
process.env.TWILIO_AUTH_TOKEN = 'test';
process.env.TWILIO_PHONE_NUMBER = '+1234567890';
process.env.DEEPGRAM_API_KEY = 'test';
process.env.OPENAI_API_KEY = 'test';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test';

jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));

const mockMulawBuffer = Buffer.from([0x7f, 0x80]);
jest.mock('../src/utils/audio', () => ({
  mp3ToMulaw: jest.fn().mockResolvedValue(mockMulawBuffer)
}));

const { Readable } = require('stream');

function makeMockStream(data) {
  const s = new Readable({ read() {} });
  process.nextTick(() => { s.push(data); s.push(null); });
  return s;
}

const mockSetMetadata = jest.fn().mockResolvedValue(undefined);
const mockToStream = jest.fn().mockImplementation(() =>
  Promise.resolve({ audioStream: makeMockStream(Buffer.from('mp3data')) })
);

jest.mock('msedge-tts', () => ({
  MsEdgeTTS: jest.fn().mockImplementation(() => ({
    setMetadata: mockSetMetadata,
    toStream: mockToStream
  })),
  OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'audio-24khz-48kbitrate-mono-mp3' }
}));

const { synthesize, clearCache } = require('../src/services/tts');

describe('tts service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearCache();
    mockSetMetadata.mockResolvedValue(undefined);
    mockToStream.mockImplementation(() =>
      Promise.resolve({ audioStream: makeMockStream(Buffer.from('mp3data')) })
    );
  });

  it('retourne un Buffer mulaw pour du texte', async () => {
    const result = await synthesize('السلام عليكم سيدي');
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result).toEqual(mockMulawBuffer);
  });

  it('appelle Edge TTS avec la voix ar-DZ-IsmaelNeural', async () => {
    await synthesize('Bonjour');
    expect(mockSetMetadata).toHaveBeenCalledWith(
      'ar-DZ-IsmaelNeural',
      expect.any(String)
    );
    expect(mockToStream).toHaveBeenCalledWith('Bonjour');
  });

  it('utilise le cache pour le même texte', async () => {
    await synthesize('texte test');
    await synthesize('texte test');
    expect(mockToStream).toHaveBeenCalledTimes(1);
  });

  it('retourne Buffer vide pour texte vide', async () => {
    const result = await synthesize('');
    expect(result.length).toBe(0);
    expect(mockToStream).not.toHaveBeenCalled();
  });

  it('lève une erreur si Edge TTS échoue', async () => {
    mockToStream.mockRejectedValueOnce(new Error('Edge TTS connexion refusée'));
    await expect(synthesize('test erreur')).rejects.toThrow('Edge TTS connexion refusée');
  });
});
