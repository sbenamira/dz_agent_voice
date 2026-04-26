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
  <script src="https://unpkg.com/@twilio/voice-sdk@2/dist/twilio.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background:#000; color:#fff; font-family:'Segoe UI',system-ui,sans-serif; min-height:100vh; display:flex; align-items:center; justify-content:center; }
    .card { background:#0d0d0d; border:1px solid #1e1e1e; border-radius:20px; padding:48px 40px; text-align:center; width:300px; }
    h1 { font-size:1.5rem; font-weight:700; }
    .sub { color:#555; font-size:0.8rem; margin-top:4px; margin-bottom:36px; }
    #btn { width:100px; height:100px; border-radius:50%; border:none; background:#ff6600; color:#fff; font-size:2rem; cursor:pointer; display:flex; align-items:center; justify-content:center; margin:0 auto 28px; transition:background 0.2s,transform 0.1s; }
    #btn:hover:not(:disabled) { background:#e05a00; } #btn:active:not(:disabled) { transform:scale(0.93); }
    #btn:disabled { background:#333; cursor:not-allowed; }
    #btn.ringing { animation:ring-pulse 1.2s ease-in-out infinite; }
    #btn.connected { background:#cc2200; }
    @keyframes ring-pulse { 0%,100% { box-shadow:0 0 0 0 rgba(255,102,0,0.5); } 50% { box-shadow:0 0 0 18px rgba(255,102,0,0); } }
    .status-row { display:flex; align-items:center; justify-content:center; gap:8px; font-size:0.8rem; color:#666; min-height:22px; }
    .dot { width:7px; height:7px; border-radius:50%; background:#444; flex-shrink:0; transition:background 0.3s; }
    .dot.ring { background:#ff6600; animation:blink 0.8s step-end infinite; } .dot.live { background:#00cc66; } .dot.error { background:#cc2200; }
    @keyframes blink { 0%,100% { opacity:1; } 50% { opacity:0.2; } }
    #status-text.live { color:#00cc66; } #status-text.error { color:#cc4444; } #status-text.ring { color:#ff6600; }
    .hint { margin-top:22px; font-size:0.68rem; color:#252525; line-height:1.6; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Karim</h1>
    <p class="sub">Agent vocal · Darija / Français</p>
    <button id="btn" onclick="toggleCall()" title="Appeler Karim">📞</button>
    <div class="status-row"><span class="dot" id="dot"></span><span id="status-text">Prêt</span></div>
    <p class="hint">Requiert TWILIO_API_KEY<br>TWILIO_API_SECRET · TWILIO_TWIML_APP_SID</p>
  </div>
  <script>
    var device=null, activeCall=null;
    function ui(state,text){
      var btn=document.getElementById('btn'),dot=document.getElementById('dot'),label=document.getElementById('status-text');
      dot.className='dot'+(state==='live'?' live':state==='ring'?' ring':state==='error'?' error':'');
      label.className=(state==='live'?'live':state==='error'?'error':state==='ring'?'ring':'');
      label.textContent=text; btn.className=state==='ring'?'ringing':state==='live'?'connected':'';
      btn.innerHTML=state==='live'?'📵':'📞'; btn.disabled=(state==='init');
    }
    async function toggleCall(){
      if(activeCall){activeCall.disconnect();return;}
      ui('init','Initialisation...');
      try{
        var res=await fetch('/token',{method:'POST'}),data=await res.json();
        if(!res.ok){ui('error',data.error||'Erreur token');return;}
        device=new Twilio.Device(data.token,{logLevel:'error'});
        device.on('error',function(err){ui('error',err.message||'Erreur Twilio');});
        await device.register(); ui('ring','Appel en cours...');
        activeCall=await device.connect();
        activeCall.on('ringing',function(){ui('ring','Sonnerie...');});
        activeCall.on('accept',function(){ui('live','Connecté');});
        activeCall.on('disconnect',function(){activeCall=null;ui('idle','Déconnecté');document.getElementById('btn').disabled=false;});
        activeCall.on('error',function(e){ui('error',e.message||'Erreur appel');activeCall=null;document.getElementById('btn').disabled=false;});
      }catch(e){ui('error',e.message||'Erreur');}
    }
  </script>
</body>
</html>`;

router.get('/test-outbound', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML_OUTBOUND);
});

const HTML_OUTBOUND = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirmation Commande — Karim</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background:#000; color:#fff; font-family:'Segoe UI',system-ui,sans-serif; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; }
    .card { background:#0d0d0d; border:1px solid #1e1e1e; border-radius:20px; padding:40px 36px; width:100%; max-width:420px; }
    h1 { font-size:1.4rem; font-weight:700; margin-bottom:4px; }
    .sub { color:#555; font-size:0.8rem; margin-bottom:28px; }
    .field-group { margin-bottom:14px; }
    label { display:block; font-size:0.72rem; color:#777; margin-bottom:5px; }
    input { width:100%; background:#141414; border:1px solid #2a2a2a; border-radius:10px; padding:11px 13px; color:#fff; font-size:0.88rem; outline:none; transition:border-color 0.2s; }
    input:focus { border-color:#ff6600; }
    .row2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    button.cta { width:100%; padding:13px; background:#ff6600; color:#fff; border:none; border-radius:12px; font-size:0.95rem; font-weight:600; cursor:pointer; transition:background 0.2s; margin-top:8px; }
    button.cta:hover:not(:disabled) { background:#e05a00; } button.cta:disabled { background:#333; cursor:not-allowed; }
    .status-row { display:flex; align-items:center; gap:8px; margin-top:18px; font-size:0.8rem; color:#666; min-height:20px; }
    .dot { width:7px; height:7px; border-radius:50%; background:#333; flex-shrink:0; transition:background 0.3s; }
    .dot.calling { background:#ff6600; animation:blink 0.8s step-end infinite; } .dot.live { background:#00cc66; } .dot.done { background:#555; } .dot.error { background:#cc2200; }
    @keyframes blink { 0%,100% { opacity:1; } 50% { opacity:0.2; } }
    #status-text.calling { color:#ff6600; } #status-text.live { color:#00cc66; } #status-text.error { color:#cc4444; }
    .call-sid { margin-top:10px; font-size:0.65rem; color:#2a2a2a; word-break:break-all; }
    #order-panel { display:none; margin-top:24px; border-top:1px solid #1e1e1e; padding-top:20px; }
    #order-panel h2 { font-size:0.85rem; color:#888; margin-bottom:12px; }
    .status-grid { display:grid; grid-template-columns:1fr 1fr; gap:7px; }
    .status-grid button { background:#141414; border:1px solid #2a2a2a; border-radius:9px; color:#ccc; padding:9px 8px; font-size:0.75rem; cursor:pointer; transition:border-color 0.15s,background 0.15s; text-align:left; }
    .status-grid button:hover { border-color:#ff6600; background:#1a1a1a; }
    .status-grid button.selected { border-color:#ff6600; background:#1f0f00; color:#fff; }
    #status-saved { font-size:0.72rem; color:#00cc66; margin-top:10px; min-height:16px; }
    #transcript-panel { display:none; margin-top:24px; border-top:1px solid #1e1e1e; padding-top:20px; }
    #transcript-panel h2 { font-size:0.85rem; color:#888; margin-bottom:12px; }
    #bubbles { display:flex; flex-direction:column; gap:8px; max-height:320px; overflow-y:auto; }
    .bubble { max-width:82%; padding:9px 13px; border-radius:14px; font-size:0.82rem; line-height:1.5; }
    .bubble.agent { background:#1e1e1e; color:#ccc; align-self:flex-start; border-bottom-left-radius:4px; }
    .bubble.client { background:#0a3d1a; color:#b8f0c8; align-self:flex-end; border-bottom-right-radius:4px; }
    .bubble .role { font-size:0.65rem; opacity:0.5; margin-bottom:3px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Confirmation Commande</h1>
    <p class="sub">Karim appelle le client pour confirmer la commande</p>

    <form id="form">
      <div class="field-group">
        <label for="tel">Numéro de téléphone *</label>
        <input id="tel" type="tel" placeholder="+21361234567" autocomplete="off" required>
      </div>
      <div class="field-group">
        <label for="nom">Nom du contact</label>
        <input id="nom" type="text" placeholder="Mohamed" autocomplete="off">
      </div>
      <div class="field-group">
        <label for="product">Nom du produit *</label>
        <input id="product" type="text" placeholder="كتاب TCF كندا" autocomplete="off" required>
      </div>
      <div class="row2">
        <div class="field-group">
          <label for="price">Prix *</label>
          <input id="price" type="text" placeholder="2500 DA" autocomplete="off" required>
        </div>
        <div class="field-group">
          <label for="delay">Délai de livraison *</label>
          <input id="delay" type="text" placeholder="3 à 5 جور" autocomplete="off" required>
        </div>
      </div>
      <div class="field-group">
        <label for="address">Adresse de livraison *</label>
        <input id="address" type="text" placeholder="Bab Ezzouar, Alger" autocomplete="off" required>
      </div>
      <button class="cta" id="btn" type="submit">📞 Appeler maintenant</button>
    </form>

    <div class="status-row">
      <span class="dot" id="dot"></span>
      <span id="status-text">Prêt</span>
    </div>
    <p class="call-sid" id="call-sid"></p>

    <div id="order-panel">
      <h2>Statut de la commande</h2>
      <div class="status-grid">
        <button data-s="confirmed">✅ Adresse confirmée</button>
        <button data-s="waiting_delivery">🕐 En attente livraison</button>
        <button data-s="no_answer">📞 Aucune réponse</button>
        <button data-s="cancelled">❌ Annulé</button>
        <button data-s="address_update">🔄 Adresse à corriger</button>
        <button data-s="delivered">📦 Livré</button>
        <button data-s="dispute">⚠️ Litige / problème</button>
        <button data-s="callback">🔁 À rappeler</button>
      </div>
      <p id="status-saved"></p>
    </div>

    <div id="transcript-panel">
      <h2>Transcription</h2>
      <div id="bubbles"></div>
    </div>
  </div>

  <script>
    var pollTimer = null;
    var currentCallId = null;

    var STATUS_MAP = {
      'queued':      { cls:'calling', text:'En file d\\'attente...' },
      'ringing':     { cls:'calling', text:'Sonnerie...' },
      'in-progress': { cls:'live',    text:'Appel en cours' },
      'completed':   { cls:'done',    text:'Appel terminé' },
      'busy':        { cls:'error',   text:'Occupé' },
      'failed':      { cls:'error',   text:'Échec' },
      'no-answer':   { cls:'error',   text:'Pas de réponse' },
      'canceled':    { cls:'done',    text:'Annulé' }
    };
    var TERMINAL = ['completed','busy','failed','no-answer','canceled'];

    function ui(dotCls, text) {
      var dot = document.getElementById('dot');
      var label = document.getElementById('status-text');
      dot.className = 'dot' + (dotCls ? ' ' + dotCls : '');
      label.className = dotCls || '';
      label.textContent = text;
    }

    function stopPoll() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    function onCallEnded() {
      document.getElementById('btn').disabled = false;
      document.getElementById('order-panel').style.display = 'block';
      if (currentCallId) loadTranscripts(currentCallId);
    }

    function pollStatus(callSid) {
      pollTimer = setInterval(function() {
        fetch('/outbound/status/' + callSid)
          .then(function(r) { return r.json(); })
          .then(function(d) {
            var s = STATUS_MAP[d.status] || { cls:'calling', text:d.status };
            ui(s.cls, s.text);
            if (TERMINAL.indexOf(d.status) !== -1) { stopPoll(); onCallEnded(); }
          })
          .catch(function() {});
      }, 2000);
    }

    function loadTranscripts(callId) {
      fetch('/api/calls/' + callId + '/transcripts')
        .then(function(r) { return r.json(); })
        .then(function(rows) {
          if (!rows || !rows.length) return;
          var bubbles = document.getElementById('bubbles');
          bubbles.innerHTML = '';
          rows.forEach(function(t) {
            var div = document.createElement('div');
            div.className = 'bubble ' + (t.role === 'agent' ? 'agent' : 'client');
            div.innerHTML = '<div class="role">' + (t.role === 'agent' ? 'Karim' : 'Client') + '</div>' +
                            '<div>' + (t.message || '') + '</div>';
            bubbles.appendChild(div);
          });
          document.getElementById('transcript-panel').style.display = 'block';
        })
        .catch(function() {});
    }

    document.querySelectorAll('.status-grid button').forEach(function(btn) {
      btn.addEventListener('click', function() {
        if (!currentCallId) return;
        document.querySelectorAll('.status-grid button').forEach(function(b) { b.classList.remove('selected'); });
        btn.classList.add('selected');
        fetch('/api/calls/' + currentCallId + '/status', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: btn.getAttribute('data-s') })
        }).then(function() {
          document.getElementById('status-saved').textContent = '✓ Statut enregistré';
        }).catch(function() {
          document.getElementById('status-saved').textContent = '⚠ Erreur';
        });
      });
    });

    document.getElementById('form').addEventListener('submit', function(e) {
      e.preventDefault();
      stopPoll();
      currentCallId = null;
      document.getElementById('btn').disabled = true;
      document.getElementById('call-sid').textContent = '';
      document.getElementById('order-panel').style.display = 'none';
      document.getElementById('transcript-panel').style.display = 'none';
      document.getElementById('status-saved').textContent = '';
      document.querySelectorAll('.status-grid button').forEach(function(b) { b.classList.remove('selected'); });
      ui('calling', 'Lancement...');

      fetch('/outbound/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telephone: document.getElementById('tel').value.trim(),
          nom:       document.getElementById('nom').value.trim(),
          productName: document.getElementById('product').value.trim(),
          price:     document.getElementById('price').value.trim(),
          address:   document.getElementById('address').value.trim(),
          deliveryDelay: document.getElementById('delay').value.trim()
        })
      })
      .then(function(r) { return r.json().then(function(d) { return { ok:r.ok, data:d }; }); })
      .then(function(r) {
        if (!r.ok) { ui('error', r.data.error || 'Erreur'); document.getElementById('btn').disabled = false; return; }
        currentCallId = r.data.callId;
        document.getElementById('call-sid').textContent = 'SID: ' + r.data.callSid;
        var s = STATUS_MAP[r.data.status] || { cls:'calling', text:r.data.status || 'En cours...' };
        ui(s.cls, s.text);
        pollStatus(r.data.callSid);
      })
      .catch(function() { ui('error', 'Réseau indisponible'); document.getElementById('btn').disabled = false; });
    });
  </script>
</body>
</html>`;

module.exports = router;
