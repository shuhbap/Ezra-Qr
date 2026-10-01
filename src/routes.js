'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const mgr = require('./sessionManager');
const wa = require('./whatsapp');
const { SESSION_ID, log, normalizeNumber } = require('./utils');

const router = express.Router();
const ACCESS_KEY = process.env.ACCESS_KEY || '';
const INDEX_HTML = path.join(__dirname, '..', 'public', 'index.html');

function requireKey(req, res, next) {
  if (!ACCESS_KEY) return next();
  const given = req.get('x-access-key') || (typeof req.query.key === 'string' ? req.query.key : '');
  const a = Buffer.from(given);
  const b = Buffer.from(ACCESS_KEY);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  return res.status(401).json({ success: false, error: 'Invalid or missing access key.' });
}

const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const arr = (hits.get(req.ip) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      return res.status(429).json({ success: false, error: 'Too many requests. Please wait a minute and try again.' });
    }
    arr.push(now);
    hits.set(req.ip, arr);
    next();
  };
}

function fail(res, e) {
  const status = e.status || 500;
  if (!e.status) log.error(`Unexpected error: ${e.stack || e.message}`);
  res.status(status).json({ success: false, error: e.status ? e.message : 'Unexpected server error. Check the server logs.' });
}

router.get('/', (req, res) => {
  if (req.accepts(['json', 'html']) === 'html') return res.sendFile(INDEX_HTML);
  res.json({ status: 'online', service: 'EZR WhatsApp Bot' });
});
router.get('/ui', (req, res) => res.sendFile(INDEX_HTML));

router.get('/status', (req, res) => {
  res.json({ ...mgr.snapshot(SESSION_ID), protected: !!ACCESS_KEY });
});

router.get('/pair', requireKey, rateLimit(6, 60000), async (req, res) => {
  try {
    if (req.query.number === undefined) {
      throw Object.assign(new Error('Missing "number" query parameter, e.g. /pair?number=919876543210'), { status: 400 });
    }
    const number = normalizeNumber(String(req.query.number));
    if (!number) {
      throw Object.assign(new Error('Invalid phone number. Use digits only with the country code and no leading 0 (e.g. 919876543210).'), { status: 400 });
    }
    const pairingCode = await wa.requestPairingCode(number);
    res.json({ success: true, sessionId: SESSION_ID, pairingCode });
  } catch (e) { fail(res, e); }
});

router.get('/qr', requireKey, rateLimit(12, 60000), async (req, res) => {
  try {
    const qr = await wa.getQr();
    if (req.query.format === 'png') {
      res.type('png').send(await QRCode.toBuffer(qr, { width: 360, margin: 2 }));
    } else {
      res.json({ success: true, sessionId: SESSION_ID, qr, qrImage: await QRCode.toDataURL(qr, { width: 360, margin: 2 }) });
    }
  } catch (e) { fail(res, e); }
});

router.post('/logout', requireKey, async (req, res) => {
  try {
    await wa.logout();
    res.json({ success: true, sessionId: SESSION_ID, message: 'Logged out' });
  } catch (e) { fail(res, e); }
});

module.exports = router;
