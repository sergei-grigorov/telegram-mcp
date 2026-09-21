// Ссылки на чаты от модели → сущности Telegram.
//
// Понимает: id в формате Bot API (-1001234567890, -123, 123456), @username,
// ссылки t.me (в том числе на сообщение, тему форума, приглашение, ?start=),
// tg://resolve, tg://join, tg://privatepost, tg://user?id=, номер телефона
// (только контакты), «me» — «Избранное», и точное название чата из диалогов.

import { ToolError } from '../mcp.js';
import { toToolError } from './errors.js';
import { chatRef, displayName, markedIdString, usernamesOf } from './format.js';
import { Api, bigInt, utils } from './lib.js';

// От 3 символов: у служебных inline-ботов короткие имена (@gif, @vid, @pic).
const USERNAME_RE = /^[a-z][a-z0-9_]{2,31}$/i;
const USERNAME_TTL_MS = 10 * 60_000;
const RESERVED_PATHS = new Set(['joinchat', 'c', 's', 'proxy', 'socks', 'addstickers', 'addemoji', 'share', 'setlanguage', 'login', 'iv', 'addlist', 'boost', 'invoice', 'm', 'nft', 'contact']);
const SELF_WORDS = new Set(['me', 'self', 'saved', 'saved messages', 'избранное']);
const DIALOGS_TTL_MS = 5 * 60_000;

function positiveInt(s) {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

// Разбор ссылки или идентификатора без обращения к сети.
export function parseChatRef(input) {
  if (input === undefined || input === null) return null;
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input) || input === 0) return null;
    return { kind: 'id', id: String(input) };
  }
  const raw = String(input).trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (SELF_WORDS.has(lower)) return { kind: 'self' };
  if (/^-?\d{1,20}$/.test(raw)) return { kind: 'id', id: raw.replace(/^(-?)0+(?=\d)/, '$1') };
  if (/^\+\d[\d\s()-]{5,20}$/.test(raw)) return { kind: 'phone', phone: raw.replace(/\D/g, '') };
  if (raw.startsWith('@') && USERNAME_RE.test(raw.slice(1))) return { kind: 'username', username: raw.slice(1).toLowerCase() };

  // tg://…
  const tg = raw.match(/^tg:\/\/(\w+)\/?\??(.*)$/i);
  if (tg) {
    const params = new URLSearchParams(tg[2]);
    const action = tg[1].toLowerCase();
    if (action === 'resolve' && params.get('domain')) {
      return clean({
        kind: 'username',
        username: params.get('domain').toLowerCase(),
        messageId: positiveInt(params.get('post')),
        topicId: positiveInt(params.get('thread')),
        startParam: params.get('start') ?? undefined,
      });
    }
    if (action === 'join' && params.get('invite')) return { kind: 'invite', hash: params.get('invite') };
    if (action === 'privatepost' && params.get('channel')) {
      return clean({ kind: 'id', id: `-100${params.get('channel')}`, messageId: positiveInt(params.get('post')), topicId: positiveInt(params.get('thread')) });
    }
    if ((action === 'user' || action === 'openmessage') && (params.get('id') || params.get('user_id'))) {
      return { kind: 'id', id: params.get('id') ?? params.get('user_id') };
    }
    return null;
  }

  // https://t.me/…
  const m = raw.match(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/(.+)$/i);
  if (m) {
    let url;
    try {
      url = new URL(`https://t.me/${m[1]}`);
    } catch {
      return null;
    }
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (!parts.length) return null;
    const first = parts[0];
    // t.me/+79991234567 — ссылка на профиль по номеру, а не приглашение.
    if (/^\+\d{7,15}$/.test(first)) return { kind: 'phone', phone: first.slice(1) };
    if (first.startsWith('+')) return { kind: 'invite', hash: first.slice(1) };
    if (first.toLowerCase() === 'joinchat' && parts[1]) return { kind: 'invite', hash: parts[1] };
    if (first.toLowerCase() === 'c' && /^\d+$/.test(parts[1] ?? '')) {
      const ids = parts.slice(2).map(positiveInt);
      return clean({
        kind: 'id',
        id: `-100${parts[1]}`,
        messageId: ids.length >= 2 ? ids[1] : ids[0],
        topicId: ids.length >= 2 ? ids[0] : positiveInt(url.searchParams.get('thread')),
      });
    }
    if (first.toLowerCase() === 's' && parts[1] && USERNAME_RE.test(parts[1])) {
      return clean({ kind: 'username', username: parts[1].toLowerCase(), messageId: positiveInt(parts[2]) });
    }
    if (RESERVED_PATHS.has(first.toLowerCase()) || !USERNAME_RE.test(first)) return null;
    const ids = parts.slice(1).map(positiveInt);
    return clean({
      kind: 'username',
      username: first.toLowerCase(),
      messageId: ids.length >= 2 ? ids[1] : ids[0],
      topicId: ids.length >= 2 ? ids[0] : positiveInt(url.searchParams.get('thread')),
      startParam: url.searchParams.get('start') ?? undefined,
      commentId: positiveInt(url.searchParams.get('comment')),
    });
  }
  // Голое слово: сначала ищем среди названий диалогов, потом как username.
  return { kind: 'title', title: raw, username: USERNAME_RE.test(raw) ? raw.toLowerCase() : undefined };
}

function clean(obj) {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}

// ───────────── Работа с сетью ─────────────

export function inputPeerOf(entity) {
  try {
    return utils.getInputPeer(entity);
  } catch {
    // «min»-пользователь: известен только по сообщению в группе, без access_hash.
    throw new ToolError(
      `${displayName(entity) ?? 'This user'} is known to this account only from a group message, so Telegram does not allow addressing them directly. Use their @username or open their profile in Telegram first.`,
    );
  }
}

// InputPeer по id в формате Bot API: из памяти или из кэша сущностей в файле сессии.
// (teleproto ищет в кэше по big-integer строгим сравнением и не находит, поэтому сами.)
export function cachedInputPeer(ctx, id) {
  const key = String(id);
  const e = ctx.lookup(key);
  if (e && !e.min) {
    try {
      return utils.getInputPeer(e);
    } catch {
      // см. inputPeerOf
    }
  }
  const row = ctx.session?._entities?.get(key);
  if (!row) return null;
  let peerId;
  let kind;
  try {
    [peerId, kind] = utils.resolveId(bigInt(key));
  } catch {
    return null;
  }
  const hash = bigInt(String(row[1] ?? 0));
  if (kind === Api.PeerUser) return new Api.InputPeerUser({ userId: peerId, accessHash: hash });
  if (kind === Api.PeerChat) return new Api.InputPeerChat({ chatId: peerId });
  if (kind === Api.PeerChannel) return new Api.InputPeerChannel({ channelId: peerId, accessHash: hash });
  return null;
}

// InputPeer по id через teleproto. Строку он понимает и как телефон или username,
// поэтому ответ принимается, только если это тот же id.
export async function inputEntityById(ctx, id) {
  try {
    const input = await ctx.client.getInputEntity(String(id));
    return markedIdString(input) === String(id) ? input : undefined;
  } catch {
    return undefined;
  }
}

// Полная сущность по InputPeer (для проверок и вывода).
export async function fetchEntity(ctx, input) {
  if (input instanceof Api.InputPeerSelf) return ctx.me;
  try {
    if (input instanceof Api.InputPeerUser) {
      const users = await ctx.client.invoke(new Api.users.GetUsers({ id: [new Api.InputUser({ userId: input.userId, accessHash: input.accessHash })] }));
      ctx.remember(users);
      const u = users[0];
      return u instanceof Api.User ? u : undefined;
    }
    if (input instanceof Api.InputPeerChannel) {
      const r = await ctx.client.invoke(new Api.channels.GetChannels({ id: [new Api.InputChannel({ channelId: input.channelId, accessHash: input.accessHash })] }));
      ctx.remember(r.chats);
      return r.chats[0];
    }
    if (input instanceof Api.InputPeerChat) {
      const r = await ctx.client.invoke(new Api.messages.GetChats({ id: [input.chatId] }));
      ctx.remember(r.chats);
      return r.chats[0];
    }
  } catch (err) {
    throw toToolError(err);
  }
  return undefined;
}

// Диалоги аккаунта (с кэшем на 5 минут): для поиска по названию и чтобы
// teleproto узнал access_hash чатов, известных только по id.
export async function loadDialogs(ctx, { force = false } = {}) {
  if (!force && ctx.dialogs && Date.now() - ctx.dialogsWarmedAt < DIALOGS_TTL_MS) return ctx.dialogs;
  const out = [];
  try {
    for (const archived of [false, true]) {
      const list = await ctx.client.getDialogs({ limit: archived ? 200 : 500, archived });
      for (const d of list) {
        if (!d.entity) continue;
        ctx.remember([d.entity]);
        out.push({ entity: d.entity, dialog: d.dialog, message: d.message, archived });
      }
    }
  } catch (err) {
    throw toToolError(err);
  }
  ctx.dialogs = out;
  ctx.dialogsWarmedAt = Date.now();
  // Среди диалогов мог появиться чат по ссылке-приглашению из списков чатов.
  await ctx.refreshInvites?.();
  return out;
}

// Username могут сменить владельца: доверяем кэшу только свежим записям.
function findCachedByUsername(ctx, username) {
  const now = Date.now();
  for (const [id, e] of ctx.cache) {
    if ((ctx.cachedAt?.get(id) ?? 0) < now - USERNAME_TTL_MS) continue;
    if (usernamesOf(e).some((u) => u.toLowerCase() === username)) return e;
  }
  return undefined;
}

async function resolveUsername(ctx, username) {
  const cached = findCachedByUsername(ctx, username);
  if (cached && !cached.min) return cached;
  let r;
  try {
    r = await ctx.client.invoke(new Api.contacts.ResolveUsername({ username }));
  } catch (err) {
    if (err?.errorMessage === 'USERNAME_NOT_OCCUPIED' || err?.errorMessage === 'USERNAME_INVALID') {
      throw new ToolError(`No user, bot, group or channel with username @${username}.`);
    }
    throw toToolError(err);
  }
  ctx.remember(r.users, r.chats);
  const id = markedIdString(r.peer);
  return ctx.lookup(id);
}

async function resolveId(ctx, id) {
  const cached = ctx.lookup(id);
  if (cached && !cached.min) return cached;
  // Строка, а не big-integer: так teleproto ищет в кэше сессии нестрого.
  const input = cachedInputPeer(ctx, id) ?? (await inputEntityById(ctx, id));
  if (input) {
    const entity = await fetchEntity(ctx, input).catch(() => undefined);
    if (entity) return entity;
  }
  // Чат известен только по id: подгружаем диалоги, чтобы узнать его access_hash.
  if (Date.now() - ctx.dialogsWarmedAt > 30_000) {
    await loadDialogs(ctx, { force: true });
    const e = ctx.lookup(id);
    if (e) return e;
  }
  throw new ToolError(
    `Chat ${id} is unknown to this account: it is not among its dialogs. Use @username or a t.me link, or find the chat with search_chats.`,
  );
}

// Поиск по названию — только среди видимых чатов: иначе список совпадений в
// тексте ошибки раскрыл бы названия скрытых чатов. Голое слово как @username не
// пробуем: «Alpha» из списка чатов не должно превратиться в незнакомца @alpha.
async function resolveTitle(ctx, title, usernameHint, isVisible = () => true) {
  const dialogs = (await loadDialogs(ctx)).filter((d) => isVisible(d.entity));
  const want = title.toLowerCase();
  const titleOf = (e) => (e instanceof Api.User && e.self ? 'Saved Messages' : displayName(e) ?? '');
  const exact = dialogs.filter((d) => titleOf(d.entity).toLowerCase() === want);
  const pick = (list) => {
    if (list.length === 1) return list[0].entity;
    if (list.length > 1) {
      throw new ToolError(
        `Several chats are called "${title}": ${list
          .slice(0, 10)
          .map((d) => JSON.stringify(chatRef(d.entity)))
          .join(', ')}. Pass the chat id instead.`,
      );
    }
    return undefined;
  };
  const byExact = pick(exact);
  if (byExact) return byExact;
  const partial = dialogs.filter((d) => titleOf(d.entity).toLowerCase().includes(want));
  const byPartial = pick(partial);
  if (byPartial) return byPartial;
  // Совпадение по username среди своих чатов — без обращения к сети.
  if (usernameHint) {
    const own = dialogs.find((d) => usernamesOf(d.entity).some((u) => u.toLowerCase() === usernameHint));
    if (own) return own.entity;
  }
  throw new ToolError(
    `No chat "${title}" among this account's dialogs. If it is a username, write it as @${usernameHint ?? 'username'}; otherwise use search_chats, or pass an id or link.`,
  );
}

async function resolvePhone(ctx, phone) {
  let r;
  try {
    r = await ctx.client.invoke(new Api.contacts.GetContacts({ hash: bigInt.zero }));
  } catch (err) {
    throw toToolError(err);
  }
  if (r instanceof Api.contacts.Contacts) {
    ctx.remember(r.users);
    const u = r.users.find((x) => x.phone === phone);
    if (u) return u;
  }
  throw new ToolError(`No contact with phone +${phone}. Only contacts can be found by phone number.`);
}

// Приглашение: участник — вернём чат, иначе — описание приглашения.
export async function checkInvite(ctx, hash) {
  let r;
  try {
    r = await ctx.client.invoke(new Api.messages.CheckChatInvite({ hash }));
  } catch (err) {
    throw toToolError(err);
  }
  if (r instanceof Api.ChatInviteAlready || r instanceof Api.ChatInvitePeek) {
    ctx.remember([r.chat]);
    // Ссылка из списков чатов теперь узнаётся и по id чата.
    ctx.inviteIds?.set(hash, markedIdString(r.chat));
    ctx.unresolvedInvites?.delete(hash);
    return { entity: r.chat, member: r instanceof Api.ChatInviteAlready };
  }
  return { invite: r };
}

// Главная функция: ссылка → { entity, input, messageId?, topicId?, startParam? }.
// opts.allowInvite: вернуть { invite } для приглашения в чат, где аккаунт не состоит.
export async function resolveChat(ctx, ref, opts = {}) {
  const parsed = parseChatRef(ref);
  if (!parsed) throw new ToolError(`Cannot understand chat reference ${JSON.stringify(ref)}: use a chat id, @username, t.me link or "me".`);
  let entity;
  switch (parsed.kind) {
    case 'self':
      entity = ctx.me;
      break;
    case 'id':
      entity = String(parsed.id) === ctx.selfId ? ctx.me : await resolveId(ctx, parsed.id);
      break;
    case 'username':
      entity = await resolveUsername(ctx, parsed.username);
      break;
    case 'phone':
      entity = await resolvePhone(ctx, parsed.phone);
      break;
    case 'title':
      entity = await resolveTitle(ctx, parsed.title, parsed.username, opts.isVisible);
      break;
    case 'invite': {
      const r = await checkInvite(ctx, parsed.hash);
      if (r.invite) {
        if (opts.allowInvite) return { invite: r.invite, hash: parsed.hash, parsed };
        throw new ToolError('This account is not a member of that chat. Join it first with join_chat (the invite link), if the user wants that.');
      }
      entity = r.entity;
      break;
    }
    default:
      throw new ToolError(`Unsupported chat reference ${JSON.stringify(ref)}`);
  }
  if (!entity) throw new ToolError(`Chat ${JSON.stringify(ref)} not found.`);
  const input = entity instanceof Api.User && entity.self ? new Api.InputPeerSelf() : inputPeerOf(entity);
  return { entity, input, messageId: parsed.messageId, topicId: parsed.topicId, startParam: parsed.startParam, commentId: parsed.commentId, parsed };
}
