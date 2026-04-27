const { supabase } = require('./database');
const logger = require('../utils/logger');

// Charge toutes les données produit + FAQ depuis Supabase — appelé UNE SEULE FOIS avant Gemini
async function loadProduct(productId) {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('id', productId)
      .single();
    if (error) throw error;
    return data;
  } catch (err) {
    logger.error('loadProduct', { error: err.message, productId });
    throw err;
  }
}

// Injecte les variables produit + commande dans le template du prompt
function buildOutboundPrompt(template, product, orderData = {}) {
  return template
    .replace('{shopName}',      product.shop_name || '')
    .replace('{productName}',   product.product_name || '')
    .replace('{price}',         String(orderData.price ?? product.price ?? ''))
    .replace('{address}',       orderData.address || '')
    .replace('{deliveryDelay}', product.delivery_delay || orderData.deliveryDelay || '')
    .replace('{guarantee}',     product.guarantee || '7 jours')
    .replace('{faq_ar}',        product.faq_ar || '')
    .replace('{faq_fr}',        product.faq_fr || '');
}

module.exports = { loadProduct, buildOutboundPrompt };
