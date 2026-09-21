import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  chatKind,
  chatRef,
  describeButtons,
  describeMedia,
  formatMessage,
  isoDate,
  markedId,
  parseDate,
  previewMessage,
} from '../server/tg/format.js';
import { Api, bigInt } from '../server/tg/lib.js';
import { channel, ME, message, peerChannel, peerUser, user } from './helpers.js';

const lookupOf = (...entities) => {
  const map = new Map(entities.map((e) => [String(markedId(e)), e]));
  return (id) => map.get(String(id));
};

test('id в формате Bot API и типы чатов', () => {
  assert.equal(markedId(channel(1234567890)), -1001234567890);
  assert.equal(markedId(peerUser(5)), 5);
  assert.equal(markedId(new Api.PeerChat({ chatId: bigInt(77) })), -77);
  assert.equal(chatKind(ME), 'self');
  assert.equal(chatKind(user(1, { bot: true })), 'bot');
  assert.equal(chatKind(channel(1, { broadcast: true })), 'channel');
  assert.equal(chatKind(channel(1, { megagroup: true })), 'supergroup');
  assert.deepEqual(chatRef(ME), { id: 1000, type: 'self', title: 'Saved Messages', username: '@testuser' });
  assert.deepEqual(chatRef(channel(9, { megagroup: true, forum: true, username: 'grp' })), { id: -1009, type: 'supergroup', title: 'Channel 9', username: '@grp', forum: true });
});

test('даты: ISO с часовым поясом, разбор ISO и unix', () => {
  assert.match(isoDate(1_700_000_000), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  assert.equal(new Date(isoDate(1_700_000_000)).getTime(), 1_700_000_000_000);
  assert.equal(parseDate('2023-11-14T22:13:20Z'), 1_700_000_000);
  assert.equal(parseDate(1_700_000_000_000), 1_700_000_000);
  assert.equal(parseDate(undefined), undefined);
  assert.throws(() => parseDate('завтра'), /cannot parse date/);
});

test('сообщение: отправитель, ответ, пересылка, текст с разметкой, реакции', () => {
  const alice = user(42, { firstName: 'Alice', username: 'alice' });
  const m = message(10, peerChannel(5), {
    fromId: peerUser(42),
    message: 'Hi there',
    entities: [new Api.MessageEntityBold({ offset: 0, length: 2 })],
    replyTo: new Api.MessageReplyHeader({ replyToMsgId: 7, quoteText: 'q' }),
    fwdFrom: new Api.MessageFwdHeader({ fromName: 'Hidden Person', date: 1_600_000_000 }),
    reactions: new Api.MessageReactions({
      results: [
        new Api.ReactionCount({ reaction: new Api.ReactionEmoji({ emoticon: '👍' }), count: 3, chosenOrder: 0 }),
        new Api.ReactionCount({ reaction: new Api.ReactionPaid(), count: 1 }),
      ],
    }),
    views: 100,
    editDate: 1_700_000_100,
    pinned: true,
  });
  const f = formatMessage(m, { lookup: lookupOf(alice, channel(5)), withChat: true });
  assert.deepEqual(f.from, { id: 42, name: 'Alice', username: '@alice' });
  assert.deepEqual(f.chat, { id: -1005, type: 'supergroup', title: 'Channel 5' });
  assert.equal(f.text, '**Hi** there');
  assert.equal(f.reply_to, 7);
  assert.equal(f.quote, 'q');
  assert.equal(f.forwarded.from, 'Hidden Person');
  assert.deepEqual(f.reactions, [{ emoji: '👍', count: 3, mine: true }, { emoji: '⭐ (paid)', count: 1 }]);
  assert.equal(f.views, 100);
  assert.equal(f.pinned, true);
  assert.ok(f.edited);
});

test('форумы: тема и ответ в теме различаются', () => {
  const inTopic = formatMessage(message(1, peerChannel(5), { replyTo: new Api.MessageReplyHeader({ forumTopic: true, replyToMsgId: 3 }) }));
  assert.equal(inTopic.topic, 3);
  assert.equal(inTopic.reply_to, undefined);
  const replyInTopic = formatMessage(message(2, peerChannel(5), { replyTo: new Api.MessageReplyHeader({ forumTopic: true, replyToMsgId: 9, replyToTopId: 3 }) }));
  assert.equal(replyInTopic.topic, 3);
  assert.equal(replyInTopic.reply_to, 9);
});

test('исходящее сообщение в личке: отправитель — я', () => {
  const f = formatMessage(message(3, peerUser(42), { out: true }), { lookup: lookupOf(ME), selfId: '1000' });
  assert.equal(f.out, true);
  assert.equal(f.from.id, 1000);
  assert.match(f.from.name, /\(me\)/);
});

test('вложения: фото, документы, опрос, прочее', () => {
  const photo = new Api.Photo({
    id: bigInt(1),
    accessHash: bigInt(1),
    fileReference: Buffer.alloc(0),
    date: 0,
    dcId: 2,
    sizes: [new Api.PhotoSize({ type: 'm', w: 320, h: 240, size: 100 }), new Api.PhotoSizeProgressive({ type: 'y', w: 1280, h: 960, sizes: [1, 2, 300] })],
  });
  assert.deepEqual(describeMedia(new Api.MessageMediaPhoto({ photo })), { type: 'photo', width: 1280, height: 960 });
  const doc = (attributes, mimeType = 'application/octet-stream') =>
    new Api.MessageMediaDocument({
      document: new Api.Document({ id: bigInt(1), accessHash: bigInt(1), fileReference: Buffer.alloc(0), date: 0, mimeType, size: bigInt(2048), dcId: 2, attributes }),
    });
  assert.deepEqual(describeMedia(doc([new Api.DocumentAttributeFilename({ fileName: 'a.pdf' })], 'application/pdf')), {
    type: 'document',
    file_name: 'a.pdf',
    mime: 'application/pdf',
    size: 2048,
  });
  assert.equal(describeMedia(doc([new Api.DocumentAttributeAudio({ voice: true, duration: 5 })], 'audio/ogg')).type, 'voice');
  assert.equal(describeMedia(doc([new Api.DocumentAttributeVideo({ roundMessage: true, duration: 3, w: 1, h: 1 })])).type, 'video_note');
  assert.equal(describeMedia(doc([new Api.DocumentAttributeAnimated(), new Api.DocumentAttributeVideo({ duration: 1, w: 1, h: 1 })])).type, 'gif');
  const sticker = describeMedia(doc([new Api.DocumentAttributeSticker({ alt: '😀', stickerset: new Api.InputStickerSetEmpty() })], 'image/webp'));
  assert.equal(sticker.type, 'sticker');
  assert.equal(sticker.emoji, '😀');

  const opt = (b) => Buffer.from([b]);
  const poll = describeMedia(
    new Api.MessageMediaPoll({
      poll: new Api.Poll({
        id: bigInt(1),
        question: new Api.TextWithEntities({ text: 'Кофе?', entities: [] }),
        answers: [
          new Api.PollAnswer({ text: new Api.TextWithEntities({ text: 'Да', entities: [] }), option: opt(0) }),
          new Api.PollAnswer({ text: new Api.TextWithEntities({ text: 'Нет', entities: [] }), option: opt(1) }),
        ],
        hash: bigInt(0),
      }),
      results: new Api.PollResults({ results: [new Api.PollAnswerVoters({ option: opt(0), voters: 5, chosen: true })], totalVoters: 5 }),
    }),
  );
  assert.deepEqual(poll, {
    type: 'poll',
    question: 'Кофе?',
    answers: [
      { index: 0, text: 'Да', voters: 5, chosen: true },
      { index: 1, text: 'Нет' },
    ],
    total_voters: 5,
  });
  assert.deepEqual(describeMedia(new Api.MessageMediaDice({ value: 6, emoticon: '🎲' })), { type: 'dice', emoji: '🎲', value: 6 });
  assert.equal(describeMedia(new Api.MessageMediaUnsupported()).type, 'unsupported');
});

test('кнопки: inline (слой 229) и клавиатура ответа', () => {
  const inline = describeButtons(
    new Api.ReplyInlineMarkup({
      rows: [
        new Api.KeyboardInlineButtonRow({
          buttons: [
            new Api.KeyboardInlineButton({ text: 'Да', type: new Api.InlineButtonTypeCallback({ data: Buffer.from('y') }) }),
            new Api.KeyboardInlineButton({ text: 'Сайт', type: new Api.InlineButtonTypeUrl({ url: 'https://ex.com' }) }),
          ],
        }),
        new Api.KeyboardInlineButtonRow({
          buttons: [
            new Api.KeyboardInlineButton({ text: 'Купить', type: new Api.InlineButtonTypeBuy() }),
            new Api.KeyboardInlineButton({ text: 'Поиск', type: new Api.InlineButtonTypeSwitchInline({ query: 'cats' }) }),
          ],
        }),
      ],
    }),
  );
  assert.deepEqual(inline, {
    keyboard: 'inline',
    rows: [
      [{ text: 'Да', type: 'callback' }, { text: 'Сайт', type: 'url', url: 'https://ex.com' }],
      [{ text: 'Купить', type: 'buy' }, { text: 'Поиск', type: 'switch_inline', query: 'cats' }],
    ],
  });
  const replyKb = describeButtons(
    new Api.ReplyKeyboardMarkup({
      rows: [new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButton({ text: 'Меню', type: new Api.ButtonTypeDefault() }), new Api.KeyboardButton({ text: 'Телефон', type: new Api.ButtonTypeRequestPhone() })] })],
      singleUse: true,
    }),
  );
  assert.deepEqual(replyKb, { keyboard: 'reply', rows: [[{ text: 'Меню', type: 'text' }, { text: 'Телефон', type: 'request_phone' }]], one_time: true });
});

test('служебные сообщения и превью для списка чатов', () => {
  const alice = user(42, { firstName: 'Alice' });
  const service = new Api.MessageService({ id: 5, peerId: peerChannel(5), date: 1_700_000_000, action: new Api.MessageActionChatAddUser({ users: [bigInt(42)] }) });
  assert.equal(formatMessage(service, { lookup: lookupOf(alice) }).service, 'added Alice');
  const other = new Api.MessageService({ id: 6, peerId: peerChannel(5), date: 1_700_000_000, action: new Api.MessageActionHistoryClear() });
  assert.equal(formatMessage(other).service, 'history cleared');
  const long = message(7, peerUser(42), { message: 'x'.repeat(500) });
  const p = previewMessage(long, lookupOf(alice));
  assert.equal(p.from, 'Alice');
  assert.equal(p.text.length, 121);
});
