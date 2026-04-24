const express = require('express');
const twilio = require('twilio');
const config = require('../config');
const logger = require('../utils/logger');

const router = express.Router();

router.get('/test-call', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML_PAGE);
});

router.post('/token', (req, res) => {
  const apiKey = process.env.TWILIO_API_KEY;
  const apiSecret = process.env.TWILIO_API_SECRET;
  const twimlAppSid = process.env.TWILIO_TWIML_APP_SID;

  if (!apiKey || !apiSecret || !twimlAppSid) {
    logger.warn('Variables Twilio manquantes pour /token', {
      apiKey: !!apiKey, apiSecret: !!apiSecret, twimlAppSid: !!twimlAppSid
    });
    return res.status(503).json({
      error: 'Configurez TWILIO_API_KEY, TWILIO_API_SECRET et TWILIO_TWIML_APP_SID'
    });
  }

  const { AccessToken } = twilio.jwt;
  const { VoiceGrant } = AccessToken;

  const grant = new VoiceGrant({
    outgoingApplicationSid: twimlAppSid,
    incomingAllow: true
  });

  const token = new AccessToken(config.twilio.accountSid, apiKey, apiSecret, {
    identity: 'karim-test',
    ttl: 3600
  });
  token.addGrant(grant);

  logger.info('Access Token généré pour test-call');
  res.json({ token: token.toJwt() });
});

const HTML_PAGE = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Test — Appeler Karim</title>
  <script src="https://sdk.twilio.com/js/client/v1.14/twilio.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: #000;
      color: #fff;
      font-family: 'Segoe UI', system-ui, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .card {
      background: #0d0d0d;
      border: 1px solid #1e1e1e;
      border-radius: 20px;
      padding: 48px 40px;
      text-align: center;
      width: 300px;
    }

    h1 { font-size: 1.5rem; font-weight: 700; letter-spacing: 0.3px; }
    .sub { color: #555; font-size: 0.8rem; margin-top: 4px; margin-bottom: 36px; }

    #btn {
      width: 100px;
      height: 100px;
      border-radius: 50%;
      border: none;
      background: #ff6600;
      color: #fff;
      font-size: 2rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 28px;
      transition: background 0.2s, transform 0.1s, box-shadow 0.2s;
      box-shadow: 0 0 0 0 rgba(255,102,0,0.4);
    }
    #btn:hover:not(:disabled) { background: #e05a00; }
    #btn:active:not(:disabled) { transform: scale(0.93); }
    #btn:disabled { background: #333; cursor: not-allowed; }
    #btn.ringing { animation: ring-pulse 1.2s ease-in-out infinite; }
    #btn.connected { background: #cc2200; box-shadow: none; }

    @keyframes ring-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(255,102,0,0.5); }
      50%       { box-shadow: 0 0 0 18px rgba(255,102,0,0); }
    }

    .status-row {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      font-size: 0.8rem;
      color: #666;
      min-height: 22px;
    }

    .dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: #444;
      flex-shrink: 0;
      transition: background 0.3s;
    }
    .dot.ring  { background: #ff6600; animation: blink 0.8s step-end infinite; }
    .dot.live  { background: #00cc66; }
    .dot.error { background: #cc2200; }

    @keyframes blink { 0%,100% { opacity:1; } 50% { opacity:0.2; } }

    #status-text.live  { color: #00cc66; }
    #status-text.error { color: #cc4444; }
    #status-text.ring  { color: #ff6600; }

    .hint {
      margin-top: 22px;
      font-size: 0.68rem;
      color: #252525;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Karim</h1>
    <p class="sub">Agent vocal · Darija / Français</p>

    <button id="btn" onclick="toggleCall()" title="Appeler Karim">📞</button>

    <div class="status-row">
      <span class="dot" id="dot"></span>
      <span id="status-text">Prêt</span>
    </div>

    <p class="hint">
      Requiert TWILIO_API_KEY<br>
      TWILIO_API_SECRET · TWILIO_TWIML_APP_SID
    </p>
  </div>

  <script>
    var device = null;
    var activeConn = null;

    function ui(state, text) {
      var btn = document.getElementById('btn');
      var dot = document.getElementById('dot');
      var label = document.getElementById('status-text');

      dot.className = 'dot' + (state === 'live' ? ' live' : state === 'ring' ? ' ring' : state === 'error' ? ' error' : '');
      label.className = (state === 'live' ? 'live' : state === 'error' ? 'error' : state === 'ring' ? 'ring' : '');
      label.textContent = text;

      btn.className = state === 'ring' ? 'ringing' : state === 'live' ? 'connected' : '';
      btn.innerHTML = state === 'live' ? '📵' : '📞';
      btn.disabled = (state === 'init');
    }

    function getDevice(cb) {
      ui('init', 'Initialisation...');
      fetch('/token', { method: 'POST' })
        .then(function(res) { return res.json().then(function(d) { return { ok: res.ok, data: d }; }); })
        .then(function(r) {
          if (!r.ok) { ui('error', r.data.error || 'Erreur token'); return cb(null); }

          var d = new Twilio.Device(r.data.token, { debug: false });
          d.on('ready',      function() { ui('idle', 'Prêt'); });
          d.on('connect',    function() { ui('live', 'Connecté'); });
          d.on('disconnect', function() { activeConn = null; ui('idle', 'Déconnecté'); });
          d.on('error',      function(e) { ui('error', e.message || 'Erreur Twilio'); });
          cb(d);
        })
        .catch(function() { ui('error', 'Réseau indisponible'); cb(null); });
    }

    function toggleCall() {
      if (activeConn) { activeConn.disconnect(); return; }

      if (!device) {
        getDevice(function(d) {
          if (!d) return;
          device = d;
          ui('ring', 'Appel en cours...');
          activeConn = device.connect();
        });
        return;
      }

      ui('ring', 'Appel en cours...');
      activeConn = device.connect();
    }
  </script>
</body>
</html>`;

module.exports = router;
