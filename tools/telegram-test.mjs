// Tests for the mirror.telegram action: it must turn each kind of WhatsApp
// message into the right Telegram call (sendMessage/sendPhoto/sendVoice/...),
// without ever touching the network or a real bot.
//
//   node tools/telegram-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { paths, env } from '../src/config.js';
import { runActions } from '../src/actions.js';

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(actual, expected, msg = '') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}\n      expected: ${JSON.stringify(expected)}\n      actual  : ${JSON.stringify(actual)}`);
  }
}

// --- a fake Telegram that records every call -------------------------------
const calls = [];
const json = (body, status = 200) => ({ status, json: async () => body });
let respond = () => json({ ok: true, result: { message_id: calls.length } });

globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  return respond(calls[calls.length - 1]);
};

const methodOf = (call) => call.url.split('/').pop();
const bodyOf = (call) => JSON.parse(call.init.body);

// --- a temp media file to upload -------------------------------------------
const tmpDir = path.join(paths.data, 'out', 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });
const mediaFile = path.join(tmpDir, 'telegram-test-media.bin');
fs.writeFileSync(mediaFile, Buffer.from('not a real image, but enough to upload'));

async function mirror(action = {}, msgOverrides = {}, ctxOverrides = {}, responder = null) {
  calls.length = 0;
  respond = responder || (() => json({ ok: true, result: { message_id: calls.length } }));
  const ctx = {
    rule: { id: 'mirror', name: 'mirror' },
    msg: {
      id: 'm1',
      type: 'text',
      chatJid: 'x@s.whatsapp.net',
      chatName: 'Orders',
      senderJid: 'y@s.whatsapp.net',
      senderName: 'Mario',
      fromMe: false,
      ...msgOverrides,
    },
    text: '',
    transcript: null,
    // nel vero pipeline ctx.mediaFile è già il media scaricato (msg.mediaFile)
    mediaFile: msgOverrides.mediaFile ?? null,
    settings: {},
    ...ctxOverrides,
  };
  const res = await runActions([{ type: 'mirror.telegram', chatId: '-100', token: 'TEST', ...action }], ctx);
  return { res, ctx, calls };
}

const withMedia = { type: 'image', mediaMimetype: 'image/jpeg', mediaFile };

console.log('\ntext\n');

await check('a text message becomes a sendMessage with sender and text', async () => {
  const { res, calls } = await mirror({}, { type: 'text' }, { text: 'we need three boxes' });
  eq(res.results[0].ok, true, `the action failed: ${res.results[0].error}`);
  eq(methodOf(calls[0]), 'sendMessage');
  eq(bodyOf(calls[0]).chat_id, '-100');
  eq(bodyOf(calls[0]).text, 'Mario we need three boxes');
});

await check('prefix: false leaves the sender out', async () => {
  const { calls } = await mirror({ prefix: false }, { type: 'text' }, { text: 'just the text' });
  eq(bodyOf(calls[0]).text, 'just the text');
});

await check('a custom prefix uses the placeholders', async () => {
  const { calls } = await mirror({ prefix: '[{{chat}}] {{sender}}:' }, { type: 'text' }, { text: 'hi' });
  eq(bodyOf(calls[0]).text, '[Orders] Mario: hi');
});

await check('threadId becomes message_thread_id (topic routing)', async () => {
  const { calls } = await mirror({ threadId: 15 }, { type: 'text' }, { text: 'hi' });
  eq(bodyOf(calls[0]).message_thread_id, 15);
});

await check('parseMode HTML: markup in the prefix stays, the values are escaped', async () => {
  const { calls } = await mirror(
    { parseMode: 'HTML', prefix: '<b>{{sender}}</b> -' },
    { type: 'text', senderName: 'Mario & Co.' },
    { text: 'a & b < c' },
  );
  eq(bodyOf(calls[0]).parse_mode, 'HTML');
  eq(bodyOf(calls[0]).text, '<b>Mario &amp; Co.</b> - a &amp; b &lt; c');
});

await check('parseMode HTML escapes the media caption too', async () => {
  const { calls } = await mirror({ parseMode: 'HTML' }, withMedia, { text: 'x & y' });
  eq(calls[0].init.body.get('parse_mode'), 'HTML');
  eq(calls[0].init.body.get('caption'), 'Mario x &amp; y');
});

await check('message: a full template, newline included, values escaped', async () => {
  const { calls } = await mirror(
    { parseMode: 'HTML', message: '<b>{{sender}}</b>\n{{content}}' },
    { type: 'text', senderName: 'Mario & Co.' },
    { text: 'riga due' },
  );
  eq(bodyOf(calls[0]).text, '<b>Mario &amp; Co.</b>\nriga due');
});

await check('message: the template is the caption of media too', async () => {
  const msg = { type: 'audio', ptt: true, mediaMimetype: 'audio/ogg; codecs=opus', mediaFile };
  const { calls } = await mirror({ parseMode: 'HTML', message: '{{sender}}\n{{transcript}}' }, msg, { text: '', transcript: 'ciao' });
  eq(calls[0].init.body.get('caption'), 'Mario\nciao');
});

await check('a message with no text at all says what it is', async () => {
  const { calls } = await mirror({}, { type: 'location' }, { text: '' });
  eq(methodOf(calls[0]), 'sendMessage');
  assert(bodyOf(calls[0]).text.includes('location'), `unclear text: ${bodyOf(calls[0]).text}`);
});

await check('a text longer than 4096 is truncated, not refused', async () => {
  const { calls } = await mirror({ prefix: false }, { type: 'text' }, { text: 'x'.repeat(5000) });
  const text = bodyOf(calls[0]).text;
  eq(text.length, 4096);
  assert(text.endsWith('…'), 'it was cut without an ellipsis');
});

console.log('\nmedia\n');

await check('an image becomes a sendPhoto with a caption', async () => {
  const { res, calls } = await mirror({}, withMedia, { text: 'look at this' });
  eq(res.results[0].ok, true, `the action failed: ${res.results[0].error}`);
  eq(methodOf(calls[0]), 'sendPhoto');
  const body = calls[0].init.body;
  eq(body.get('chat_id'), '-100');
  eq(body.get('caption'), 'Mario look at this');
  assert(body.get('photo') instanceof Blob, 'the photo was not attached as a file');
});

await check('asDocument:true sends an image as a document', async () => {
  const { calls } = await mirror({ asDocument: true }, withMedia, { text: 'look' });
  eq(methodOf(calls[0]), 'sendDocument');
  assert(calls[0].init.body.get('document') instanceof Blob, 'the file is missing');
});

await check('a voice note (ptt/ogg) becomes a sendVoice', async () => {
  const msg = { type: 'audio', ptt: true, seconds: 7, mediaMimetype: 'audio/ogg; codecs=opus', mediaFile };
  const { calls } = await mirror({}, msg, { text: '', transcript: 'buy milk' });
  eq(methodOf(calls[0]), 'sendVoice');
  const body = calls[0].init.body;
  eq(body.get('caption'), 'Mario buy milk');
  eq(body.get('duration'), '7');
});

await check('a non-ptt audio becomes a sendAudio', async () => {
  const msg = { type: 'audio', ptt: false, mediaMimetype: 'audio/mpeg', mediaFile };
  const { calls } = await mirror({}, msg, { text: '' });
  eq(methodOf(calls[0]), 'sendAudio');
});

await check('a video becomes a sendVideo', async () => {
  const { calls } = await mirror({}, { type: 'video', mediaMimetype: 'video/mp4', mediaFile });
  eq(methodOf(calls[0]), 'sendVideo');
});

await check('a document keeps its file name', async () => {
  const msg = { type: 'document', mediaMimetype: 'application/pdf', fileName: 'invoice.pdf', mediaFile };
  const { calls } = await mirror({}, msg, { text: 'the invoice' });
  eq(methodOf(calls[0]), 'sendDocument');
  eq(calls[0].init.body.get('document').name, 'invoice.pdf');
});

await check('a sticker becomes a sendSticker, caption in a message before it', async () => {
  const { calls } = await mirror({}, { type: 'sticker', mediaMimetype: 'image/webp', mediaFile });
  eq(calls.length, 2, 'expected the caption message plus the sticker');
  eq(methodOf(calls[0]), 'sendMessage');
  eq(methodOf(calls[1]), 'sendSticker');
});

await check('an animated sticker sendSticker refuses is retried as a document', async () => {
  const responder = (call) => (methodOf(call) === 'sendSticker'
    ? json({ ok: false, description: 'STICKER_ANIMATED unsupported' }, 400)
    : json({ ok: true, result: {} }));
  const { res, calls } = await mirror(
    { prefix: false },
    { type: 'sticker', mediaMimetype: 'image/webp', mediaFile },
    {},
    responder,
  );
  eq(res.results[0].ok, true, `the fallback failed: ${res.results[0].error}`);
  eq(calls.map(methodOf), ['sendSticker', 'sendDocument']);
});

await check('the media is downloaded on demand when the pipeline did not', async () => {
  calls.length = 0;
  respond = () => json({ ok: true, result: {} });
  let asked = 0;
  const ctx = {
    rule: { id: 'mirror', name: 'mirror' },
    msg: { id: 'm2', type: 'image', chatName: 'Orders', senderName: 'Mario', mediaMimetype: 'image/jpeg' },
    text: '',
    transcript: null,
    mediaFile: null,
    settings: {},
    downloadMedia: async () => { asked += 1; return mediaFile; },
  };
  const res = await runActions([{ type: 'mirror.telegram', chatId: '-100', token: 'TEST' }], ctx);
  eq(res.results[0].ok, true, `the action failed: ${res.results[0].error}`);
  eq(asked, 1, 'downloadMedia was not called exactly once');
  eq(methodOf(calls[0]), 'sendPhoto');
});

await check('with no media and no download function it fails, and says why', async () => {
  const { res } = await mirror({}, { type: 'image', mediaMimetype: 'image/jpeg', mediaFile: null });
  eq(res.results[0].ok, false);
  assert(/media/i.test(res.results[0].error), `unclear error: ${res.results[0].error}`);
});

console.log('\nconfiguration\n');

await check('without Telegram configured the action fails with the env names', async () => {
  const prevToken = env.telegramToken;
  const prevChat = env.telegramChatId;
  env.telegramToken = '';
  env.telegramChatId = '';
  try {
    const res = await runActions([{ type: 'mirror.telegram' }], {
      rule: { id: 'r', name: 'r' },
      msg: { type: 'text', senderName: 'x' },
      text: 'hi',
      settings: {},
    });
    eq(res.results[0].ok, false);
    assert(/TELEGRAM_BOT_TOKEN/.test(res.results[0].error), `unclear error: ${res.results[0].error}`);
  } finally {
    env.telegramToken = prevToken;
    env.telegramChatId = prevChat;
  }
});

fs.rmSync(mediaFile, { force: true });

console.log(failed ? `\n✗ ${failed} tests failed\n` : '\n✓ telegram mirror ok\n');
process.exit(failed ? 1 : 0);
