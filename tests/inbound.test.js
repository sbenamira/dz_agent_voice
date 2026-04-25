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
jest.mock('../src/services/database', () => ({
  createCall: jest.fn().mockResolvedValue({ id: 'call-uuid', direction: 'inbound', created_at: '2026-04-24T11:00:00.000Z' }),
  updateCall: jest.fn().mockResolvedValue({ id: 'call-uuid' }),
  insertTranscript: jest.fn().mockResolvedValue({ id: 'tr-uuid' })
}));
jest.mock('../src/services/agent', () => ({
  streamResponse: jest.fn().mockResolvedValue('واخا سيدي'),
  isArabic: jest.fn().mockReturnValue(true)
}));
jest.mock('../src/services/stt', () => ({
  createDeepgramSession: jest.fn().mockReturnValue({ send: jest.fn(), close: jest.fn() })
}));
jest.mock('../src/services/tts', () => ({
  synthesize: jest.fn().mockResolvedValue(Buffer.from([0x7f]))
}));
jest.mock('@deepgram/sdk', () => ({
  createClient: jest.fn(),
  LiveTranscriptionEvents: { Open: 'open', Transcript: 'transcript', Error: 'error', Close: 'close' }
}));

const express = require('express');
const http = require('http');

describe('inbound route', () => {
  let server;

  beforeAll((done) => {
    const { router } = require('../src/routes/inbound');
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use('/', router);
    server = http.createServer(app);
    server.listen(0, done);
  });

  afterAll((done) => { server.close(done); });

  it('POST /inbound retourne TwiML XML avec Stream', (done) => {
    const postData = 'CallSid=CA1234&From=%2B213555000111&To=%2B12296335468';
    const port = server.address().port;

    const req = http.request({
      hostname: 'localhost',
      port,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        host: 'localhost'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/xml/i);
        expect(data).toContain('Stream');
        done();
      });
    });

    req.on('error', done);
    req.write(postData);
    req.end();
  });

  it('le TwiML contient Connect et Stream url wss://', (done) => {
    const postData = 'CallSid=CA5678';
    const port = server.address().port;

    const req = http.request({
      hostname: 'localhost',
      port,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        host: 'myapp.onrender.com'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        expect(data).toContain('Connect');
        expect(data).toContain('wss://');
        done();
      });
    });

    req.on('error', done);
    req.write(postData);
    req.end();
  });
});
