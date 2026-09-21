// Текст сообщения от модели → строка и сущности Telegram (с учётом режима разметки),
// разбиение длинных текстов на части по 4096 символов.

import { ToolError } from '../mcp.js';
import { Api, HTMLParser, utils } from './lib.js';
import { parseMarkdown } from './markdown.js';
import { cachedInputPeer, inputEntityById } from './peers.js';

export const MESSAGE_LIMIT = 4096;
export const CAPTION_LIMIT = 1024;

function cloneEntity(e, patch) {
  return Object.assign(Object.create(Object.getPrototypeOf(e)), e, patch);
}

// Как stripEntities в markdown.js, но для объектов TL (сохраняет их класс).
export function stripTl(text, entities) {
  const lead = text.length - text.trimStart().length;
  const trimmed = text.trim();
  const out = [];
  for (const e of entities) {
    const start = Math.max(0, e.offset - lead);
    const end = Math.min(trimmed.length, e.offset - lead + e.length);
    if (end > start) out.push(cloneEntity(e, { offset: start, length: end - start }));
  }
  return [trimmed, out];
}

// Упоминание [имя](tg://user?id=…) при отправке требует InputUser.
async function mentionEntity(acc, offset, length, userId) {
  try {
    const input = cachedInputPeer(acc, String(userId)) ?? (await inputEntityById(acc, userId));
    if (!input) return null;
    return new Api.InputMessageEntityMentionName({ offset, length, userId: utils.getInputUser(input) });
  } catch {
    return null; // пользователь неизвестен аккаунту — останется просто текст
  }
}

// Описания из parseMarkdown → объекты MessageEntity.
export async function toTlEntities(acc, descriptors) {
  const out = [];
  for (const d of descriptors) {
    const base = { offset: d.offset, length: d.length };
    switch (d.type) {
      case 'bold':
        out.push(new Api.MessageEntityBold(base));
        break;
      case 'italic':
        out.push(new Api.MessageEntityItalic(base));
        break;
      case 'underline':
        out.push(new Api.MessageEntityUnderline(base));
        break;
      case 'strike':
        out.push(new Api.MessageEntityStrike(base));
        break;
      case 'spoiler':
        out.push(new Api.MessageEntitySpoiler(base));
        break;
      case 'code':
        out.push(new Api.MessageEntityCode(base));
        break;
      case 'pre':
        out.push(new Api.MessageEntityPre({ ...base, language: d.language ?? '' }));
        break;
      case 'text_url':
        out.push(new Api.MessageEntityTextUrl({ ...base, url: d.url }));
        break;
      case 'blockquote':
        out.push(new Api.MessageEntityBlockquote(base));
        break;
      case 'mention_name': {
        const e = acc ? await mentionEntity(acc, d.offset, d.length, d.userId) : null;
        if (e) out.push(e);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

// HTML: <tg-spoiler> как в Bot API; ссылки tg://user?id= — в упоминания для отправки.
async function htmlEntities(acc, input) {
  const html = input
    .replace(/<tg-spoiler>/gi, '<spoiler>')
    .replace(/<\/tg-spoiler>/gi, '</spoiler>')
    .replace(/<span\s+class=["']tg-spoiler["']\s*>([\s\S]*?)<\/span>/gi, '<spoiler>$1</spoiler>');
  const [text, entities] = HTMLParser.parse(html);
  const out = [];
  for (const e of entities ?? []) {
    const m = e instanceof Api.MessageEntityTextUrl ? e.url.match(/^tg:\/\/user\?id=(\d+)$/i) : null;
    if (e instanceof Api.MessageEntityMentionName || m) {
      const mention = acc ? await mentionEntity(acc, e.offset, e.length, m ? m[1] : e.userId) : null;
      if (mention) out.push(mention);
    } else {
      out.push(e);
    }
  }
  return stripTl(text ?? '', out);
}

// → [текст, сущности]
export async function buildText(acc, text, mode = 'markdown') {
  const input = String(text ?? '');
  if (mode === 'plain') return [input.trim(), []];
  if (mode === 'html') return htmlEntities(acc, input);
  const parsed = parseMarkdown(input);
  return [parsed.text, await toTlEntities(acc, parsed.entities)];
}

const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;

// Длинный текст → части не длиннее limit: режем по переносу строки или пробелу
// во второй половине части и никогда — посреди эмодзи (суррогатной пары).
export function splitMessage(text, entities, limit = MESSAGE_LIMIT) {
  if (text.length <= limit) return [[text, entities]];
  const parts = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + limit, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end - 1);
      const sp = text.lastIndexOf(' ', end - 1);
      if (nl > offset + limit / 2) end = nl + 1;
      else if (sp > offset + limit / 2) end = sp + 1;
      if (isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
    }
    const chunk = text.slice(offset, end);
    const chunkEntities = [];
    for (const e of entities) {
      const start = Math.max(e.offset, offset);
      const stop = Math.min(e.offset + e.length, end);
      if (stop > start) chunkEntities.push(cloneEntity(e, { offset: start - offset, length: stop - start }));
    }
    const [t, es] = stripTl(chunk, chunkEntities);
    if (t) parts.push([t, es]);
    offset = end;
  }
  return parts;
}

export function checkCaption(acc, text) {
  const limit = acc.me?.premium ? MESSAGE_LIMIT : CAPTION_LIMIT;
  if (text.length > limit) {
    throw new ToolError(
      `The caption is ${text.length} characters; Telegram allows ${limit}. Send a shorter caption and put the rest into a separate message.`,
    );
  }
}
