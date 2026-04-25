process.env.GROQ_API_KEY = 'test';
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

const { Readable, PassThrough } = require('stream');
const { EventEmitter } = require('events');

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

// Mock child_process pour synthesizeStream
jest.mock('child_process', () => ({
  spawn: jest.fn().mockImplementation(() => {
    const { PassThrough } = require('stream');
    const { EventEmitter } = require('events');
    const proc = new EventEmitter();
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = jest.fn();
    process.nextTick(() => {
      proc.stdout.push(Buffer.from([0x7f, 0x80]));
      proc.stdout.push(null);
    });
    return proc;
  })
}));

const { synthesize, synthesizeStream, clearCache } = require('../src/services/tts');

describe('tts service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearCache();
    mockSetMetadata.mockResolvedValue(undefined);
    mockToStream.mockImplementation(() =>
      Promise.resolve({ audioStream: makeMockStream(Buffer.from('mp3data')) })
    );
  });

  describe('synthesize', () => {
    it('retourne un Buffer mulaw pour du texte', async () => {
      const result = await synthesize('السلام عليكم سيدي');
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result).toEqual(mockMulawBuffer);
    });

    it('appelle Edge TTS avec la voix ar-DZ-IsmaelNeural', async () => {
      await synthesize('Bonjour');
      expect(mockSetMetadata).toHaveBeenCalledWith('ar-DZ-IsmaelNeural', expect.any(String));
    });

    it('utilise le cache pour le même texte', async () => {
      await synthesize('texte test');
      await synthesize('texte test');
      expect(mockToStream).toHaveBeenCalledTimes(1);
    });

    it('retourne Buffer vide pour texte vide', async () => {
      const result = await synthesize('');
      expect(result.length).toBe(0);
    });

    it('lève une erreur si Edge TTS échoue', async () => {
      mockToStream.mockRejectedValueOnce(new Error('Edge TTS connexion refusée'));
      await expect(synthesize('test erreur')).rejects.toThrow('Edge TTS connexion refusée');
    });
  });

  describe('synthesizeStream', () => {
    it('appelle onChunk avec des chunks mulaw', async () => {
      const chunks = [];
      await synthesizeStream('Bonjour', chunk => chunks.push(chunk));
      expect(chunks.length).toBeGreaterThan(0);
      expect(Buffer.isBuffer(chunks[0])).toBe(true);
    });

    it('ne fait rien pour texte vide', async () => {
      const chunks = [];
      await synthesizeStream('', chunk => chunks.push(chunk));
      expect(chunks.length).toBe(0);
    });

    it('utilise le cache pour le même texte', async () => {
      const { spawn } = require('child_process');
      await synthesizeStream('texte cache', () => {});
      await synthesizeStream('texte cache', () => {});
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });
});
