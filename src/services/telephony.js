const twilio = require('twilio');
const config = require('../config');
const logger = require('../utils/logger');

let client = null;

function getTwilioClient() {
  if (!client) {
    client = twilio(config.twilio.accountSid, config.twilio.authToken);
  }
  return client;
}

// Lance un appel sortant vers un numéro
async function initiateCall(to, webhookUrl) {
  try {
    const call = await getTwilioClient().calls.create({
      to,
      from: config.twilio.phoneNumber,
      url: webhookUrl
    });
    logger.info('Appel initié', { to, callSid: call.sid });
    return call;
  } catch (err) {
    logger.error('initiateCall', { error: err.message, to });
    throw err;
  }
}

// Récupère le statut d'un appel en cours
async function getCallStatus(callSid) {
  try {
    const call = await getTwilioClient().calls(callSid).fetch();
    return call.status;
  } catch (err) {
    logger.error('getCallStatus', { error: err.message, callSid });
    throw err;
  }
}

// Génère le TwiML pour connecter un appel au WebSocket media stream
function generateTwiMLStream(streamUrl, callSid) {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();
  const connect = response.connect();
  const stream = connect.stream({ url: streamUrl });
  if (callSid) stream.parameter({ name: 'callSid', value: callSid });
  return response.toString();
}

// Génère un TwiML simple de rejet
function generateTwiMLReject() {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();
  response.reject();
  return response.toString();
}

module.exports = { getTwilioClient, initiateCall, getCallStatus, generateTwiMLStream, generateTwiMLReject };
