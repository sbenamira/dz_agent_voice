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

jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));

const mockUpdateCallStatus = jest.fn().mockResolvedValue({ id: 'call-uuid' });

jest.mock('../src/services/database', () => ({
  updateCallStatus: mockUpdateCallStatus,
  supabase: {}
}));

const outboundFunctions = require('../src/functions/outbound-functions');

beforeEach(() => jest.clearAllMocks());

describe('confirm_order', () => {
  test('appelle updateCallStatus avec "confirmé"', async () => {
    const result = await outboundFunctions.confirm_order({}, 'call-123');
    expect(mockUpdateCallStatus).toHaveBeenCalledWith('call-123', 'confirmé');
    expect(result.success).toBe(true);
  });

  test('accepte des notes optionnelles sans erreur', async () => {
    await expect(
      outboundFunctions.confirm_order({ notes: 'RAS' }, 'call-456')
    ).resolves.toEqual({ success: true });
  });

  test('fonctionne sans arguments', async () => {
    await expect(
      outboundFunctions.confirm_order(undefined, 'call-789')
    ).resolves.toEqual({ success: true });
  });
});

describe('cancel_order', () => {
  test('appelle updateCallStatus avec "annulé_client"', async () => {
    const result = await outboundFunctions.cancel_order({ reason: 'trop cher' }, 'call-123');
    expect(mockUpdateCallStatus).toHaveBeenCalledWith('call-123', 'annulé_client');
    expect(result.success).toBe(true);
  });

  test('fonctionne sans arguments', async () => {
    await expect(
      outboundFunctions.cancel_order(undefined, 'call-789')
    ).resolves.toEqual({ success: true });
  });
});

describe('request_human_callback', () => {
  test('appelle updateCallStatus avec "rappel_humain"', async () => {
    const result = await outboundFunctions.request_human_callback({ reason: 'question technique' }, 'call-123');
    expect(mockUpdateCallStatus).toHaveBeenCalledWith('call-123', 'rappel_humain');
    expect(result.success).toBe(true);
  });
});

describe('propagation erreur DB', () => {
  test('propage l\'erreur si updateCallStatus rejette', async () => {
    mockUpdateCallStatus.mockRejectedValueOnce(new Error('DB down'));
    await expect(
      outboundFunctions.confirm_order({}, 'call-err')
    ).rejects.toThrow('DB down');
  });
});
