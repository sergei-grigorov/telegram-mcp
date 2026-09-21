// Объекты Telegram → компактный JSON для модели. Пустые поля не выводятся.

import { Api, Rich, utils } from './lib.js';
import { toMarkdown } from './markdown.js';

// ───────────── Идентификаторы и даты ─────────────

// Идентификатор в формате Bot API: пользователь — положительный, группа — «-id»,
// канал и супергруппа — «-100id». Всегда умещается в double (≤ 2^53).
export function markedId(peerOrEntity) {
  return Number(utils.getPeerId(peerOrEntity));
}

export function markedIdString(peerOrEntity) {
  return String(utils.getPeerId(peerOrEntity));
}

const pad = (n) => String(Math.abs(Math.trunc(n))).padStart(2, '0');

// Местное время с часовым поясом: 2026-09-21T17:29:05+03:00.
export function isoDate(unix) {
  if (!unix) return undefined;
  const d = new Date(Number(unix) * 1000);
  if (Number.isNaN(d.getTime())) return undefined;
  const off = -d.getTimezoneOffset();
  const local = new Date(d.getTime() + off * 60000).toISOString().slice(0, 19);
  return `${local}${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`;
}

// «+79*******34»: номер целиком в ответы модели не попадает.
export function maskPhone(phone) {
  if (!phone) return null;
  const d = String(phone).replace(/\D/g, '');
  if (d.length < 6) return '***';
  return `+${d.slice(0, 2)}${'*'.repeat(d.length - 4)}${d.slice(-2)}`;
}

// Дата от модели (ISO, «2026-09-21», unix-секунды) → unix-секунды.
export function parseDate(value, name = 'date') {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return Math.trunc(value > 1e12 ? value / 1000 : value);
  const s = String(value).trim();
  if (/^\d{9,13}$/.test(s)) return parseDate(Number(s), name);
  // Дата без времени — полночь по местному времени, как и все даты в ответах.
  const day = s.match(/^(\d{4})-(\d\d)-(\d\d)$/);
  if (day) return Math.trunc(new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime() / 1000);
  const t = Date.parse(s);
  if (Number.isNaN(t)) {
    const err = new Error(`${name}: cannot parse date "${s}"; use ISO 8601, e.g. 2026-09-21T18:00:00+03:00`);
    err.exposed = true;
    throw err;
  }
  return Math.trunc(t / 1000);
}

function clean(obj) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined || v === null || v === false || v === '' || (Array.isArray(v) && v.length === 0)) delete obj[k];
  }
  return obj;
}

export function truncate(text, max) {
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

// ───────────── Пользователи и чаты ─────────────

export function displayName(entity) {
  if (!entity) return undefined;
  if (entity instanceof Api.User) {
    if (entity.deleted) return 'Deleted Account';
    return [entity.firstName, entity.lastName].filter(Boolean).join(' ') || undefined;
  }
  return entity.title || undefined;
}

export function usernamesOf(entity) {
  const out = [];
  if (entity?.username) out.push(entity.username);
  for (const u of entity?.usernames ?? []) {
    if (u?.username && u.active !== false && !out.includes(u.username)) out.push(u.username);
  }
  return out;
}

export function chatKind(entity) {
  if (entity instanceof Api.User) {
    if (entity.self) return 'self';
    return entity.bot ? 'bot' : 'user';
  }
  if (entity instanceof Api.Chat || entity instanceof Api.ChatForbidden || entity instanceof Api.ChatEmpty) return 'group';
  if (entity instanceof Api.Channel || entity instanceof Api.ChannelForbidden) {
    if (entity.broadcast) return 'channel';
    return 'supergroup';
  }
  if (entity instanceof Api.UserEmpty) return 'user';
  return 'unknown';
}

// Короткая ссылка на чат: для списков и заголовков.
export function chatRef(entity) {
  if (!entity) return undefined;
  const kind = chatKind(entity);
  const out = { id: markedId(entity), type: kind };
  if (kind === 'self') out.title = 'Saved Messages';
  else out.title = displayName(entity) ?? String(out.id);
  const names = usernamesOf(entity);
  if (names.length) out.username = `@${names[0]}`;
  if (entity.forum) out.forum = true;
  if (entity instanceof Api.ChannelForbidden || entity instanceof Api.ChatForbidden) out.no_access = true;
  return clean(out);
}

// Короткая ссылка на отправителя сообщения.
export function senderRef(entity) {
  if (!entity) return undefined;
  if (entity instanceof Api.User) {
    const names = usernamesOf(entity);
    return clean({
      id: markedId(entity),
      name: entity.self ? `${displayName(entity) ?? 'me'} (me)` : displayName(entity),
      username: names.length ? `@${names[0]}` : undefined,
      bot: entity.bot,
    });
  }
  return chatRef(entity);
}

export function formatStatus(status) {
  if (!status) return undefined;
  if (status instanceof Api.UserStatusOnline) return 'online';
  if (status instanceof Api.UserStatusOffline) return `last seen ${isoDate(status.wasOnline)}`;
  if (status instanceof Api.UserStatusRecently) return 'last seen recently';
  if (status instanceof Api.UserStatusLastWeek) return 'last seen within a week';
  if (status instanceof Api.UserStatusLastMonth) return 'last seen within a month';
  return undefined;
}

// Подробности о пользователе или чате (без полной информации — её дописывает get_chat).
export function describeEntity(entity) {
  if (!entity) return undefined;
  const out = chatRef(entity);
  const names = usernamesOf(entity);
  if (names.length > 1) out.usernames = names.map((n) => `@${n}`);
  if (entity instanceof Api.User) {
    Object.assign(out, {
      first_name: entity.firstName,
      last_name: entity.lastName,
      // Свой номер маскируем, как в connector_status; номера контактов — как есть.
      phone: entity.phone ? (entity.self ? maskPhone(entity.phone) : `+${entity.phone}`) : undefined,
      status: formatStatus(entity.status),
      contact: entity.contact,
      mutual_contact: entity.mutualContact,
      verified: entity.verified,
      premium: entity.premium,
      support: entity.support,
      scam: entity.scam,
      fake: entity.fake,
      deleted: entity.deleted,
      restricted: entity.restricted ? (entity.restrictionReason ?? []).map((r) => r.text).join('; ') || true : undefined,
      bot_inline_placeholder: entity.botInlinePlaceholder,
      paid_message_stars: entity.sendPaidMessagesStars ? Number(entity.sendPaidMessagesStars) : undefined,
    });
  } else {
    Object.assign(out, {
      members: entity.participantsCount || undefined,
      verified: entity.verified,
      scam: entity.scam,
      fake: entity.fake,
      creator: entity.creator,
      left: entity.left,
      deactivated: entity.deactivated,
      restricted: entity.restricted ? (entity.restrictionReason ?? []).map((r) => r.text).join('; ') || true : undefined,
      join_to_send: entity.joinToSend,
      join_request: entity.joinRequest,
      slow_mode: entity.slowmodeEnabled,
      protected_content: entity.noforwards,
      paid_message_stars: entity.sendPaidMessagesStars ? Number(entity.sendPaidMessagesStars) : undefined,
      admin: entity.adminRights ? true : undefined,
    });
  }
  return clean(out);
}

// ───────────── Вложения ─────────────

function attribute(doc, cls) {
  return doc?.attributes?.find((a) => a instanceof cls);
}

export function photoDimensions(photo) {
  let best;
  for (const s of photo?.sizes ?? []) {
    if ((s instanceof Api.PhotoSize || s instanceof Api.PhotoSizeProgressive) && (!best || s.w * s.h > best.w * best.h)) best = s;
  }
  return best ? { width: best.w, height: best.h } : {};
}

export function documentKind(doc) {
  const audio = attribute(doc, Api.DocumentAttributeAudio);
  const video = attribute(doc, Api.DocumentAttributeVideo);
  if (attribute(doc, Api.DocumentAttributeSticker)) return 'sticker';
  if (attribute(doc, Api.DocumentAttributeCustomEmoji)) return 'custom_emoji';
  if (audio?.voice) return 'voice';
  if (video?.roundMessage) return 'video_note';
  if (attribute(doc, Api.DocumentAttributeAnimated)) return 'gif';
  if (video) return 'video';
  if (audio) return 'audio';
  return 'document';
}

export function documentFileName(doc) {
  return attribute(doc, Api.DocumentAttributeFilename)?.fileName;
}

function describeDocument(doc, extra = {}) {
  if (!doc || doc instanceof Api.DocumentEmpty) return { type: 'document', unavailable: true };
  const kind = documentKind(doc);
  const audio = attribute(doc, Api.DocumentAttributeAudio);
  const video = attribute(doc, Api.DocumentAttributeVideo);
  const image = attribute(doc, Api.DocumentAttributeImageSize);
  const sticker = attribute(doc, Api.DocumentAttributeSticker);
  return clean({
    type: kind,
    file_name: documentFileName(doc),
    mime: doc.mimeType,
    size: doc.size !== undefined ? Number(doc.size) : undefined,
    duration: audio?.duration ?? (video?.duration !== undefined ? Math.round(video.duration) : undefined),
    width: video?.w ?? image?.w,
    height: video?.h ?? image?.h,
    title: audio?.title,
    performer: audio?.performer,
    emoji: sticker?.alt,
    ...extra,
  });
}

function textOf(twe) {
  if (!twe) return undefined;
  if (typeof twe === 'string') return twe;
  return toMarkdown(twe.text, twe.entities);
}

function describePoll(media) {
  const poll = media.poll;
  const results = media.results;
  const voters = new Map();
  for (const r of results?.results ?? []) voters.set(Buffer.from(r.option).toString('hex'), r);
  return clean({
    type: 'poll',
    question: textOf(poll.question),
    answers: poll.answers.map((a, i) => {
      const r = voters.get(Buffer.from(a.option).toString('hex'));
      return clean({ index: i, text: textOf(a.text), voters: r?.voters, chosen: r?.chosen, correct: r?.correct });
    }),
    total_voters: results?.totalVoters,
    closed: poll.closed,
    quiz: poll.quiz,
    multiple_choice: poll.multipleChoice,
    public_voters: poll.publicVoters,
    revote_disabled: poll.revotingDisabled,
    close_date: poll.closeDate ? isoDate(poll.closeDate) : undefined,
    solution: results?.solution ? toMarkdown(results.solution, results.solutionEntities) : undefined,
  });
}

export function describeMedia(media) {
  if (!media || media instanceof Api.MessageMediaEmpty) return undefined;
  if (media instanceof Api.MessageMediaPhoto) {
    if (!media.photo || media.photo instanceof Api.PhotoEmpty) return clean({ type: 'photo', unavailable: true, ttl: media.ttlSeconds });
    return clean({ type: 'photo', ...photoDimensions(media.photo), spoiler: media.spoiler, ttl: media.ttlSeconds, live_photo: media.livePhoto });
  }
  if (media instanceof Api.MessageMediaDocument) {
    return describeDocument(media.document, { spoiler: media.spoiler, ttl: media.ttlSeconds });
  }
  if (media instanceof Api.MessageMediaWebPage) {
    const w = media.webpage;
    if (w instanceof Api.WebPage) {
      return clean({
        type: 'link_preview',
        url: w.url,
        site: w.siteName,
        title: w.title,
        description: truncate(w.description, 300),
        has_photo: Boolean(w.photo) || undefined,
      });
    }
    return clean({ type: 'link_preview', url: w?.url });
  }
  if (media instanceof Api.MessageMediaPoll) return describePoll(media);
  if (media instanceof Api.MessageMediaGeo) return clean({ type: 'location', lat: media.geo?.lat, long: media.geo?.long });
  if (media instanceof Api.MessageMediaGeoLive) {
    return clean({ type: 'live_location', lat: media.geo?.lat, long: media.geo?.long, period: media.period });
  }
  if (media instanceof Api.MessageMediaVenue) {
    return clean({ type: 'venue', title: media.title, address: media.address, lat: media.geo?.lat, long: media.geo?.long });
  }
  if (media instanceof Api.MessageMediaContact) {
    return clean({
      type: 'contact',
      name: [media.firstName, media.lastName].filter(Boolean).join(' '),
      phone: media.phoneNumber,
      user_id: media.userId && Number(media.userId) ? Number(media.userId) : undefined,
    });
  }
  if (media instanceof Api.MessageMediaDice) return { type: 'dice', emoji: media.emoticon, value: media.value };
  if (media instanceof Api.MessageMediaGame) return clean({ type: 'game', title: media.game?.title, description: media.game?.description });
  if (media instanceof Api.MessageMediaInvoice) {
    return clean({
      type: 'invoice',
      title: media.title,
      description: truncate(media.description, 300),
      amount: media.totalAmount !== undefined ? Number(media.totalAmount) : undefined,
      currency: media.currency,
      test: media.test,
    });
  }
  if (media instanceof Api.MessageMediaStory) {
    return clean({ type: 'story', from: media.peer ? markedId(media.peer) : undefined, story_id: media.id });
  }
  if (media instanceof Api.MessageMediaGiveaway) {
    return clean({
      type: 'giveaway',
      quantity: media.quantity,
      months: media.months,
      stars: media.stars ? Number(media.stars) : undefined,
      prize: media.prizeDescription,
      until: isoDate(media.untilDate),
    });
  }
  if (media instanceof Api.MessageMediaGiveawayResults) {
    return clean({ type: 'giveaway_results', winners: media.winnersCount, unclaimed: media.unclaimedCount });
  }
  if (media instanceof Api.MessageMediaPaidMedia) {
    return { type: 'paid_media', stars: Number(media.starsAmount), items: media.extendedMedia?.length ?? 0 };
  }
  if (media instanceof Api.MessageMediaToDo) {
    const done = new Set((media.completions ?? []).map((c) => c.id));
    return clean({
      type: 'checklist',
      title: textOf(media.todo?.title),
      items: (media.todo?.list ?? []).map((item) => clean({ id: item.id, text: textOf(item.title), done: done.has(item.id) })),
    });
  }
  if (media instanceof Api.MessageMediaUnsupported) return { type: 'unsupported' };
  return { type: media.className.replace(/^MessageMedia/, '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase() };
}

// ───────────── Кнопки ─────────────

const INLINE_TYPES = [
  [() => Api.InlineButtonTypeCallback, 'callback'],
  [() => Api.InlineButtonTypeUrl, 'url'],
  [() => Api.InlineButtonTypeUrlAuth, 'login_url'],
  [() => Api.InputInlineButtonTypeUrlAuth, 'login_url'],
  [() => Api.InlineButtonTypeWebView, 'web_app'],
  [() => Api.InlineButtonTypeSwitchInline, 'switch_inline'],
  [() => Api.InlineButtonTypeGame, 'game'],
  [() => Api.InlineButtonTypeBuy, 'buy'],
  [() => Api.InlineButtonTypeUserProfile, 'user_profile'],
  [() => Api.InputInlineButtonTypeUserProfile, 'user_profile'],
  [() => Api.InlineButtonTypeCopy, 'copy'],
  [() => Api.InlineButtonTypeDisabled, 'disabled'],
];

const REPLY_TYPES = [
  [() => Api.ButtonTypeDefault, 'text'],
  [() => Api.ButtonTypeRequestPhone, 'request_phone'],
  [() => Api.ButtonTypeRequestGeoLocation, 'request_location'],
  [() => Api.ButtonTypeRequestPoll, 'request_poll'],
  [() => Api.ButtonTypeRequestPeer, 'request_chat'],
  [() => Api.InputButtonTypeRequestPeer, 'request_chat'],
  [() => Api.ButtonTypeSimpleWebView, 'web_app'],
];

export function buttonKind(button) {
  const table = button instanceof Api.KeyboardInlineButton ? INLINE_TYPES : REPLY_TYPES;
  for (const [cls, name] of table) if (button.type instanceof cls()) return name;
  return button.type?.className ?? 'unknown';
}

export function describeButton(button) {
  const kind = buttonKind(button);
  const t = button.type ?? {};
  return clean({
    text: button.text,
    type: kind,
    url: t.url,
    query: kind === 'switch_inline' ? t.query ?? '' : undefined,
    user_id: kind === 'user_profile' && t.userId !== undefined && !t.userId?.className ? Number(String(t.userId)) : undefined,
    copy_text: t.copyText,
    requires_password: t.requiresPassword,
  });
}

export function describeButtons(markup) {
  if (markup instanceof Api.ReplyInlineMarkup) {
    return { keyboard: 'inline', rows: markup.rows.map((row) => row.buttons.map(describeButton)) };
  }
  if (markup instanceof Api.ReplyKeyboardMarkup) {
    return clean({
      keyboard: 'reply',
      rows: markup.rows.map((row) => row.buttons.map(describeButton)),
      placeholder: markup.placeholder,
      one_time: markup.singleUse,
    });
  }
  if (markup instanceof Api.ReplyKeyboardForceReply) return { keyboard: 'force_reply' };
  return undefined;
}

// ───────────── Служебные сообщения ─────────────

function nameList(ids, lookup) {
  return (ids ?? [])
    .map((id) => {
      const e = lookup(String(id));
      return e ? displayName(e) : `user ${id}`;
    })
    .join(', ');
}

export function describeAction(action, lookup = () => undefined) {
  const A = Api;
  if (action instanceof A.MessageActionChatCreate) return `created group "${action.title}"`;
  if (action instanceof A.MessageActionChannelCreate) return `created channel "${action.title}"`;
  if (action instanceof A.MessageActionChatEditTitle) return `changed title to "${action.title}"`;
  if (action instanceof A.MessageActionChatEditPhoto) return 'changed chat photo';
  if (action instanceof A.MessageActionChatDeletePhoto) return 'removed chat photo';
  if (action instanceof A.MessageActionChatAddUser) return `added ${nameList(action.users, lookup)}`;
  if (action instanceof A.MessageActionChatDeleteUser) return `removed ${nameList([action.userId], lookup)}`;
  if (action instanceof A.MessageActionChatJoinedByLink) return 'joined via invite link';
  if (action instanceof A.MessageActionChatJoinedByRequest) return 'joined (request approved)';
  if (action instanceof A.MessageActionChatMigrateTo) return 'group upgraded to supergroup';
  if (action instanceof A.MessageActionChannelMigrateFrom) return `supergroup created from group "${action.title}"`;
  if (action instanceof A.MessageActionPinMessage) return 'pinned a message';
  if (action instanceof A.MessageActionHistoryClear) return 'history cleared';
  if (action instanceof A.MessageActionPhoneCall) {
    return `${action.video ? 'video ' : ''}call${action.duration ? ` (${action.duration} s)` : ' (missed or declined)'}`;
  }
  if (action instanceof A.MessageActionGroupCall) return action.duration ? `group call ended (${action.duration} s)` : 'group call started';
  if (action instanceof A.MessageActionScreenshotTaken) return 'took a screenshot';
  if (action instanceof A.MessageActionCustomAction) return action.message;
  if (action instanceof A.MessageActionContactSignUp) return 'joined Telegram';
  if (action instanceof A.MessageActionSetMessagesTTL) return action.period ? `auto-delete set to ${action.period} s` : 'auto-delete disabled';
  if (action instanceof A.MessageActionTopicCreate) return `created topic "${action.title}"`;
  if (action instanceof A.MessageActionTopicEdit) return `edited topic${action.title ? ` "${action.title}"` : ''}`;
  if (action instanceof A.MessageActionBotAllowed) return 'allowed the bot to write';
  if (action instanceof A.MessageActionGameScore) return `game score ${action.score}`;
  if (action instanceof A.MessageActionPaymentSent) return `payment sent: ${Number(action.totalAmount)} ${action.currency} (minor units)`;
  if (action instanceof A.MessageActionBoostApply) return `boosted the chat (${action.boosts})`;
  if (action instanceof A.MessageActionWebViewDataSent) return `sent data from a web app: ${action.text}`;
  return action?.className
    ? action.className.replace(/^MessageAction/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
    : 'service message';
}

// ───────────── Реакции ─────────────

export function formatReactions(reactions) {
  if (!reactions?.results?.length) return undefined;
  return reactions.results.map((r) => {
    let emoji;
    if (r.reaction instanceof Api.ReactionEmoji) emoji = r.reaction.emoticon;
    else if (r.reaction instanceof Api.ReactionCustomEmoji) emoji = `custom:${String(r.reaction.documentId)}`;
    else if (r.reaction instanceof Api.ReactionPaid) emoji = '⭐ (paid)';
    else emoji = r.reaction?.className ?? '?';
    return clean({ emoji, count: r.count, mine: r.chosenOrder !== undefined && r.chosenOrder !== null });
  });
}

// ───────────── Сообщения ─────────────

function fwdInfo(fwd, lookup) {
  if (!fwd) return undefined;
  const from = fwd.fromId ? lookup(markedIdString(fwd.fromId)) : undefined;
  return clean({
    from: from ? senderRef(from) : fwd.fromId ? { id: markedId(fwd.fromId) } : fwd.fromName,
    date: isoDate(fwd.date),
    channel_post: fwd.channelPost,
    author: fwd.postAuthor,
    imported: fwd.imported,
  });
}

// Отправитель: fromId, а если его нет — собеседник (личный чат) или сам канал.
export function senderPeerOf(m) {
  if (m.fromId) return m.fromId;
  return m.peerId;
}

// ctx: { lookup(markedIdString) → entity, selfId: string, withChat: boolean }
export function formatMessage(m, ctx = {}) {
  const lookup = ctx.lookup ?? (() => undefined);
  if (m instanceof Api.MessageEmpty) return { id: m.id, deleted: true };
  const out = { id: m.id, date: isoDate(m.date) };
  if (ctx.withChat && m.peerId) {
    const chat = lookup(markedIdString(m.peerId));
    out.chat = chat ? chatRef(chat) : { id: markedId(m.peerId) };
  }
  if (m.out) out.out = true;
  const senderPeer = m.out && !m.fromId ? null : senderPeerOf(m);
  if (senderPeer) {
    const sender = lookup(markedIdString(senderPeer));
    out.from = sender ? senderRef(sender) : { id: markedId(senderPeer) };
  } else if (m.out && ctx.selfId) {
    const me = lookup(String(ctx.selfId));
    out.from = me ? senderRef(me) : { id: Number(ctx.selfId) };
  }
  if (m.postAuthor) out.author = m.postAuthor;
  const r = m.replyTo;
  if (r instanceof Api.MessageReplyHeader) {
    // В форуме replyToMsgId без replyToTopId — это просто тема, а не ответ.
    if (r.forumTopic) {
      out.topic = r.replyToTopId ?? r.replyToMsgId;
      if (r.replyToTopId && r.replyToMsgId) out.reply_to = r.replyToMsgId;
    } else {
      if (r.replyToMsgId) out.reply_to = r.replyToMsgId;
      if (r.replyToTopId) out.thread = r.replyToTopId;
    }
    if (r.replyToPeerId) out.reply_to_chat = markedId(r.replyToPeerId);
    if (r.quoteText) out.quote = truncate(r.quoteText, 500);
    if (r.replyFrom) out.reply_to_external = fwdInfo(r.replyFrom, lookup);
  } else if (r instanceof Api.MessageReplyStoryHeader) {
    out.reply_to_story = { from: markedId(r.peer), story_id: r.storyId };
  }
  if (m.fwdFrom) out.forwarded = fwdInfo(m.fwdFrom, lookup);
  if (m.viaBotId) {
    const bot = lookup(String(m.viaBotId));
    out.via_bot = bot ? `@${usernamesOf(bot)[0] ?? displayName(bot)}` : Number(m.viaBotId);
  }
  if (m instanceof Api.MessageService) {
    out.service = describeAction(m.action, lookup);
  } else {
    let text = toMarkdown(m.message, m.entities);
    // Сообщения с «богатой» вёрсткой (слой 228+) приходят блоками, а не текстом.
    if (m.richMessage) {
      try {
        const rich = Rich.toMarkdown(m.richMessage);
        if (rich) text = text ? `${text}\n\n${rich}` : rich;
      } catch {
        // неизвестный блок — останется то, что было в тексте
      }
    }
    if (text) out.text = ctx.maxText ? truncate(text, ctx.maxText) : text;
    const media = describeMedia(m.media);
    if (media) out.media = media;
    const buttons = describeButtons(m.replyMarkup);
    if (buttons) out.buttons = buttons;
  }
  const reactions = formatReactions(m.reactions);
  if (reactions) out.reactions = reactions;
  if (m.views) out.views = m.views;
  if (m.forwards) out.forwards = m.forwards;
  if (m.replies?.replies) out[m.replies.comments ? 'comments' : 'replies'] = m.replies.replies;
  if (m.editDate && !m.editHide) out.edited = isoDate(m.editDate);
  if (m.pinned) out.pinned = true;
  if (m.groupedId) out.album = String(m.groupedId);
  if (m.ttlPeriod) out.ttl = m.ttlPeriod;
  if (m.noforwards) out.protected = true;
  if (m.fromScheduled) out.scheduled = true;
  if (m.paidMessageStars) out.paid_stars = Number(m.paidMessageStars);
  return out;
}

// Короткий пересказ последнего сообщения для списка чатов.
export function previewMessage(m, lookup) {
  if (!m || m instanceof Api.MessageEmpty) return undefined;
  const f = formatMessage(m, { lookup, maxText: 120 });
  return clean({
    id: f.id,
    date: f.date,
    from: f.out ? 'me' : f.from?.name ?? f.from?.title,
    text: f.text ?? f.service,
    media: f.media?.type,
  });
}
