'use strict';
const { SESSION_ID, log } = require('./src/utils'); // also loads .env
const express = require('express');
const routes = require('./src/routes');
const wa = require('./src/whatsapp');

const PORT = Number(process.env.PORT) || 8000;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

// Defence in depth: nothing from these paths is ever served (no static middleware is used at all).
app.use((req, res, next) => {
  let p = req.path;
  try { p = decodeURIComponent(p); } catch (_) { /* keep raw */ }
  if (/^\/(sessions|temp|\.env|\.git|node_modules)(\/|$)/i.test(p)) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  next();
});

app.use(routes);
app.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }));
app.use((err, req, res, _next) => {
  log.error(`Unhandled HTTP error: ${err.message}`);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

const server = app.listen(PORT, HOST, () => {
  log.info(`HTTP server listening on ${HOST}:${PORT}`);
  wa.bootstrap().catch((e) => log.error(`Bootstrap failed: ${e.message}`));
});

function shutdown(signal) {
  log.info(`${signal} received, shutting down`);
  wa.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (r) => log.error(`Unhandled rejection: ${r && r.message ? r.message : r}`));
process.on('uncaughtException', (e) => log.error(`Uncaught exception: ${e.message}`));
