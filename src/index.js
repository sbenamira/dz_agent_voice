const http = require('http');
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

app.use('/inbound', inboundRouter);
app.use('/outbound', outboundRouter);

// API REST CRUD (workspaces, subjects, campaigns, contacts, stats)
app.use('/api', require('./routes/api'));

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
