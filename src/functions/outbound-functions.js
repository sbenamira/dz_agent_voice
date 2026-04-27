const { updateCallStatus } = require('../services/database');
const logger = require('../utils/logger');

// Handlers appelés par Gemini Live via function calling
const outboundFunctions = {

  confirm_order: async ({ notes } = {}, callId) => {
    await updateCallStatus(callId, 'confirmé');
    logger.info('[OUTBOUND] Confirmé', { callId, notes });
    return { success: true };
  },

  cancel_order: async ({ reason } = {}, callId) => {
    await updateCallStatus(callId, 'annulé_client');
    logger.info('[OUTBOUND] Annulé', { callId, reason });
    return { success: true };
  },

  request_human_callback: async ({ reason } = {}, callId) => {
    await updateCallStatus(callId, 'rappel_humain');
    logger.info('[OUTBOUND] Rappel humain', { callId, reason });
    return { success: true };
  }
};

module.exports = outboundFunctions;
