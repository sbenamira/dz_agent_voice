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

const mockSingle = jest.fn();
const mockEq     = jest.fn(() => ({ single: mockSingle }));
const mockSelect = jest.fn(() => ({ eq: mockEq }));
const mockFrom   = jest.fn(() => ({ select: mockSelect }));

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: mockFrom })
}));

const { loadProduct, buildOutboundPrompt } = require('../src/services/product');

const PRODUCT_FIXTURE = {
  id: 'prod-uuid',
  shop_name: 'TechShop DZ',
  product_name: 'Écouteurs Bluetooth',
  price: 2500,
  delivery_delay: '2 à 3 jours',
  guarantee: '7 jours',
  faq_ar: 'السؤال: هل هو أصلي؟ الجواب: نعم',
  faq_fr: 'Q: Compatible iPhone? R: Oui'
};

describe('loadProduct', () => {
  beforeEach(() => jest.clearAllMocks());

  test('retourne les données produit depuis Supabase', async () => {
    mockSingle.mockResolvedValue({ data: PRODUCT_FIXTURE, error: null });

    const result = await loadProduct('prod-uuid');

    expect(mockFrom).toHaveBeenCalledWith('products');
    expect(mockSelect).toHaveBeenCalledWith('*');
    expect(mockEq).toHaveBeenCalledWith('id', 'prod-uuid');
    expect(result).toEqual(PRODUCT_FIXTURE);
  });

  test('lève une erreur si Supabase retourne une erreur', async () => {
    mockSingle.mockResolvedValue({ data: null, error: new Error('Produit introuvable') });

    await expect(loadProduct('inconnu')).rejects.toThrow('Produit introuvable');
  });
});

describe('buildOutboundPrompt', () => {
  const template = [
    'Boutique : {shopName}',
    'Produit : {productName}',
    'Prix : {price} DA',
    'Adresse : {address}',
    'Délai : {deliveryDelay}',
    'Garantie : {guarantee}',
    'FAQ AR : {faq_ar}',
    'FAQ FR : {faq_fr}'
  ].join('\n');

  test('injecte toutes les variables produit et commande', () => {
    const order  = { price: 2200, address: 'Oran, Algérie' };
    const result = buildOutboundPrompt(template, PRODUCT_FIXTURE, order);

    expect(result).toContain('TechShop DZ');
    expect(result).toContain('Écouteurs Bluetooth');
    expect(result).toContain('2200 DA');           // prix commande prioritaire sur prix produit
    expect(result).toContain('Oran, Algérie');
    expect(result).toContain('2 à 3 jours');       // délai produit
    expect(result).toContain('7 jours');
    expect(result).toContain('السؤال: هل هو أصلي؟');
    expect(result).toContain('Compatible iPhone');
  });

  test('utilise deliveryDelay de orderData si product.delivery_delay est absent', () => {
    const prodSansDelai = { ...PRODUCT_FIXTURE, delivery_delay: null };
    const result = buildOutboundPrompt(template, prodSansDelai, { deliveryDelay: '48h' });
    expect(result).toContain('48h');
  });

  test('utilise le prix produit si orderData.price est absent', () => {
    const result = buildOutboundPrompt(template, PRODUCT_FIXTURE, { address: 'Alger' });
    expect(result).toContain('2500 DA');
  });

  test('remplace faq_ar et faq_fr par chaîne vide si nulles', () => {
    const produit = { ...PRODUCT_FIXTURE, faq_ar: null, faq_fr: null };
    const result  = buildOutboundPrompt(template, produit, {});

    expect(result).not.toContain('{faq_ar}');
    expect(result).not.toContain('{faq_fr}');
  });

  test('utilise la garantie par défaut "7 jours" si absente', () => {
    const produit = { ...PRODUCT_FIXTURE, guarantee: null };
    const result  = buildOutboundPrompt(template, produit, {});
    expect(result).toContain('7 jours');
  });

  test('ne laisse aucun token {…} non remplacé', () => {
    const result = buildOutboundPrompt(template, PRODUCT_FIXTURE, { price: 1000, address: 'Blida' });
    expect(result).not.toMatch(/\{[a-zA-Z_]+\}/);
  });
});
