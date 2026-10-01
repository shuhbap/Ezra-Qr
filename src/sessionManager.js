'use strict';
const fs = require('fs');
const path = require('path');
const { maskNumber } = require('./utils');

const SESSIONS_ROOT = path.resolve(__dirname, '..', 'sessions');
const PAIR_TTL_MS = 120000;
const sessions = new Map();

function sessionDir(id) { return path.join(SESSIONS_ROOT, id); }

function getOrCreate(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      id,
      sock: null,
      authState: null,
      status: 'disconnected', // disconnected | connecting | connected
      authenticated: false,
      pairing: { code: null, number: null, requestedAt: 0 },
      pairingBusy: false,
      reconnectAttempts: 0,
      restartCount: 0,
      reconnectTimer: null,
      phoneNumber: null,
      lastConnected: null,
      lastDisconnectReason: null,
      qr: null,
      starting: null,
      ready: null,
      _readyResolve: null,
      _readyReject: null,
      _readyTimer: null,
      _backupTimer: null,
    });
  }
  return sessions.get(id);
}

function hasRegisteredCreds(id) {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(sessionDir(id), 'creds.json'), 'utf8'));
    return creds && creds.registered === true;
  } catch (_) { return false; }
}

function removeSessionFiles(id) {
  fs.rmSync(sessionDir(id), { recursive: true, force: true });
}

function snapshot(id) {
  const s = getOrCreate(id);
  return {
    sessionId: id,
    connected: s.status === 'connected',
    authenticated: s.authenticated,
    connectionStatus: s.status,
    pairingActive: !!(s.sock && s.pairing.code && Date.now() - s.pairing.requestedAt < PAIR_TTL_MS),
    lastConnected: s.lastConnected,
    reconnectAttempts: s.reconnectAttempts,
    lastDisconnectReason: s.lastDisconnectReason,
    linkedNumber: s.authenticated ? maskNumber(s.phoneNumber) : null,
  };
}

module.exports = { sessions, SESSIONS_ROOT, PAIR_TTL_MS, sessionDir, getOrCreate, hasRegisteredCreds, removeSessionFiles, snapshot };
