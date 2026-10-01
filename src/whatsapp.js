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

const makeWASocket =
  typeof baileys.default === 'function'
    ? baileys.default
    : baileys.makeWASocket;

const mgr = require('./sessionManager');

const {
  SESSION_ID,
  log,
  baileysLogger,
  formatPairingCode,
  httpError,
} = require('./utils');


/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const MAX_RECONNECT =
  Number(process.env.MAX_RECONNECT_ATTEMPTS) || 10;

const startedAt = Date.now();


/* ------------------------------------------------------------------ */
/* Gist Backup Configuration                                           */
/* ------------------------------------------------------------------ */

/*
 * Required in .env:
 *
 * GIST_TOKEN=github_pat_xxxxxxxxxxxxxxxxx
 * GIST_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *
 * Use a PRIVATE Gist for WhatsApp session data.
 */

const GIST_TOKEN = process.env.GIST_TOKEN || '';
const GIST_ID = process.env.GIST_ID || '';

const GIST_ENABLED = !!(GIST_TOKEN && GIST_ID);

const gist = GIST_ENABLED
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

let backupRunning = false;


/* ------------------------------------------------------------------ */
/* Socket lifecycle                                                    */
/* ------------------------------------------------------------------ */

function newReady(s) {
  s.ready = new Promise((resolve, reject) => {
    s._readyResolve = resolve;
    s._readyReject = reject;
  });

  s.ready.catch(() => {});
}

const resolveReady = (s) =>
  s._readyResolve && s._readyResolve();

const rejectReady = (s, err) =>
  s._readyReject && s._readyReject(err);


/**
 * Stop listening to and close the current socket.
 * Never throws.
 */
function detachSocket(s) {
  const sock = s.sock;

  s.sock = null;

  clearTimeout(s._readyTimer);
  s._readyTimer = null;

  if (!sock) return;

  try {
    [
      'connection.update',
      'creds.update',
      'messages.upsert',
    ].forEach((e) => {
      sock.ev.removeAllListeners(e);
    });
  } catch (_) {
    /* ignore */
  }

  try {
    sock.end(undefined);
  } catch (_) {
    /* already closed */
  }
}


/* ------------------------------------------------------------------ */
/* Session creation                                                    */
/* ------------------------------------------------------------------ */

function createSession() {
  const s = mgr.getOrCreate(SESSION_ID);

  if (s.starting) {
    return s.starting;
  }

  s.starting = startSocket(s).finally(() => {
    s.starting = null;
  });

  return s.starting;
}


async function startSocket(s) {
  clearTimeout(s.reconnectTimer);
  s.reconnectTimer = null;

  detachSocket(s);

  log.info('Creating WhatsApp socket…');

  s.status = 'connecting';
  s.qr = null;

  newReady(s);

  /*
   * Local session directory:
   *
   * sessions/<SESSION_ID>/
   */
  const dir = mgr.sessionDir(SESSION_ID);

  fs.mkdirSync(dir, {
    recursive: true,
  });

  const {
    state,
    saveCreds,
  } = await useMultiFileAuthState(dir);


  /* -------------------------------------------------------------- */
  /* WhatsApp Web version                                           */
  /* -------------------------------------------------------------- */

  let version;

  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch (_) {
    log.warn(
      'Could not fetch latest WhatsApp Web version; using Baileys default'
    );
  }


  /* -------------------------------------------------------------- */
  /* Create socket                                                   */
  /* -------------------------------------------------------------- */

  const sock = makeWASocket({
    ...(version ? { version } : {}),

    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(
        state.keys,
        baileysLogger
      ),
    },

    logger: baileysLogger,

    browser: Browsers.ubuntu('Chrome'),

    printQRInTerminal: false,

    markOnlineOnConnect: false,

    syncFullHistory: false,
  });


  s.sock = sock;
  s.authState = state;
  s.authenticated = !!state.creds.registered;


  /* -------------------------------------------------------------- */
  /* Credentials update                                             */
  /* -------------------------------------------------------------- */

  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();

      /*
       * Save the complete multi-file session to Gist.
       */
      scheduleBackup();

    } catch (e) {
      log.error(
        `Failed to save credentials: ${e.message}`
      );
    }
  });


  /* -------------------------------------------------------------- */
  /* Socket events                                                   */
  /* -------------------------------------------------------------- */

  sock.ev.on(
    'connection.update',
    (u) => {
      if (s.sock === sock) {
        onConnectionUpdate(s, sock, u);
      }
    }
  );

  sock.ev.on(
    'messages.upsert',
    (m) => {
      if (s.sock === sock) {
        onMessages(s, sock, m);
      }
    }
  );
}


/* ------------------------------------------------------------------ */
/* Connection updates                                                  */
/* ------------------------------------------------------------------ */

function onConnectionUpdate(s, sock, update) {
  const {
    connection,
    qr,
  } = update;


  /* -------------------------------------------------------------- */
  /* QR                                                              */
  /* -------------------------------------------------------------- */

  if (qr) {
    s.qr = qr;

    resolveReady(s);

    log.debug('QR code available');
  }


  /* -------------------------------------------------------------- */
  /* Connecting                                                       */
  /* -------------------------------------------------------------- */

  if (connection === 'connecting') {
    s.status = 'connecting';

    if (!s._readyTimer) {
      s._readyTimer = setTimeout(
        () => resolveReady(s),
        6000
      );
    }
  }


  /* -------------------------------------------------------------- */
  /* Connected                                                        */
  /* -------------------------------------------------------------- */

  if (connection === 'open') {
    s.status = 'connected';

    s.authenticated = true;

    s.reconnectAttempts = 0;

    s.restartCount = 0;

    s.lastConnected =
      new Date().toISOString();

    s.qr = null;

    s.pairing = {
      code: null,
      number: null,
      requestedAt: 0,
    };

    s.phoneNumber =
      sock.user && sock.user.id
        ? String(sock.user.id)
            .split(/[:@]/)[0]
        : s.phoneNumber;

    resolveReady(s);

    log.info(
      'WhatsApp connected successfully.'
    );

    /*
     * Backup complete session after connection.
     */
    scheduleBackup();
  }


  /* -------------------------------------------------------------- */
  /* Connection closed                                                */
  /* -------------------------------------------------------------- */

  if (connection === 'close') {
    handleClose(s, update);
  }
}


/* ------------------------------------------------------------------ */
/* Connection close                                                   */
/* ------------------------------------------------------------------ */

function handleClose(s, update) {
  const err =
    update.lastDisconnect &&
    update.lastDisconnect.error;

  const code =
    (err &&
      err.output &&
      err.output.statusCode) ||
    0;

  const registered =
    !!(
      s.authState &&
      s.authState.creds &&
      s.authState.creds.registered
    );


  s.status = 'disconnected';

  s.lastDisconnectReason =
    code || null;

  log.warn('Connection closed');

  log.warn(
    `Disconnect reason: ${
      code || 'unknown'
    }${
      err && err.message
        ? ` (${err.message})`
        : ''
    }`
  );


  rejectReady(
    s,
    httpError(
      503,
      `Connection closed (reason ${
        code || 'unknown'
      }) before WhatsApp was ready.`
    )
  );


  detachSocket(s);


  /* -------------------------------------------------------------- */
  /* Logged out / bad session                                        */
  /* -------------------------------------------------------------- */

  if (
    code === DisconnectReason.loggedOut ||
    code === DisconnectReason.badSession
  ) {
    log.warn(
      code === DisconnectReason.loggedOut
        ? 'Logged out from WhatsApp. Removing saved credentials; a fresh pairing is required.'
        : 'Bad session. Removing saved credentials; a fresh pairing is required.'
    );

    wipeSession(s);

    return;
  }


  /* -------------------------------------------------------------- */
  /* Replaced / forbidden                                            */
  /* -------------------------------------------------------------- */

  if (
    code === DisconnectReason.connectionReplaced ||
    code === DisconnectReason.forbidden
  ) {
    log.warn(
      'Session was replaced/forbidden; not reconnecting automatically.'
    );

    return;
  }


  /* -------------------------------------------------------------- */
  /* Not registered                                                   */
  /* -------------------------------------------------------------- */

  if (!registered) {
    s.pairing = {
      code: null,
      number: null,
      requestedAt: 0,
    };

    log.info(
      'Closed before pairing completed; not reconnecting. Request a new pairing code.'
    );

    return;
  }


  /* -------------------------------------------------------------- */
  /* Reconnect                                                        */
  /* -------------------------------------------------------------- */

  scheduleReconnect(
    s,
    {
      restart:
        code ===
        DisconnectReason.restartRequired,
    }
  );
}


/* ------------------------------------------------------------------ */
/* Wipe local session                                                  */
/* ------------------------------------------------------------------ */

function wipeSession(s) {
  clearTimeout(s.reconnectTimer);

  s.reconnectTimer = null;


  try {
    mgr.removeSessionFiles(SESSION_ID);
  } catch (e) {
    log.error(
      `Could not remove session files: ${e.message}`
    );
  }


  s.authState = null;

  s.authenticated = false;

  s.status = 'disconnected';

  s.qr = null;

  s.phoneNumber = null;

  s.reconnectAttempts = 0;

  s.restartCount = 0;

  s.pairing = {
    code: null,
    number: null,
    requestedAt: 0,
  };
}


/* ------------------------------------------------------------------ */
/* Reconnect                                                           */
/* ------------------------------------------------------------------ */

function scheduleReconnect(
  s,
  { restart = false } = {}
) {
  if (s.reconnectTimer) {
    return;
  }


  let delay;


  if (
    restart &&
    s.restartCount < 5
  ) {
    s.restartCount++;

    delay = 500;
  } else {
    if (
      s.reconnectAttempts >=
      MAX_RECONNECT
    ) {
      log.error(
        'Max reconnect attempts reached; giving up. Restart the server or pair again.'
      );

      s.status = 'disconnected';

      return;
    }


    s.reconnectAttempts++;

    delay = Math.min(
      30000,
      1000 *
        2 **
          (s.reconnectAttempts - 1)
    );
  }


  s.status = 'connecting';


  log.info(
    `Reconnecting in ${delay} ms (attempt ${s.reconnectAttempts})`
  );


  s.reconnectTimer = setTimeout(
    async () => {
      s.reconnectTimer = null;

      try {
        await createSession();
      } catch (e) {
        log.error(
          `Reconnect failed: ${e.message}`
        );

        scheduleReconnect(s);
      }
    },
    delay
  );
}


/* ------------------------------------------------------------------ */
/* Pairing / QR / logout                                               */
/* ------------------------------------------------------------------ */

async function waitReady(
  s,
  ms = 25000
) {
  let t;

  try {
    await Promise.race([
      s.ready,

      new Promise((_, rej) => {
        t = setTimeout(
          () =>
            rej(
              httpError(
                504,
                'Timed out waiting for WhatsApp. Check the server\'s internet connection and try again.'
              )
            ),
          ms
        );
      }),
    ]);
  } finally {
    clearTimeout(t);
  }
}


/* ------------------------------------------------------------------ */
/* Pairing code                                                        */
/* ------------------------------------------------------------------ */

async function requestPairingCode(number) {
  const s =
    mgr.getOrCreate(SESSION_ID);


  if (
    s.authenticated ||
    mgr.hasRegisteredCreds(SESSION_ID)
  ) {
    throw httpError(
      409,
      `Session ${SESSION_ID} is already authenticated. Log out first if you want to link a different number.`
    );
  }


  if (s.pairingBusy) {
    throw httpError(
      429,
      'A pairing request is already in progress. Please wait a few seconds.'
    );
  }


  s.pairingBusy = true;


  try {
    const p = s.pairing;


    if (
      s.sock &&
      p.code &&
      p.number === number &&
      Date.now() -
        p.requestedAt <
        mgr.PAIR_TTL_MS
    ) {
      return p.code;
    }


    /* ------------------------------------------------------------ */
    /* Start from clean unregistered state                          */
    /* ------------------------------------------------------------ */

    clearTimeout(
      s.reconnectTimer
    );

    s.reconnectTimer = null;

    detachSocket(s);

    mgr.removeSessionFiles(
      SESSION_ID
    );


    s.pairing = {
      code: null,
      number: null,
      requestedAt: 0,
    };

    s.authenticated = false;


    await createSession();


    log.info(
      'Waiting for pairing…'
    );


    await waitReady(s);


    const sock = s.sock;


    if (!sock) {
      throw httpError(
        503,
        'The socket closed before a pairing code could be requested. Please try again.'
      );
    }


    let raw;


    try {
      raw =
        await sock.requestPairingCode(
          number
        );
    } catch (e) {
      throw httpError(
        502,
        `WhatsApp could not issue a pairing code: ${e.message}`
      );
    }


    const code =
      formatPairingCode(raw);


    s.pairing = {
      code,
      number,
      requestedAt:
        Date.now(),
    };


    s.phoneNumber = number;


    log.info(
      `Pairing code generated: ${code.slice(
        0,
        2
      )}**-****`
    );


    return code;

  } finally {
    s.pairingBusy = false;
  }
}


/* ------------------------------------------------------------------ */
/* QR                                                                  */
/* ------------------------------------------------------------------ */

async function getQr() {
  const s =
    mgr.getOrCreate(SESSION_ID);


  if (
    s.authenticated ||
    mgr.hasRegisteredCreds(SESSION_ID)
  ) {
    throw httpError(
      409,
      `Session ${SESSION_ID} is already authenticated; no QR code is needed.`
    );
  }


  if (!s.sock) {
    await createSession();
  }


  await waitReady(s);


  if (!s.qr) {
    throw httpError(
      503,
      'QR code is not available yet. Retry in a few seconds.'
    );
  }


  return s.qr;
}


/* ------------------------------------------------------------------ */
/* Logout                                                              */
/* ------------------------------------------------------------------ */

async function logout() {
  const s =
    mgr.getOrCreate(SESSION_ID);


  clearTimeout(
    s.reconnectTimer
  );

  s.reconnectTimer = null;


  const sock = s.sock;


  if (
    sock &&
    s.status === 'connected'
  ) {
    try {
      await sock.logout();
    } catch (e) {
      log.warn(
        `Remote logout failed (continuing): ${e.message}`
      );
    }
  }


  detachSocket(s);


  wipeSession(s);


  log.info(
    'Session logged out and credentials removed'
  );
}


/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

const MENU =
  'EZR WhatsApp Bot\n\n1. Ping\n2. Status\n3. Help';


function extractText(message) {
  const c =
    normalizeMessageContent(
      message
    ) || {};


  return (
    c.conversation ||
    (
      c.extendedTextMessage &&
      c.extendedTextMessage.text
    ) ||
    (
      c.imageMessage &&
      c.imageMessage.caption
    ) ||
    (
      c.videoMessage &&
      c.videoMessage.caption
    ) ||
    ''
  );
}


async function onMessages(
  s,
  sock,
  {
    messages,
    type,
  }
) {
  if (type !== 'notify') {
    return;
  }


  for (const m of messages) {
    try {
      if (
        !m.message ||
        !m.key ||
        m.key.fromMe
      ) {
        continue;
      }


      const jid =
        m.key.remoteJid;


      if (
        !jid ||
        jid.endsWith('@broadcast') ||
        jid.endsWith('@newsletter')
      ) {
        continue;
      }


      const text =
        extractText(
          m.message
        )
          .trim()
          .toLowerCase();


      let reply = null;


      if (text === 'ping') {
        reply = 'pong';

      } else if (text === 'menu') {
        reply = MENU;

      } else if (text === 'status') {
        const up =
          Math.floor(
            (Date.now() -
              startedAt) /
              1000
          );


        reply =
          `EZR WhatsApp Bot\nStatus: online\nUptime: ${Math.floor(
            up / 3600
          )}h ${Math.floor(
            (up % 3600) / 60
          )}m`;

      } else if (text === 'help') {
        reply =
          'Commands: ping, menu, status, help';
      }


      /*
       * Only ever reply to an explicit command.
       * Never message anyone unprompted.
       */

      if (reply) {
        await sock.sendMessage(
          jid,
          {
            text: reply,
          },
          {
            quoted: m,
          }
        );
      }

    } catch (e) {
      log.error(
        `Message handler error: ${e.message}`
      );
    }
  }
}


/* ================================================================== */
/* GIST BACKUP                                                        */
/* ================================================================== */


/* ------------------------------------------------------------------ */
/* Read local session files                                            */
/* ------------------------------------------------------------------ */

function readSessionFilesForGist() {
  const dir =
    mgr.sessionDir(
      SESSION_ID
    );


  if (!fs.existsSync(dir)) {
    return {};
  }


  const files = {};


  for (
    const name of fs.readdirSync(dir)
  ) {
    const filePath =
      path.join(
        dir,
        name
      );


    let stat;


    try {
      stat =
        fs.statSync(filePath);
    } catch (_) {
      continue;
    }


    /*
     * Only backup files.
     */
    if (!stat.isFile()) {
      continue;
    }


    /*
     * Baileys multi-file auth state
     * consists of JSON files.
     *
     * Ignore unexpected files.
     */
    if (
      !name.endsWith('.json')
    ) {
      continue;
    }


    try {
      const content =
        fs.readFileSync(
          filePath,
          'utf8'
        );


      files[
        `session/${name}`
      ] = {
        content,
      };

    } catch (e) {
      log.warn(
        `Could not read session file ${name}: ${e.message}`
      );
    }
  }


  return files;
}


/* ------------------------------------------------------------------ */
/* Backup local session to Gist                                        */
/* ------------------------------------------------------------------ */

async function backupToGist() {
  if (!GIST_ENABLED) {
    return;
  }


  if (backupRunning) {
    return;
  }


  if (
    !mgr.hasRegisteredCreds(
      SESSION_ID
    )
  ) {
    return;
  }


  backupRunning = true;


  try {
    const files =
      readSessionFilesForGist();


    if (
      !Object.keys(files).length
    ) {
      log.debug(
        'No session files available for Gist backup'
      );

      return;
    }


    await gist.patch(
      `/gists/${GIST_ID}`,
      {
        description:
          `EZR WhatsApp Session - ${SESSION_ID}`,

        files,
      }
    );


    log.info(
      `Gist backup completed: ${
        Object.keys(files).length
      } session files`
    );

  } catch (e) {
    log.warn(
      `Gist backup failed: ${
        e.response
          ? `HTTP ${e.response.status}`
          : e.message
      }`
    );

  } finally {
    backupRunning = false;
  }
}


/* ------------------------------------------------------------------ */
/* Schedule Gist backup                                                */
/* ------------------------------------------------------------------ */

function scheduleBackup() {
  if (!GIST_ENABLED) {
    return;
  }


  const s =
    mgr.getOrCreate(
      SESSION_ID
    );


  clearTimeout(
    s._backupTimer
  );


  /*
   * Wait a few seconds so multiple
   * creds.update events don't trigger
   * many immediate Gist requests.
   */
  s._backupTimer =
    setTimeout(
      () => {
        backupToGist().catch(
          () => {}
        );
      },
      5000
    );


  if (
    s._backupTimer.unref
  ) {
    s._backupTimer.unref();
  }
}


/* ------------------------------------------------------------------ */
/* Restore session from Gist                                           */
/* ------------------------------------------------------------------ */

async function restoreFromGist() {
  if (!GIST_ENABLED) {
    log.debug(
      'Gist backup disabled'
    );

    return;
  }


  /*
   * Do not overwrite an existing
   * registered local session.
   */
  if (
    mgr.hasRegisteredCreds(
      SESSION_ID
    )
  ) {
    log.debug(
      'Local registered session found; skipping Gist restore'
    );

    return;
  }


  try {
    const response =
      await gist.get(
        `/gists/${GIST_ID}`
      );


    const gistFiles =
      response.data.files || {};


    const dir =
      mgr.sessionDir(
        SESSION_ID
      );


    fs.mkdirSync(
      dir,
      {
        recursive: true,
      }
    );


    let restored = 0;


    for (
      const [name, file]
      of Object.entries(
        gistFiles
      )
    ) {
      /*
       * Only restore files under
       * our session/ namespace.
       */
      if (
        !name.startsWith(
          'session/'
        )
      ) {
        continue;
      }


      if (
        typeof file.content !==
        'string'
      ) {
        continue;
      }


      const filename =
        name.replace(
          /^session\//,
          ''
        );


      /*
       * Prevent path traversal.
       */
      if (
        !filename ||
        filename.includes('/') ||
        filename.includes('\\') ||
        filename === '.' ||
        filename === '..'
      ) {
        continue;
      }


      /*
       * Only JSON auth files.
       */
      if (
        !filename.endsWith(
          '.json'
        )
      ) {
        continue;
      }


      const filePath =
        path.join(
          dir,
          filename
        );


      fs.writeFileSync(
        filePath,
        file.content,
        {
          mode: 0o600,
        }
      );


      restored++;
    }


    if (restored > 0) {
      log.info(
        `Gist restore completed: ${restored} session files restored`
      );
    } else {
      log.info(
        'No WhatsApp session files found in Gist'
      );
    }

  } catch (e) {
    if (
      e.response &&
      e.response.status === 404
    ) {
      log.info(
        'No Gist backup found'
      );

      return;
    }


    log.warn(
      `Gist restore failed: ${
        e.response
          ? `HTTP ${e.response.status}`
          : e.message
      }`
    );
  }
}


/* ================================================================== */
/* BOOTSTRAP                                                          */
/* ================================================================== */

async function bootstrap() {
  /*
   * Restore from Gist BEFORE checking
   * local credentials.
   */
  await restoreFromGist();


  const s =
    mgr.getOrCreate(
      SESSION_ID
    );


  if (
    mgr.hasRegisteredCreds(
      SESSION_ID
    )
  ) {
    log.info(
      'Saved credentials found; reconnecting existing session…'
    );


    s.authenticated = true;


    try {
      await createSession();

    } catch (e) {
      log.error(
        `Initial connect failed: ${e.message}`
      );

      scheduleReconnect(s);
    }

  } else {
    log.info(
      'No authenticated session. Open the web UI and generate a pairing code.'
    );
  }
}


/* ================================================================== */
/* SHUTDOWN                                                           */
/* ================================================================== */

function shutdown() {
  const s =
    mgr.getOrCreate(
      SESSION_ID
    );


  clearTimeout(
    s.reconnectTimer
  );

  clearTimeout(
    s._backupTimer
  );


  /*
   * Credentials stay on disk.
   * No logout on server shutdown.
   */
  detachSocket(s);
}


/* ================================================================== */
/* EXPORTS                                                            */
/* ================================================================== */

module.exports = {
  bootstrap,
  createSession,
  requestPairingCode,
  getQr,
  logout,
  shutdown,
};
