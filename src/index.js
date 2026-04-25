const http = require('http');
const path = require('path');
const express = require('express');
const config = require('./config');
const logger = require('./utils/logger');
const { router: inboundRouter, setupMediaStream } = require('./routes/inbound');
const outboundRouter = require('./routes/outbound');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Health check pour Render.com
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Basic Auth optionnel pour le dashboard (DASHBOARD_PASSWORD requis)
function dashboardAuth(req, res, next) {
  const pwd = process.env.DASHBOARD_PASSWORD;
  if (!pwd) return next();
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="DZ Dashboard"');
    return res.status(401).send('Authentification requise');
  }
  const decoded = Buffer.from(auth.slice(6), 'base64').toString();
  const inputPwd = decoded.slice(decoded.indexOf(':') + 1);
  if (inputPwd !== pwd) {
    res.set('WWW-Authenticate', 'Basic realm="DZ Dashboard"');
    return res.status(401).send('Mot de passe incorrect');
  }
  next();
}

app.get('/dashboard', dashboardAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

app.use('/inbound', inboundRouter);
app.use('/outbound', outboundRouter);

// API REST CRUD (workspaces, subjects, campaigns, contacts, stats)
app.use('/api', require('./routes/api'));

// Page de test navigateur + endpoint token Twilio Client JS
app.use('/', require('./routes/testcall'));

app.use((req, res) => {
  res.status(404).json({ error: 'Route non trouvée' });
});

app.use((err, req, res, next) => {
  logger.error('Erreur non gérée', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Erreur interne du serveur' });
});

const server = http.createServer(app);

setupMediaStream(server);

server.listen(config.server.port, () => {
  logger.info('Serveur démarré', { port: config.server.port, env: process.env.NODE_ENV || 'development' });
});

module.exports = { app, server };
