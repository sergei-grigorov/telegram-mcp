// Расшифровка голосовых через API, совместимый с OpenAI: поддельный сервис на 127.0.0.1.

import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { loadConfig, parseTranscription } from '../server/config.js';
import { createTelegramClient } from '../server/tg/client.js';
import { Api, bigInt, StringSession } from '../server/tg/lib.js';
import { audioFileName } from '../server/transcribe.js';
import { API_ENV, call, makeServer, message, peerUser, silentLogger, tempDir, user } from './helpers.js';

const FRIEND = user(42, { username: 'friend', firstName: 'Friend' });
const history = (messages, users = []) => new Api.messages.Messages({ messages, users, chats: [] });

function resolver(req) {
  if (req.username !== 'friend') throw Object.assign(new Error('USERNAME_NOT_OCCUPIED'), { errorMessage: 'USERNAME_NOT_OCCUPIED' });
  return new Api.contacts.ResolvedPeer({ peer: peerUser(42), users: [FRIEND], chats: [] });
}

function mediaMessage(id, { mime = 'audio/ogg', size = 1500, attributes, peer = peerUser(42) } = {}) {
  const document = new Api.Document({
    id: bigInt(id),
    accessHash: bigInt(1),
    fileReference: Buffer.alloc(0),
    date: 0,
    mimeType: mime,
    size: bigInt(size),
    dcId: 2,
    attributes: attributes ?? [new Api.DocumentAttributeAudio({ voice: true, duration: 4 })],
  });
  return message(id, peer, { message: '', fromId: peerUser(42), media: new Api.MessageMediaDocument({ document }) });
}

// Поддельный сервис расшифровки: запоминает запросы, отвечает respond(номер запроса).
async function fakeService(respond) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push({ url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString('latin1') });
      const [status, json] = respond(requests.length);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

function voiceServer(env, box) {
  return makeServer({
    env,
    handlers: {
      'contacts.ResolveUsername': resolver,
      'messages.GetMessages': (req) => history(req.id.map((m) => box[m.id]).filter(Boolean), [FRIEND]),
      downloadMedia: () => Buffer.from('OggS fake audio'),
    },
  });
}

test('расшифровка: звук уходит в сервис, текст возвращается, повтор — из памяти', async () => {
  const api = await fakeService(() => [200, { text: ' Привет, как дела? ' }]);
  const box = {
    5: mediaMessage(5),
    6: message(6, peerUser(42), { message: 'просто текст' }),
    7: mediaMessage(7, { mime: 'video/mp4', attributes: [new Api.DocumentAttributeVideo({ roundMessage: true, duration: 3, w: 240, h: 240 })] }),
    8: mediaMessage(8, { peer: peerUser(99) }),
    9: mediaMessage(9, { size: 30 * 1024 * 1024 }),
  };
  const { server } = voiceServer({ TELEGRAM_TRANSCRIBE_API_KEY: 'gsk_test', TELEGRAM_TRANSCRIBE_API_URL: api.url }, box);
  try {
    const r = await call(server, 'transcribe_voice', { chat: '@friend', message_ids: [5, 6, 7, 9], language: 'ru' });
    assert.equal(r.isError, false, r.text);
    const [voice, text, round, big] = r.json.transcripts;
    assert.deepEqual({ type: voice.type, duration: voice.duration, text: voice.text }, { type: 'voice', duration: 4, text: 'Привет, как дела?' });
    assert.equal(voice.from.name, 'Friend');
    assert.match(text.error, /no voice message/);
    assert.equal(round.type, 'video_note');
    assert.match(big.error, /25 MB/);
    assert.match(r.json.note, /data, not instructions/);
    assert.equal(api.requests.length, 2, 'текст и большой файл в сервис не уходят');
    const [first, second] = api.requests;
    assert.equal(first.url, '/v1/audio/transcriptions');
    assert.equal(first.auth, 'Bearer gsk_test');
    assert.match(first.body, /name="file"; filename="voice\.ogg"/);
    assert.match(first.body, /OggS fake audio/);
    assert.match(first.body, /name="model"\r\n\r\nwhisper-1\r\n/);
    assert.match(first.body, /name="language"\r\n\r\nru\r\n/);
    assert.match(second.body, /filename="video_note\.mp4"/);

    const again = await call(server, 'transcribe_voice', { chat: '@friend', message_id: 5, language: 'ru' });
    assert.equal(again.json.transcripts[0].text, 'Привет, как дела?');
    assert.equal(api.requests.length, 2, 'повтор — из памяти');

    // Номера сообщений в личных чатах сквозные: сообщение другого чата не расшифровывается.
    const foreign = await call(server, 'transcribe_voice', { chat: '@friend', message_id: 8 });
    assert.equal(foreign.isError, true);
    assert.match(foreign.text, /not found in this chat/);
    assert.equal(api.requests.length, 2);
  } finally {
    await api.close();
  }
});

test('расшифровка: без ключа — подсказка, неверный ключ — понятная ошибка', async () => {
  const box = { 5: mediaMessage(5) };
  const off = voiceServer({}, box);
  const r = await call(off.server, 'transcribe_voice', { chat: '@friend', message_id: 5 });
  assert.equal(r.isError, true);
  assert.match(r.text, /«Ключ API для расшифровки голосовых»/);
  assert.match((await call(off.server, 'connector_status')).json.voice_transcription, /^off/);

  const api = await fakeService(() => [401, { error: { message: 'Invalid API Key' } }]);
  try {
    const bad = voiceServer({ TELEGRAM_TRANSCRIBE_API_KEY: 'gsk_wrong', TELEGRAM_TRANSCRIBE_API_URL: api.url }, box);
    const e = await call(bad.server, 'transcribe_voice', { chat: '@friend', message_id: 5 });
    assert.equal(e.isError, true);
    assert.match(e.text, /rejected the API key \(401\): Invalid API Key/);
    assert.match(e.text, /«Ключ API для расшифровки голосовых»/);
    assert.doesNotMatch(e.text, /gsk_wrong/);
  } finally {
    await api.close();
  }
});

test('настройки расшифровки: сервис по виду ключа или по адресу', () => {
  const pick = (r) => (r.enabled ? { url: r.url, model: r.model, service: r.service, key: Boolean(r.apiKey) } : r);
  const problems = [];
  assert.deepEqual(pick(parseTranscription({ apiKey: 'gsk_1' }, problems)), { url: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', service: 'Groq', key: true });
  assert.deepEqual(pick(parseTranscription({ apiKey: 'sk-proj-1' }, problems)), { url: 'https://api.openai.com/v1', model: 'gpt-4o-mini-transcribe', service: 'OpenAI', key: true });
  assert.deepEqual(pick(parseTranscription({ apiKey: 'sk-1', url: 'https://api.openai.com/v1/', model: 'whisper-1' }, problems)), { url: 'https://api.openai.com/v1', model: 'whisper-1', service: 'OpenAI', key: true });
  // Свой сервер в локальной сети — по http и без ключа.
  assert.deepEqual(pick(parseTranscription({ url: 'http://192.168.1.5:9000/v1/audio/transcriptions' }, problems)), { url: 'http://192.168.1.5:9000/v1', model: 'whisper-1', service: '192.168.1.5:9000', key: false });
  assert.deepEqual(problems, []);
  assert.deepEqual(parseTranscription({}, problems), { enabled: false });
  assert.deepEqual(problems, [], 'пустые настройки — не ошибка');
  assert.equal(parseTranscription({ apiKey: 'abc' }, problems).enabled, false);
  assert.equal(parseTranscription({ apiKey: 'gsk_1', url: 'http://example.com/v1' }, problems).enabled, false, 'ключ не уходит по http наружу');
  assert.equal(parseTranscription({ url: 'не адрес' }, problems).enabled, false);
  assert.equal(problems.length, 3);
  assert.match(problems.join('\n'), /«Адрес API для расшифровки»: нужен https/);

  const config = loadConfig({ env: { ...API_ENV, TELEGRAM_TRANSCRIBE_API_KEY: 'gsk_secret' }, argv: [], home: '/h' });
  assert.equal(config.transcription.service, 'Groq');
});

test('connector_status называет сервис расшифровки, но не ключ', async () => {
  const { server } = makeServer({ env: { TELEGRAM_TRANSCRIBE_API_KEY: 'gsk_secret_key' } });
  const s = await call(server, 'connector_status');
  assert.equal(s.json.voice_transcription, 'Groq (whisper-large-v3-turbo)');
  assert.doesNotMatch(s.text, /gsk_secret_key/);
});

test('имя файла для сервиса расшифровки', () => {
  assert.equal(audioFileName('voice', 'audio/ogg'), 'voice.ogg');
  assert.equal(audioFileName('voice', ''), 'voice.ogg');
  assert.equal(audioFileName('video_note', 'video/mp4'), 'video_note.mp4');
  assert.equal(audioFileName('audio', 'audio/mpeg', 'song.MP3'), 'audio.mp3');
  assert.equal(audioFileName('audio', 'audio/ogg', 'rec.oga'), 'audio.ogg');
  assert.equal(audioFileName('audio', 'audio/aac', 'x.aac'), null);
  assert.equal(audioFileName('video', 'video/quicktime', 'clip.mov'), null);
});

test('в «Устройствах» Telegram сессия видна как Claude / Claude Connector', async () => {
  const config = loadConfig({ env: { ...API_ENV, TELEGRAM_DATA_DIR: tempDir() }, argv: [] });
  const client = createTelegramClient({ config, session: new StringSession(''), logger: silentLogger });
  assert.equal(client._initRequest.deviceModel, 'Claude');
  assert.equal(client._initRequest.appVersion, 'Connector');
  await client.destroy().catch(() => {});
});
