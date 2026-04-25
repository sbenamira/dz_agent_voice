process.env.GROQ_API_KEY = 'test';
process.env.DEEPGRAM_API_KEY = 'test';
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
jest.mock('../src/services/campaign', () => ({
  runCampaign: jest.fn().mockResolvedValue(undefined),
  detectResult: jest.fn((status, dur) => dur < 10 ? 'raccroché' : 'complété')
}));
jest.mock('../src/services/database', () => ({
  insertContacts: jest.fn().mockResolvedValue([]),
  getCallStats: jest.fn().mockResolvedValue([
    { resultat: 'intéressé', duree_secondes: 45, created_at: '2026-04-24T11:00:00.000Z' },
    { resultat: 'refus', duree_secondes: 12, created_at: '2026-04-24T11:01:00.000Z' },
    { resultat: 'intéressé', duree_secondes: 67, created_at: '2026-04-24T11:02:00.000Z' }
  ])
}));
jest.mock('../src/utils/excel', () => ({
  parseContactsExcel: jest.fn().mockReturnValue([
    { telephone: '+213555000111', nom: 'Ahmed', donnees_custom: {} }
  ]),
  validatePhoneNumber: jest.fn().mockReturnValue(true)
}));

const express = require('express');
const http = require('http');

describe('outbound route', () => {
  let server;

  beforeAll((done) => {
    const router = require('../src/routes/outbound');
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
    const str = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(str), host: 'localhost' }
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => cb(null, res, JSON.parse(data)));
    });
    req.on('error', cb);
    req.write(str);
    req.end();
  }

  it('POST /start lance la campagne et retourne success', (done) => {
    post('/start', { campaignId: 'campaign-uuid' }, (err, res, body) => {
      expect(res.statusCode).toBe(200);
      expect(body.success).toBe(true);
      expect(body.campaignId).toBe('campaign-uuid');
      done(err);
    });
  });

  it('POST /start retourne 400 sans campaignId', (done) => {
    post('/start', {}, (err, res, body) => {
      expect(res.statusCode).toBe(400);
      expect(body.error).toBeTruthy();
      done(err);
    });
  });

  it('GET /stats retourne les statistiques agrégées', (done) => {
    const port = server.address().port;
    http.get(`http://localhost:${port}/stats/campaign-uuid`, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        const body = JSON.parse(data);
        expect(body.total).toBe(3);
        expect(body['intéressé']).toBe(2);
        expect(body['refus']).toBe(1);
        expect(body.duree_totale).toBe(124);
        done();
      });
    }).on('error', done);
  });

  it('detectResult retourne raccroché pour appel court', () => {
    const { detectResult } = require('../src/services/campaign');
    expect(detectResult('completed', 5)).toBe('raccroché');
  });

  it('detectResult retourne complété pour appel normal', () => {
    const { detectResult } = require('../src/services/campaign');
    expect(detectResult('completed', 60)).toBe('complété');
  });
});
