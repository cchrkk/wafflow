import { childLogger } from './logger.js';
import { alternateJid, isSelf, normalizeJid, selfJids } from './contacts.js';

const log = childLogger('rules');

export { normalizeJid };

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Un campo testuale può essere:
 *   "testo"                              -> contains, case-insensitive
 *   ["a","b"]                            -> true se contiene almeno uno
 *   { mode:"contains|exact|regex", value|patterns, flags? }
 *
 * `flags` vale solo per mode: regex (default "i"). Serve il flag "u" per i
 * confini unicode: \b considera lettere solo [A-Za-z0-9_], quindi "\bcittà\b"
 * non matcherebbe mai.
 */
function matchesText(value, spec) {
  if (value == null) return false;
  let mode = 'contains';
  let patterns;
  let flags = 'i';

  if (typeof spec === 'string') patterns = [spec];
  else if (Array.isArray(spec)) patterns = spec;
  else if (typeof spec === 'object') {
    mode = (spec.mode || 'contains').toLowerCase();
    patterns = asArray(spec.patterns ?? spec.value);
    if (spec.flags != null) flags = String(spec.flags).replace(/[^gimsuy]/g, '');
  } else return false;

  const haystack = String(value);
  const lower = haystack.toLowerCase();

  return patterns.some((p) => {
    const needle = String(p);
    switch (mode) {
      case 'exact':
        return lower === needle.toLowerCase();
      case 'regex': {
        try {
          return new RegExp(needle, flags).test(haystack);
        } catch (err) {
          log.warn({ pattern: needle, flags, err: err.message }, 'invalid regex, ignored');
          return false;
        }
      }
      case 'contains':
      default:
        return lower.includes(needle.toLowerCase());
    }
  });
}

/**
 * Estrae i gruppi di cattura dalla prima regex di textMatch che matcha.
 * Serve a usare nel campo di un'azione una parola presa dal messaggio:
 *
 *   textMatch: { mode: regex, patterns: ['accendi (?:la )?luce (?<stanza>\w+)'] }
 *   entityId: "light.{{stanza}}"
 *
 * Ritorna { list: ["cameretta"], named: { stanza: "cameretta" } } oppure null.
 */
export function extractCaptures(rule, text) {
  const tm = rule.match?.textMatch;
  if (!tm || typeof tm !== 'object' || Array.isArray(tm)) return null;
  if (String(tm.mode || '').toLowerCase() !== 'regex') return null;
  if (text == null || text === '') return null;

  // niente flag g: exec su una regex globale diventa stateful
  const flags = String(tm.flags || 'i').replace(/[^imsuy]/g, '');

  for (const p of asArray(tm.patterns ?? tm.value)) {
    let re;
    try {
      re = new RegExp(String(p), flags);
    } catch {
      continue;
    }
    const m = re.exec(String(text));
    if (!m) continue;
    return {
      list: m.slice(1).map((x) => (x == null ? '' : x)),
      named: { ...(m.groups || {}) },
    };
  }
  return null;
}

/**
 * Cerca la trappola classica delle regex sui testi italiani: un \b che deve
 * fare da confine a una parola accentata. \b considera lettere solo
 * [A-Za-z0-9_], quindi "\b(cartone|città)\b" non matcherà mai su "città":
 * dopo la è c'è una virgola, e fra due non-lettere non esiste confine.
 *
 * Il controllo è volutamente largo (basta un \b e una lettera accentata nel
 * pattern): cercare l'adiacenza esatta fallisce su "\b(a|città|b)\b", che è
 * proprio la forma in cui il problema si presenta davvero.
 *
 * Ritorna [{ rule, pattern }].
 */
export function auditRegexes(rules) {
  const problemi = [];
  for (const r of rules) {
    const tm = r.match?.textMatch;
    if (!tm || typeof tm !== 'object' || Array.isArray(tm)) continue;
    if (String(tm.mode || '').toLowerCase() !== 'regex') continue;
    for (const p of asArray(tm.patterns ?? tm.value)) {
      const pat = String(p);
      if (!pat.includes('\\b')) continue;
      if (!/[^\x00-\x7F]/.test(pat)) continue;
      problemi.push({ rule: r.id, pattern: pat });
    }
  }
  return problemi;
}

/**
 * Confronto fra jid. Accetta come candidati sia la forma LID sia quella col numero,
 * e capisce il segnaposto "@me" (il tuo account).
 */
function matchesJid(candidates, spec) {
  const want = [];
  for (const p of asArray(spec)) {
    if (typeof p === 'string' && p.trim().toLowerCase() === '@me') want.push(...selfJids());
    else want.push(normalizeJid(p));
  }

  const have = new Set();
  for (const c of asArray(candidates)) {
    const n = normalizeJid(c);
    if (!n) continue;
    have.add(n);
    const alt = alternateJid(n);
    if (alt) have.add(alt);
  }

  const haveUsers = new Set([...have].map((j) => j.split('@')[0]));
  return want.filter(Boolean).some((t) => have.has(t) || haveUsers.has(t.split('@')[0]));
}

function matchesType(value, spec) {
  const list = asArray(spec).map((t) => String(t).toLowerCase());
  if (list.includes('*') || list.includes('any')) return true;
  if (list.includes('media') && ['audio', 'image', 'video', 'document', 'sticker'].includes(value)) return true;
  return list.includes(String(value).toLowerCase());
}

/**
 * Le uniche chiavi che `ruleMatches()` guarda. Tutto il resto dentro `match`
 * viene ignorato in silenzio — è così che un `threadId` (che è un parametro
 * dell'azione, non un criterio) finisce per non fare nulla. `--check` lo segnala.
 */
export const MATCH_KEYS = [
  'chatJid', 'chatName', 'senderJid', 'senderName', 'self',
  'type', 'isGroup', 'ptt', 'mediaMimetype', 'textMatch',
];

/**
 * Verifica se un messaggio normalizzato soddisfa il match di una regola.
 * `resolvedText` è il testo utile: body del messaggio oppure trascrizione.
 */
export function ruleMatches(rule, msg, resolvedText) {
  const m = rule.match || {};
  const checks = [];

  if (m.chatJid != null) checks.push(['chatJid', matchesJid([msg.chatJid, msg.chatJidAlt], m.chatJid)]);
  if (m.chatName != null) checks.push(['chatName', matchesText(msg.chatName, m.chatName)]);
  if (m.senderJid != null) checks.push(['senderJid', matchesJid([msg.senderJid, msg.senderJidAlt], m.senderJid)]);
  if (m.senderName != null) checks.push(['senderName', matchesText(msg.senderName, m.senderName)]);
  if (m.self != null) checks.push(['self', isSelf(msg.senderJid) === Boolean(m.self)]);
  if (m.type != null) checks.push(['type', matchesType(msg.type, m.type)]);
  if (m.isGroup != null) checks.push(['isGroup', Boolean(msg.isGroup) === Boolean(m.isGroup)]);
  if (m.ptt != null) checks.push(['ptt', Boolean(msg.ptt) === Boolean(m.ptt)]);
  if (m.mediaMimetype != null) checks.push(['mediaMimetype', matchesText(msg.mediaMimetype, m.mediaMimetype)]);
  if (m.textMatch != null) checks.push(['textMatch', matchesText(resolvedText, m.textMatch)]);

  const failed = checks.filter(([, ok]) => !ok).map(([n]) => n);
  const ok = failed.length === 0;
  if (!ok) log.debug({ rule: rule.id, failed }, 'rule not satisfied');
  return { ok, failed, checks: checks.length };
}

/** Applica i filtri di classificazione LLM, se presenti. */
export function classifyAllows(rule, classification) {
  if (!rule.classify) return true;
  if (!classification) return true; // LLM non disponibile: non bloccare
  const labels = asArray(rule.classify.labels || []).map((l) => String(l).toLowerCase());
  if (labels.length && !labels.includes(classification.label)) return false;
  const min = Number(rule.classify.minConfidence ?? 0);
  return classification.confidence >= min;
}
