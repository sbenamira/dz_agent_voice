const config = require('../config');
const logger = require('../utils/logger');
const db = require('./database');
const telephony = require('./telephony');

const MAX_RETRIES = 2;
const RETRY_STATUSES = ['no-answer', 'busy', 'failed'];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Détermine le résultat d'un appel selon son statut Twilio et sa durée
function detectResult(twilioStatus, dureeSecondes) {
  if (twilioStatus === 'no-answer' || twilioStatus === 'busy') return 'pas_répondu';
  if (twilioStatus === 'failed') return 'échec';
  if (dureeSecondes < 10) return 'raccroché';
  return 'complété';
}

// Lance tous les appels d'une campagne outbound de façon séquentielle
async function runCampaign(campaignId, baseUrl) {
  try {
    await db.updateCampaignStatus(campaignId, 'en_cours');
    logger.info('Campagne démarrée', { campaignId });

    const contacts = await db.getContactsByStatus(campaignId, 'en_attente');
    logger.info('Contacts à appeler', { campaignId, total: contacts.length });

    const webhookUrl = `${baseUrl}/inbound`;

    for (const contact of contacts) {
      let done = false;

      for (let attempt = 1; attempt <= MAX_RETRIES && !done; attempt++) {
        try {
          logger.info('Appel contact', { telephone: contact.telephone, attempt });

          const callRecord = await db.createCall({
            campaign_id: campaignId,
            contact_id: contact.id,
            direction: 'outbound'
          });

          const twilioCall = await telephony.initiateCall(contact.telephone, webhookUrl);

          // Polling jusqu'à la fin de l'appel (max 120s)
          let status = 'queued';
          let waited = 0;
          const terminalStatuses = ['completed', 'failed', 'busy', 'no-answer', 'canceled'];
          while (!terminalStatuses.includes(status) && waited < 120000) {
            await sleep(2000);
            waited += 2000;
            status = await telephony.getCallStatus(twilioCall.sid);
          }

          const dureeSecondes = Math.round(waited / 1000);
          const resultat = detectResult(status, dureeSecondes);

          await db.updateCall(callRecord.id, { statut: 'terminé', duree_secondes: dureeSecondes, resultat });

          if (RETRY_STATUSES.includes(status) && attempt < MAX_RETRIES) {
            logger.info('Retry planifié', { telephone: contact.telephone, attempt });
            await sleep(config.calls.delayMs * 2);
          } else {
            done = true;
            const contactStatut = RETRY_STATUSES.includes(status) ? 'pas_répondu' : 'appelé';
            await db.updateContactStatus(contact.id, contactStatut);
          }
        } catch (err) {
          logger.error('Erreur appel contact', { telephone: contact.telephone, error: err.message, attempt });
          await db.updateContactStatus(contact.id, 'erreur');
          done = true;
        }
      }

      await sleep(config.calls.delayMs);
    }

    await db.updateCampaignStatus(campaignId, 'terminée');
    logger.info('Campagne terminée', { campaignId });
  } catch (err) {
    logger.error('runCampaign', { error: err.message, campaignId });
    await db.updateCampaignStatus(campaignId, 'erreur');
    throw err;
  }
}

module.exports = { runCampaign, detectResult };
