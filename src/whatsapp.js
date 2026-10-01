'use strict';
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const baileys = require('@whiskeysockets/baileys');
const {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  normalizeMessageContent,
} = baileys;
const makeWASocket = typeof baileys.default === 'function' ? baileys.default : baileys.makeWASocket;

const mgr = require('./sessionManager');
const { SESSION_ID, log, baileysLogger, formatPairingCode, httpError } = require('./utils');

const MAX_RECONNECT = Number(process.env.MAX_RECONNECT_ATTEMPTS) || 10;
const startedAt = Date.now();

/* ------------------------------------------------------------------ */
/* Socket lifecycle                                                    */
/* ------------------------------------------------------------------ */

function newReady(s) {
  s.ready = new Promise((resolve, reject) => { s._readyResolve = resolve; s._readyReject = reject; });
  s.ready.catch(() => {}); // avoid unhandled rejection when nobody is waiting
}
const resolveReady = (s) => s._readyResolve && s._readyResolve();
const rejectReady = (s, err) => s._readyReject && s._readyReject(err);

/** Stop listening to and close the current socket (if any). Never throws. */
function detachSocket(s) {
  const sock = s.sock;
  s.sock = null;
  clearTimeout(s._readyTimer);
  s._readyTimer = null;
  if (!sock) return;
  try {
    ['connection.update', 'creds.update', 'messages.upsert'].forEach((e) => sock.ev.removeAllListeners(e));
  } catch (_) { /* ignore */ }
  try { sock.end(undefined); } catch (_) { /* already closed */ }
}

function createSession() {
  const s = mgr.getOrCreate(SESSION_ID);
  if (s.starting) return s.starting; // never two sockets for one session
  s.starting = startSocket(s).finally(() => { s.starting = null; });
  return s.starting;
}

async function startSocket(s) {
  clearTimeout(s.reconnectTimer);
  s.reconnectTimer = null;
  detachSocket(s); // clean up any old socket first

  log.info('Creating WhatsApp socket…');
  s.status = 'connecting';
  s.qr = null;
  newReady(s);

  const dir = mgr.sessionDir(SESSION_ID);
  fs.mkdirSync(dir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(dir);

  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); }
  catch (_) { log.warn('Could not fetch latest WhatsApp Web version; using Baileys default'); }

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLogger) },
    logger: baileysLogger,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  s.sock = sock;
  s.authState = state;
  s.authenticated = !!state.creds.registered;

  sock.ev.on('creds.update', async () => {
    try { await saveCreds(); } catch (e) { log.error(`Failed to save credentials: ${e.message}`); }
    scheduleBackup();
  });
  sock.ev.on('connection.update', (u) => { if (s.sock === sock) onConnectionUpdate(s, sock, u); });
  sock.ev.on('messages.upsert', (m) => { if (s.sock === sock) onMessages(s, sock, m); });
}

function onConnectionUpdate(s, sock, update) {
  const { connection, qr } = update;

  if (qr) {
    s.qr = qr;
    resolveReady(s); // QR emitted => handshake done, socket is ready for pairing
    log.debug('QR code available');
  }

  if (connection === 'connecting') {
    s.status = 'connecting';
    if (!s._readyTimer) s._readyTimer = setTimeout(() => resolveReady(s), 6000); // fallback
  }

  if (connection === 'open') {
    s.status = 'connected';
    s.authenticated = true;
    s.reconnectAttempts = 0;
    s.restartCount = 0;
    s.lastConnected = new Date().toISOString();
    s.qr = null;
    s.pairing = { code: null, number: null, requestedAt: 0 };
    s.phoneNumber = sock.user && sock.user.id ? String(sock.user.id).split(/[:@]/)[0] : s.phoneNumber;
    resolveReady(s);
    log.info('WhatsApp connected successfully.');
    scheduleBackup();
  }

  if (connection === 'close') handleClose(s, update);
}

function handleClose(s, update) {
  const err = update.lastDisconnect && update.lastDisconnect.error;
  const code = (err && err.output && err.output.statusCode) || 0;
  const registered = !!(s.authState && s.authState.creds && s.authState.creds.registered);

  s.status = 'disconnected';
  s.lastDisconnectReason = code || null;
  log.warn('Connection closed');
  log.warn(`Disconnect reason: ${code || 'unknown'}${err && err.message ? ` (${err.message})` : ''}`);

  rejectReady(s, httpError(503, `Connection closed (reason ${code || 'unknown'}) before WhatsApp was ready.`));
  detachSocket(s);

  if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession) {
    log.warn(code === DisconnectReason.loggedOut
      ? 'Logged out from WhatsApp. Removing saved credentials; a fresh pairing is required.'
      : 'Bad session. Removing saved credentials; a fresh pairing is required.');
    wipeSession(s);
    return;
  }
  if (code === DisconnectReason.connectionReplaced || code === DisconnectReason.forbidden) {
    log.warn('Session was replaced/forbidden; not reconnecting automatically.');
    return;
  }
  if (!registered) {
    s.pairing = { code: null, number: null, requestedAt: 0 };
    log.info('Closed before pairing completed; not reconnecting. Request a new pairing code.');
    return;
  }
  // 515 restartRequired is expected right after a successful pairing; 408/428/others: backoff reconnect.
  scheduleReconnect(s, { restart: code === DisconnectReason.restartRequired });
}

function wipeSession(s) {
  clearTimeout(s.reconnectTimer);
  s.reconnectTimer = null;
  try { mgr.removeSessionFiles(SESSION_ID); } catch (e) { log.error(`Could not remove session files: ${e.message}`); }
  s.authState = null;
  s.authenticated = false;
  s.status = 'disconnected';
  s.qr = null;
  s.phoneNumber = null;
  s.reconnectAttempts = 0;
  s.restartCount = 0;
  s.pairing = { code: null, number: null, requestedAt: 0 };
}

function scheduleReconnect(s, { restart = false } = {}) {
  if (s.reconnectTimer) return;
  let delay;
  if (restart && s.restartCount < 5) {
    s.restartCount++;
    delay = 500;
  } else {
    if (s.reconnectAttempts >= MAX_RECONNECT) {
      log.error('Max reconnect attempts reached; giving up. Restart the server or pair again.');
      s.status = 'disconnected';
      return;
    }
    s.reconnectAttempts++;
    delay = Math.min(30000, 1000 * 2 ** (s.reconnectAttempts - 1)); // exponential backoff, capped at 30s
  }
  s.status = 'connecting';
  log.info(`Reconnecting in ${delay} ms (attempt ${s.reconnectAttempts})`);
  s.reconnectTimer = setTimeout(async () => {
    s.reconnectTimer = null;
    try { await createSession(); }
    catch (e) { log.error(`Reconnect failed: ${e.message}`); scheduleReconnect(s); }
  }, delay);
}

/* ------------------------------------------------------------------ */
/* Pairing / QR / logout                                               */
/* ------------------------------------------------------------------ */

async function waitReady(s, ms = 25000) {
  let t;
  try {
    await Promise.race([
      s.ready,
      new Promise((_, rej) => { t = setTimeout(() => rej(httpError(504, 'Timed out waiting for WhatsApp. Check the server\'s internet connection and try again.')), ms); }),
    ]);
  } finally { clearTimeout(t); }
}

async function requestPairingCode(number) {
  const s = mgr.getOrCreate(SESSION_ID);
  if (s.authenticated || mgr.hasRegisteredCreds(SESSION_ID)) {
    throw httpError(409, `Session ${SESSION_ID} is already authenticated. Log out first if you want to link a different number.`);
  }
  if (s.pairingBusy) throw httpError(429, 'A pairing request is already in progress. Please wait a few seconds.');
  s.pairingBusy = true;
  try {
    const p = s.pairing;
    if (s.sock && p.code && p.number === number && Date.now() - p.requestedAt < mgr.PAIR_TTL_MS) {
      return p.code; // one code per active socket
    }

    // Start from a clean, unregistered state (unregistered creds are worthless).
    clearTimeout(s.reconnectTimer);
    s.reconnectTimer = null;
    detachSocket(s);
    mgr.removeSessionFiles(SESSION_ID);
    s.pairing = { code: null, number: null, requestedAt: 0 };
    s.authenticated = false;

    await createSession();
    log.info('Waiting for pairing…');
    await waitReady(s);

    const sock = s.sock;
    if (!sock) throw httpError(503, 'The socket closed before a pairing code could be requested. Please try again.');

    let raw;
    try { raw = await sock.requestPairingCode(number); }
    catch (e) { throw httpError(502, `WhatsApp could not issue a pairing code: ${e.message}`); }

    const code = formatPairingCode(raw);
    s.pairing = { code, number, requestedAt: Date.now() };
    s.phoneNumber = number;
    log.info(`Pairing code generated: ${code.slice(0, 2)}**-****`); // masked: codes grant account linking
    return code;
  } finally {
    s.pairingBusy = false;
  }
}

async function getQr() {
  const s = mgr.getOrCreate(SESSION_ID);
  if (s.authenticated || mgr.hasRegisteredCreds(SESSION_ID)) {
    throw httpError(409, `Session ${SESSION_ID} is already authenticated; no QR code is needed.`);
  }
  if (!s.sock) await createSession();
  await waitReady(s);
  if (!s.qr) throw httpError(503, 'QR code is not available yet. Retry in a few seconds.');
  return s.qr;
}

async function logout() {
  const s = mgr.getOrCreate(SESSION_ID);
  clearTimeout(s.reconnectTimer);
  s.reconnectTimer = null;
  const sock = s.sock;
  if (sock && s.status === 'connected') {
    try { await sock.logout(); } catch (e) { log.warn(`Remote logout failed (continuing): ${e.message}`); }
  }
  detachSocket(s);
  wipeSession(s);
  log.info('Session logged out and credentials removed');
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

const MENU = 'EZR WhatsApp Bot\n\n1. Ping\n2. Status\n3. Help';

function extractText(message) {
  const c = normalizeMessageContent(message) || {};
  return (c.conversation || (c.extendedTextMessage && c.extendedTextMessage.text) ||
    (c.imageMessage && c.imageMessage.caption) || (c.videoMessage && c.videoMessage.caption) || '');
}

async function onMessages(s, sock, { messages, type }) {
  if (type !== 'notify') return;
  for (const m of messages) {
    try {
      if (!m.message || !m.key || m.key.fromMe) continue;
      const jid = m.key.remoteJid;
      if (!jid || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue;

      const text = extractText(m.message).trim().toLowerCase();
      let reply = null;
      if (text === 'ping') reply = 'pong';
      else if (text === 'menu') reply = MENU;
      else if (text === 'status') {
        const up = Math.floor((Date.now() - startedAt) / 1000);
        reply = `EZR WhatsApp Bot\nStatus: online\nUptime: ${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m`;
      } else if (text === 'help') reply = 'Commands: ping, menu, status, help';

      // Only ever reply to an explicit command; never message anyone unprompted.
      if (reply) await sock.sendMessage(jid, { text: reply }, { quoted: m });
    } catch (e) {
      log.error(`Message handler error: ${e.message}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Optional GitHub backup of creds.json (never blocks WhatsApp)        */
/* ------------------------------------------------------------------ */

const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const GH_REPO = process.env.GITHUB_REPO || '';
const GH_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GH_ENABLED = !!(GH_TOKEN && GH_REPO);
const GH_REMOTE_PATH = `sessions/${SESSION_ID}/creds.json`;
const gh = GH_ENABLED
  ? axios.create({
      baseURL: 'https://api.github.com',
      timeout: 15000,
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ezr-whatsapp-bot',
      },
    })
  : null;
const ghUrl = `/repos/${GH_REPO}/contents/${GH_REMOTE_PATH}`;
let backupRunning = false;

function scheduleBackup() {
  if (!GH_ENABLED) return;
  const s = mgr.getOrCreate(SESSION_ID);
  clearTimeout(s._backupTimer);
  s._backupTimer = setTimeout(() => { backupCreds().catch(() => {}); }, 5000);
  if (s._backupTimer.unref) s._backupTimer.unref();
}

async function backupCreds() {
  if (!GH_ENABLED || backupRunning || !mgr.hasRegisteredCreds(SESSION_ID)) return;
  backupRunning = true;
  try {
    const file = path.join(mgr.sessionDir(SESSION_ID), 'creds.json');
    const content = fs.readFileSync(file).toString('base64');
    let sha;
    try { sha = (await gh.get(ghUrl, { params: { ref: GH_BRANCH } })).data.sha; }
    catch (e) { if (!e.response || e.response.status !== 404) throw e; }
    await gh.put(ghUrl, { message: `Backup ${SESSION_ID} creds`, content, branch: GH_BRANCH, ...(sha ? { sha } : {}) });
    log.debug('GitHub backup uploaded');
  } catch (e) {
    log.warn(`GitHub backup failed (WhatsApp unaffected): ${e.response ? `HTTP ${e.response.status}` : e.message}`);
  } finally { backupRunning = false; }
}

async function restoreFromGithub() {
  if (!GH_ENABLED || mgr.hasRegisteredCreds(SESSION_ID)) return;
  try {
    const res = await gh.get(ghUrl, { params: { ref: GH_BRANCH } });
    const text = Buffer.from(res.data.content, 'base64').toString('utf8');
    if (JSON.parse(text).registered !== true) return;
    const dir = mgr.sessionDir(SESSION_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'creds.json'), text, { mode: 0o600 });
    log.info('Credentials restored from GitHub backup');
  } catch (e) {
    if (e.response && e.response.status === 404) log.info('No GitHub backup found');
    else log.warn(`GitHub restore skipped: ${e.response ? `HTTP ${e.response.status}` : e.message}`);
  }
}

/* ------------------------------------------------------------------ */

async function bootstrap() {
  await restoreFromGithub();
  const s = mgr.getOrCreate(SESSION_ID);
  if (mgr.hasRegisteredCreds(SESSION_ID)) {
    log.info('Saved credentials found; reconnecting existing session…');
    s.authenticated = true;
    try { await createSession(); }
    catch (e) { log.error(`Initial connect failed: ${e.message}`); scheduleReconnect(s); }
  } else {
    log.info('No authenticated session. Open the web UI and generate a pairing code.');
  }
}

function shutdown() {
  const s = mgr.getOrCreate(SESSION_ID);
  clearTimeout(s.reconnectTimer);
  clearTimeout(s._backupTimer);
  detachSocket(s); // credentials stay on disk; no logout
}

module.exports = { bootstrap, createSession, requestPairingCode, getQr, logout, shutdown };
