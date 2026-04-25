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

const mockConnection = {
  on: jest.fn(),
  send: jest.fn(),
  finish: jest.fn(),
  getReadyState: jest.fn().mockReturnValue(1)
};

jest.mock('@deepgram/sdk', () => ({
  createClient: jest.fn().mockReturnValue({
    listen: { live: jest.fn().mockReturnValue(mockConnection) }
  }),
  LiveTranscriptionEvents: {
    Open: 'open',
    Transcript: 'transcript',
    Error: 'error',
    Close: 'close'
  }
}));

const { createDeepgramSession } = require('../src/services/stt');

describe('stt service', () => {
  beforeEach(() => jest.clearAllMocks());

  it('retourne un objet avec send() et close()', () => {
    const session = createDeepgramSession(() => {}, () => {});
    expect(typeof session.send).toBe('function');
    expect(typeof session.close).toBe('function');
  });

  it('enregistre le handler Open sur la connexion', () => {
    createDeepgramSession(() => {}, () => {});
    expect(mockConnection.on).toHaveBeenCalledWith('open', expect.any(Function));
  });

  it('send() transmet le buffer audio quand ready', () => {
    const session = createDeepgramSession(() => {}, () => {});
    const openCb = mockConnection.on.mock.calls.find(c => c[0] === 'open')?.[1];
    if (openCb) openCb();
    const buf = Buffer.from([0x7f, 0x80, 0x00]);
    session.send(buf);
    expect(mockConnection.send).toHaveBeenCalledWith(buf);
  });

  it('close() appelle finish()', () => {
    const session = createDeepgramSession(() => {}, () => {});
    session.close();
    expect(mockConnection.finish).toHaveBeenCalled();
  });

  it('appelle onTranscript avec le texte final', () => {
    const onTranscript = jest.fn();
    createDeepgramSession(onTranscript, () => {});
    const openCb = mockConnection.on.mock.calls.find(c => c[0] === 'open')?.[1];
    if (openCb) openCb();
    const transcriptCb = mockConnection.on.mock.calls.find(c => c[0] === 'transcript')?.[1];
    if (transcriptCb) {
      transcriptCb({ is_final: true, channel: { alternatives: [{ transcript: 'واش راك' }] } });
      expect(onTranscript).toHaveBeenCalledWith('واش راك');
    }
  });
});
