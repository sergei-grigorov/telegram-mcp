// Схема Telegram API (TL) для прямых вызовов: поиск методов, описание
// параметров, JSON → объекты TL и обратно.

import { ToolError } from '../mcp.js';
import { Api, bigInt, definitions, utils } from './lib.js';

const functions = new Map();
const constructors = new Map();
const byResult = new Map();

for (const d of definitions) {
  const full = d.namespace ? `${d.namespace}.${d.name}` : d.name;
  d.fullName = full;
  if (d.isFunction) functions.set(full.toLowerCase(), d);
  else {
    constructors.set(full.toLowerCase(), d);
    if (!byResult.has(d.result)) byResult.set(d.result, []);
    byResult.get(d.result).push(d);
  }
}

export const snake = (s) => s.replace(/([A-Z])/g, (m) => `_${m.toLowerCase()}`);
export const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

// Имя метода в любом виде: messages.getHistory, messages.GetHistory, messages_getHistory.
export function findMethod(name) {
  const key = String(name).trim().replace(/^Api\./i, '').replace(/_/g, '.').toLowerCase();
  return functions.get(key) ?? null;
}

export function findConstructor(name) {
  const key = String(name).trim().replace(/^Api\./i, '').toLowerCase();
  return constructors.get(key) ?? null;
}

function classFor(d) {
  return d.namespace ? Api[d.namespace][d.name] : Api[d.name];
}

function argType(a) {
  return a.isVector ? `Vector<${a.type}>` : a.type;
}

function realArgs(d) {
  return Object.entries(d.argsConfig).filter(([, a]) => !a.flagIndicator);
}

const lcfirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

// Имя как в документации Telegram: messages.getHistory, inputPeerUser.
export function tlName(d) {
  return d.namespace ? `${d.namespace}.${lcfirst(d.name)}` : lcfirst(d.name);
}

export function describeDefinition(d) {
  return {
    [d.isFunction ? 'method' : 'constructor']: tlName(d),
    returns: d.result,
    params: realArgs(d).map(([name, a]) => ({ name: snake(name), type: argType(a), optional: a.isFlag || undefined })),
  };
}

export function constructorsOf(type) {
  return (byResult.get(type) ?? []).map(describeDefinition);
}

export function searchSchema(query, limit = 40) {
  const q = String(query).toLowerCase().replace(/_/g, '');
  const hit = (d) => d.fullName.toLowerCase().includes(q);
  const methods = [...functions.values()].filter(hit).slice(0, limit).map(tlName);
  const types = [...constructors.values()].filter(hit).slice(0, limit).map((d) => `${tlName(d)} → ${d.result}`);
  return { methods, constructors: types };
}

// Методы, которые не вызываются никогда, даже при включённых прямых вызовах:
// вход и выход (в том числе подтверждение чужого входа по QR — угон аккаунта),
// пароль, удаление аккаунта, передача прав владельца, платежи, Telegram Passport.
const BLOCKED = [
  /^auth\./,
  /passkey/i,
  /^Invoke/, // обёртки вроде InvokeWithTakeout протащили бы любой метод мимо проверок
  /^updates\./, // разность обновлений отдала бы сообщения из скрытых и служебного чатов
  /^account\.(registerDevice|unregisterDevice|setAccountTTL|updateConnectedBot|confirmBotConnection|toggleConnectedBotPaused|disablePeerConnectedBot|updateDeviceLocked)$/i,
  /^bots\.(createBot|exportBotToken)$/i,
  /^contacts\.getLocated$/i,
  /^help\.acceptTermsOfService$/i,
  /^account\.(deleteAccount|resetPassword|updatePasswordSettings|getPasswordSettings|confirmPasswordEmail|resendPasswordEmail|cancelPasswordEmail|declinePasswordReset|changePhone|sendChangePhoneCode|sendConfirmPhoneCode|confirmPhone|resetAuthorization|resetWebAuthorization|resetWebAuthorizations|acceptAuthorization|getAuthorizationForm|getAllSecureValues|getSecureValue|saveSecureValue|deleteSecureValue|sendVerifyEmailCode|verifyEmail|initTakeoutSession|finishTakeoutSession|setAuthorizationTTL|changeAuthorizationSettings|invalidateSignInCodes)$/i,
  /^(channels\.editCreator|messages\.editChatCreator)$/i,
  /^messages\.(acceptUrlAuth|requestUrlAuth|sendPaidReaction|requestWebView|requestSimpleWebView|requestAppWebView|requestMainWebView|prolongWebView|sendWebViewData|sendWebViewResultMessage)$/i,
  /^payments\.(?!get)/i,
  /^premium\.(?!get)/i,
  /^fragment\./i,
  /^smsjobs\./i,
  /^bots\.(invokeWebViewCustomMethod|sendCustomRequest)$/i,
  /^account\.(toggleNoPaidMessagesException|sendVerifyPhoneCode|verifyPhone)$/i,
  /^contacts\.(getContactIDs|getSaved)$/i, // все контакты разом, мимо «Скрытых чатов»
];

// Номера сообщений в личных чатах и обычных группах сквозные для всего аккаунта:
// эти методы без чата затронули бы и скрытые чаты. Для них есть свои инструменты.
const USE_TOOL = {
  'messages.DeleteMessages': 'delete_messages',
  'messages.ReadMessageContents': 'mark_as_read',
  'messages.ForwardMessages': 'forward_messages',
};

export function blockedReason(d) {
  if (!d.namespace) return `${tlName(d)} is a low-level MTProto service method and is never available through the connector.`;
  if (USE_TOOL[d.fullName]) {
    return `${tlName(d)} is not available through send_api_request: message numbers in private chats and basic groups are shared by the whole account, so it could reach hidden chats. Use ${USE_TOOL[d.fullName]} instead.`;
  }
  // Всё, что обязательно требует облачного пароля (InputCheckPasswordSRP), — тоже.
  const needsPassword = Object.values(d.argsConfig).some((a) => a.type === 'InputCheckPasswordSRP' && !a.isFlag);
  if (needsPassword || BLOCKED.some((re) => re.test(d.fullName))) {
    return `${tlName(d)} is never available through the connector (login and account security, passkeys, push devices, connected business bots, account self-destruct, account deletion, ownership transfer, payments, web logins, Passport, raw update streams, bulk contact lists).`;
  }
  return null;
}

// Удаление и выход через прямые вызовы требуют ещё и разрешения на удаление.
export function extraCapabilities(d) {
  const method = d.name;
  if (/^(Delete|Clear|Leave)/.test(method) || /^(SetHistoryTTL|SetDefaultHistoryTTL|ResetSaved|DeleteByPhones)$/.test(method)) return ['delete'];
  return [];
}

// Конструкторы, которые тратят деньги или ставки, — никогда.
const BLOCKED_CONSTRUCTORS = /^(InputMediaStakeDice|InputInvoice\w*|InputStorePaymentStars\w*|InputStorePaymentStarsGift\w*|SuggestedPost)$/;

// Пиры, заданные объектом (inputPeerUser и т. п.), тоже проверяются по спискам чатов.
const PEER_CONSTRUCTORS = new Set(['InputPeerUser', 'InputPeerChat', 'InputPeerChannel', 'InputUser', 'InputChannel', 'InputPeerUserFromMessage', 'InputPeerChannelFromMessage', 'InputUserFromMessage', 'InputChannelFromMessage']);

function markedFromObject(obj) {
  if (obj.userId !== undefined && !obj.userId?.className) return String(obj.userId);
  if (obj.chatId !== undefined) return `-${obj.chatId}`;
  if (obj.channelId !== undefined) return `-100${obj.channelId}`;
  return null;
}

const PEER_TYPES = new Set(['InputPeer', 'InputUser', 'InputChannel', 'InputDialogPeer', 'InputNotifyPeer']);

function toBytes(v, path) {
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  if (v && typeof v === 'object') {
    if (typeof v._bytes === 'string') return Buffer.from(v._bytes, 'base64');
    if (typeof v.base64 === 'string') return Buffer.from(v.base64, 'base64');
    if (typeof v.hex === 'string') return Buffer.from(v.hex, 'hex');
  }
  if (Array.isArray(v) && v.every((x) => Number.isInteger(x) && x >= 0 && x < 256)) return Buffer.from(v);
  throw new ToolError(`${path}: expected bytes (a UTF-8 string, {"_bytes": base64} or {"hex": …})`);
}

function toLong(v, path) {
  if (bigInt.isInstance(v)) return v;
  if (typeof v === 'number' && Number.isInteger(v)) return bigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return bigInt(v.trim());
  throw new ToolError(`${path}: expected an integer (long); pass big values as strings`);
}

function toInt(v, path) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return Math.trunc(Date.parse(v) / 1000);
  throw new ToolError(`${path}: expected an integer (dates may be ISO strings)`);
}

async function convertPeer(ctx, value, type, path) {
  const r = await ctx.resolvePeer(value, path);
  const input = r.input;
  switch (type) {
    case 'InputPeer':
      return input;
    case 'InputUser':
      return utils.getInputUser(input);
    case 'InputChannel':
      return utils.getInputChannel(input);
    case 'InputDialogPeer':
      return new Api.InputDialogPeer({ peer: input });
    case 'InputNotifyPeer':
      return new Api.InputNotifyPeer({ peer: input });
    default:
      return input;
  }
}

// Значение из JSON → значение нужного типа TL.
export async function fromJson(value, a, ctx, path) {
  if (a.isVector) {
    const list = Array.isArray(value) ? value : [value];
    const out = [];
    for (let i = 0; i < list.length; i++) out.push(await fromJson(list[i], { ...a, isVector: false }, ctx, `${path}[${i}]`));
    return out;
  }
  const type = a.type;
  switch (type) {
    case 'int':
      return toInt(value, path);
    case 'long':
    case 'int128':
    case 'int256':
      return toLong(value, path);
    case 'double':
      if (typeof value === 'number') return value;
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
      throw new ToolError(`${path}: expected a number`);
    case 'string':
      if (typeof value === 'string') return value;
      if (typeof value === 'number') return String(value);
      throw new ToolError(`${path}: expected a string`);
    case 'bytes':
      return toBytes(value, path);
    case 'true':
    case 'Bool':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      throw new ToolError(`${path}: expected true or false`);
    case 'X':
      throw new ToolError(`${path}: generic wrapper methods are not supported; call the inner method directly`);
    default:
      break;
  }
  if (type === 'InputCheckPasswordSRP') throw new ToolError(`${path}: actions confirmed with the cloud password are never available through the connector`);
  if (PEER_TYPES.has(type) && (typeof value === 'string' || typeof value === 'number')) return convertPeer(ctx, value, type, path);
  if (type === 'InputMessage' && typeof value === 'number') return new Api.InputMessageID({ id: value });
  if (type === 'InputStickerSet' && typeof value === 'string') return new Api.InputStickerSetShortName({ shortName: value });
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const name = value._ ?? value['@type'] ?? value.className;
    if (typeof name !== 'string') {
      const options = (byResult.get(type) ?? []).map((d) => d.fullName).slice(0, 15);
      throw new ToolError(`${path}: an object of type ${type} needs "_" with the constructor name${options.length ? ` (one of: ${options.join(', ')})` : ''}`);
    }
    const d = findConstructor(name);
    if (!d) throw new ToolError(`${path}: unknown constructor ${name}`);
    if (d.result !== type) throw new ToolError(`${path}: ${d.fullName} is a ${d.result}, but ${type} is expected`);
    return buildObject(d, value, ctx, path);
  }
  throw new ToolError(`${path}: expected ${type}`);
}

// Аргументы метода/конструктора из JSON (snake_case или camelCase).
export async function buildArgs(d, params, ctx, path = 'params') {
  const cfg = Object.fromEntries(realArgs(d));
  const out = {};
  const seen = new Set();
  for (const [rawKey, value] of Object.entries(params ?? {})) {
    if (rawKey === '_' || rawKey === '@type' || rawKey === 'className') continue;
    const key = cfg[rawKey] ? rawKey : camel(rawKey);
    const a = cfg[key];
    if (!a) {
      throw new ToolError(`${path}: unknown parameter "${rawKey}" for ${d.fullName}. Parameters: ${Object.keys(cfg).map(snake).join(', ') || 'none'}`);
    }
    seen.add(key);
    if (value === null || value === undefined) continue;
    if (a.type === 'true' && value === false) continue;
    out[key] = await fromJson(value, a, ctx, `${path}.${snake(key)}`);
  }
  const missing = [];
  for (const [key, a] of Object.entries(cfg)) {
    if (a.isFlag || seen.has(key) || key === 'randomId') continue;
    // Служебные числовые параметры (hash, смещения) по умолчанию нулевые.
    if (/^(hash|offset\w*|addOffset|maxId|minId|maxDate|minDate)$/.test(key) && !a.isVector) {
      if (a.type === 'long') out[key] = bigInt.zero;
      else if (a.type === 'int') out[key] = 0;
      else if (a.type === 'InputPeer') out[key] = new Api.InputPeerEmpty();
      else if (a.type === 'string') out[key] = '';
      if (out[key] !== undefined) continue;
    }
    missing.push(`${snake(key)}: ${argType(a)}`);
  }
  if (missing.length) throw new ToolError(`${path}: missing required parameter(s) of ${d.fullName}: ${missing.join(', ')}`);
  return out;
}

async function buildObject(d, value, ctx, path) {
  if (BLOCKED_CONSTRUCTORS.test(d.name)) throw new ToolError(`${path}: ${tlName(d)} spends money and is never available through the connector`);
  const Cls = classFor(d);
  const obj = new Cls(await buildArgs(d, value, ctx, path));
  if (PEER_CONSTRUCTORS.has(d.name)) {
    const id = markedFromObject(obj);
    if (id) ctx.checkPeerId?.(id, path);
  }
  // «Я сам» — это «Избранное», оно тоже может быть закрыто списками чатов.
  if ((d.name === 'InputPeerSelf' || d.name === 'InputUserSelf') && ctx.selfId) ctx.checkPeerId?.(ctx.selfId, path);
  return obj;
}

// Обычные группы в старых методах задаются голым числом, а не пиром.
function checkIdArgs(d, args, ctx) {
  for (const [key, a] of realArgs(d)) {
    if (a.type !== 'long' || args[key] === undefined) continue;
    let mark = null;
    if (key === 'chatId' || (d.fullName === 'messages.GetChats' && key === 'id')) mark = (v) => `-${v}`;
    else if (d.fullName === 'contacts.EditCloseFriends' && key === 'id') mark = (v) => String(v);
    if (!mark) continue;
    for (const v of [].concat(args[key])) ctx.checkPeerId?.(mark(v), `params.${snake(key)}`);
  }
}

export async function buildRequest(method, params, ctx) {
  const d = findMethod(method);
  if (!d) {
    const s = searchSchema(String(method).split('.').pop());
    throw new ToolError(`Unknown method ${method}.${s.methods.length ? ` Similar: ${s.methods.slice(0, 10).join(', ')}` : ''} Find the name with search_api_methods.`);
  }
  const blocked = blockedReason(d);
  if (blocked) throw new ToolError(blocked);
  if (params && Object.keys(params).some((k) => /^allow_?paid_?stars$/i.test(k) && params[k])) {
    throw new ToolError('Requests that spend Telegram Stars are not allowed.');
  }
  const Cls = classFor(d);
  const args = await buildArgs(d, params, ctx);
  checkIdArgs(d, args, ctx);
  return { request: new Cls(args), definition: d };
}

// ───────────── Фильтр ответа ─────────────

// id чата в формате Bot API по Peer/InputPeer/InputUser/InputChannel и обёрткам с полем peer.
export function peerIdOf(p) {
  if (!p || typeof p !== 'object') return null;
  if (p instanceof Api.PeerUser || p instanceof Api.InputPeerUser || p instanceof Api.InputUser || p instanceof Api.InputPeerUserFromMessage || p instanceof Api.InputUserFromMessage) {
    return String(p.userId);
  }
  if (p instanceof Api.PeerChat || p instanceof Api.InputPeerChat) return `-${p.chatId}`;
  if (p instanceof Api.PeerChannel || p instanceof Api.InputPeerChannel || p instanceof Api.InputChannel || p instanceof Api.InputPeerChannelFromMessage || p instanceof Api.InputChannelFromMessage) {
    return `-100${p.channelId}`;
  }
  const wrappers = [Api.DialogPeer, Api.InputDialogPeer, Api.NotifyPeer, Api.InputNotifyPeer, Api.NotifyForumTopic, Api.InputNotifyForumTopic, Api.StarsTransactionPeer];
  if (wrappers.some((cls) => cls && p instanceof cls)) return peerIdOf(p.peer);
  return null;
}

function isBarePeer(p) {
  return peerIdOf(p) !== null && !('peer' in p);
}

// Пользователь или чат (записи users/chats) и их полные сведения.
function entityIdOf(e) {
  if (e instanceof Api.User || e instanceof Api.UserEmpty || e instanceof Api.UserFull) return String(e.id);
  if (e instanceof Api.Chat || e instanceof Api.ChatForbidden || e instanceof Api.ChatEmpty || e instanceof Api.ChatFull) return `-${e.id}`;
  if (e instanceof Api.Channel || e instanceof Api.ChannelForbidden || e instanceof Api.ChannelFull) return `-100${e.id}`;
  return null;
}

const isFull = (e) => e instanceof Api.UserFull || e instanceof Api.ChatFull || e instanceof Api.ChannelFull;

// Контакты перечисляются по id пользователя, без поля peer.
const CONTACT_KEYS = { Contact: 'userId', ContactStatus: 'userId', ContactBirthday: 'contactId', ImportedContact: 'userId' };

// Поля с id пользователей внутри показываемого содержимого: авторы, пригласившие,
// администраторы, боты. Их записи в users остаются в ответе.
const USER_REF_KEYS = ['userId', 'inviterId', 'promotedBy', 'kickedBy', 'approvedBy', 'actorId', 'adminId', 'viaBotId', 'viaBusinessBotId', 'botId', 'newCreatorId', 'fromId', 'receiverId', 'requestedBy'];

// К какому чату относится объект: поле peer/peerId (сообщения, диалоги,
// черновики, истории, реакции…), у обновлений без него — чат вложенного
// сообщения или channelId/chatId/userId, у контактов — сам пользователь.
function scopeOf(obj) {
  for (const key of ['peer', 'peerId']) {
    const id = peerIdOf(obj[key]);
    if (id) return id;
  }
  const name = obj.className ?? '';
  if (/^Update[A-Z]/.test(name)) {
    // Новое, изменённое, отложенное сообщение — по чату сообщения.
    const inner = obj.message && typeof obj.message === 'object' ? peerIdOf(obj.message.peerId) : null;
    if (inner) return inner;
    if (bigInt.isInstance(obj.channelId)) return `-100${obj.channelId}`;
    if (bigInt.isInstance(obj.chatId)) return `-${obj.chatId}`;
    if (bigInt.isInstance(obj.userId)) return String(obj.userId);
  }
  const key = CONTACT_KEYS[name];
  if (key && bigInt.isInstance(obj[key])) return String(obj[key]);
  return null;
}

const opaque = (v) => !v || typeof v !== 'object' || Buffer.isBuffer(v) || v instanceof Uint8Array || bigInt.isInstance(v);

// Убирает из ответа прямого вызова всё, что относится к скрытым и служебному
// чатам, а при списке «Только эти чаты» — ко всем чатам вне его:
//  • объекты, привязанные к чату (сообщения, диалоги, обновления, контакты…);
//  • пиры в списках (результаты поиска, папки);
//  • записи пользователей и чатов (users/chats), если чат не виден и на него
//    не ссылается оставшееся содержимое (автор сообщения в видимой группе
//    остаётся, если он не в «Скрытых чатах»).
// visible(id) — чат виден; hidden(id) — чат явно скрыт (служебный или в
// «Скрытых чатах»); selfId — свой аккаунт (его запись остаётся всегда).
// Каждый объект обходится один раз: у объектов TL есть originalArgs с теми же
// детьми, и наивный обход рос бы экспоненциально.
export function scrubResponse(value, { visible, hidden = () => false, selfId } = {}) {
  const refs = new Set();
  const keepFull = (e) => {
    const id = entityIdOf(e);
    return id === selfId || visible(id);
  };
  const keepEntity = (e) => {
    const id = entityIdOf(e);
    return id === selfId || visible(id) || (refs.has(id) && !hidden(id));
  };
  const dropped = (obj, inList) => {
    if (opaque(obj) || !obj.className) return false;
    const scope = scopeOf(obj);
    if (scope) return !visible(scope);
    if (isFull(obj)) return !keepFull(obj);
    return inList && isBarePeer(obj) && !visible(peerIdOf(obj));
  };
  const isEntity = (v) => !opaque(v) && entityIdOf(v) !== null && !isFull(v);

  // Проход 1: убрать привязанное к закрытым чатам, собрать ссылки из оставшегося.
  const seen = new WeakSet();
  const collect = (obj) => {
    const own = peerIdOf(obj);
    if (own) refs.add(own);
    for (const key of USER_REF_KEYS) if (bigInt.isInstance(obj[key])) refs.add(String(obj[key]));
    if (Array.isArray(obj.users)) for (const u of obj.users) if (bigInt.isInstance(u)) refs.add(String(u));
  };
  const walk = (v, depth) => {
    if (opaque(v) || seen.has(v) || depth > 60) return v;
    seen.add(v);
    if (Array.isArray(v)) return v.filter((x) => !dropped(x, true)).map((x) => walk(x, depth + 1));
    if (isEntity(v)) return v; // решается во втором проходе
    collect(v);
    for (const k of Object.keys(v)) {
      if (SKIP.has(k) || k.startsWith('_') || opaque(v[k])) continue;
      v[k] = dropped(v[k], false) ? null : walk(v[k], depth + 1);
    }
    return v;
  };

  // Проход 2: записи пользователей и чатов.
  const seen2 = new WeakSet();
  const prune = (v, depth) => {
    if (opaque(v) || seen2.has(v) || depth > 60) return v;
    seen2.add(v);
    if (Array.isArray(v)) return v.filter((x) => !isEntity(x) || keepEntity(x)).map((x) => prune(x, depth + 1));
    if (isEntity(v)) return v;
    for (const k of Object.keys(v)) {
      if (SKIP.has(k) || k.startsWith('_') || opaque(v[k])) continue;
      v[k] = isEntity(v[k]) && !keepEntity(v[k]) ? null : prune(v[k], depth + 1);
    }
    return v;
  };

  if (dropped(value, false)) return null;
  const out = walk(value, 0);
  if (isEntity(out)) return keepEntity(out) ? out : null;
  return prune(out, 0);
}

// ───────────── TL → JSON ─────────────

const SKIP = new Set(['CONSTRUCTOR_ID', 'SUBCLASS_OF_ID', 'className', 'classType', 'originalArgs', 'flags', 'flags2']);

export function toJson(value, { maxBytes = 512, maxItems = 300, depth = 0 } = {}) {
  const opts = { maxBytes, maxItems, depth: depth + 1 };
  if (value === null || value === undefined) return null;
  if (bigInt.isInstance(value) || typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const buf = Buffer.from(value);
    if (buf.length <= maxBytes) return { _bytes: buf.toString('base64') };
    return { _bytes: buf.subarray(0, maxBytes).toString('base64'), _bytes_total: buf.length, _truncated: true };
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, maxItems).map((v) => toJson(v, opts));
    if (value.length > maxItems) items.push(`… ${value.length - maxItems} more`);
    return items;
  }
  if (typeof value === 'object') {
    if (depth > 25) return '…';
    const out = {};
    if (value.className) out._ = value.className;
    for (const [k, v] of Object.entries(value)) {
      if (SKIP.has(k) || k.startsWith('_') || typeof v === 'function') continue;
      if (v === undefined || v === null || v === false) continue;
      out[k] = toJson(v, opts);
    }
    return out;
  }
  return value;
}
