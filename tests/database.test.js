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

const mockChain = {
  from: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  single: jest.fn(),
  eq: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  delete: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  rpc: jest.fn()
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => mockChain
}));

const db = require('../src/services/database');

describe('database service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockChain).forEach(k => {
      if (k !== 'single' && k !== 'rpc') mockChain[k].mockReturnThis();
    });
  });

  describe('createWorkspace', () => {
    it('crée un workspace et retourne les données', async () => {
      const workspace = { id: 'uuid-1', nom: 'Konfident', email: 'admin@konfident.dz', created_at: '2026-04-24T11:00:00.000Z' };
      mockChain.single.mockResolvedValue({ data: workspace, error: null });

      const result = await db.createWorkspace({ nom: 'Konfident', email: 'admin@konfident.dz' });
      expect(result).toEqual(workspace);
      expect(mockChain.from).toHaveBeenCalledWith('workspaces');
    });

    it('lève une erreur si Supabase échoue', async () => {
      mockChain.single.mockResolvedValue({ data: null, error: new Error('DB error') });
      await expect(db.createWorkspace({ nom: 'Test' })).rejects.toThrow('DB error');
    });
  });

  describe('createCall', () => {
    it('crée un appel inbound', async () => {
      const call = { id: 'call-uuid', direction: 'inbound', statut: 'en_cours', created_at: '2026-04-24T11:00:00.000Z' };
      mockChain.single.mockResolvedValue({ data: call, error: null });

      const result = await db.createCall({ campaign_id: null, contact_id: null, direction: 'inbound' });
      expect(result.direction).toBe('inbound');
      expect(mockChain.from).toHaveBeenCalledWith('calls');
    });
  });

  describe('updateCall', () => {
    it('met à jour statut et durée', async () => {
      const updated = { id: 'call-uuid', statut: 'terminé', duree_secondes: 87 };
      mockChain.single.mockResolvedValue({ data: updated, error: null });

      const result = await db.updateCall('call-uuid', { statut: 'terminé', duree_secondes: 87 });
      expect(result.statut).toBe('terminé');
      expect(result.duree_secondes).toBe(87);
    });
  });

  describe('insertTranscript', () => {
    it('insère un transcript agent en arabe', async () => {
      const transcript = { id: 'tr-uuid', call_id: 'call-uuid', role: 'agent', message: 'السلام عليكم', langue: 'ar' };
      mockChain.single.mockResolvedValue({ data: transcript, error: null });

      const result = await db.insertTranscript({ call_id: 'call-uuid', role: 'agent', message: 'السلام عليكم', langue: 'ar' });
      expect(result.role).toBe('agent');
      expect(result.langue).toBe('ar');
    });
  });

  describe('getContactsByStatus', () => {
    it('retourne les contacts en attente', async () => {
      const contacts = [
        { id: 'c-1', telephone: '+213555000111', nom: 'Ahmed', statut: 'en_attente' }
      ];
      const chainWithThen = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        then: (resolve) => resolve({ data: contacts, error: null })
      };
      mockChain.from.mockReturnValueOnce(chainWithThen);

      const result = await db.getContactsByStatus('campaign-uuid', 'en_attente');
      expect(Array.isArray(result)).toBe(true);
      expect(result[0].telephone).toBe('+213555000111');
    });
  });
});
