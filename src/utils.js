'use strict';
require('dotenv').config();
const pino = require('pino');

const SESSION_ID = process.env.SESSION_ID || 'EZR4-4BH1';
if (!/^[A-Za-z0-9_-]{1,64}$/.test(SESSION_ID)) {
  throw new Error('SESSION_ID may only contain letters, digits, "-" and "_".');
}

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' });

const mk = (level) => (msg, extra) => logger[level](extra || {}, `[${SESSION_ID}] ${msg}`);
const log = { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') };

/** Strip + / spaces / dashes / brackets; return digits (E.164 length, no leading 0) or null. */
function normalizeNumber(input) {
  if (typeof input !== 'string') return null;
  const digits = input.replace(/[\s+\-().]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  if (digits.startsWith('0')) return null;
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

const formatPairingCode = (raw) => {
  const c = String(raw).replace(/[^A-Za-z0-9]/g, '');
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
};

const maskNumber = (n) => (n ? `${'•'.repeat(Math.max(0, String(n).length - 4))}${String(n).slice(-4)}` : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpError = (status, message) => Object.assign(new Error(message), { status });

module.exports = { SESSION_ID, log, baileysLogger, normalizeNumber, formatPairingCode, maskNumber, sleep, httpError };
