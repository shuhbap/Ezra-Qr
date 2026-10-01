'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { sessionDir } = require('./sessionManager');
const { SESSION_ID, log } = require('./utils');

const GIST_TOKEN = process.env.GIST_TOKEN || '';
const GIST_ID = process.env.GIST_ID || '';

const ENABLED = !!(GIST_TOKEN && GIST_ID);

const gist = ENABLED
  ? axios.create({
      baseURL: 'https://api.github.com',
      timeout: 20000,
      headers: {
        Authorization: `Bearer ${GIST_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ezr-whatsapp-bot',
      },
    })
  : null;


/*
 * Read every file inside sessions/<SESSION_ID>
 * and convert it to Gist files.
 */
function readSessionFiles() {
  const dir = sessionDir(SESSION_ID);

  if (!fs.existsSync(dir)) {
    return {};
  }

  const files = {};

  for (const name of fs.readdirSync(dir)) {
    const filePath = path.join(dir, name);

    if (!fs.statSync(filePath).isFile()) continue;

    const content = fs.readFileSync(filePath);

    files[`session/${name}`] = {
      content: content.toString('base64'),
    };
  }

  return files;
}


/*
 * Restore all session files from Gist
 */
async function restoreFromGist() {
  if (!ENABLED) {
    log.debug('Gist backup disabled');
    return;
  }

  try {
    const response = await gist.get(`/gists/${GIST_ID}`);
    const gistFiles = response.data.files || {};

    const dir = sessionDir(SESSION_ID);
    fs.mkdirSync(dir, { recursive: true });

    let restored = 0;

    for (const [name, file] of Object.entries(gistFiles)) {
      if (!name.startsWith('session/')) continue;
      if (!file.content) continue;

      const filename = name.replace(/^session\//, '');

      // Prevent path traversal
      if (
        !filename ||
        filename.includes('/') ||
        filename.includes('\\') ||
        filename === '.' ||
        filename === '..'
      ) {
        continue;
      }

      const filePath = path.join(dir, filename);

      const content = Buffer.from(file.content, 'base64');

      fs.writeFileSync(filePath, content, {
        mode: 0o600,
      });

      restored++;
    }

    log.info(`Gist restore completed: ${restored} session files restored`);
  } catch (e) {
    if (e.response && e.response.status === 404) {
      log.info('No Gist backup found');
      return;
    }

    log.warn(
      `Gist restore failed: ${
        e.response ? `HTTP ${e.response.status}` : e.message
      }`
    );
  }
}


/*
 * Backup complete Baileys session to Gist
 */
async function backupToGist() {
  if (!ENABLED) return;

  try {
    const files = readSessionFiles();

    if (!Object.keys(files).length) {
      log.debug('No session files available for Gist backup');
      return;
    }

    await gist.patch(`/gists/${GIST_ID}`, {
      description: `EZR WhatsApp Session - ${SESSION_ID}`,
      files,
    });

    log.info(
      `Gist backup completed: ${Object.keys(files).length} session files`
    );
  } catch (e) {
    log.warn(
      `Gist backup failed: ${
        e.response ? `HTTP ${e.response.status}` : e.message
      }`
    );
  }
}


module.exports = {
  ENABLED,
  backupToGist,
  restoreFromGist,
};
