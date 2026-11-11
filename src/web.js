import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { renderSVG } from 'uqr';
import { paths, loadConfig } from './config.js';
import { childLogger, logsSince, markLogs, recentLogs } from './logger.js';
import { ruleMatches, classifyAllows } from './rules.js';
import { classify } from './classify.js';
import { handleMessage } from './pipeline.js';
import { transcribe } from './transcribe.js';
import { buildTestMessage } from './testkit.js';
import { directory } from './contacts.js';
import { saveBuffer } from './media.js';

const log = childLogger('web');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_FILE = path.join(HERE, 'web', 'ui.html');

const MAX_YAML_BYTES = 1 * 1024 * 1024;      // 1 MB
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;    // 25 MB, un vocale WhatsApp è molto meno
const TOKEN_FILE = path.join(paths.data, 'web-token.txt');

/**
 * Token del pannello. Se WEB_TOKEN è vuoto ne genera uno e lo tiene in
 * data/web-token.txt: meglio di nessuna autenticazione, che su LAN significa
 * che chiunque può riscrivere le regole.
 */
function resolveToken(configured) {
  if (configured) return { token: configured, generated: false };
  try {
    const saved = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (saved) return { token: saved, generated: false };
  } catch { /* non esiste ancora */ }
  const token = crypto.randomBytes(24).toString('base64url');
  try {
    fs.mkdirSync(paths.data, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  } catch (err) {
    log.warn({ err: err.message }, 'cannot save the panel token');
  }
  return { token, generated: true };
}

function send(res, status, body, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': type === 'application/json' ? 'application/json; charset=utf-8' : type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error(`body too large (max ${Math.round(limit / 1024 / 1024)} MB)`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Spiega, regola per regola, perché ha matchato o perché no.
 * È il pezzo che rende utile il pannello: `ruleMatches` calcola già quali
 * criteri falliscono, qui viene solo restituito invece di finire nel log.
 */
async function explain(config, msg, text) {
  const esiti = [];
  for (const rule of config.rules) {
    const { ok, failed } = ruleMatches(rule, msg, text);
    const voce = {
      id: rule.id,
      name: rule.name,
      priority: rule.priority,
      matched: ok,
      failed,
      classify: null,
      blockedByClassify: false,
      actions: rule.actions.map((a) => a.type),
    };
    if (ok && rule.classify) {
      voce.classify = await classify({
        text,
        labels: rule.classify.labels,
        model: rule.classify.model,
        context: `Chat: ${msg.chatName}${msg.senderName ? `, mittente: ${msg.senderName}` : ''}`,
      });
      voce.blockedByClassify = !classifyAllows(rule, voce.classify);
      if (voce.blockedByClassify) voce.matched = false;
    }
    esiti.push(voce);
  }
  return esiti;
}

function readRulesFile() {
  try {
    return fs.readFileSync(paths.rulesFile, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Il QR come SVG, per mostrarlo nel pannello: WhatsApp lo vuole scansionato e
 * un token in testo non serve a nessuno. Il QR grezzo non esce dal server.
 */
function sessionSnapshot(session) {
  const s = session?.status?.() || { state: 'unavailable' };
  let qrSvg = null;
  if (s.qr) {
    try {
      qrSvg = renderSVG(s.qr, { ecc: 'M', border: 2, pixelSize: 6 });
    } catch (err) {
      log.warn({ err: err.message }, 'cannot render the QR');
    }
  }
  const { qr, ...rest } = s;
  return { ...rest, available: Boolean(session?.reset), qrSvg };
}

/**
 * YAML forbids a tab as indentation, and a tab is invisible in a textarea: the
 * mistake only surfaces when the save is refused, with a message about line 210
 * and no way to see what is wrong there. Expanding the leading tabs to spaces
 * removes the whole class of problem; the caller says how many lines changed.
 *
 * Only the whitespace in front of the first character of a line is touched: a
 * tab inside a line (in a string, or in a block scalar) is legal content and
 * stays exactly where it is.
 */
export function detab(yamlText, size = 2) {
  let converted = 0;
  const text = String(yamlText ?? '').replace(/^([ \t]*\t)(?=\S)/gm, (lead) => {
    converted += 1;
    return lead.replace(/\t/g, ' '.repeat(size));
  });
  return { text, converted };
}

/** Scrive le regole in modo atomico, tenendo una copia di quelle precedenti. */
function writeRulesFile(yamlText) {
  const dir = path.dirname(paths.rulesFile);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(paths.rulesFile)) {
    fs.copyFileSync(paths.rulesFile, `${paths.rulesFile}.bak`);
  }
  const tmp = `${paths.rulesFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, yamlText, 'utf8');
  fs.renameSync(tmp, paths.rulesFile);
}

/**
 * Avvia il pannello web.
 *
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} opts.host         "127.0.0.1" (solo questa macchina) o "0.0.0.0" (LAN)
 * @param {string} [opts.token]      se vuoto ne viene generato uno
 * @param {Function} opts.reload     ricarica la config e la restituisce (lancia se non valida)
 * @param {Function} opts.getConfig  config corrente
 * @param {object} [opts.session]    controllo della sessione WhatsApp:
 *                                   { status(): stato, reset(): cancella auth/ e rifà il QR }
 */
export function startWeb({ port, host, token: configuredToken, reload, getConfig, session }) {
  const { token, generated } = resolveToken(configuredToken);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const route = `${req.method} ${url.pathname}`;

    // La pagina non è protetta: senza token non può fare nulla comunque.
    if (route === 'GET /' || route === 'GET /index.html') {
      try {
        send(res, 200, fs.readFileSync(UI_FILE), 'text/html; charset=utf-8');
      } catch (err) {
        send(res, 500, { error: `cannot read ui.html: ${err.message}` });
      }
      return;
    }

    // The editor logic is a separate module, so it can be tested in Node.
    if (route === 'GET /editor.js') {
      try {
        send(res, 200, fs.readFileSync(path.join(HERE, 'web', 'editor.js')), 'text/javascript; charset=utf-8');
      } catch (err) {
        send(res, 500, { error: `cannot read editor.js: ${err.message}` });
      }
      return;
    }

    // Logo, used as the page icon.
    if (route === 'GET /logo.svg') {
      try {
        send(res, 200, fs.readFileSync(path.join(paths.root, 'assets', 'logo.svg')), 'image/svg+xml');
      } catch {
        send(res, 404, { error: 'logo not found' });
      }
      return;
    }

    if (!url.pathname.startsWith('/api/')) {
      send(res, 404, { error: 'not found' });
      return;
    }

    const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (provided !== token) {
      send(res, 401, { error: 'missing or wrong token' });
      return;
    }

    try {
      // --- le ultime righe di log, per leggerle dal pannello ---
      if (route === 'GET /api/logs') {
        const n = Number(url.searchParams.get('n')) || 200;
        send(res, 200, { lines: recentLogs(n) });
        return;
      }
      // --- la sessione WhatsApp: stato, QR, e il reset che rifà il login ---
      if (route === 'GET /api/session') {
        send(res, 200, sessionSnapshot(session));
        return;
      }

      // Cancella auth/ e riparte: WhatsApp manderà un QR nuovo, che il pannello
      // mostra da solo al giro successivo. Le regole, i contatti e i media non
      // vengono toccati.
      if (route === 'POST /api/session/reset') {
        if (!session?.reset) {
          send(res, 501, { error: 'this panel has no control over the WhatsApp session' });
          return;
        }
        await session.reset();
        log.warn('WhatsApp session reset from the panel: waiting for the new QR');
        send(res, 200, { ok: true, ...sessionSnapshot(session) });
        return;
      }

      // --- stato: regole attive + come si legge il file adesso ---
      if (route === 'GET /api/state') {
        const config = getConfig();
        send(res, 200, {
          rulesFile: path.relative(paths.root, paths.rulesFile),
          yaml: readRulesFile(),
          rules: config.rules.map((r) => ({
            id: r.id, name: r.name, priority: r.priority, enabled: r.enabled,
            actions: r.actions.map((a) => a.type),
          })),
          settings: config.settings,
          contacts: directory().rows.slice(0, 200),
          me: directory().me,
        });
        return;
      }

      // --- salva le regole: valida PRIMA di scrivere, mai YAML rotto su disco ---
      if (route === 'PUT /api/rules') {
        const body = (await readBody(req, MAX_YAML_BYTES)).toString('utf8');
        const parsed = JSON.parse(body || '{}');
        if (typeof parsed.yaml !== 'string') {
          send(res, 400, { error: 'serve { "yaml": "..." }' });
          return;
        }

        // Un tab come indentazione è invisibile e YAML lo rifiuta: lo si
        // trasforma in spazi prima di validare, così l'errore al rigo 210 non
        // blocca più nessuno. Quanti ne sono cambiati lo dice la risposta.
        const { text: yamlText, converted: tabsConverted } = detab(parsed.yaml);

        // Valida su un file temporaneo: se è rotto, l'originale non viene toccato.
        // È la difesa che oggi mancava: una chiave duplicata scritta a mano è
        // arrivata su disco e l'app ha continuato con le regole vecchie.
        // L'estensione conta: config.js sceglie YAML o JSON da lì.
        const est = path.extname(paths.rulesFile) || '.yaml';
        const probe = `${paths.rulesFile}.probe${est}`;
        fs.writeFileSync(probe, yamlText, 'utf8');
        let valida;
        try {
          valida = loadConfig(probe);
        } catch (err) {
          fs.rmSync(probe, { force: true });
          send(res, 400, { error: err.message });
          return;
        }
        fs.rmSync(probe, { force: true });

        // dryRun = solo controllo: non scrive niente su disco
        if (parsed.dryRun) {
          send(res, 200, { ok: true, validated: true, rules: valida.rules.length, tabsConverted });
          return;
        }

        writeRulesFile(yamlText);
        const config = await reload();
        log.info({ rules: config.rules.length, tabsConverted }, 'rules saved from the panel');
        send(res, 200, { ok: true, rules: config.rules.length, tabsConverted });
        return;
      }

      // --- prova con un testo ---
      if (route === 'POST /api/test') {
        const body = JSON.parse((await readBody(req, MAX_YAML_BYTES)).toString('utf8') || '{}');
        // segnaposto: le righe scritte da qui in poi sono quelle di questo test
        const mark = markLogs();
        const msg = buildTestMessage({ ...body, type: body.type || 'text' });
        const esiti = await explain(getConfig(), msg, msg.text);
        const res1 = await handleMessage({ config: getConfig(), msg, dryRun: true });
        send(res, 200, {
          transcript: res1.transcript || null,
          matched: res1.matched,
          actions: res1.actions,
          rules: esiti,
          logs: logsSince(mark),
        });
        return;
      }

      // --- prova con un vocale caricato ---
      if (route === 'POST /api/test-audio') {
        const buf = await readBody(req, MAX_AUDIO_BYTES);
        if (!buf.length) {
          send(res, 400, { error: 'no audio received' });
          return;
        }
        const mark = markLogs();
        const file = saveBuffer(buf, {
          subdir: 'test',
          basename: `upload-${Date.now()}`,
          extension: (url.searchParams.get('ext') || 'ogg').replace(/[^a-z0-9]/gi, ''),
        });

        let trascrizione = null;
        let erroreTrascrizione = null;
        try {
          const t = await transcribe(file);
          trascrizione = t?.text ?? null;
        } catch (err) {
          erroreTrascrizione = err.message;
        }

        const msg = buildTestMessage({
          type: 'audio',
          ptt: true,
          mediaFile: file,
          chatName: url.searchParams.get('chatName') || 'Test chat',
          senderName: url.searchParams.get('senderName') || 'Test sender',
          chatJid: url.searchParams.get('chatJid') || undefined,
          senderJid: url.searchParams.get('senderJid') || undefined,
          isGroup: url.searchParams.get('isGroup') === 'true',
        });

        const esiti = await explain(getConfig(), msg, trascrizione || '');
        const res2 = await handleMessage({
          config: getConfig(),
          msg,
          dryRun: true,
          precomputedTranscript: trascrizione,
        });
        send(res, 200, {
          transcript: trascrizione,
          transcriptError: erroreTrascrizione,
          matched: res2.matched,
          actions: res2.actions,
          rules: esiti,
        });
        return;
      }

      // --- ultimi messaggi processati (quello che il programma ha letto) ---
      if (route === 'GET /api/messages') {
        const n = Math.min(Number(url.searchParams.get('n') || 30), 200);
        let righe = [];
        try {
          righe = fs.readFileSync(path.join(paths.data, 'messages.jsonl'), 'utf8')
            .trim().split('\n').slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean);
        } catch { /* nessun log */ }
        send(res, 200, { messages: righe.reverse() });
        return;
      }

      send(res, 404, { error: 'unknown endpoint' });
    } catch (err) {
      const status = err.status || 500;
      // A 4xx is something the user typed into the test bench: a warning, not
      // an alarm. Only a real server-side failure deserves ERROR.
      log[status >= 500 ? 'error' : 'warn']({ route, err: err.message }, 'panel error');
      send(res, status, { error: err.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const dove = host === '127.0.0.1' || host === 'localhost' ? 'solo questa macchina' : `LAN (${host})`;
      log.info(`web panel on http://${host}:${port} — ${dove}`);
      if (generated) log.info(`token generated and saved to ${path.relative(paths.root, TOKEN_FILE)}: ${token}`);
      else log.info('panel token: the one in WEB_TOKEN');
      if (host === '0.0.0.0' && !configuredToken) {
        log.warn('the panel is exposed on the LAN: whoever knows the token can rewrite your rules. Keep it private.');
      }
      resolve({ server, token, close: () => server.close() });
    });
  });
}
