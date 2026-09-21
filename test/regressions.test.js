// Проверки по итогам независимого ревью: каждая соответствует найденной ошибке.

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { isAuthError } from '../server/accounts.js';
import { loadConfig } from '../server/config.js';
import { Policy } from '../server/policy.js';
import { AccountStore, FileSession } from '../server/store.js';
import { Api, bigInt } from '../server/tg/lib.js';
import { parseChatRef } from '../server/tg/peers.js';
import { splitMessage } from '../server/tg/text.js';
import { scrubResponse, toJson } from '../server/tg/tljson.js';
import { API_ENV, call, channel, fakeSessionString, makeServer, ME, message, peerChannel, peerUser, silentLogger, tempDir, user } from './helpers.js';

const FRIEND = user(42, { username: 'friend', firstName: 'Friend' });
const SERVICE = user(777000, { firstName: 'Telegram' });
const history = (messages, users = [], chats = []) => new Api.messages.Messages({ messages, users, chats });
const rpcError = (code) => Object.assign(new Error(code), { errorMessage: code });

function resolver(...entities) {
  return (req) => {
    const e = entities.find((x) => (x.username ?? '').toLowerCase() === req.username);
    if (!e) throw rpcError('USERNAME_NOT_OCCUPIED');
    const peer = e instanceof Api.User ? new Api.PeerUser({ userId: e.id }) : new Api.PeerChannel({ channelId: e.id });
    return new Api.contacts.ResolvedPeer({ peer, users: e instanceof Api.User ? [e] : [], chats: e instanceof Api.User ? [] : [e] });
  };
}

test('сообщения по номеру: чужие чаты (в том числе 777000) не отдаются и не удаляются', async () => {
  // messages.getMessages ищет по всему аккаунту — Telegram вернёт и чужие сообщения.
  const box = {
    1: message(1, peerUser(777000), { message: 'Login code: 55555' }),
    2: message(2, peerUser(42), { message: 'чужой чат' }),
    3: message(3, peerUser(1000), { message: 'Избранное' }),
  };
  const { server, client } = makeServer({
    env: { TELEGRAM_ALLOW_DELETE: 'true' },
    handlers: {
      'contacts.ResolveUsername': resolver(FRIEND),
      'messages.GetMessages': (req) => history(req.id.map((m) => box[m.id]).filter(Boolean), [SERVICE, FRIEND]),
      'messages.DeleteMessages': () => new Api.messages.AffectedMessages({ pts: 1, ptsCount: 1 }),
    },
  });
  const r = await call(server, 'get_messages', { chat: 'me', ids: [1, 2, 3] });
  assert.deepEqual(r.json.messages.map((m) => m.id), [3]);
  assert.doesNotMatch(r.text, /55555/);

  const d = await call(server, 'download_media', { chat: 'me', message_id: 1 });
  assert.equal(d.isError, true);
  assert.match(d.text, /not found in this chat/);

  const del = await call(server, 'delete_messages', { chat: '@friend', message_ids: [2, 1] });
  assert.equal(del.isError, true);
  assert.match(del.text, /1 not found in this chat/);
  assert.ok(!client.calls.some((c) => c.className === 'messages.DeleteMessages'), 'ничего не удалено');
  const ok = await call(server, 'delete_messages', { chat: '@friend', message_ids: [2] });
  assert.equal(ok.isError, false, ok.text);
});

test('поиск чата по названию не раскрывает скрытые чаты', async () => {
  const hidden = user(50, { firstName: 'Alpha', username: 'secret' });
  const visible = channel(60, { title: 'Alpha Team', megagroup: true });
  const other = channel(61, { title: 'Alpha Beta', megagroup: true });
  const dialog = (entity) => ({ entity, dialog: new Api.Dialog({ peer: new Api.PeerUser({ userId: entity.id }), topMessage: 1, readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 0, unreadMentionsCount: 0, unreadReactionsCount: 0, unreadPollVotesCount: 0, notifySettings: new Api.PeerNotifySettings({}) }) });
  const { server } = makeServer({
    env: { TELEGRAM_HIDDEN_CHATS: '@secret' },
    handlers: { dialogs: () => [dialog(hidden), dialog(visible), dialog(other), dialog(SERVICE)] },
  });
  const r = await call(server, 'get_messages', { chat: 'Alpha' });
  assert.equal(r.isError, true);
  assert.match(r.text, /Several chats are called|No chat "Alpha"/);
  assert.doesNotMatch(r.text, /secret|"id":50|777000/);
});

test('прямые вызовы API: скрытые чаты и 777000 закрыты, удаление — только с разрешением', async () => {
  const handlers = {
    'contacts.ResolveUsername': resolver(FRIEND),
    'messages.GetHistory': () => history([message(9, peerUser(42), { message: 'ok' }), message(8, peerUser(777000), { message: 'code 12345' })], [FRIEND, SERVICE]),
    'messages.DeleteHistory': () => new Api.messages.AffectedHistory({ pts: 1, ptsCount: 1, offset: 0 }),
  };
  const { server } = makeServer({ env: { TELEGRAM_ALLOW_RAW_API: 'true' }, handlers });
  const obj = await call(server, 'send_api_request', { method: 'messages.getHistory', params: { peer: { _: 'inputPeerUser', user_id: 777000, access_hash: '1' }, limit: 5 } });
  assert.equal(obj.isError, true);
  assert.match(obj.text, /hidden/);
  const scrubbed = await call(server, 'send_api_request', { method: 'messages.getHistory', params: { peer: '@friend', limit: 5 } });
  assert.equal(scrubbed.isError, false, scrubbed.text);
  assert.doesNotMatch(scrubbed.text, /12345/);
  assert.match(scrubbed.text, /"ok"/);
  const del = await call(server, 'send_api_request', { method: 'messages.deleteHistory', params: { peer: '@friend', max_id: 0 } });
  assert.match(del.text, /«Разрешить удаление и выход из чатов»/);
  for (const method of ['account.registerDevice', 'account.setAccountTTL', 'account.registerPasskey', 'updates.getDifference', 'bots.exportBotToken', 'account.updateConnectedBot']) {
    const r = await call(server, 'send_api_request', { method, params: {} });
    assert.match(r.text, /never available/, method);
  }
  const stake = await call(server, 'send_api_request', { method: 'messages.sendMedia', params: { peer: '@friend', message: '', media: { _: 'inputMediaStakeDice', game_hash: 'x', ton_amount: 1, client_seed: { _bytes: 'AA==' } } } });
  assert.match(stake.text, /spends money|never available|missing|unknown/);
});

test('списки чатов: t.me/c/…, приглашения и строгие разрешающие списки', () => {
  const cfg = (env) => loadConfig({ env: { ...API_ENV, ...env }, argv: [], home: '/h' });
  const c = cfg({ TELEGRAM_HIDDEN_CHATS: 'https://t.me/c/1234567890/5, https://t.me/+AbCdEfGhIjKl, t.me/joinchat/ZzYyXxWwVv' });
  assert.deepEqual(c.chats.hidden.map((e) => e.id ?? e.hash), ['-1001234567890', 'AbCdEfGhIjKl', 'ZzYyXxWwVv']);
  assert.deepEqual(c.problems, []);
  const p = new Policy(c);
  const ch = channel(1234567890);
  assert.equal(p.isVisible(ch), false);
  const group = channel(777, { megagroup: true });
  const acc = { selfId: '1000', inviteIds: new Map([['AbCdEfGhIjKl', '-100777']]) };
  assert.equal(p.isVisible(group), true, 'без сопоставления приглашения чат не опознан');
  assert.equal(p.isVisible(group, acc), false, 'приглашение сопоставлено с чатом аккаунта');
  assert.throws(() => p.requireInviteAllowed('ZzYyXxWwVv'), /hidden/);
  // Разрешающие списки сверяются строго: «42» — это пользователь 42, а не канал -10042.
  const strict = new Policy(cfg({ TELEGRAM_WRITABLE_CHATS: '42' }));
  assert.equal(strict.isWritable(user(42)), true);
  assert.equal(strict.isWritable(channel(42)), false);
  assert.equal(new Policy(cfg({ TELEGRAM_HIDDEN_CHATS: '42' })).isVisible(channel(42)), false, 'а скрывающий — нестрого');
});

test('длинный текст не режется посреди эмодзи', () => {
  const text = `${'a'.repeat(4095)}😀${'b'.repeat(10)}`;
  const parts = splitMessage(text, []);
  assert.equal(parts.length, 2);
  assert.equal(parts[0][0].length, 4095);
  assert.ok(parts[1][0].startsWith('😀'));
  assert.equal(parts.map((p) => p[0]).join(''), text);
});

test('короткие имена ботов и ссылки t.me/+номер', () => {
  assert.deepEqual(parseChatRef('@gif'), { kind: 'username', username: 'gif' });
  assert.deepEqual(parseChatRef('https://t.me/vid'), { kind: 'username', username: 'vid' });
  assert.deepEqual(parseChatRef('https://t.me/+79991234567'), { kind: 'phone', phone: '79991234567' });
});

test('сессия: новый непроверенный ключ не записывается; чужие изменения файла не затираются', async () => {
  const store = new AccountStore(path.join(tempDir(), 'accounts'), silentLogger);
  const original = fakeSessionString();
  store.write('main', { session: original, user: { id: '1' } });
  const s = new FileSession({ store, name: 'main', data: store.read('main'), logger: silentLogger });
  await s.load();
  // Сбой связи: teleproto создал новый (неавторизованный) ключ.
  const { AuthKey } = await import('../server/tg/lib.js');
  const fresh = new AuthKey();
  await fresh.setKey(Buffer.alloc(256, 9));
  s.setAuthKey(fresh);
  assert.equal(s.keyChanged(), true);
  s.flush();
  assert.equal(store.read('main').session, original, 'в файле остался рабочий ключ');
  s.markVerified();
  s.flush();
  assert.notEqual(store.read('main').session, original, 'проверенный ключ записан');
  // Другой процесс вошёл заново — наша копия файл не перезаписывает.
  store.write('main', { session: fakeSessionString(3), user: { id: '1' } });
  s.processEntities({ users: [user(5)] });
  s.flush();
  assert.equal(store.read('main').session, fakeSessionString(3));
});

test('ожидание бота не заканчивается на собственном /start', async () => {
  const bot = user(700, { bot: true, username: 'slowbot', firstName: 'Slow' });
  let polls = 0;
  const { server } = makeServer({
    handlers: {
      'contacts.ResolveUsername': resolver(bot),
      'messages.GetHistory': (req) => {
        if (req.limit === 1) return history([message(10, peerUser(700))], [bot]);
        polls++;
        const own = message(11, peerUser(700), { out: true, message: '/start' });
        return history(polls < 4 ? [own] : [message(12, peerUser(700), { message: 'Привет!' }), own], [bot]);
      },
    },
  });
  const r = await call(server, 'start_bot', { bot: '@slowbot', wait_seconds: 10 });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json.messages.map((m) => m.text), ['/start', 'Привет!']);
});

test('«прочитано» — действие: учитывает «Писать только в эти чаты» и лимит', async () => {
  const { server } = makeServer({
    env: { TELEGRAM_WRITABLE_CHATS: 'me', TELEGRAM_ACTIONS_PER_MINUTE: '1' },
    handlers: {
      'contacts.ResolveUsername': resolver(FRIEND),
      'messages.GetHistory': () => history([message(5, peerUser(1000))]),
      'messages.ReadHistory': () => new Api.messages.AffectedMessages({ pts: 1, ptsCount: 1 }),
      'messages.ReadMentions': () => new Api.messages.AffectedHistory({ pts: 1, ptsCount: 0, offset: 0 }),
      'messages.ReadReactions': () => new Api.messages.AffectedHistory({ pts: 1, ptsCount: 0, offset: 0 }),
    },
  });
  assert.match((await call(server, 'mark_as_read', { chat: '@friend' })).text, /«Писать только в эти чаты»/);
  assert.equal((await call(server, 'mark_as_read', { chat: 'me' })).isError, false);
  assert.match((await call(server, 'mark_as_read', { chat: 'me' })).text, /actions per minute/);
});

test('сессию завершили с телефона: аккаунт помечается вышедшим, check это видит', async () => {
  let revoked = false;
  const { server, services } = makeServer({
    handlers: {
      'contacts.ResolveUsername': resolver(FRIEND),
      'messages.GetHistory': () => {
        if (revoked) throw rpcError('AUTH_KEY_UNREGISTERED');
        return history([]);
      },
      'users.GetUsers': () => {
        if (revoked) throw rpcError('SESSION_REVOKED');
        return [];
      },
    },
  });
  assert.equal((await call(server, 'get_messages', { chat: '@friend' })).isError, false);
  revoked = true;
  const r = await call(server, 'get_messages', { chat: '@friend' });
  assert.equal(r.isError, true);
  assert.match(r.text, /no longer valid|open_login_page/);
  assert.match(services.accounts.status('main'), /logged out/);
  const s = await call(server, 'connector_status', { check: true });
  assert.match(s.json.accounts[0].status, /error: .*logged out|error:/);
});

test('пользователь, известный только по сообщению в группе: понятная ошибка', async () => {
  // «min»-запись без access_hash: обратиться к такому пользователю напрямую нельзя.
  const minUser = new Api.User({ id: bigInt(99), min: true, firstName: 'Anon' });
  const { server, services } = makeServer({ handlers: {} });
  const acc = await services.accounts.use('main');
  acc.remember([minUser]);
  const r = await call(server, 'get_chat_info', { chat: 99 });
  assert.equal(r.isError, true);
  assert.doesNotMatch(r.text, /Internal error/);
  assert.match(r.text, /unknown to this account|only from a group message/);
});

test('id чата после перезапуска находится по кэшу в файле сессии', async () => {
  const { server, services, client } = makeServer({
    handlers: {
      'channels.GetChannels': (req) => {
        assert.equal(String(req.id[0].accessHash), '123456');
        return new Api.messages.Chats({ chats: [channel(5000, { title: 'Archive', accessHash: bigInt(123456) })] });
      },
      'messages.GetHistory': () => history([], [], []),
    },
  });
  const acc = await services.accounts.use('main');
  // Как будто строка пришла из файла: -1005000 с access_hash 123456, в памяти ничего.
  acc.session._entities.set('-1005000', ['-1005000', bigInt(123456), null, null, 'Archive']);
  const r = await call(server, 'get_messages', { chat: -1005000 });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.chat.title, 'Archive');
  assert.ok(!client.calls.some((c) => c.className === 'messages.GetDialogs'), 'диалоги не перечитывались');
});

// ───────────── Второй проход ревью ─────────────

const GROUP = channel(5000, { title: 'Group', megagroup: true });
const SECRET = user(43, { username: 'secret', firstName: 'Secret' });
const dialogOf = (peer) =>
  new Api.Dialog({ peer, topMessage: 1, readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 0, unreadMentionsCount: 0, unreadReactionsCount: 0, unreadPollVotesCount: 0, notifySettings: new Api.PeerNotifySettings({}) });

test('фильтр ответа прямого вызова: обход без экспоненты, байты не перебираются', () => {
  let node = new Api.TextPlain({ text: 'x' });
  for (let i = 0; i < 40; i++) node = new Api.TextBold({ text: node });
  assert.ok(node.originalArgs, 'у объектов TL есть originalArgs с теми же детьми');
  const started = Date.now();
  assert.equal(scrubResponse(node, { visible: () => true }), node);
  const doc = new Api.Document({ id: bigInt(1), accessHash: bigInt(1), fileReference: Buffer.alloc(5_000_000), date: 0, mimeType: 'x', size: bigInt(1), dcId: 2, attributes: [] });
  const big = message(1, peerUser(42), { media: new Api.MessageMediaDocument({ document: doc }) });
  scrubResponse(new Api.messages.Messages({ messages: [big], chats: [], users: [] }), { visible: () => true });
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} мс`);
});

test('фильтр ответа прямого вызова: диалоги, записи, обновления и контакты скрытых чатов убираются', () => {
  const AUTHOR = user(44, { firstName: 'Author' });
  const STRANGER = user(45, { firstName: 'Stranger' });
  const OTHER = channel(6000, { title: 'Other' });
  const hiddenIds = new Set(['43']);
  // «Только эти чаты»: группа и «Избранное»; «Скрытые чаты»: Secret.
  const strict = { visible: (id) => ['-1005000', '1000'].includes(id), hidden: (id) => hiddenIds.has(id), selfId: '1000' };
  const out = scrubResponse(
    new Api.messages.Dialogs({
      dialogs: [dialogOf(peerChannel(5000)), dialogOf(peerUser(43)), dialogOf(peerUser(45)), dialogOf(peerChannel(6000))],
      messages: [
        message(1, peerChannel(5000), { fromId: peerUser(44) }),
        message(2, peerChannel(5000), { fromId: peerUser(43) }),
        message(3, peerUser(43), { message: 'секрет' }),
        message(4, peerUser(45)),
        message(5, peerChannel(6000)),
      ],
      chats: [GROUP, OTHER],
      users: [ME, SECRET, AUTHOR, STRANGER],
    }),
    strict,
  );
  assert.deepEqual(out.dialogs.map((d) => String(d.peer.channelId)), ['5000']);
  assert.deepEqual(out.messages.map((m) => m.id), [1, 2]);
  assert.deepEqual(out.chats.map((c) => c.title), ['Group']);
  // Свой аккаунт и автор сообщения в видимой группе остаются; явно скрытый — нет, даже как автор.
  assert.deepEqual(out.users.map((u) => u.firstName), ['Test', 'Author']);
  assert.doesNotMatch(JSON.stringify(toJson(out)), /секрет|Secret|Stranger|Other/);

  const updates = scrubResponse(
    new Api.Updates({
      updates: [
        new Api.UpdateNewChannelMessage({ message: message(7, peerChannel(5000)), pts: 1, ptsCount: 1 }),
        new Api.UpdateNewMessage({ message: message(8, peerUser(43)), pts: 1, ptsCount: 1 }),
        new Api.UpdateReadChannelInbox({ channelId: bigInt(6000), maxId: 1, stillUnreadCount: 0, pts: 1 }),
        new Api.UpdateUserStatus({ userId: bigInt(43), status: new Api.UserStatusRecently({}) }),
        new Api.UpdateDialogPinned({ peer: new Api.DialogPeer({ peer: peerUser(45) }) }),
      ],
      users: [SECRET],
      chats: [],
      date: 0,
      seq: 0,
    }),
    strict,
  );
  assert.deepEqual(updates.updates.map((x) => x.className), ['UpdateNewChannelMessage']);
  assert.deepEqual(updates.users, []);

  // Без «Только этих чатов» видно всё, кроме скрытого.
  const loose = { visible: (id) => !hiddenIds.has(id), hidden: (id) => hiddenIds.has(id), selfId: '1000' };
  const contacts = scrubResponse(
    new Api.contacts.Contacts({ contacts: [new Api.Contact({ userId: bigInt(44), mutual: false }), new Api.Contact({ userId: bigInt(43), mutual: true })], savedCount: 0, users: [AUTHOR, SECRET] }),
    loose,
  );
  assert.deepEqual(contacts.contacts.map((x) => String(x.userId)), ['44']);
  assert.deepEqual(contacts.users.map((x) => x.firstName), ['Author']);
  const found = scrubResponse(new Api.contacts.Found({ myResults: [peerUser(43), peerUser(44)], results: [], chats: [], users: [SECRET, AUTHOR] }), loose);
  assert.deepEqual(found.myResults.map((p) => String(p.userId)), ['44']);
  assert.deepEqual(found.users.map((x) => x.firstName), ['Author']);
  // Ответ целиком о скрытом чате — пустой.
  assert.equal(scrubResponse(new Api.contacts.ResolvedPeer({ peer: peerUser(43), users: [SECRET], chats: [] }), loose), null);
  assert.equal(scrubResponse(SECRET, loose), null);
});

test('прямые вызовы: ответ проходит фильтр, в том числе по username из кэша сессии', async () => {
  const dialogs = () =>
    new Api.messages.Dialogs({
      dialogs: [dialogOf(peerUser(42)), dialogOf(peerUser(43)), dialogOf(peerUser(46))],
      messages: [message(1, peerUser(42), { message: 'привет' }), message(2, peerUser(43), { message: 'секрет' }), message(3, peerUser(46), { message: 'тоже секрет' })],
      chats: [],
      users: [FRIEND, SECRET],
    });
  const { server, services } = makeServer({ env: { TELEGRAM_ALLOW_RAW_API: 'true', TELEGRAM_HIDDEN_CHATS: '@secret, @ghost' }, handlers: { 'messages.GetDialogs': dialogs } });
  const acc = await services.accounts.use('main');
  // Пользователь 46 известен только по строке кэша сессии (username ghost).
  acc.session._entities.set('46', ['46', bigInt(1), 'ghost', null, 'Ghost']);
  const r = await call(server, 'send_api_request', { method: 'messages.getDialogs', params: { limit: 10 } });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /привет/);
  assert.doesNotMatch(r.text, /секрет|Secret/);
});

test('прямые вызовы: chat_id обычных групп, «я сам», незнакомые id и приглашения сверяются со списками', async () => {
  const handlers = {
    'contacts.ResolveUsername': resolver(FRIEND),
    'messages.CheckChatInvite': () => new Api.ChatInvite({ title: 'Тайный клуб', participantsCount: 3, photo: new Api.PhotoEmpty({ id: bigInt(0) }), color: 0 }),
  };
  const { server, client } = makeServer({ env: { TELEGRAM_ALLOW_RAW_API: 'true', TELEGRAM_HIDDEN_CHATS: '-777, https://t.me/+SecretHash1' }, handlers });
  for (const [method, params] of [
    ['messages.getFullChat', { chat_id: 777 }],
    ['messages.getChats', { id: [777] }],
    ['messages.editChatTitle', { chat_id: '777', title: 'x' }],
  ]) {
    const r = await call(server, 'send_api_request', { method, params });
    assert.equal(r.isError, true, method);
    assert.match(r.text, /hidden/, method);
  }
  const inv = await call(server, 'send_api_request', { method: 'messages.checkChatInvite', params: { hash: 'SecretHash1' } });
  assert.equal(inv.isError, true);
  assert.doesNotMatch(inv.text, /Тайный клуб/);
  for (const [method, tool] of [
    ['messages.deleteMessages', 'delete_messages'],
    ['messages.forwardMessages', 'forward_messages'],
    ['messages.readMessageContents', 'mark_as_read'],
  ]) {
    const r = await call(server, 'send_api_request', { method, params: {} });
    assert.match(r.text, new RegExp(tool), method);
  }
  for (const method of ['destroySession', 'destroyAuthKey', 'account.toggleNoPaidMessagesException', 'account.sendVerifyPhoneCode', 'account.verifyPhone', 'contacts.getContactIDs']) {
    const r = await call(server, 'send_api_request', { method, params: {} });
    assert.match(r.text, /never available/, method);
  }
  const suggested = await call(server, 'send_api_request', { method: 'messages.sendMessage', params: { peer: '@friend', message: 'x', suggested_post: { _: 'suggestedPost', schedule_date: 1 } } });
  assert.match(suggested.text, /spends money/);
  const invoked = client.calls.map((c) => c.className).filter((n) => n !== 'contacts.ResolveUsername' && n !== 'messages.CheckChatInvite');
  assert.deepEqual(invoked, [], 'ни один закрытый вызов не ушёл в Telegram');

  // «Только эти чаты»: незнакомый id и «Избранное» (его нет в списке) закрыты.
  const strict = makeServer({ env: { TELEGRAM_ALLOW_RAW_API: 'true', TELEGRAM_VISIBLE_CHATS: '@friend' }, handlers });
  for (const peer of [{ _: 'inputPeerChannel', channel_id: 999, access_hash: 1 }, { _: 'inputPeerSelf' }]) {
    const r = await call(strict.server, 'send_api_request', { method: 'messages.getHistory', params: { peer, limit: 1 } });
    assert.equal(r.isError, true, JSON.stringify(peer));
    assert.match(r.text, /hidden|unknown/);
  }
  assert.ok(!strict.client.calls.some((c) => c.className === 'messages.GetHistory'));
});

test('приглашение из «Скрытых чатов»: закрыто и там, где аккаунт уже состоит; нераспознанная ссылка видна в статусе', async () => {
  let failing = true;
  const handlers = {
    'messages.CheckChatInvite': () => {
      if (failing) throw rpcError('TIMEOUT');
      return new Api.ChatInviteAlready({ chat: GROUP });
    },
    'messages.GetHistory': () => history([], [], [GROUP]),
    dialogs: () => [{ entity: GROUP, dialog: dialogOf(peerChannel(5000)) }],
  };
  const { server } = makeServer({ env: { TELEGRAM_HIDDEN_CHATS: 'https://t.me/+HiddenHash1' }, handlers });
  // При подключении Telegram не ответил: ссылка не сопоставлена с чатом.
  assert.equal((await call(server, 'get_messages', { chat: 'me' })).isError, false);
  const s = await call(server, 'connector_status');
  assert.match(s.json.settings_problems.join('\n'), /HiddenHash1.*пока не опознан/);
  failing = false;
  // Список чатов сначала перепроверяет ссылки: группа уже не видна.
  const list = await call(server, 'list_chats');
  assert.equal(list.isError, false, list.text);
  assert.doesNotMatch(list.text, /Group/);
  const byId = await call(server, 'get_messages', { chat: -1005000 });
  assert.equal(byId.isError, true, byId.text);
  const byLink = await call(server, 'get_messages', { chat: 'https://t.me/+HiddenHash1' });
  assert.equal(byLink.isError, true);
  assert.match(byLink.text, /hidden/);
  assert.equal((await call(server, 'connector_status')).json.settings_problems, undefined);
});

test('ссылка из «Скрытых чатов» закрыта по хешу, даже если id чата по ней ещё не узнан', async () => {
  let checks = 0;
  const handlers = {
    'messages.CheckChatInvite': () => {
      checks++;
      // При подключении — ошибка, потом аккаунт уже в чате.
      if (checks === 1) throw rpcError('TIMEOUT');
      return new Api.ChatInviteAlready({ chat: GROUP });
    },
    'messages.GetHistory': () => history([], [], [GROUP]),
    'channels.JoinChannel': () => new Api.Updates({ updates: [], users: [], chats: [GROUP], date: 0, seq: 0 }),
    'messages.ImportChatInvite': () => new Api.Updates({ updates: [], users: [], chats: [GROUP], date: 0, seq: 0 }),
  };
  const { server, client } = makeServer({ env: { TELEGRAM_HIDDEN_CHATS: 't.me/+HiddenHash2' }, handlers });
  const join = await call(server, 'join_chat', { chat: 'https://t.me/+HiddenHash2' });
  assert.equal(join.isError, true);
  assert.match(join.text, /hidden/);
  assert.ok(!client.calls.some((c) => c.className === 'messages.ImportChatInvite'));
});

test('ответ teleproto на поиск по id принимается, только если это тот же id', async () => {
  const { server } = makeServer({
    handlers: {
      // teleproto понял строку «4242» как телефон и нашёл другого человека.
      getInputEntity: () => new Api.InputPeerUser({ userId: bigInt(42), accessHash: bigInt(1) }),
      'users.GetUsers': () => [FRIEND],
    },
  });
  const r = await call(server, 'get_chat_info', { chat: 4242 });
  assert.equal(r.isError, true);
  assert.doesNotMatch(r.text, /Friend/);
  assert.match(r.text, /unknown to this account/);
});

test('ошибка сессии на старом подключении не рвёт новое; AUTH_KEY_PERM_EMPTY — не выход', async () => {
  const { services } = makeServer({ handlers: {} });
  const { accounts } = services;
  const old = await accounts.use('main');
  await accounts.disconnect('main');
  const fresh = await accounts.use('main');
  assert.notEqual(old, fresh);
  await accounts.markBroken('main', 'AUTH_KEY_UNREGISTERED', old);
  assert.equal(accounts.current('main'), fresh);
  assert.equal(accounts.status('main'), 'connected');
  assert.equal(isAuthError(rpcError('AUTH_KEY_PERM_EMPTY')), false);
  assert.equal(isAuthError(rpcError('AUTH_KEY_UNREGISTERED')), true);
});

test('кнопка профиля пользователя возвращает его id', async () => {
  const BOT = user(700, { bot: true, username: 'shopbot', firstName: 'Shop' });
  const profile = new Api.KeyboardInlineButton({ text: 'Автор', type: new Api.InlineButtonTypeUserProfile({ userId: bigInt(42) }) });
  const m = message(40, peerUser(700), { fromId: peerUser(700), replyMarkup: new Api.ReplyInlineMarkup({ rows: [new Api.KeyboardInlineButtonRow({ buttons: [profile] })] }) });
  const { server } = makeServer({ handlers: { 'contacts.ResolveUsername': resolver(BOT), 'messages.GetMessages': () => history([m], [BOT]), 'messages.GetHistory': () => history([m], [BOT]) } });
  const r = await call(server, 'press_button', { chat: '@shopbot', message_id: 40 });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.user_id, '42');
});

test('длинный список контактов обрезается с конца: остаётся начало по алфавиту', async () => {
  const people = Array.from({ length: 300 }, (_, i) => user(2000 + i, { firstName: `C${String(i).padStart(3, '0')}`, lastName: 'x'.repeat(40), contact: true }));
  const { server } = makeServer({
    env: { TELEGRAM_MAX_OUTPUT_CHARS: '5000' },
    handlers: { 'contacts.GetContacts': () => new Api.contacts.Contacts({ contacts: [], savedCount: 0, users: [...people].reverse() }) },
  });
  const r = await call(server, 'list_contacts');
  assert.equal(r.isError, false, r.text);
  assert.match(r.json.contacts[0].name, /^C000/);
  assert.match(r.json.truncated, /left out/);
});
