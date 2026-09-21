// Общее для инструментов: схемы параметров, выбор аккаунта и чата, вывод.

import { ToolError } from '../mcp.js';
import { toToolError } from '../tg/errors.js';
import { chatRef, formatMessage, markedIdString } from '../tg/format.js';
import { Api, bigInt } from '../tg/lib.js';
import { resolveChat } from '../tg/peers.js';

export const ACCOUNT = {
  type: 'string',
  description: 'Account to act as: name from connector_status (or @username). Omit to use the default account.',
};

export const CHAT = {
  type: ['string', 'integer'],
  description:
    'Chat: id from previous results (e.g. -1001234567890), @username, t.me link, "me" (Saved Messages) or exact chat title.',
};

export const MESSAGE_ID = { type: 'integer', minimum: 1, description: 'Message id in this chat.' };

export const PARSE_MODE = {
  type: 'string',
  enum: ['markdown', 'html', 'plain'],
  description:
    'Formatting of the text. markdown (default): **bold**, *italic*, __underline__, ~~strike~~, ||spoiler||, `code`, ```lang\\ncode```, [text](url), [name](tg://user?id=123), lines starting with "> " are a quote; escape with \\. html: <b>, <i>, <u>, <s>, <tg-spoiler>, <code>, <pre>, <a href>, <blockquote>. plain: no formatting.',
};

export function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

export const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

// ───────────── Вывод ─────────────

// JSON, где элементы списков идут по одному на строку: читается как текст и
// тратит меньше токенов, чем JSON с отступами.
export function toText(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[\n${value.map((x) => ` ${JSON.stringify(x)}`).join(',\n')}\n]`;
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  const lines = entries.map(([k, v], i) => {
    const comma = i < entries.length - 1 ? ',' : '';
    if (Array.isArray(v) && v.length && v.some((x) => x && typeof x === 'object')) {
      return ` ${JSON.stringify(k)}: [\n${v.map((x) => `  ${JSON.stringify(x)}`).join(',\n')}\n ]${comma}`;
    }
    return ` ${JSON.stringify(k)}: ${JSON.stringify(v)}${comma}`;
  });
  return `{\n${lines.join('\n')}\n}`;
}

function shortenTexts(value, max) {
  if (Array.isArray(value)) return value.map((v) => shortenTexts(v, max));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = typeof v === 'string' && v.length > max && ['text', 'description', 'about', 'bio', 'quote'].includes(k) ? `${v.slice(0, max)}… [truncated]` : shortenTexts(v, max);
    }
    return out;
  }
  return value;
}

const CURSOR_KEYS = ['next_offset', 'next_offset_id', 'next_min_id'];

// Укладывает ответ в предел длины: сначала укорачивает тексты, потом убирает
// часть элементов списка. trim = { key, keep: 'start' | 'end', cursor(kept) → поля }:
// какой край списка сохранить и как пересчитать курсор следующей страницы по тому,
// что действительно осталось в ответе.
export function fitText(value, max, trim) {
  let text = toText(value);
  if (text.length <= max) return text;
  for (const limit of [2000, 500, 200]) {
    value = shortenTexts(value, limit);
    text = toText(value);
    if (text.length <= max) return text;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const key = trim?.key ?? Object.keys(value).filter((k) => Array.isArray(value[k])).sort((a, b) => value[b].length - value[a].length)[0];
    const list = key ? value[key] : null;
    if (Array.isArray(list) && list.length > 1) {
      let keep = list.length;
      while (keep > 1) {
        keep = Math.floor(keep * 0.8);
        const kept = trim?.keep === 'start' ? list.slice(0, keep) : list.slice(list.length - keep);
        const trial = { ...value, [key]: kept };
        if (trim?.cursor) Object.assign(trial, trim.cursor(kept));
        // Без правила пересчёта курсор по полному списку был бы неверным — убираем.
        else for (const k of CURSOR_KEYS) delete trial[k];
        trial.truncated = `${list.length - keep} of ${list.length} items of "${key}" were left out to fit the response size;${trim?.cursor ? ' the cursor continues from what is shown.' : ' request fewer items.'}`;
        text = toText(trial);
        if (text.length <= max) return text;
      }
    }
  }
  return `${text.slice(0, max)}\n… [response truncated]`;
}

export function reply(services, value, trim) {
  return fitText(value, services.config.maxOutputChars, trim);
}

// ───────────── Аккаунт и чат ─────────────

// Аккаунт для инструмента: проверяет разрешения и «только чтение».
export async function account(services, args, capability = 'read') {
  const caps = [].concat(capability);
  for (const c of caps) services.policy.require(c);
  const write = caps.some((c) => c !== 'read');
  return services.accounts.use(args.account, { write });
}

// Чат для инструмента: разбор ссылки, проверка «скрытых» и «только этих» чатов.
export async function chat(services, acc, ref, { write = false, allowInvite = false } = {}) {
  if (ref === undefined || ref === null || ref === '') throw new ToolError('"chat" is required.');
  const { policy } = services;
  const r = await resolveChat(acc, ref, { allowInvite, isVisible: (e) => policy.isVisible(e, acc) });
  if (r.parsed?.kind === 'invite') policy.requireInviteNotHidden(r.parsed.hash);
  if (r.invite) {
    policy.requireInviteAllowed(r.hash);
    return r;
  }
  if (write) policy.requireWritable(r.entity, acc);
  else policy.requireVisible(r.entity, acc);
  return r;
}

export function messageIdFrom(args, resolved, field = 'message_id') {
  const id = args[field] ?? resolved.messageId;
  if (!id) throw new ToolError(`"${field}" is required (or pass a t.me link to the message as "chat").`);
  return id;
}

// id чата в формате Bot API для входного пира.
export function inputMarkedId(acc, input) {
  if (input instanceof Api.InputPeerSelf) return acc.selfId;
  if (input instanceof Api.InputPeerUser) return String(input.userId);
  if (input instanceof Api.InputPeerChat) return `-${input.chatId}`;
  if (input instanceof Api.InputPeerChannel) return `-100${input.channelId}`;
  return null;
}

// Сообщения по id из указанного чата. Для каналов — channels.getMessages. Личные
// чаты и группы делят одну нумерацию на весь аккаунт, и messages.getMessages
// отдаёт сообщение из любого чата, включая скрытые и служебный, — поэтому всё,
// что не из этого чата, отбрасываем.
export async function getMessagesByIds(acc, input, ids) {
  const list = ids.map((id) => new Api.InputMessageID({ id }));
  const request =
    input instanceof Api.InputPeerChannel
      ? new Api.channels.GetMessages({ channel: new Api.InputChannel({ channelId: input.channelId, accessHash: input.accessHash }), id: list })
      : new Api.messages.GetMessages({ id: list });
  const r = await acc.invoke(request);
  const want = inputMarkedId(acc, input);
  return (r.messages ?? []).filter((m) => !(m instanceof Api.MessageEmpty) && m.peerId && markedIdString(m.peerId) === want);
}

export async function getMessage(acc, resolved, id) {
  const [m] = await getMessagesByIds(acc, resolved.input, [id]);
  if (!m) throw new ToolError(`Message ${id} not found in this chat (deleted or wrong id).`);
  return m;
}

// Все сообщения с этими id должны быть в этом чате — иначе отказ.
export async function requireMessagesInChat(acc, resolved, ids) {
  const found = await getMessagesByIds(acc, resolved.input, ids);
  const have = new Set(found.map((m) => m.id));
  const missing = ids.filter((id) => !have.has(id));
  if (missing.length) throw new ToolError(`Message(s) ${missing.join(', ')} not found in this chat (deleted or wrong id).`);
  return found;
}

// Страница истории: общая лента, ветка (комментарии, тема форума) или сообщения одного отправителя.
// «Новее чем minId» листаем вперёд, как teleproto: offset_id = minId + 1 и
// add_offset = -limit. С одним min_id Telegram отдал бы самые новые сообщения и
// пропустил бы промежуточные. Ответ — от новых к старым, как у Telegram.
export async function fetchHistory(acc, input, { limit, offsetId = 0, minId = 0, thread, fromUser }) {
  const forward = minId > 0 && !offsetId;
  const common = forward
    ? { offsetId: minId + 1, addOffset: -limit, limit, maxId: 0, minId: 0, hash: bigInt.zero }
    : { offsetId, addOffset: 0, limit, maxId: 0, minId, hash: bigInt.zero };
  let r;
  if (thread) {
    r = await acc.invoke(new Api.messages.GetReplies({ peer: input, msgId: thread, offsetDate: 0, ...common }));
  } else if (fromUser) {
    r = await acc.invoke(
      new Api.messages.Search({ peer: input, q: '', fromId: fromUser, filter: new Api.InputMessagesFilterEmpty(), minDate: 0, maxDate: 0, ...common }),
    );
  } else {
    r = await acc.invoke(new Api.messages.GetHistory({ peer: input, offsetDate: 0, ...common }));
  }
  if (forward && Array.isArray(r?.messages)) r.messages = r.messages.filter((m) => m.id > minId);
  return r;
}

export async function latestMessageId(acc, input, thread) {
  const r = await fetchHistory(acc, input, { limit: 1, thread });
  return r.messages?.[0]?.id ?? 0;
}

export function formatMessages(acc, messages, opts = {}) {
  return messages.map((m) => formatMessage(m, { lookup: acc.lookupFn, selfId: acc.selfId, ...opts }));
}

// Сообщения из ответа Telegram (messages.Messages/Slice/ChannelMessages) → вывод,
// без сообщений из скрытых чатов.
export function visibleMessages(services, acc, result, opts = {}) {
  const out = [];
  for (const m of result?.messages ?? []) {
    if (!m.peerId) continue;
    // Чат, который нельзя проверить, не показываем.
    const entity = acc.lookup(markedIdString(m.peerId));
    if (!entity || !services.policy.isVisible(entity, acc)) continue;
    out.push(m);
  }
  return formatMessages(acc, out, opts);
}

// Новые сообщения из ответа Updates (пересылка, опросы, inline-результаты).
export function messagesFromUpdates(acc, updates) {
  acc.remember(updates?.users, updates?.chats);
  const out = [];
  for (const u of updates?.updates ?? []) {
    if (u instanceof Api.UpdateNewMessage || u instanceof Api.UpdateNewChannelMessage || u instanceof Api.UpdateNewScheduledMessage) {
      out.push(u.message);
    }
  }
  return out;
}

export function header(acc, entity) {
  return { account: acc.name, chat: chatRef(entity) };
}

// Отмена вызова клиентом и бюджет времени (Claude Desktop ждёт ответ около минуты).
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
  });
}

export async function guard(fn, prefix) {
  try {
    return await fn();
  } catch (err) {
    throw toToolError(err, prefix);
  }
}
