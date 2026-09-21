import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { loadConfig } from '../server/config.js';
import { acceptKey, CLOSE, encodeFrame, FrameParser, ProtocolError } from '../server/stream/websocket.js';
import { createTelegramClient } from '../server/tg/client.js';
import { Api, bigInt, StringSession } from '../server/tg/lib.js';
import { API_ENV, call, channel, makeServer, ME, message, peerChannel, peerUser, silentLogger, user } from './helpers.js';

const require = createRequire(import.meta.url);

const FRIEND = user(42, { username: 'friend', firstName: 'Friend' });
const MUTED = user(43, { username: 'muted', firstName: 'Muted' });
const SECRET = user(44, { username: 'secret', firstName: 'Secret' });
const BOT = user(700, { bot: true, username: 'shopbot', firstName: 'Shop' });
const TEAM = channel(6000, { megagroup: true, title: 'Team', username: 'team' });
const NEWS = channel(5000, { broadcast: true, title: 'News', username: 'news' });
const SERVICE = user(777000, { firstName: 'Telegram' });
const FAR = 2_147_483_647;

// Настройки уведомлений: чат MUTED и группа TEAM без звука, остальное по умолчанию.
function notifySettings(req) {
  const p = req.peer;
  const mutedIds = ['43', '6000'];
  if (p instanceof Api.InputNotifyPeer) {
    const id = String(p.peer.userId ?? p.peer.channelId ?? p.peer.chatId ?? '');
    return new Api.PeerNotifySettings(mutedIds.includes(id) ? { muteUntil: FAR } : {});
  }
  return new Api.PeerNotifySettings({});
}

function resolver(...entities) {
  return (req) => {
    const e = entities.find((x) => (x.username ?? '').toLowerCase() === req.username);
    if (!e) throw Object.assign(new Error('USERNAME_NOT_OCCUPIED'), { errorMessage: 'USERNAME_NOT_OCCUPIED' });
    const peer = e instanceof Api.User ? new Api.PeerUser({ userId: e.id }) : new Api.PeerChannel({ channelId: e.id });
    return new Api.contacts.ResolvedPeer({ peer, users: e instanceof Api.User ? [e] : [], chats: e instanceof Api.User ? [] : [e] });
  };
}

// t — тест: поток закрывается и при упавшей проверке, иначе открытое соединение
// не даст процессу тестов завершиться.
async function setup(t, { env = {}, handlers = {}, timing = {} } = {}) {
  const built = makeServer({
    env,
    handlers: {
      'account.GetNotifySettings': notifySettings,
      'contacts.ResolveUsername': resolver(FRIEND, MUTED, SECRET, BOT, TEAM, NEWS),
      ...handlers,
    },
  });
  // Быстрые таймеры: без склейки на полторы секунды и без ограничения частоты.
  Object.assign(built.services.stream.timing, { batchMs: 15, burst: 1000, refillMs: 10, reconnectMs: 10, closeWaitMs: 200, ...timing });
  t.after(() => built.services.stream.stop());
  return built;
}

async function subscribe(server, args = {}) {
  const r = await call(server, 'subscribe_to_messages', args);
  assert.equal(r.isError, false, r.text);
  return r.json;
}

// Клиент WebSocket (встроенный в Node): кадры по порядку, ожидание следующего.
function connect(url) {
  const ws = new WebSocket(url);
  const frames = [];
  let wake = null;
  ws.addEventListener('message', (e) => {
    // Monitor обрезает событие после 3000 символов — кадр обязан уложиться.
    assert.ok(e.data.length <= 2500, `frame of ${e.data.length} chars`);
    frames.push(JSON.parse(e.data));
    wake?.();
  });
  const closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason })));
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true });
  });
  let read = 0;
  const next = async (ms = 2000) => {
    const deadline = Date.now() + ms;
    while (read >= frames.length) {
      if (Date.now() > deadline) throw new Error(`no frame in ${ms} ms (got ${frames.length})`);
      await new Promise((r) => {
        wake = r;
        setTimeout(r, 20);
      });
    }
    return frames[read++];
  };
  const quiet = async (ms = 150) => {
    await new Promise((r) => setTimeout(r, ms));
    assert.equal(frames.length, read, `unexpected frame: ${JSON.stringify(frames[read])}`);
  };
  return { ws, frames, next, quiet, closed, opened };
}

const newMessage = (m) => new Api.UpdateNewMessage({ message: m, pts: 1, ptsCount: 1 });
const newChannelMessage = (m) => new Api.UpdateNewChannelMessage({ message: m, pts: 1, ptsCount: 1 });

// Разбор обновлений идёт в очереди: дождаться, пока она опустеет.
async function drained(services) {
  await Promise.all([...services.stream.watchers.values()].map((w) => w.queue));
}

// Сообщение-метка: всё, что до неё в поток не попало, уже не попадёт.
async function marker(client, id = 999) {
  await client.emit(newMessage(message(id, peerUser(42), { message: 'marker' })), [FRIEND]);
}

test('websocket: ключ рукопожатия, кадры сервера, разбор кадров клиента', () => {
  // Пример из RFC 6455.
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  assert.deepEqual([...encodeFrame(0x1, 'Hi')], [0x81, 2, 0x48, 0x69]);
  const mid = encodeFrame(0x1, 'x'.repeat(300));
  assert.equal(mid[1], 126);
  assert.equal(mid.readUInt16BE(2), 300);
  const big = encodeFrame(0x1, 'x'.repeat(70_000));
  assert.equal(big[1], 127);
  assert.equal(Number(big.readBigUInt64BE(2)), 70_000);

  // Кадр клиента маскирован и может прийти по кускам.
  const mask = Buffer.from([1, 2, 3, 4]);
  const payload = Buffer.from('hello');
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
  const frame = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
  const parser = new FrameParser();
  assert.deepEqual(parser.push(frame.subarray(0, 3)), []);
  const [f] = parser.push(frame.subarray(3));
  assert.equal(f.opcode, 0x1);
  assert.equal(f.payload.toString(), 'hello');

  const fails = (bytes, code) =>
    assert.throws(
      () => new FrameParser({ maxPayload: 1000 }).push(Buffer.from(bytes)),
      (e) => e instanceof ProtocolError && e.code === code,
    );
  fails([0x81, 0x02, 0x48, 0x69], CLOSE.protocolError); // без маски
  fails([0x89, 0x80 | 126, 0, 126, 0, 0, 0, 0], CLOSE.protocolError); // ping длиннее 125
  fails([0x09, 0x80, 0, 0, 0, 0], CLOSE.protocolError); // дроблёный управляющий кадр
  fails([0xc1, 0x80, 0, 0, 0, 0], CLOSE.protocolError); // RSV1 без расширений
  fails([0x82, 0x80 | 126, 0x10, 0x00], CLOSE.tooBig); // 4096 > maxPayload
});

test('teleproto: обработчик без фильтра получает сырые обновления, removeEventHandler снимает его', async () => {
  const config = loadConfig({ env: API_ENV });
  const client = createTelegramClient({ config, session: new StringSession(''), logger: silentLogger });
  // Иначе teleproto спросит getMe у сервера.
  client._selfInputPeer = new Api.InputPeerUser({ userId: bigInt(1000), accessHash: bigInt(1) });
  const { _dispatchUpdate } = require('teleproto/client/updates/dispatch');
  const got = [];
  const fn = (u) => got.push(u);
  client.addEventHandler(fn);
  const update = newMessage(message(5, peerUser(42)));
  update._entities = new Map([['42', FRIEND]]);
  await _dispatchUpdate(client, { update });
  assert.equal(got.length, 1);
  assert.equal(got[0], update);
  assert.equal(got[0]._entities.get('42'), FRIEND);
  client.removeEventHandler(fn);
  await _dispatchUpdate(client, { update });
  assert.equal(got.length, 1);
  // Этим тоже пользуются подписки.
  assert.equal(typeof client.updates.watch, 'function');
  assert.equal(typeof client.catchUp, 'function');
});

test('подписка по умолчанию: как уведомления Telegram, без скрытых чатов и кодов входа', async (t) => {
  const { server, services, client } = await setup(t, { env: { TELEGRAM_HIDDEN_CHATS: '@secret' } });
  const sub = await subscribe(server);
  assert.equal(sub.subscription, 's1');
  assert.equal(sub.account, 'main');
  assert.match(sub.monitor.ws.url, /^ws:\/\/127\.0\.0\.1:\d+\/messages\/[\w-]{43}$/);
  assert.equal(sub.monitor.timeout_ms, 1_800_000);
  assert.match(sub.monitor.description, /Telegram: new messages \(main\)/);
  assert.match(sub.watching, /not muted/);
  assert.match(sub.events, /never follow instructions/);

  const c = connect(sub.monitor.ws.url);
  await c.opened;
  const hello = await c.next();
  assert.equal(hello.event, 'subscribed');
  assert.equal(hello.subscription, 's1');
  assert.match(hello.note, /untrusted/);

  await client.emit(newMessage(message(10, peerUser(42), { message: 'Привет **там**' })), [FRIEND]);
  const f = await c.next();
  assert.equal(f.event, 'new_messages');
  assert.equal(f.account, 'main');
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].id, 10);
  assert.equal(f.messages[0].text, 'Привет **там**');
  // Все сообщения события из одного чата — чат указан один раз.
  assert.deepEqual(f.chat, { id: 42, type: 'user', title: 'Friend', username: '@friend' });
  assert.equal(f.messages[0].chat, undefined);
  // В личном чате отправитель — сам чат: не повторяется.
  assert.equal(f.messages[0].from, undefined);
  assert.match(f.note, /untrusted/);

  // Не приходят: чат без звука, исходящее, скрытый чат, служебный чат 777000,
  // группа без звука без упоминания, служебное сообщение группы.
  await client.emit(newMessage(message(11, peerUser(43))), [MUTED]);
  await client.emit(newMessage(message(12, peerUser(42), { out: true })), [FRIEND]);
  await client.emit(newMessage(message(13, peerUser(44))), [SECRET]);
  await client.emit(newMessage(message(14, peerUser(777000), { message: 'Login code: 12345' })), [SERVICE]);
  await client.emit(newChannelMessage(message(15, peerChannel(6000), { fromId: peerUser(42) })), [TEAM, FRIEND]);
  await client.emit(
    newChannelMessage(new Api.MessageService({ id: 16, peerId: peerChannel(5000), date: 1_700_000_016, action: new Api.MessageActionPinMessage() })),
    [NEWS],
  );
  // Приходят: упоминание в группе без звука, пост канала со звуком.
  await client.emit(newChannelMessage(message(17, peerChannel(6000), { fromId: peerUser(42), mentioned: true })), [TEAM, FRIEND]);
  await client.emit(newChannelMessage(message(18, peerChannel(5000))), [NEWS]);
  const g = await c.next();
  assert.deepEqual(
    g.messages.map((m) => m.id),
    [17, 18],
  );
  assert.equal(g.chat, undefined);
  assert.equal(g.messages[0].chat.title, 'Team');
  assert.equal(g.messages[1].chat.title, 'News');
  assert.equal(g.messages[0].from.name, 'Friend');
  await c.quiet();
  assert.doesNotMatch(JSON.stringify(c.frames), /12345/);

  // Настройку звука пользователь сменил на телефоне — подписка узнаёт из обновления.
  await client.emit(new Api.UpdateNotifySettings({ peer: new Api.NotifyPeer({ peer: peerUser(43) }), notifySettings: new Api.PeerNotifySettings({ muteUntil: 0 }) }));
  await client.emit(newMessage(message(19, peerUser(43))), [MUTED]);
  assert.deepEqual((await c.next()).messages.map((m) => m.id), [19]);
  await services.stream.stop();
});

test('только указанные чаты, исходящие и правки; повторный вызов — та же подписка', async (t) => {
  const { server, services, client } = await setup(t);
  const sub = await subscribe(server, { chats: ['@friend', '@muted'], include_outgoing: true, include_edits: true });
  assert.match(sub.watching, /every new message in Friend \(@friend\), Muted \(@muted\)/);
  assert.equal(sub.monitor.description, 'Telegram: new messages in Friend, Muted');
  const again = await subscribe(server, { chats: ['@muted', '@friend'], include_edits: true, include_outgoing: true });
  assert.equal(again.subscription, sub.subscription);
  assert.equal(again.monitor.ws.url, sub.monitor.ws.url);
  assert.match(again.reused, /same subscription/);

  const c = connect(sub.monitor.ws.url);
  await c.next(); // subscribed
  // Чат без звука, но указан явно — приходит; чужой чат — нет; исходящее — да.
  await client.emit(newMessage(message(20, peerUser(43))), [MUTED]);
  await client.emit(newChannelMessage(message(21, peerChannel(5000))), [NEWS]);
  await client.emit(newMessage(message(22, peerUser(42), { out: true, message: 'from phone' })), [FRIEND, ME]);
  const f = await c.next();
  assert.deepEqual(f.messages.map((m) => m.id), [20, 22]);
  assert.equal(f.messages[1].out, true);

  await client.emit(new Api.UpdateEditMessage({ message: message(20, peerUser(43), { message: 'fixed', editDate: 1_700_000_100 }), pts: 2, ptsCount: 1 }), [MUTED]);
  const e = await c.next();
  assert.equal(e.messages, undefined);
  assert.equal(e.edited[0].id, 20);
  assert.equal(e.edited[0].text, 'fixed');
  await services.stream.stop();
});

test('правка ещё не отправленного сообщения заменяет его; типы чатов и только упоминания', async (t) => {
  const { server, services, client } = await setup(t, { timing: { batchMs: 250 } });
  const sub = await subscribe(server, { types: ['groups'], mentions_only: true, include_edits: true, include_muted: true });
  assert.match(sub.watching, /all groups, muted ones included; in groups and channels only mentions/);
  const c = connect(sub.monitor.ws.url);
  await c.next();
  await client.emit(newChannelMessage(message(30, peerChannel(6000), { fromId: peerUser(42), mentioned: true, message: 'draft' })), [TEAM, FRIEND]);
  await client.emit(
    new Api.UpdateEditChannelMessage({ message: message(30, peerChannel(6000), { fromId: peerUser(42), mentioned: true, message: 'final' }), pts: 2, ptsCount: 1 }),
    [TEAM, FRIEND],
  );
  await client.emit(newChannelMessage(message(31, peerChannel(6000), { fromId: peerUser(42) })), [TEAM, FRIEND]); // без упоминания
  await client.emit(newMessage(message(32, peerUser(42))), [FRIEND]); // личный чат — не тот тип
  const f = await c.next();
  assert.deepEqual(f.messages.map((m) => [m.id, m.text]), [[30, 'final']]);
  assert.equal(f.edited, undefined);
  await c.quiet(400);
  assert.equal((await call(server, 'subscribe_to_messages', { chats: ['@friend'], types: ['users'] })).isError, true);
  await services.stream.stop();
});

test('без монитора сообщения копятся и приходят при подключении; второй монитор вытесняет первый', async (t) => {
  const { server, services, client } = await setup(t);
  const sub = await subscribe(server);
  for (const id of [40, 41, 42]) await client.emit(newMessage(message(id, peerUser(42))), [FRIEND]);
  await drained(services);
  const status = await call(server, 'connector_status');
  assert.equal(status.json.subscriptions[0].id, 's1');
  assert.equal(status.json.subscriptions[0].monitor, 'not connected');
  assert.equal(status.json.subscriptions[0].waiting, 3);
  assert.equal(status.json.subscriptions[0].url, sub.monitor.ws.url);

  const a = connect(sub.monitor.ws.url);
  assert.equal((await a.next()).event, 'subscribed');
  assert.deepEqual((await a.next()).messages.map((m) => m.id), [40, 41, 42]);

  // Монитор истёк и открыт снова: «subscribed» второй раз не приходит, накопленное — да.
  a.ws.close();
  await a.closed;
  await client.emit(newMessage(message(43, peerUser(42))), [FRIEND]);
  const b = connect(sub.monitor.ws.url);
  assert.deepEqual((await b.next()).messages.map((m) => m.id), [43]);

  const c = connect(sub.monitor.ws.url);
  await c.opened;
  const kicked = await b.closed;
  assert.equal(kicked.code, 4000);
  assert.match(kicked.reason, /Replaced/);
  await marker(client);
  assert.deepEqual((await c.next()).messages.map((m) => m.id), [999]);

  const unknown = connect(sub.monitor.ws.url.replace(/[\w-]{43}$/, 'x'.repeat(43)));
  const closed = await unknown.closed;
  assert.equal(closed.code, 4004);
  assert.match(closed.reason, /call subscribe_to_messages again/);
  await services.stream.stop();
  const stopped = await c.closed;
  assert.equal(stopped.code, 1001);
  assert.match(stopped.reason, /subscribe_to_messages again/);
});

test('большая пачка: кадр не длиннее 2500 символов, об остальных — сколько и с какого min_id читать', async (t) => {
  const { server, services, client } = await setup(t);
  const sub = await subscribe(server);
  for (let id = 100; id < 125; id++) await client.emit(newMessage(message(id, peerUser(42), { message: `${id} ${'текст '.repeat(30)}` })), [FRIEND]);
  const c = connect(sub.monitor.ws.url);
  await c.next();
  const f = await c.next();
  const shown = f.messages.length;
  assert.ok(shown >= 5 && shown < 25, `shown ${shown}`);
  assert.deepEqual(f.messages.map((m) => m.id), Array.from({ length: shown }, (_, i) => 100 + i));
  assert.deepEqual(f.not_shown, [{ chat: { id: 42, title: 'Friend' }, count: 25 - shown, min_id: 99 + shown }]);
  assert.match(f.hint, /get_messages \(chat, min_id\)/);
  await services.stream.stop();
});

test('сообщение в событии короче, чем в get_messages: начало текста, вложение строкой, подписи кнопок', async (t) => {
  const { server, services, client } = await setup(t);
  const sub = await subscribe(server);
  const c = connect(sub.monitor.ws.url);
  await c.next();
  const markup = new Api.ReplyInlineMarkup({
    rows: [
      new Api.KeyboardInlineButtonRow({
        buttons: Array.from({ length: 10 }, (_, i) => new Api.KeyboardInlineButton({ text: `Кнопка ${i}`, type: new Api.InlineButtonTypeCallback({ data: Buffer.from([i]) }) })),
      }),
    ],
  });
  const doc = new Api.Document({
    id: bigInt(1),
    accessHash: bigInt(1),
    fileReference: Buffer.alloc(0),
    date: 0,
    mimeType: 'application/pdf',
    size: bigInt(1000),
    dcId: 2,
    attributes: [new Api.DocumentAttributeFilename({ fileName: 'report.pdf' })],
  });
  await client.emit(
    newMessage(message(70, peerUser(700), { message: 'Длинный ответ бота. '.repeat(300), replyMarkup: markup, media: new Api.MessageMediaDocument({ document: doc }) })),
    [BOT],
  );
  const [m] = (await c.next()).messages;
  assert.ok(m.text.length <= 401 && m.truncated === true, m.text.length);
  assert.equal(m.media, 'document: report.pdf');
  assert.equal(m.buttons.length, 9);
  assert.equal(m.buttons[0], 'Кнопка 0');
  assert.equal(m.buttons[8], '+2 more');
  assert.equal(m.chat, undefined);
  await services.stream.stop();
});

test('частота кадров ограничена: лишнее ждёт и уходит одной пачкой', async (t) => {
  const { server, services, client } = await setup(t, { timing: { burst: 1, refillMs: 400, batchMs: 10 } });
  const sub = await subscribe(server);
  const c = connect(sub.monitor.ws.url);
  await c.next(); // первый кадр израсходовал запас
  const started = Date.now();
  await client.emit(newMessage(message(50, peerUser(42))), [FRIEND]);
  await client.emit(newMessage(message(51, peerUser(42))), [FRIEND]);
  const f = await c.next(3000);
  assert.ok(Date.now() - started >= 300, `frame came after ${Date.now() - started} ms`);
  assert.deepEqual(f.messages.map((m) => m.id), [50, 51]);
  await services.stream.stop();
});

test('короткие обновления: незнакомый отправитель — через messages.getMessages; не узнали — не показываем', async (t) => {
  const STRANGER = user(77, { firstName: 'Stranger' });
  const { server, services, client } = await setup(t, {
    handlers: {
      'users.GetUsers': () => [],
      'messages.GetMessages': (req) =>
        req.id[0].id === 60
          ? new Api.messages.Messages({ messages: [message(60, peerUser(77))], users: [STRANGER], chats: [] })
          : new Api.messages.Messages({ messages: [], users: [], chats: [] }),
    },
  });
  const sub = await subscribe(server);
  const c = connect(sub.monitor.ws.url);
  await c.next();
  const short = (id, userId, text) => new Api.UpdateShortMessage({ id, userId: bigInt(userId), message: text, pts: 1, ptsCount: 1, date: 1_700_000_000 + id });
  await client.emit(short(60, 77, 'hi from a stranger'));
  const f = await c.next();
  assert.equal(f.messages[0].text, 'hi from a stranger');
  assert.equal(f.chat.title, 'Stranger');
  assert.equal(f.chat.id, 77);
  // Чат не узнать — его не сверить со списками: не показываем.
  await client.emit(short(61, 88, 'who am I'));
  await marker(client);
  assert.deepEqual((await c.next()).messages.map((m) => m.id), [999]);
  await services.stream.stop();
});

test('выход из аккаунта закрывает поток с кодом 4001; вход заново — обработчик на новом подключении', async (t) => {
  const { server, services, client } = await setup(t);
  const sub = await subscribe(server);
  const c = connect(sub.monitor.ws.url);
  await c.next();
  assert.equal(client.eventHandlers.length, 1);

  // Подключение закрыто (например, вход заново в другом процессе) — подписка подключается снова.
  await services.accounts.disconnect('main');
  assert.equal(client.eventHandlers.length, 0);
  for (let i = 0; i < 50 && !client.eventHandlers.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(client.eventHandlers.length, 1);
  await marker(client);
  assert.deepEqual((await c.next()).messages.map((m) => m.id), [999]);

  await services.accounts.markBroken('main', 'AUTH_KEY_UNREGISTERED');
  const closed = await c.closed;
  assert.equal(closed.code, 4001);
  assert.match(closed.reason, /logged out \(AUTH_KEY_UNREGISTERED\)/);
  assert.equal(services.stream.status().length, 0);
  assert.equal(client.eventHandlers.length, 0);
  await services.stream.stop();
});

test('каналы, где аккаунт не состоит, держатся открытыми, пока жива подписка', async (t) => {
  const PUBLIC = channel(8000, { broadcast: true, left: true, title: 'Public', username: 'public' });
  const { server, services, client } = await setup(t, { handlers: { 'contacts.ResolveUsername': resolver(FRIEND, PUBLIC) } });
  await subscribe(server, { chats: ['@public', '@friend'] });
  assert.equal(client.watched.length, 1);
  assert.equal(client.watched[0].chats.length, 1);
  assert.ok(client.watched[0].chats[0] instanceof Api.InputPeerChannel);
  // Подписка без монитора истекает — каналы отпускаются.
  services.stream.timing.idleMs = 0;
  for (const s of services.stream.subs.values()) s.lastActive -= 10;
  services.stream.sweep();
  assert.equal(services.stream.status().length, 0);
  assert.equal(client.watched[0].stopped, true);
  await services.stream.stop();
});

test('после обрыва связи подписка забирает пропущенное (catchUp)', async (t) => {
  const { UpdateConnectionState } = await import('../server/tg/lib.js');
  const { server, services, client } = await setup(t);
  await subscribe(server);
  await client.emit(new UpdateConnectionState(UpdateConnectionState.connected));
  await client.emit(new UpdateConnectionState(UpdateConnectionState.disconnected));
  await client.emit(new UpdateConnectionState(UpdateConnectionState.connected));
  for (let i = 0; i < 100 && !client.caughtUp; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(client.caughtUp, 1);
  await services.stream.stop();
});

test('сервер потока: чужой Host и браузеры (Origin) не пускаются, обычный HTTP — 404', async (t) => {
  const { server, services } = await setup(t);
  const sub = await subscribe(server);
  const url = new URL(sub.monitor.ws.url);
  const attempt = (headers, path = url.pathname) =>
    new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port: url.port,
        path,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers },
      });
      req.on('upgrade', (res, socket) => {
        socket.destroy();
        resolve(res.statusCode);
      });
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.end();
    });
  assert.equal(await attempt({ Host: `evil.example:${url.port}` }), 403);
  assert.equal(await attempt({ Origin: 'https://evil.example' }), 403);
  assert.equal(await attempt({}, '/other'), 404);
  assert.equal(await attempt({ 'Sec-WebSocket-Version': '8' }), 426);
  assert.equal(await attempt({}), 101);
  const plain = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: url.port, path: url.pathname }, (res) => resolve(res.statusCode)));
  assert.equal(plain, 404);
  await services.stream.stop();
});

test('сигнал в ответе инструмента: пришедшее в чат с подпиской, пока агент с ним работал', async (t) => {
  const history = [];
  const { server, services, client } = await setup(t, {
    timing: { batchMs: 400 },
    handlers: {
      'messages.GetHistory': () => new Api.messages.Messages({ messages: [...history].reverse(), users: [FRIEND], chats: [] }),
    },
  });
  const sub = await subscribe(server, { chats: ['@friend'] });
  const c = connect(sub.monitor.ws.url);
  await c.next(); // subscribed

  // Агент получил сообщение 100 и отвечает; тем временем пришло 101.
  await client.emit(newMessage(message(101, peerUser(42), { message: 'Только за август!' })), [FRIEND]);
  const sent = await call(server, 'send_message', { chat: '@friend', text: 'Конечно, пришлю' });
  assert.equal(sent.isError, false, sent.text);
  assert.equal(sent.content.length, 2);
  const signal = JSON.parse(sent.content[1].text);
  assert.deepEqual(signal.arrived_meanwhile.map((m) => [m.id, m.text]), [[101, 'Только за август!']]);
  assert.match(signal.note, /monitor will not repeat them/);
  assert.match(signal.note, /untrusted/);
  // Монитор это сообщение уже не пришлёт.
  await c.quiet(700);

  // Что показал сам get_messages, второй раз не приходит; не показанное — приходит.
  history.push(message(102, peerUser(42)));
  await client.emit(newMessage(message(102, peerUser(42))), [FRIEND]);
  await client.emit(newMessage(message(103, peerUser(42), { message: 'и ещё' })), [FRIEND]);
  const read = await call(server, 'get_messages', { chat: '@friend' });
  assert.deepEqual(read.json.messages.map((m) => m.id), [102]);
  assert.deepEqual(JSON.parse(read.content[1].text).arrived_meanwhile.map((m) => m.id), [103]);
  await c.quiet(700);

  // Чат без подписки — без сигнала; сообщение в подписанный чат, с которым вызов не
  // работал, остаётся монитору.
  await client.emit(newMessage(message(104, peerUser(42), { message: 'пока ты занят другим' })), [FRIEND]);
  const other = await call(server, 'send_message', { chat: '@muted', text: 'hi' });
  assert.equal(other.content.length, 1);
  assert.deepEqual((await c.next()).messages.map((m) => m.id), [104]);
  assert.equal(services.stream.status()[0].waiting, undefined);
});

test('«Избранное»: по умолчанию не приходит, указанное явно — приходит', async (t) => {
  const { server, client } = await setup(t);
  const all = await subscribe(server);
  const saved = await subscribe(server, { chats: ['me'] });
  assert.match(saved.watching, /Saved Messages/);
  const a = connect(all.monitor.ws.url);
  const b = connect(saved.monitor.ws.url);
  await a.next();
  await b.next();
  await client.emit(newMessage(message(80, peerUser(1000), { out: true, message: 'заметка себе' })), [ME]);
  const f = await b.next();
  assert.equal(f.chat.title, 'Saved Messages');
  assert.deepEqual(f.messages.map((m) => m.text), ['заметка себе']);
  await a.quiet(200);
});

test('служебный чат 777000 не приходит, даже если его показ разрешён; подписаться на него нельзя', async (t) => {
  const { server, client } = await setup(t, {
    env: { TELEGRAM_ALLOW_SERVICE_CHAT: 'true' },
    handlers: { 'users.GetUsers': () => [SERVICE], getInputEntity: () => new Api.InputPeerUser({ userId: bigInt(777000), accessHash: bigInt(1) }) },
  });
  const refused = await call(server, 'subscribe_to_messages', { chats: ['777000'] });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /never streamed/);
  const sub = await subscribe(server);
  const c = connect(sub.monitor.ws.url);
  await c.next();
  await client.emit(newMessage(message(90, peerUser(777000), { message: 'Login code: 12345' })), [SERVICE]);
  await marker(client);
  assert.deepEqual((await c.next()).messages.map((m) => m.id), [999]);
});

test('«Скрытые чаты» по приглашению: вступил с телефона — новую группу сперва сверяем со ссылкой', async (t) => {
  const HIDDEN_BY_LINK = channel(6100, { megagroup: true, title: 'Секретная', username: undefined });
  let member = false;
  const { server, services, client } = await setup(t, {
    env: { TELEGRAM_HIDDEN_CHATS: 'https://t.me/+HiddenHash123' },
    handlers: {
      'messages.CheckChatInvite': () =>
        member ? new Api.ChatInviteAlready({ chat: HIDDEN_BY_LINK }) : new Api.ChatInvite({ title: 'Секретная', photo: new Api.PhotoEmpty({ id: bigInt(0) }), participantsCount: 5 }),
    },
  });
  const sub = await subscribe(server, { include_muted: true });
  const c = connect(sub.monitor.ws.url);
  await c.next();
  // Аккаунт вступил в скрытый чат с телефона, и оттуда сразу пишут.
  member = true;
  await client.emit(newChannelMessage(message(95, peerChannel(6100), { fromId: peerUser(42), message: 'секрет' })), [HIDDEN_BY_LINK, FRIEND]);
  // Обычный канал после сверки проходит.
  await client.emit(newChannelMessage(message(96, peerChannel(5000))), [NEWS]);
  const f = await c.next();
  assert.deepEqual(f.messages.map((m) => m.id), [96]);
  assert.doesNotMatch(JSON.stringify(c.frames), /секрет/);
  assert.equal(services.accounts.current('main').inviteIds.get('HiddenHash123'), '-1006100');
});

test('кадр не теряется, если отправить не удалось; отменённый вызов не забирает сообщения', async (t) => {
  const { server, services, client } = await setup(t);
  const hub = services.stream;
  await subscribe(server, { chats: ['@friend'] });
  const sub = [...hub.subs.values()][0];
  let accept = false;
  const sentFrames = [];
  sub.conn = { open: true, on() {}, sendText: (text) => accept && sentFrames.push(text) > 0 };
  await client.emit(newMessage(message(110, peerUser(42))), [FRIEND]);
  await drained(services);
  hub.flush(sub);
  assert.equal(sub.pending.length, 1, 'после неудачной отправки сообщение остаётся в очереди');
  accept = true;
  hub.flush(sub);
  assert.equal(sub.pending.length, 0);
  assert.match(sentFrames[0], /"id":110/);

  await client.emit(newMessage(message(111, peerUser(42))), [FRIEND]);
  await drained(services);
  const scope = { chats: new Map([['main:42', { account: 'main', chatId: '42' }]]), shown: new Set() };
  const aborted = AbortSignal.abort();
  assert.equal(await hub.takeArrived(scope, aborted), null);
  assert.equal(sub.pending.length, 1);
  assert.match(await hub.takeArrived(scope), /"id":111/);
  assert.equal(sub.pending.length, 0);
  sub.conn = null;
});

test('кадр укладывается в 2500 символов и при длинных служебных сообщениях и названиях чатов', async (t) => {
  const { server, services } = await setup(t);
  const hub = services.stream;
  await subscribe(server, { chats: ['@team'] });
  const sub = [...hub.subs.values()][0];
  const long = 'Очень длинное название чата '.repeat(5).slice(0, 128);
  // Служебное сообщение «добавил …» со списком из сотни имён.
  sub.pending.push({ kind: 'new', chatId: '-1006000', id: 1, message: { id: 1, chat: { id: -1006000, title: long }, service: `added ${'Участник '.repeat(400)}` } });
  for (let i = 0; i < 40; i++) {
    sub.pending.push({ kind: 'new', chatId: String(-1007000 - i), id: 10 + i, message: { id: 10 + i, chat: { id: -1007000 - i, title: `${long}${i}` }, text: 'x'.repeat(300) } });
  }
  sub.dropped = 7;
  const frame = hub.buildFrame(sub);
  assert.ok(frame.text.length <= 2500, `frame of ${frame.text.length} chars`);
  const parsed = JSON.parse(frame.text);
  assert.match(parsed.lost, /^7 message/);
  assert.equal(frame.consumed, 41);
  // Сборка кадра очередь не трогает: её чистит flush после отправки.
  assert.equal(sub.pending.length, 41);
});

test('поток: после ошибки протокола данные не копятся; остановка не ждёт молчащих клиентов', async (t) => {
  const net = await import('node:net');
  const { server, services } = await setup(t);
  const sub = await subscribe(server);
  const url = new URL(sub.monitor.ws.url);
  // «Клиент», который не отвечает на close и шлёт немаскированный кадр, а потом мусор.
  const raw = net.connect(Number(url.port), '127.0.0.1');
  t.after(() => raw.destroy());
  raw.on('error', () => {});
  await new Promise((r) => raw.once('connect', r));
  raw.write(
    `GET ${url.pathname} HTTP/1.1\r\nHost: 127.0.0.1:${url.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
  );
  await new Promise((r) => raw.once('data', r));
  raw.write(Buffer.from([0x81, 0x02, 0x48, 0x69])); // без маски — ошибка протокола
  raw.write(Buffer.alloc(1024 * 1024, 7));
  await new Promise((r) => setTimeout(r, 100));
  const conn = [...services.stream.server.conns][0];
  assert.equal(conn.parser, null);
  const started = Date.now();
  await services.stream.stop();
  assert.ok(Date.now() - started < 1500, `stop took ${Date.now() - started} ms`);
  assert.equal(services.stream.server.conns.size, 0);
});
