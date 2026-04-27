process.env.GROQ_API_KEY        = 'test';
process.env.TWILIO_ACCOUNT_SID  = 'test';
process.env.TWILIO_AUTH_TOKEN   = 'test';
process.env.TWILIO_PHONE_NUMBER = '+1234567890';
process.env.DEEPGRAM_API_KEY    = 'test';
process.env.ELEVENLABS_API_KEY  = 'test';
process.env.ELEVENLABS_VOICE_ID = 'test';
process.env.OPENAI_API_KEY      = 'test';
process.env.SUPABASE_URL        = 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY   = 'test';
process.env.GOOGLE_API_KEY      = 'test-google-key';

jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));

const EventEmitter = require('events');

// Instance Gemini WS capturée à chaque new WebSocket()
let mockGeminiWs;

jest.mock('ws', () => {
  // EventEmitter doit être requis à l'intérieur du factory (règle Jest out-of-scope)
  const { EventEmitter } = require('events');
  const MockWS = jest.fn().mockImplementation(() => {
    mockGeminiWs = new EventEmitter();
    mockGeminiWs.readyState = 1; // OPEN
    mockGeminiWs.send       = jest.fn();
    mockGeminiWs.close      = jest.fn().mockImplementation(() => {
      mockGeminiWs.readyState = 3; // CLOSED
    });
    return mockGeminiWs;
  });
  MockWS.OPEN       = 1;
  MockWS.CONNECTING = 0;
  MockWS.CLOSING    = 2;
  MockWS.CLOSED     = 3;
  MockWS.Server     = jest.fn();
  return MockWS;
});

const { createGeminiLiveSession, mulawToPcm16k, pcm24kToMulaw } = require('../src/services/gemini-live');

// ── Conversion audio ──────────────────────────────────────────────────────────

describe('conversion audio', () => {
  test('mulawToPcm16k produit 4 octets par octet mulaw (upsample ×2)', () => {
    const mulaw = Buffer.from([0xFF, 0x7F, 0x00]);
    expect(mulawToPcm16k(mulaw).length).toBe(12);
  });

  test('mulawToPcm16k retourne un Buffer vide pour entrée vide', () => {
    expect(mulawToPcm16k(Buffer.alloc(0)).length).toBe(0);
  });

  test('pcm24kToMulaw produit ⌊N_samples/3⌋ octets (downsample ÷3)', () => {
    const pcm = Buffer.alloc(60); // 30 samples 16-bit à 24kHz
    expect(pcm24kToMulaw(pcm).length).toBe(10);
  });

  test('pcm24kToMulaw retourne un Buffer vide pour entrée vide', () => {
    expect(pcm24kToMulaw(Buffer.alloc(0)).length).toBe(0);
  });

  test('résultat pcm24kToMulaw est un Buffer d\'octets valides (0–255)', () => {
    const pcm   = Buffer.alloc(12, 0x10); // 6 samples
    const mulaw = pcm24kToMulaw(pcm);
    expect(mulaw.length).toBe(2);
    for (const byte of mulaw) {
      expect(byte).toBeGreaterThanOrEqual(0);
      expect(byte).toBeLessThanOrEqual(255);
    }
  });
});

// ── createGeminiLiveSession ───────────────────────────────────────────────────

describe('createGeminiLiveSession', () => {
  let wsClient, session;

  beforeEach(() => {
    wsClient            = new EventEmitter();
    wsClient.readyState = 1;
    wsClient.send       = jest.fn();
    session             = null;
  });

  afterEach(() => {
    if (session) session.close();
  });

  test('envoie le message setup avec le modèle et le prompt au open', () => {
    const functions = { confirm_order: jest.fn(), cancel_order: jest.fn() };
    session = createGeminiLiveSession(wsClient, 'Prompt système', functions, jest.fn());

    mockGeminiWs.emit('open');

    expect(mockGeminiWs.send).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(mockGeminiWs.send.mock.calls[0][0]);
    expect(msg.setup).toBeDefined();
    expect(msg.setup.model).toContain('gemini');
    expect(msg.setup.systemInstruction.parts[0].text).toBe('Prompt système');
    expect(msg.setup.tools[0].functionDeclarations).toHaveLength(2);
  });

  test('émet gemini-audio quand Gemini produit de l\'audio', () => {
    const audioHandler = jest.fn();
    wsClient.on('gemini-audio', audioHandler);

    session = createGeminiLiveSession(wsClient, 'Prompt', {}, jest.fn());
    mockGeminiWs.emit('open');
    mockGeminiWs.emit('message', JSON.stringify({ setupComplete: true }));

    const pcmData = Buffer.alloc(60, 0).toString('base64'); // 30 samples 24kHz
    mockGeminiWs.emit('message', JSON.stringify({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: pcmData } }] }
      }
    }));

    expect(audioHandler).toHaveBeenCalledTimes(1);
    expect(audioHandler.mock.calls[0][0]).toBeInstanceOf(Buffer);
  });

  test('émet gemini-turn-complete à la fin d\'un tour', () => {
    const handler = jest.fn();
    wsClient.on('gemini-turn-complete', handler);

    session = createGeminiLiveSession(wsClient, 'Prompt', {}, jest.fn());
    mockGeminiWs.emit('open');
    mockGeminiWs.emit('message', JSON.stringify({ serverContent: { turnComplete: true } }));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('émet gemini-interrupted quand le client coupe la parole', () => {
    const handler = jest.fn();
    wsClient.on('gemini-interrupted', handler);

    session = createGeminiLiveSession(wsClient, 'Prompt', {}, jest.fn());
    mockGeminiWs.emit('open');
    mockGeminiWs.emit('message', JSON.stringify({ serverContent: { interrupted: true } }));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('appelle onFunctionCall et renvoie la réponse toolResponse à Gemini', async () => {
    const onFunctionCall = jest.fn().mockResolvedValue({ success: true });
    session = createGeminiLiveSession(wsClient, 'Prompt', { confirm_order: jest.fn() }, onFunctionCall);
    mockGeminiWs.emit('open');
    mockGeminiWs.emit('message', JSON.stringify({ setupComplete: true }));

    mockGeminiWs.emit('message', JSON.stringify({
      toolCall: {
        functionCalls: [{ id: 'fc-1', name: 'confirm_order', args: { notes: 'OK' } }]
      }
    }));

    await new Promise(r => setImmediate(r));

    expect(onFunctionCall).toHaveBeenCalledWith('confirm_order', { notes: 'OK' });
    const lastSend = JSON.parse(mockGeminiWs.send.mock.calls.at(-1)[0]);
    expect(lastSend.toolResponse.functionResponses[0].id).toBe('fc-1');
    expect(lastSend.toolResponse.functionResponses[0].response.output.success).toBe(true);
  });

  test('sendAudio n\'envoie rien avant setupComplete', () => {
    session = createGeminiLiveSession(wsClient, 'Prompt', {}, jest.fn());
    // Pas de 'open' ni 'setupComplete'
    session.sendAudio(Buffer.from([0xFF, 0x7F]));
    expect(mockGeminiWs.send).not.toHaveBeenCalled();
  });

  test('sendAudio convertit mulaw en PCM 16kHz et envoie à Gemini', () => {
    session = createGeminiLiveSession(wsClient, 'Prompt', {}, jest.fn());
    mockGeminiWs.emit('open');
    mockGeminiWs.emit('message', JSON.stringify({ setupComplete: true }));

    session.sendAudio(Buffer.from([0xFF, 0x7F, 0x00]));

    const audioMsg = JSON.parse(mockGeminiWs.send.mock.calls[1][0]);
    expect(audioMsg.realtimeInput.audio.mimeType).toBe('audio/pcm;rate=16000');
    expect(typeof audioMsg.realtimeInput.audio.data).toBe('string');
  });

  test('close() ferme le WebSocket Gemini', () => {
    session = createGeminiLiveSession(wsClient, 'Prompt', {}, jest.fn());
    mockGeminiWs.emit('open');
    session.close();
    expect(mockGeminiWs.close).toHaveBeenCalled();
  });
});
