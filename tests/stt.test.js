process.env.GROQ_API_KEY = 'test';
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

// Mock Deepgram SDK
const mockHandlers = {};
const mockConnection = {
  on: jest.fn((event, cb) => { mockHandlers[event] = cb; }),
  send: jest.fn(),
  getReadyState: jest.fn().mockReturnValue(1),
  finish: jest.fn()
};

jest.mock('@deepgram/sdk', () => ({
  createClient: jest.fn().mockReturnValue({
    listen: { live: jest.fn().mockReturnValue(mockConnection) }
  }),
  LiveTranscriptionEvents: {
    Open: 'Open',
    Close: 'Close',
    Transcript: 'Transcript',
    Error: 'Error'
  }
}));

const { createDeepgramSession } = require('../src/services/stt');

describe('stt service (Deepgram Nova-3)', () => {
  // Fake timers évitent que setInterval du KeepAlive reste ouvert
  beforeAll(() => jest.useFakeTimers());
  afterAll(() => jest.useRealTimers());

  beforeEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    Object.keys(mockHandlers).forEach(k => delete mockHandlers[k]);
    mockConnection.send.mockClear();
    mockConnection.finish.mockClear();
    mockConnection.getReadyState.mockReturnValue(1);
  });

  it('retourne un objet avec send() et close()', () => {
    const session = createDeepgramSession(() => {}, () => {});
    expect(typeof session.send).toBe('function');
    expect(typeof session.close).toBe('function');
  });

  it('appelle onTranscript uniquement pour les transcripts finaux', () => {
    const onTranscript = jest.fn();
    createDeepgramSession(onTranscript, () => {});
    // Le handler Transcript est enregistré dans le callback Open
    if (mockHandlers['Open']) mockHandlers['Open']();
    mockHandlers['Transcript']({
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: 'واش عندك' }] }
    });
    expect(onTranscript).toHaveBeenCalledWith('واش عندك');
  });

  it("n'appelle pas onTranscript pour les transcripts non finaux", () => {
    const onTranscript = jest.fn();
    createDeepgramSession(onTranscript, () => {});
    if (mockHandlers['Open']) mockHandlers['Open']();
    mockHandlers['Transcript']({
      is_final: false,
      channel: { alternatives: [{ transcript: 'واش' }] }
    });
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('appelle onInterim pour les transcripts non finaux avec texte (FIX 4)', () => {
    const onTranscript = jest.fn();
    const onInterim = jest.fn();
    createDeepgramSession(onTranscript, () => {}, onInterim);
    if (mockHandlers['Open']) mockHandlers['Open']();
    mockHandlers['Transcript']({
      is_final: false,
      channel: { alternatives: [{ transcript: 'واش' }] }
    });
    expect(onInterim).toHaveBeenCalledWith('واش');
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("n'appelle pas onInterim pour les transcripts vides", () => {
    const onInterim = jest.fn();
    createDeepgramSession(() => {}, () => {}, onInterim);
    if (mockHandlers['Open']) mockHandlers['Open']();
    mockHandlers['Transcript']({
      is_final: false,
      channel: { alternatives: [{ transcript: '   ' }] }
    });
    expect(onInterim).not.toHaveBeenCalled();
  });

  it('send() envoie le buffer quand la connexion est ouverte', () => {
    const session = createDeepgramSession(() => {}, () => {});
    const buf = Buffer.from([0x7f, 0x80]);
    session.send(buf);
    expect(mockConnection.send).toHaveBeenCalledWith(buf);
  });

  it('send() ne lance pas si la connexion est fermée', () => {
    mockConnection.getReadyState.mockReturnValue(3);
    const session = createDeepgramSession(() => {}, () => {});
    session.send(Buffer.from([0x7f]));
    expect(mockConnection.send).not.toHaveBeenCalled();
  });

  it('close() appelle finish() et stoppe les reconnexions', () => {
    const session = createDeepgramSession(() => {}, () => {});
    session.close();
    expect(mockConnection.finish).toHaveBeenCalled();
  });

  it('envoie un KeepAlive toutes les 5s après ouverture (FIX 3)', () => {
    createDeepgramSession(() => {}, () => {});
    if (mockHandlers['Open']) mockHandlers['Open']();
    jest.advanceTimersByTime(5000);
    expect(mockConnection.send).toHaveBeenCalledWith(JSON.stringify({ type: 'KeepAlive' }));
  });
});
