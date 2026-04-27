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

jest.mock('../src/services/campaign', () => ({
  runCampaign:  jest.fn().mockResolvedValue(undefined),
  detectResult: jest.fn((status, dur) => dur < 10 ? 'raccroché' : 'complété')
}));

const mockUpdateCallStatus = jest.fn().mockResolvedValue({ id: 'call-uuid' });
const mockUpdateCall       = jest.fn().mockResolvedValue({ id: 'call-uuid' });

jest.mock('../src/services/database', () => ({
  insertContacts:   jest.fn().mockResolvedValue([]),
  getCallStats:     jest.fn().mockResolvedValue([
    { resultat: 'confirmé',      duree_secondes: 45 },
    { resultat: 'annulé_client', duree_secondes: 20 },
    { resultat: 'confirmé',      duree_secondes: 60 }
  ]),
  createCall:       jest.fn().mockResolvedValue({ id: 'call-uuid' }),
  updateCall:       mockUpdateCall,
  updateCallStatus: mockUpdateCallStatus,
  supabase:         {}
}));

const mockInitiateCall = jest.fn().mockResolvedValue({ sid: 'CA123', status: 'queued' });
jest.mock('../src/services/telephony', () => ({
  initiateCall:        mockInitiateCall,
  getCallStatus:       jest.fn().mockResolvedValue('in-progress'),
  generateTwiMLStream: jest.fn().mockReturnValue('<Response/>')
}));

jest.mock('../src/services/gemini-live', () => ({
  createGeminiLiveSession: jest.fn().mockReturnValue({
    sendAudio: jest.fn(),
    close:     jest.fn(),
    rebind:    jest.fn(),
    isReady:   jest.fn(() => false)
  })
}));

jest.mock('../src/services/product', () => ({
  loadProduct: jest.fn().mockResolvedValue({
    id: 'prod-uuid', shop_name: 'Test Shop', product_name: 'Produit Test',
    price: 1000, delivery_delay: '2 jours', guarantee: '7 jours', faq_ar: '', faq_fr: ''
  }),
  buildOutboundPrompt: jest.fn().mockReturnValue('Prompt injecté')
}));

jest.mock('../src/functions/outbound-functions', () => ({
  confirm_order:          jest.fn().mockResolvedValue({ success: true }),
  cancel_order:           jest.fn().mockResolvedValue({ success: true }),
  request_human_callback: jest.fn().mockResolvedValue({ success: true })
}));

jest.mock('../src/utils/excel', () => ({
  parseContactsExcel:  jest.fn().mockReturnValue([
    { telephone: '+213555000111', nom: 'Ahmed', donnees_custom: {} }
  ]),
  validatePhoneNumber: jest.fn().mockReturnValue(true)
}));

const express = require('express');
const http    = require('http');

describe('outbound route', () => {
  let server;

  beforeAll((done) => {
    const { router } = require('../src/routes/outbound');
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use('/', router);
    server = http.createServer(app);
    server.listen(0, done);
  });

  afterAll((done) => { server.close(done); });

  function post(path, body, cb) {
    const port = server.address().port;
    const str  = JSON.stringify(body);
    const req  = http.request({
      hostname: 'localhost', port, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(str),
        host: 'localhost'
      }
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
        cb(null, res, parsed);
      });
    });
    req.on('error', cb);
    req.write(str);
    req.end();
  }

  // ── POST /start ───────────────────────────────────────────────────────────────

  test('POST /start lance la campagne et retourne success', (done) => {
    post('/start', { campaignId: 'campaign-uuid' }, (err, res, body) => {
      expect(res.statusCode).toBe(200);
      expect(body.success).toBe(true);
      expect(body.campaignId).toBe('campaign-uuid');
      done(err);
    });
  });

  test('POST /start retourne 400 sans campaignId', (done) => {
    post('/start', {}, (err, res, body) => {
      expect(res.statusCode).toBe(400);
      expect(body.error).toBeTruthy();
      done(err);
    });
  });

  // ── POST /call ────────────────────────────────────────────────────────────────

  test('POST /call crée l\'appel avec productId et retourne callSid + callId', (done) => {
    post('/call', {
      telephone: '+213555000111', productId: 'prod-uuid',
      price: 2500, address: 'Alger', deliveryDelay: '2 jours'
    }, (err, res, body) => {
      expect(res.statusCode).toBe(200);
      expect(body.success).toBe(true);
      expect(body.callSid).toBe('CA123');
      expect(body.callId).toBe('call-uuid');
      done(err);
    });
  });

  test('POST /call fonctionne sans productId (appel ad-hoc)', (done) => {
    post('/call', { telephone: '+213555000111' }, (err, res, body) => {
      expect(res.statusCode).toBe(200);
      expect(body.success).toBe(true);
      done(err);
    });
  });

  test('POST /call retourne 400 sans telephone', (done) => {
    post('/call', { productId: 'prod-uuid' }, (err, res, body) => {
      expect(res.statusCode).toBe(400);
      expect(body.error).toContain('telephone');
      done(err);
    });
  });

  test('POST /call retourne 400 si numéro invalide', (done) => {
    const { validatePhoneNumber } = require('../src/utils/excel');
    validatePhoneNumber.mockReturnValueOnce(false);
    post('/call', { telephone: '0555000111' }, (err, res, body) => {
      expect(res.statusCode).toBe(400);
      expect(body.error).toContain('invalide');
      done(err);
    });
  });

  test('POST /call appelle initiateCall avec l\'URL webhook correcte', (done) => {
    mockInitiateCall.mockClear();
    post('/call', { telephone: '+213666000222', productId: 'prod-abc' }, (err, res) => {
      expect(res.statusCode).toBe(200);
      expect(mockInitiateCall).toHaveBeenCalledTimes(1);
      const [phone, webhookUrl] = mockInitiateCall.mock.calls[0];
      expect(phone).toBe('+213666000222');
      expect(webhookUrl).toContain('/outbound/webhook');
      done(err);
    });
  });

  // ── POST /webhook/status ──────────────────────────────────────────────────────

  test('POST /webhook/status retourne 200 pour no-answer', (done) => {
    post('/webhook/status', { CallSid: 'CA-unknown', CallStatus: 'no-answer' }, (err, res) => {
      expect(res.statusCode).toBe(200);
      done(err);
    });
  });

  test('POST /webhook/status retourne 200 pour completed (pas de mise à jour)', (done) => {
    post('/webhook/status', { CallSid: 'CA-unknown', CallStatus: 'completed' }, (err, res) => {
      expect(res.statusCode).toBe(200);
      done(err);
    });
  });

  // ── GET /stats ────────────────────────────────────────────────────────────────

  test('GET /stats retourne les statistiques agrégées', (done) => {
    const port = server.address().port;
    http.get(`http://localhost:${port}/stats/campaign-uuid`, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        const body = JSON.parse(data);
        expect(body.total).toBe(3);
        expect(body['confirmé']).toBe(2);
        expect(body['annulé_client']).toBe(1);
        expect(body.duree_totale).toBe(125);
        done();
      });
    }).on('error', done);
  });
});
