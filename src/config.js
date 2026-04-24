require('dotenv').config();

const logger = require('./utils/logger');

const REQUIRED_KEYS = [
  'ANTHROPIC_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'DEEPGRAM_API_KEY',
  'OPENAI_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY'
];

function validate() {
  const missing = REQUIRED_KEYS.filter(key => !process.env[key]);
  if (missing.length > 0) {
    logger.error('Variables d\'environnement manquantes', { missing });
    process.exit(1);
  }
}

validate();

module.exports = {
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-haiku-4-5-20251001'
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    phoneNumber: process.env.TWILIO_PHONE_NUMBER
  },
  deepgram: {
    apiKey: process.env.DEEPGRAM_API_KEY
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    embeddingModel: 'text-embedding-3-small'
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY
  },
  server: {
    port: parseInt(process.env.PORT) || 3000,
    baseUrl: process.env.BASE_URL || ''
  },
  calls: {
    maxConcurrent: parseInt(process.env.MAX_CONCURRENT_CALLS) || 10,
    delayMs: parseInt(process.env.CALL_DELAY_MS) || 2000
  }
};
