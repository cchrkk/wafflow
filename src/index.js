#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, describeRule, resolveRulesFile, paths, env, VERSION } from './config.js';
import { logger } from './logger.js';
import { handleMessage } from './pipeline.js';
import { startWhatsApp } from './whatsapp.js';
import { assertTranscribeReady, transcribeBackendName } from './transcribe.js';
import { ACTION_TYPES, PLACEHOLDERS } from './actions.js';
import { auditRegexes } from './rules.js';
import { flush, getStats } from './store.js';
import { directory, flushContacts } from './contacts.js';
import { sweepMedia } from './media.js';
import { startWeb } from './web.js';
import { buildTestMessage } from './testkit.js';
import { markConnected, markMessage, runHealth, startHealth } from './health.js';

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const flagValue = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const HELP = `
wafflow — categorises WhatsApp messages and runs actions

Usage:
  npm start                     connects to WhatsApp (QR on first run) and listens
  npm start -- --login          same as above, explicit
  npm start -- --check          validates config/rules.yaml and the environment, then exits
  npm start -- --health         says whether the running instance is healthy (it is the container healthcheck)
  npm run contacts              shows the jids, LIDs and names it knows
  npm start -- --simulate FILE  runs a fake message through the rule engine (dry run)
  npm start -- --simulate FILE --live   same, but really runs the actions

Options:
  --config FILE   use a rules file other than config/rules.yaml
  --dry           connects but runs no action
  --help          this text
`.trim();

function banner(config) {
  logger.info('─'.repeat(72));
  logger.info('🔒 READ-ONLY MODE — no blue ticks, no online presence');
  if (config.settings.allowReply) {
    logger.warn('⚠ SENDING ENABLED — ALLOW_REPLY=true: rules can write into chats');
  }
  logger.info(`wafflow ${VERSION} · transcription: ${transcribeBackendName()}`);
  const files = config.ruleFiles || [path.relative(paths.root, paths.rulesFile)];
  logger.info(`config: ${files.join(' + ')}`);
  logger.info(`rules active: ${config.rules.length}`);
  for (const r of config.rules) {
    const da = r.from ? ` [${r.from}]` : '';
    logger.info(`  • [${String(r.priority).padStart(3)}] ${r.id.padEnd(22)} ${describeRule(r)}${da}`);
  }
  logger.info('─'.repeat(72));
}

/** Chiamata di sola lettura a Home Assistant, per verificare URL e token. */
async function haApi(pathname) {
  const res = await fetch(`${env.haUrl}${pathname}`, {
    headers: { Authorization: `Bearer ${env.haToken}` },
    signal: AbortSignal.timeout(env.actionTimeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

async function telegramApi(method, params = {}) {  const res = await fetch(`https://api.telegram.org/bot${env.telegramToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(env.actionTimeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || `HTTP ${res.status}`);
  return data.result;
}

async function runCheck(config) {
  let ok = true;
  logger.info('▶ checking configuration…');
  logger.info(`  ✓ version: ${VERSION}`);
  logger.info('  ✓ read-only: readMessages() and presence disabled at the client level');
  if (config.settings.allowReply) {
    logger.warn('  ! ALLOW_REPLY=true: rules with the "reply" action can WRITE INTO CHATS');
    logger.warn('    (read receipts and presence stay off: those are not configurable)');
  }
  const wantsReply = config.rules.some((r) => r.actions.some((a) => a.type === 'reply'));
  if (wantsReply && !config.settings.allowReply) {
    logger.warn('  ! "reply" action used but sending is off: set ALLOW_REPLY=true in .env to enable it');
  }

  try {
    const backend = assertTranscribeReady();
    logger.info(`  ✓ transcription: ${backend}${backend === 'command' ? ` (${env.transcribeCommand})` : ''}`);
  } catch (err) {
    ok = false;
    logger.error(`  ✗ transcription: ${err.message}`);
  }

  const usedTypes = new Set(config.rules.flatMap((r) => r.actions.map((a) => a.type)));
  for (const t of usedTypes) {
    if (!ACTION_TYPES.includes(t)) {
      ok = false;
      logger.error(`  ✗ unknown action: ${t} (available: ${ACTION_TYPES.join(', ')})`);
    }
  }
  logger.info(`  ✓ ${usedTypes.size} action types used, all recognised`);

  const ret = config.settings.mediaRetentionDays;
  const retLabel = ret < 0 ? 'never' : ret === 0 ? 'deleted right after processing' : `${ret} days`;
  logger.info(`  ✓ media in data/out: kept ${retLabel}${ret >= 0 ? ' (tmp/ always emptied)' : ''}`);

  if (env.webEnabled) {
    const dove = ['127.0.0.1', 'localhost'].includes(env.webBind) ? 'solo questa macchina' : `LAN (${env.webBind})`;
    logger.info(`  ✓ web panel: port ${env.webPort}, ${dove}, ${env.webToken ? 'token from .env' : 'token generated in data/web-token.txt'}`);
  } else {
    logger.info('  · web panel disabled (WEB_ENABLED=true to turn it on)');
  }

  // Segnaposto scritti male: {{transcriptt}} non esplode, ma esce vuoto o letterale.
  // Sono validi anche i gruppi di cattura delle regex: {{1}} e {{nome}}.
  const gruppiConNome = new Set();
  for (const r of config.rules) {
    const tm = r.match?.textMatch;
    if (!tm || typeof tm !== 'object' || Array.isArray(tm)) continue;
    for (const p of [].concat(tm.patterns ?? tm.value ?? [])) {
      for (const g of String(p).matchAll(/\(\?<([A-Za-z]\w*)>/g)) gruppiConNome.add(g[1]);
    }
  }

  const raw = JSON.stringify(config.rules);
  const unknowns = new Set();
  for (const [, name] of raw.matchAll(/\{\{(\w+)\}\}/g)) {
    if (PLACEHOLDERS.includes(name)) continue;
    if (/^\d+$/.test(name)) continue;            // {{1}}, {{2}}: gruppi di cattura
    if (gruppiConNome.has(name)) continue;        // {{stanza}}: gruppo con nome
    unknowns.add(name);
  }
  if (unknowns.size) {
    ok = false;
    logger.error(`  ✗ unknown placeholders: ${[...unknowns].join(', ')}`);
    logger.error(`     available: ${PLACEHOLDERS.join(', ')}, {{1}}, {{namedGroup}}`);
  } else {
    logger.info(`  ✓ all {{...}} placeholders are valid${gruppiConNome.size ? ` (groups: ${[...gruppiConNome].join(', ')})` : ''}`);
  }

  if (usedTypes.has('notify.telegram') || usedTypes.has('mirror.telegram')) {
    if (!env.telegramToken || !env.telegramChatId) {
      ok = false;
      logger.error('  ✗ telegram used but TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are missing');
    } else {
      try {
        const me = await telegramApi('getMe');
        const chat = await telegramApi('getChat', { chat_id: env.telegramChatId });
        const name = chat.title || chat.username || [chat.first_name, chat.last_name].filter(Boolean).join(' ');
        logger.info(`  ✓ telegram: @${me.username} → chat "${name}" (id ${chat.id})`);
      } catch (err) {
        ok = false;
        logger.error(`  ✗ telegram: ${err.message}`);
        logger.error(`     → apri https://t.me/${(process.env.TELEGRAM_BOT_USERNAME || 'il_tuo_bot')} e premi Start, poi riprova`);
      }
    }
  }
  const HA_ACTIONS = ['ha.webhook', 'ha.service', 'ha.action', 'ha.button', 'ha.script', 'ha.automation', 'ha.notify'];
  if (HA_ACTIONS.some((t) => usedTypes.has(t))) {
    if (!env.haUrl) {
      logger.warn('  ! Home Assistant actions used but HA_URL is missing in .env');
    } else if (!env.haToken) {
      logger.warn('  ! Home Assistant actions used but HA_TOKEN is missing in .env');
    } else {
      try {
        const cfg = await haApi('/api/config');
        logger.info(`  ✓ home assistant: ${cfg.location_name || 'home'} · HA ${cfg.version} · ${env.haUrl}`);
      } catch (err) {
        ok = false;
        logger.error(`  ✗ home assistant (${env.haUrl}): ${err.message}`);
        logger.error('     → check HA_URL and create a long-lived token: Profile → Security → Long-lived access tokens');
      }
    }
  }
  if (usedTypes.has('shell') && !config.settings.allowShell) {
    logger.warn('  ! "shell" action used but settings.allowShell=false: it will fail at runtime');
  }

  // Trappola classica: \b accanto a una lettera accentata. Sembra scritto
  // giusto e non matcha mai, perché \b per JavaScript conosce solo [A-Za-z0-9_].
  const trappole = auditRegexes(config.rules);
  if (trappole.length) {
    ok = false;
    for (const t of trappole) {
      logger.error(`  ✗ rule "${t.rule}": you use \\b with an accented word — that word will NEVER match`);
      logger.error(`     ${t.pattern}`);
    }
    logger.error('     \\b only knows [A-Za-z0-9_], so there is no boundary next to è, à, ò...');
    logger.error('     → confini unicode:   flags: iu   e   (?<![\\p{L}\\p{N}])parola(?![\\p{L}\\p{N}])');
    logger.error('     → or, for a plain keyword list, just use   mode: contains');
  } else {
    logger.info('  ✓ no \\b next to accented words');
  }
  if (!fs.existsSync(paths.rulesFile)) {
    logger.warn(`  ! ${path.relative(paths.root, paths.rulesFile)} does not exist: copy config/rules.example.yaml`);
  }

  logger.info(`  ✓ config: ${(config.ruleFiles || []).join(' + ')}`);
  for (const w of config.warnings || []) logger.warn(`  ! ${w}`);

  logger.info(ok ? '✓ configuration valid' : '✗ configuration has errors');
  return ok ? 0 : 1;
}

async function runSimulate(config, file, live) {
  const abs = path.isAbsolute(file) ? file : path.join(paths.root, file);
  const sample = JSON.parse(fs.readFileSync(abs, 'utf8'));

  // Stessa fabbrica di messaggi del pannello web: un solo posto da tenere allineato.
  const msg = buildTestMessage(sample);

  logger.info({ dryRun: !live, sample: path.basename(abs) }, '▶ simulation');
  const res = await handleMessage({
    config,
    msg,
    dryRun: !live,
    downloadMedia: async () => msg.mediaFile,
    send: live && config.settings.allowReply
      ? async (jid, content) => logger.info({ jid, content }, '[simulation] WhatsApp send (allowReply)')
      : null,
  });

  logger.info('— result —');
  logger.info(`  rules fired: ${res.matched?.length ? res.matched.join(', ') : '(none)'}`);
  logger.info(`  transcript:      ${res.transcript ? JSON.stringify(res.transcript) : '(none)'}`);
  for (const a of res.actions || []) {
    logger.info(`  action ${a.ok ? '✓' : '✗'} ${a.rule} → ${a.type}${a.error ? ` (${a.error})` : ''}`);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Elenca jid e nomi che il programma conosce (rubrica lid <-> numero). */
function printContacts() {
  const { me, rows, total } = directory();
  console.log('\nCONTACTS (data/contacts.json)\n');
  if (me) {
    console.log('  You:');
    console.log(`    name        ${me.name || '(unknown)'}`);
    console.log(`    jid         ${me.jid || '(not known)'}`);
    console.log(`    lid         ${me.lid || '(not known)'}`);
    console.log('');
  } else {
    console.log('  You: still unknown (run the program at least once)\n');
  }
  if (!rows.length) {
    console.log('  No contacts saved yet: names arrive after the first connection.\n');
    return;
  }
  for (const r of rows) {
    const alt = r.alt ? `  <->  ${r.alt}` : '';
    console.log(`  ${r.name.padEnd(24)} ${r.jid}${alt}`);
  }
  console.log(`\n  ${total} entries in total (groups included)\n`);
}

/**
 * Impedisce che due istanze usino la stessa cartella auth/: sarebbe la causa
 * numero uno dell'errore 440 (connessione sostituita a vicenda).
 */
function acquireInstanceLock() {
  const file = path.join(paths.data, 'instance.lock');
  fs.mkdirSync(paths.data, { recursive: true });

  try {
    const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (prev.pid && prev.pid !== process.pid) {
      try {
        process.kill(prev.pid, 0); // il processo è vivo?
        logger.error(`another instance is already running (pid ${prev.pid}, started ${prev.startedAt}). Close it before restarting.`);
        process.exit(1);
      } catch (err) {
        if (err.code !== 'ESRCH') throw err;
        logger.warn(`orphan lock from pid ${prev.pid}, overwriting it`);
      }
    }
  } catch (err) {
    if (err instanceof SyntaxError || err.code === 'ENOENT') { /* niente lock o lock illeggibile */ }
    else throw err;
  }

  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

  process.on('exit', () => {
    try {
      const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cur.pid === process.pid) fs.unlinkSync(file);
    } catch { /* ignore */ }
  });
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log(HELP);
    return;
  }

  // Healthcheck, prima di caricare la configurazione: deve dire se il processo
  // VIVO sta facendo il suo lavoro (connesso e capace di leggere), non se il
  // file delle regole è valido — per quello c'è --check. Legge solo un file,
  // quindi non si connette a niente ed è sicuro da chiamare ogni minuto.
  if (hasFlag('--health')) process.exit(runHealth());

  // --config: file di regole alternativo (yaml o json)
  paths.rulesFile = resolveRulesFile(flagValue('--config'));

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (hasFlag('--check')) {
      logger.error(`✗ invalid configuration: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  if (hasFlag('--check')) process.exit(await runCheck(config));

  if (hasFlag('--contacts')) {
    printContacts();
    return;
  }

  if (hasFlag('--simulate')) {
    const file = flagValue('--simulate') || 'fixtures/sample-text.json';
    await runSimulate(config, file, hasFlag('--live'));
    return;
  }

  banner(config);
  const dry = hasFlag('--dry');

  acquireInstanceLock();

  // Se ci sono azioni Home Assistant, verifica subito che HA risponda: un URL
  // sbagliato si scopre all'avvio invece che al primo ordine che arriva.
  const HA_ACTION_TYPES = new Set(['ha.webhook', 'ha.service', 'ha.action', 'ha.button', 'ha.script', 'ha.automation', 'ha.notify']);
  const haUsed = config.rules.some((r) => r.actions.some((a) => HA_ACTION_TYPES.has(a.type)));
  if (haUsed) {
    if (!env.haUrl || !env.haToken) {
      logger.warn('Home Assistant actions configured, but HA_URL/HA_TOKEN are missing in .env: they will fail');
    } else {
      try {
        const cfg = await haApi('/api/config');
        logger.info(`Home Assistant: ${cfg.location_name || 'home'} · HA ${cfg.version} · ${env.haUrl}`);
      } catch (err) {
        logger.error(`Home Assistant NOT reachable (${env.haUrl}): ${err.message}`);
        logger.error('until you fix HA_URL or the network, ha.* actions fail doing nothing');
      }
    }
  }

  // Pulizia dei media: all'avvio e poi ogni 6 ore. La soglia si rilegge ogni
  // volta, così cambiarla in rules.yaml vale subito senza riavviare.
  const retention = () => config.settings.mediaRetentionDays;
  try {
    sweepMedia(retention());
  } catch (err) {
    logger.warn(`media cleanup at startup failed: ${err.message}`);
  }
  setInterval(() => {
    try {
      sweepMedia(retention());
    } catch (err) {
      logger.warn(`media cleanup failed: ${err.message}`);
    }
  }, 6 * 60 * 60 * 1000).unref();

  // ricarica le regole se il file cambia (senza riavviare)
  let watcher;
  let configBrokenSince = null;
  try {
    watcher = fs.watch(paths.rulesFile, { persistent: false }, () => {
      setTimeout(() => {
        try {
          config = loadConfig();
          configBrokenSince = null;
          logger.info(`♻ rules reloaded (${config.rules.length} active)`);
        } catch (err) {
          configBrokenSince = configBrokenSince || Date.now();
          logger.error(`rule reload failed, keeping the previous ones: ${err.message}`);
        }
      }, 300);
    });
  } catch { /* il file può non esistere ancora */ }

  // Se la config è rotta l'app continua con le regole di prima: se non lo
  // ripetessi, un errore di battitura passerebbe inosservato per ore.
  setInterval(() => {
    if (!configBrokenSince) return;
    const minuti = Math.round((Date.now() - configBrokenSince) / 60000);
    logger.error(
      `config/rules.yaml has been invalid for ${minuti} min: still using the previous ${config.rules.length} rules. ` +
      'Check with: npm run check',
    );
  }, 2 * 60 * 1000).unref();

  // Pannello web, facoltativo. Non può mandare messaggi: passa sempre da
  // handleMessage({dryRun:true}), quindi l'invariante di sola lettura regge
  // anche se il pannello avesse un bug.
  if (env.webEnabled) {
    try {
      await startWeb({
        port: env.webPort,
        host: env.webBind,
        token: env.webToken,
        getConfig: () => config,
        reload: async () => {
          config = loadConfig();
          configBrokenSince = null;
          logger.info(`♻ rules reloaded from the panel (${config.rules.length} active)`);
          return config;
        },
      });
    } catch (err) {
      logger.error(`web panel did not start: ${err.message}`);
    }
  } else {
    logger.info('web panel disabled (WEB_ENABLED=true to turn it on)');
  }

  // Da qui in poi possono arrivare messaggi: il watcher deve essere installato
  // prima, o i primi fallimenti di decifratura non li conta nessuno.
  startHealth();

  const client = startWhatsApp({
    allowReply: config.settings.allowReply,
    onState: (s, code) => {
      // la salute tiene il conto della connessione: è quello che legge --health
      markConnected(s === 'open', s);
      // 'open' e 'close' sono già raccontati da whatsapp.js: qui solo il resto,
      // e i casi gravi, per non avere tre righe per ogni caduta di rete.
      if (s === 'loggedOut' || s === 'fatal') logger.error({ code }, 'connection: session closed by WhatsApp');
      else logger.debug({ state: s, code }, 'connection state');
    },
    onMessage: async (msg, { sock, downloadMedia }) => {
      markMessage();
      await handleMessage({
        config,
        msg,
        downloadMedia,
        // null in modalità solo lettura: l'azione "reply" non ha modo di scrivere
        send: config.settings.allowReply
          ? (jid, content, opts) => sock.sendMessage(jid, content, opts)
          : null,
        dryRun: dry,
      });
    },
  });

  const shutdown = async (signal) => {
    logger.info(`${signal} ricevuto, chiudo…`);
    watcher?.close();
    flush();
    flushContacts();
    logger.info({ stats: getStats() }, 'statistiche');
    client.stop();
    await sleep(300);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => logger.error({ err: String(err) }, 'unhandled rejection'));

  process.on('exit', () => flush());
  setInterval(flush, 30000).unref();

  client.ready.then(() => logger.info('✅ ready: listening for incoming messages'));

  await client.run;
}

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'avvio fallito');
  process.exit(1);
});
