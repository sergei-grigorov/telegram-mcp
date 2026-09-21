import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { Api, bigInt, CustomFile } from '../server/tg/lib.js';
import { call, channel, makeServer, ME, message, peerChannel, peerUser, tempDir, user } from './helpers.js';

const BOT = user(700, { bot: true, username: 'shopbot', firstName: 'Shop' });
const FRIEND = user(42, { username: 'friend', firstName: 'Friend' });
const NEWS = channel(5000, { username: 'news', broadcast: true, title: 'News' });

function resolver(...entities) {
  return (req) => {
    const e = entities.find((x) => (x.username ?? '').toLowerCase() === req.username);
    if (!e) throw Object.assign(new Error('USERNAME_NOT_OCCUPIED'), { errorMessage: 'USERNAME_NOT_OCCUPIED' });
    const peer = e instanceof Api.User ? new Api.PeerUser({ userId: e.id }) : new Api.PeerChannel({ channelId: e.id });
    return new Api.contacts.ResolvedPeer({ peer, users: e instanceof Api.User ? [e] : [], chats: e instanceof Api.User ? [] : [e] });
  };
}

const history = (messages, users = [], chats = []) => new Api.messages.Messages({ messages, users, chats });

test('connector_status: аккаунты без полного номера, разрешения, подсказки', async () => {
  const { server } = makeServer();
  const r = await call(server, 'connector_status');
  assert.equal(r.json.accounts[0].name, 'main');
  assert.equal(r.json.accounts[0].phone, '+79*******22');
  assert.equal(r.json.accounts[0].default, true);
  assert.doesNotMatch(r.text, /79990001122/);
  assert.equal(r.json.api_credentials, 'set');
});

test('open_login_page открывает локальную страницу', async () => {
  const { server, services, opened } = makeServer();
  const r = await call(server, 'open_login_page', { account: 'work' });
  assert.match(r.text, /^Login page: http:\/\/127\.0\.0\.1:\d+\/[\w-]+\/#account=work/);
  assert.equal(opened.length, 1);
  assert.match(r.text, /Do not ask for codes or passwords/);
  await services.login.stop();
  const noApi = makeServer({ env: { TELEGRAM_API_ID: '' } });
  const e = await call(noApi.server, 'open_login_page');
  assert.equal(e.isError, true);
  assert.match(e.text, /my\.telegram\.org/);
});

test('чтение сообщений: по @username, от старых к новым, разметка, следующая страница', async () => {
  const msgs = [3, 2, 1].map((id) => message(id, peerUser(42), { fromId: id === 2 ? peerUser(1000) : undefined, out: id === 2 }));
  msgs[0].message = 'Hi **there**';
  msgs[0].entities = [];
  const { server, client } = makeServer({
    handlers: {
      'contacts.ResolveUsername': resolver(FRIEND),
      'messages.GetHistory': (req) => {
        assert.equal(req.limit, 3);
        assert.equal(req.offsetId, 0);
        return history(msgs, [FRIEND, ME]);
      },
    },
  });
  const r = await call(server, 'get_messages', { chat: '@friend', limit: 3 });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json.messages.map((m) => m.id), [1, 2, 3]);
  assert.deepEqual(r.json.chat, { id: 42, type: 'user', title: 'Friend', username: '@friend' });
  assert.equal(r.json.messages[0].from.name, 'Friend');
  assert.equal(r.json.messages[1].out, true);
  assert.equal(r.json.next_offset_id, 1);
  assert.equal(client.calls.filter((c) => c.className === 'contacts.ResolveUsername').length, 1);
  // Второй раз @friend берётся из кэша.
  await call(server, 'get_messages', { chat: '@friend', limit: 3 });
  assert.equal(client.calls.filter((c) => c.className === 'contacts.ResolveUsername').length, 1);
});

test('ожидание ответа: wait_seconds ждёт новые сообщения после min_id', async () => {
  let polls = 0;
  const { server } = makeServer({
    handlers: {
      'contacts.ResolveUsername': resolver(BOT),
      'messages.GetHistory': (req) => {
        // Вперёд от min_id: offset_id = min_id + 1, add_offset = -limit.
        assert.equal(req.offsetId, 11);
        assert.equal(req.addOffset, -req.limit);
        polls++;
        return history(polls < 2 ? [] : [message(11, peerUser(700), { message: 'Готово!' }), message(10, peerUser(700))], [BOT]);
      },
    },
  });
  const r = await call(server, 'get_messages', { chat: '@shopbot', min_id: 10, wait_seconds: 5 });
  assert.deepEqual(r.json.messages.map((m) => m.text), ['Готово!'], 'сообщение min_id само не попадает');
  assert.ok(polls >= 2);
});

test('чтение вперёд от min_id: без пропусков, курсор next_min_id', async () => {
  const { server } = makeServer({
    handlers: {
      'contacts.ResolveUsername': resolver(FRIEND),
      'messages.GetHistory': (req) => {
        assert.equal(req.offsetId, 101);
        // Telegram отдаёт от новых к старым: 102…101 из запрошенного окна.
        return history([message(102, peerUser(42)), message(101, peerUser(42))], [FRIEND]);
      },
    },
  });
  const r = await call(server, 'get_messages', { chat: '@friend', min_id: 100, limit: 2 });
  assert.deepEqual(r.json.messages.map((m) => m.id), [101, 102]);
  assert.equal(r.json.next_min_id, 102);
  assert.equal(r.json.next_offset_id, undefined);
});

test('укороченный ответ: курсор считается по показанным сообщениям', async () => {
  const many = Array.from({ length: 50 }, (_, i) => message(200 - i, peerUser(42), { message: 'x'.repeat(3000) }));
  const { server } = makeServer({
    env: { TELEGRAM_MAX_OUTPUT_CHARS: '5000' },
    handlers: { 'contacts.ResolveUsername': resolver(FRIEND), 'messages.GetHistory': () => history(many, [FRIEND]) },
  });
  const r = await call(server, 'get_messages', { chat: '@friend', limit: 50 });
  const ids = r.json.messages.map((m) => m.id);
  assert.ok(ids.length < 50 && ids.length > 1);
  assert.equal(ids[ids.length - 1], 200, 'остаются самые новые');
  assert.equal(r.json.next_offset_id, ids[0], 'следующая страница — старше самого старого показанного');
  assert.match(r.json.truncated, /cursor continues/);
});

test('отправка: Markdown → сущности, длинный текст делится, лимит действий', async () => {
  // Номер 5 — сообщение этого чата, 7 — сообщение другого личного чата (номера сквозные).
  const box = { 5: message(5, peerUser(42)), 7: message(7, peerUser(99)) };
  const { server, client } = makeServer({
    env: { TELEGRAM_ACTIONS_PER_MINUTE: '3' },
    handlers: { 'contacts.ResolveUsername': resolver(FRIEND), 'messages.GetMessages': (req) => history(req.id.map((m) => box[m.id]).filter(Boolean), [FRIEND]) },
  });
  for (const replyTo of [6, 7]) {
    const bad = await call(server, 'send_message', { chat: '@friend', text: 'x', reply_to: replyTo });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /not found in this chat/);
  }
  assert.equal(client.sent.length, 0, 'ответ на чужое сообщение не отправляется');
  const r = await call(server, 'send_message', { chat: '@friend', text: 'Привет, **мир**! [ссылка](https://ex.com)', reply_to: 5, silent: true });
  assert.equal(r.isError, false, r.text);
  const sent = client.sent[0];
  assert.equal(sent.message, 'Привет, мир! ссылка');
  assert.deepEqual(sent.formattingEntities.map((e) => e.className), ['MessageEntityBold', 'MessageEntityTextUrl']);
  assert.equal(sent.replyTo, 5);
  assert.equal(sent.silent, true);
  assert.equal(r.json.sent.length, 1);

  const long = `${'слово '.repeat(1000)}`;
  const r2 = await call(server, 'send_message', { chat: '@friend', text: long, parse_mode: 'plain' });
  assert.equal(r2.json.sent.length, 2);
  assert.ok(client.sent[1].message.length <= 4096 && client.sent[2].message.length <= 4096);
  const r3 = await call(server, 'send_message', { chat: '@friend', text: 'ещё' });
  assert.equal(r3.isError, true);
  assert.match(r3.text, /at most 3 actions per minute/);
});

test('ограничения: скрытый чат, «писать только сюда», аккаунт только для чтения', async () => {
  const handlers = { 'contacts.ResolveUsername': resolver(FRIEND, BOT), 'messages.GetHistory': () => history([]) };
  const hidden = makeServer({ env: { TELEGRAM_HIDDEN_CHATS: '@friend' }, handlers });
  const r = await call(hidden.server, 'get_messages', { chat: '@friend' });
  assert.equal(r.isError, true);
  assert.match(r.text, /hidden by the connector settings/);

  const writable = makeServer({ env: { TELEGRAM_WRITABLE_CHATS: '@shopbot' }, handlers });
  assert.equal((await call(writable.server, 'get_messages', { chat: '@friend' })).isError, false);
  const w = await call(writable.server, 'send_message', { chat: '@friend', text: 'x' });
  assert.match(w.text, /«Писать только в эти чаты»/);
  assert.equal(writable.client.sent.length, 0);

  const ro = makeServer({ env: { TELEGRAM_READ_ONLY_ACCOUNTS: 'main' }, handlers });
  const s = await call(ro.server, 'send_message', { chat: '@friend', text: 'x' });
  assert.match(s.text, /read-only/);
  assert.equal((await call(ro.server, 'get_messages', { chat: '@friend' })).isError, false);

  const off = makeServer({ env: { TELEGRAM_ALLOW_SEND: 'false' }, handlers });
  assert.ok(!off.tools.some((t) => t.name === 'send_message'), 'выключенного инструмента нет в списке');
  // Вызов из устаревшего списка получает объяснение, какую настройку включить.
  const denied = await call(off.server, 'send_message', { chat: '@friend', text: 'x' });
  assert.equal(denied.isError, true);
  assert.match(denied.text, /turned off.*«Разрешить отправку сообщений»/);
  assert.equal(off.client.sent.length, 0);
});

function botMessage(id, rows, extra = {}) {
  return message(id, peerUser(700), {
    fromId: peerUser(700),
    message: 'Выберите',
    replyMarkup: new Api.ReplyInlineMarkup({ rows: rows.map((buttons) => new Api.KeyboardInlineButtonRow({ buttons })) }),
    ...extra,
  });
}

const cb = (text, data) => new Api.KeyboardInlineButton({ text, type: new Api.InlineButtonTypeCallback({ data: Buffer.from(data) }) });

test('кнопка с callback: ответ бота, изменённое сообщение, новые сообщения', async () => {
  const rows = [[cb('Да', 'yes'), cb('Нет', 'no')], [new Api.KeyboardInlineButton({ text: 'Сайт', type: new Api.InlineButtonTypeUrl({ url: 'https://shop.example' }) })]];
  const original = botMessage(20, rows);
  let edited = false;
  const { server, client } = makeServer({
    handlers: {
      'contacts.ResolveUsername': resolver(BOT),
      'messages.GetMessages': () => history([edited ? botMessage(20, rows, { message: 'Принято', editDate: 1_800_000_000 }) : original], [BOT]),
      'messages.GetHistory': (req) => (req.limit === 1 ? history([original], [BOT]) : history(edited ? [message(21, peerUser(700), { fromId: peerUser(700), message: 'Спасибо!' })] : [], [BOT])),
      'messages.GetBotCallbackAnswer': (req) => {
        assert.equal(req.msgId, 20);
        assert.equal(req.data.toString(), 'yes');
        edited = true;
        return new Api.messages.BotCallbackAnswer({ message: 'Ок', cacheTime: 0 });
      },
    },
  });
  const r = await call(server, 'press_button', { chat: '@shopbot', message_id: 20, text: 'да', wait_seconds: 3 });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json.button, { row: 0, col: 0, text: 'Да', type: 'callback' });
  assert.equal(r.json.bot_answer.text, 'Ок');
  assert.equal(r.json.updated_message.text, 'Принято');
  assert.deepEqual(r.json.new_messages.map((m) => m.text), ['Спасибо!']);

  const url = await call(server, 'press_button', { chat: '@shopbot', message_id: 20, row: 1, col: 0 });
  assert.equal(url.json.url, 'https://shop.example');
  assert.match(url.json.note, /nothing was opened/);
  assert.equal(client.calls.filter((c) => c.className === 'messages.GetBotCallbackAnswer').length, 1);

  const missing = await call(server, 'press_button', { chat: '@shopbot', message_id: 20, text: 'Купить' });
  assert.match(missing.text, /No button "Купить"[\s\S]*\[0,0\] Да/);
});

test('кнопки оплаты и с паролем не нажимаются; номер телефона — только с разрешением', async () => {
  const pay = botMessage(30, [[new Api.KeyboardInlineButton({ text: 'Оплатить', type: new Api.InlineButtonTypeBuy() })]]);
  const secret = botMessage(31, [[new Api.KeyboardInlineButton({ text: 'Передать', type: new Api.InlineButtonTypeCallback({ data: Buffer.from('x'), requiresPassword: true }) })]]);
  const phone = message(32, peerUser(700), {
    replyMarkup: new Api.ReplyKeyboardMarkup({ rows: [new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButton({ text: 'Поделиться', type: new Api.ButtonTypeRequestPhone() })] })] }),
  });
  const byId = { 30: pay, 31: secret, 32: phone };
  const handlers = {
    'contacts.ResolveUsername': resolver(BOT),
    'messages.GetMessages': (req) => history([byId[req.id[0].id]], [BOT]),
    'messages.GetHistory': () => history([], [BOT]),
    'messages.SendMedia': (req) => {
      assert.ok(req.media instanceof Api.InputMediaContact);
      return new Api.Updates({ updates: [], users: [], chats: [], date: 0, seq: 0 });
    },
  };
  const { server, client } = makeServer({ handlers });
  assert.match((await call(server, 'press_button', { chat: '@shopbot', message_id: 30 })).text, /payment/);
  assert.match((await call(server, 'press_button', { chat: '@shopbot', message_id: 31 })).text, /2FA password/);
  assert.match((await call(server, 'press_button', { chat: '@shopbot', message_id: 32 })).text, /share_phone: true/);
  assert.match((await call(server, 'press_button', { chat: '@shopbot', message_id: 32, share_phone: true })).text, /«Разрешить менять профиль и контакты»/);
  assert.equal(client.calls.some((c) => c.className === 'messages.GetBotCallbackAnswer' || c.className === 'messages.SendMedia'), false);

  const withProfile = makeServer({ env: { TELEGRAM_ALLOW_PROFILE: 'true' }, handlers });
  const ok = await call(withProfile.server, 'press_button', { chat: '@shopbot', message_id: 32, share_phone: true, wait_seconds: 0 });
  assert.equal(ok.isError, false, ok.text);
  assert.ok(withProfile.client.calls.some((c) => c.className === 'messages.SendMedia'));
});

test('глобальный поиск не показывает скрытые чаты', async () => {
  const { server } = makeServer({
    env: { TELEGRAM_HIDDEN_CHATS: '@news' },
    handlers: {
      'messages.SearchGlobal': (req) => {
        assert.equal(req.q, 'отчёт');
        return new Api.messages.Messages({
          messages: [message(1, peerChannel(5000), { message: 'отчёт в канале' }), message(2, peerUser(42), { message: 'отчёт от друга' })],
          users: [FRIEND],
          chats: [NEWS],
        });
      },
    },
  });
  const r = await call(server, 'search_messages', { query: 'отчёт' });
  assert.deepEqual(r.json.messages.map((m) => m.text), ['отчёт от друга']);
  assert.equal(r.json.messages[0].chat.id, 42);
});

test('список чатов: фильтр непрочитанных, скрытые исключены, служебный чат не виден', async () => {
  const dialog = (entity, unreadCount, last) => ({ entity, dialog: new Api.Dialog({ peer: new Api.PeerUser({ userId: entity.id }), topMessage: 1, readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount, unreadMentionsCount: 0, unreadReactionsCount: 0, unreadPollVotesCount: 0, notifySettings: new Api.PeerNotifySettings({}) }), message: last });
  const service = user(777000, { firstName: 'Telegram' });
  const { server } = makeServer({
    env: { TELEGRAM_HIDDEN_CHATS: '@shopbot' },
    handlers: {
      dialogs: () => [dialog(service, 1, message(1, peerUser(777000), { message: 'Код входа: 12345' })), dialog(BOT, 2), dialog(FRIEND, 3, message(9, peerUser(42), { message: 'привет' })), dialog(user(43), 0)],
    },
  });
  const r = await call(server, 'list_chats', { unread_only: true });
  assert.deepEqual(r.json.chats.map((c) => c.id), [42]);
  assert.equal(r.json.chats[0].unread, 3);
  assert.equal(r.json.chats[0].last.text, 'привет');
  assert.doesNotMatch(r.text, /12345/);
});

test('фото из сообщения возвращается картинкой', async () => {
  const photo = new Api.Photo({ id: bigInt(1), accessHash: bigInt(1), fileReference: Buffer.alloc(0), date: 0, dcId: 2, sizes: [new Api.PhotoSize({ type: 'x', w: 800, h: 600, size: 10 })] });
  const { server } = makeServer({
    handlers: {
      'contacts.ResolveUsername': resolver(FRIEND),
      'messages.GetMessages': () => history([message(5, peerUser(42), { media: new Api.MessageMediaPhoto({ photo }) })], [FRIEND]),
      downloadMedia: (media, params) => {
        assert.equal(params.thumb, 'x');
        return Buffer.from([0xff, 0xd8, 0xff]);
      },
    },
  });
  const r = await call(server, 'download_media', { chat: '@friend', message_id: 5 });
  assert.equal(r.isError, false, r.text);
  const image = r.content.find((c) => c.type === 'image');
  assert.equal(image.mimeType, 'image/jpeg');
  assert.equal(image.data, Buffer.from([0xff, 0xd8, 0xff]).toString('base64'));
  assert.deepEqual(r.json.media, { type: 'photo', width: 800, height: 600, bytes: 3 });
});

test('отправка файла: только из разрешённых папок', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'pic.png'), 'png');
  const { server, client } = makeServer({ argv: ['--upload-dirs', dir], handlers: { 'contacts.ResolveUsername': resolver(FRIEND) } });
  const r = await call(server, 'send_file', { chat: '@friend', file: path.join(dir, 'pic.png'), caption: '**фото**' });
  assert.equal(r.isError, false, r.text);
  const sent = client.sent[0];
  // Файл сначала загружается (чтобы «Стоп» мог отменить отправку), потом отправляется.
  assert.ok(client.uploaded[0] instanceof CustomFile);
  assert.equal(client.uploaded[0].name, 'pic.png');
  assert.ok(sent.file instanceof Api.InputFile);
  assert.equal(sent.file.name, 'pic.png');
  assert.equal(sent.caption, 'фото');
  assert.equal(sent.formattingEntities[0].className, 'MessageEntityBold');
  const bad = await call(server, 'send_file', { chat: '@friend', file: '/etc/hosts' });
  assert.match(bad.text, /outside the folders/);
  const url = await call(server, 'send_file', { chat: '@friend', file: 'HTTPS://example.com/a.jpg' });
  assert.equal(url.isError, false);
  assert.equal(client.sent.at(-1).file, 'https://example.com/a.jpg');
  const two = await call(server, 'send_file', { chat: '@friend', file: 'https://x.y/a.jpg', data_base64: 'AAAA' });
  assert.match(two.text, /exactly one/);
});

test('вступление по приглашению и пересылка', async () => {
  const group = channel(6000, { megagroup: true, title: 'Group' });
  const { server, client } = makeServer({
    handlers: {
      'messages.CheckChatInvite': () => new Api.ChatInvite({ title: 'Group', photo: new Api.PhotoEmpty({ id: bigInt(0) }), participantsCount: 10, color: 0 }),
      'messages.ImportChatInvite': (req) => {
        assert.equal(req.hash, 'AbCdEf');
        return new Api.messages.ChatInviteJoinResultOk({ updates: new Api.Updates({ updates: [], users: [], chats: [group], date: 0, seq: 0 }) });
      },
      'contacts.ResolveUsername': resolver(FRIEND, NEWS),
      'channels.GetMessages': (req) => history(req.id.map((m) => message(m.id, peerChannel(5000))), [], [NEWS]),
      'messages.ForwardMessages': (req) => {
        assert.deepEqual(req.id, [1, 2]);
        assert.equal(req.dropAuthor, true);
        return new Api.Updates({
          updates: [new Api.UpdateNewMessage({ message: message(77, peerUser(42)), pts: 0, ptsCount: 0 })],
          users: [],
          chats: [],
          date: 0,
          seq: 0,
        });
      },
    },
  });
  const j = await call(server, 'join_chat', { chat: 'https://t.me/+AbCdEf' });
  assert.equal(j.isError, false, j.text);
  assert.deepEqual(j.json.chat, { id: -1006000, type: 'supergroup', title: 'Group' });
  const f = await call(server, 'forward_messages', { from_chat: '@news', message_ids: [1, 2], to_chat: '@friend', as_copy: true });
  assert.deepEqual(f.json.forwarded, [77]);
  assert.ok(client.calls.some((c) => c.className === 'messages.ForwardMessages'));
});

test('прямые вызовы API: только при включённой настройке, опасные закрыты', async () => {
  const handlers = {
    'contacts.ResolveUsername': resolver(FRIEND),
    'users.GetFullUser': (req) => {
      assert.ok(req.id instanceof Api.InputUser);
      return new Api.users.UserFull({
        fullUser: new Api.UserFull({ id: bigInt(42), settings: new Api.PeerSettings({}), notifySettings: new Api.PeerNotifySettings({}), commonChatsCount: 2, about: 'bio' }),
        chats: [],
        users: [FRIEND],
      });
    },
  };
  const { server } = makeServer({ env: { TELEGRAM_ALLOW_RAW_API: 'true' }, handlers });
  const r = await call(server, 'send_api_request', { method: 'users.getFullUser', params: { id: '@friend' } });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.result.fullUser.about, 'bio');
  const blocked = await call(server, 'send_api_request', { method: 'auth.acceptLoginToken', params: { token: { _bytes: 'AA==' } } });
  assert.match(blocked.text, /never available/);
  const d = await call(server, 'describe_api_method', { method: 'messages.sendMessage' });
  assert.ok(d.json.params.some((p) => p.name === 'reply_to'));
});
