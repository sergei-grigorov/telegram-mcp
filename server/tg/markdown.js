// Markdown ⇄ текст с сущностями Telegram (MessageEntity).
//
// Разметка при отправке — то, что обычно пишет модель:
//   **жирный**, *курсив* или _курсив_, __подчёркнутый__, ~~зачёркнутый~~,
//   ||спойлер||, `код`, ```язык\nблок кода```, [текст](https://…),
//   [имя](tg://user?id=123) — упоминание, строки «> …» — цитата,
//   «# Заголовок» — жирная строка, \* — экранирование.
// Встроенные в teleproto парсеры для этого не годятся: они не понимают
// одиночные звёздочки, не экранируют и превращают «-текст-» в курсив.
//
// Смещения сущностей считаются в UTF-16, как и длина строк в JS.

const CLASS_TO_TYPE = {
  MessageEntityBold: 'bold',
  MessageEntityItalic: 'italic',
  MessageEntityUnderline: 'underline',
  MessageEntityStrike: 'strike',
  MessageEntitySpoiler: 'spoiler',
  MessageEntityCode: 'code',
  MessageEntityPre: 'pre',
  MessageEntityTextUrl: 'text_url',
  MessageEntityMentionName: 'mention_name',
  InputMessageEntityMentionName: 'mention_name',
  MessageEntityBlockquote: 'blockquote',
  MessageEntityCustomEmoji: 'custom_emoji',
  MessageEntityFormattedDate: 'formatted_date',
};

const DELIM_TYPES = { '**': 'bold', '*': 'italic', _: 'italic', __: 'underline', '~~': 'strike', '||': 'spoiler' };

const isSpace = (c) => c === undefined || /\s/u.test(c);
const isPunct = (c) => c !== undefined && /[\p{P}\p{S}]/u.test(c);
const isEscapable = (c) => c !== undefined && /[!-/:-@[-`{-~]/.test(c);

// Правила «прилегания» разделителей по CommonMark, упрощённо: «2 * 3 * 4» и
// snake_case_имена не превращаются в курсив.
function flanking(prev, next) {
  const left = !isSpace(next) && !(isPunct(next) && !isSpace(prev) && !isPunct(prev));
  const right = !isSpace(prev) && !(isPunct(prev) && !isSpace(next) && !isPunct(next));
  return { left, right };
}

// Ищет «](url)» для «[» в позиции start. Возвращает { textEnd, url, end } или null.
function scanLink(s, start) {
  let depth = 0;
  let i = start;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '`') {
      const run = s.slice(i).match(/^`+/)[0];
      const close = s.indexOf(run, i + run.length);
      if (close > 0) i = close + run.length - 1;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) break;
    } else if (c === '\n' && s[i + 1] === '\n') return null;
  }
  if (depth !== 0 || s[i + 1] !== '(') return null;
  const textEnd = i;
  let j = i + 2;
  let parens = 0;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '(') parens++;
    else if (c === ')') {
      if (parens === 0) break;
      parens--;
    } else if (c === '\n') return null;
  }
  if (j >= s.length) return null;
  let url = s.slice(textEnd + 2, j).trim();
  // [текст](url "заголовок") — заголовок отбрасываем
  url = url.replace(/\s+"[^"]*"$/, '').replace(/^<(.*)>$/, '$1');
  if (!url || /\s/.test(url)) return null;
  return { textEnd, url, end: j + 1 };
}

// Разбор строки на токены: text, code, delim, link.
function tokenize(s) {
  const tokens = [];
  let buf = '';
  const flush = () => {
    if (buf) tokens.push({ kind: 'text', value: buf });
    buf = '';
  };
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === '\\' && isEscapable(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const run = s.slice(i).match(/^`+/)[0];
      const close = s.indexOf(run, i + run.length);
      if (close > i && !(run.length < 3 && s.slice(i + run.length, close).includes('\n\n'))) {
        let value = s.slice(i + run.length, close);
        flush();
        if (run.length >= 3) {
          let language = '';
          const m = value.match(/^([\w+#.-]+)\n/);
          if (m) {
            language = m[1];
            value = value.slice(m[0].length);
          } else if (value.startsWith('\n')) value = value.slice(1);
          if (value.endsWith('\n')) value = value.slice(0, -1);
          tokens.push({ kind: 'code', type: 'pre', value, language });
        } else {
          if (value.length > 2 && value.startsWith(' ') && value.endsWith(' ') && value.trim()) value = value.slice(1, -1);
          tokens.push({ kind: 'code', type: 'code', value });
        }
        i = close + run.length;
        continue;
      }
      buf += run;
      i += run.length;
      continue;
    }
    if (c === '[') {
      const link = scanLink(s, i);
      if (link) {
        flush();
        tokens.push({ kind: 'link', url: link.url, children: tokenize(s.slice(i + 1, link.textEnd)) });
        i = link.end;
        continue;
      }
    }
    if (c === '*' || c === '_' || c === '~' || c === '|') {
      const run = s.slice(i).match(c === '*' ? /^\*+/ : c === '_' ? /^_+/ : c === '~' ? /^~+/ : /^\|+/)[0];
      const prev = s[i - 1];
      const next = s[i + run.length];
      const { left, right } = flanking(prev, next);
      let canOpen = left;
      let canClose = right;
      if (c === '_') {
        canOpen = left && (!right || isPunct(prev));
        canClose = right && (!left || isPunct(next));
      }
      let parts;
      if (c === '~' || c === '|') parts = run.length === 2 ? [run] : null;
      else if (run.length === 1 || run.length === 2) parts = [run];
      else if (run.length === 3) parts = canClose && !canOpen ? [c, c + c] : [c + c, c];
      else parts = null;
      if (!parts || (!canOpen && !canClose)) {
        buf += run;
        i += run.length;
        continue;
      }
      flush();
      for (const marker of parts) tokens.push({ kind: 'delim', marker, canOpen, canClose });
      i += run.length;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  return tokens;
}

// Пары разделителей: открывающий получает ссылку на закрывающий.
function matchDelimiters(tokens) {
  const stack = [];
  tokens.forEach((t, idx) => {
    if (t.kind !== 'delim') return;
    if (t.canClose) {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (tokens[stack[k]].marker === t.marker) {
          tokens[stack[k]].pair = idx;
          t.closes = true;
          stack.length = k;
          return;
        }
      }
    }
    if (t.canOpen) stack.push(idx);
  });
}

function emitInline(tokens, out) {
  matchDelimiters(tokens);
  const open = new Map();
  tokens.forEach((t, idx) => {
    if (t.kind === 'text') {
      out.text += t.value;
    } else if (t.kind === 'code') {
      const offset = out.text.length;
      out.text += t.value;
      if (t.value.length) {
        const e = { type: t.type, offset, length: t.value.length };
        if (t.type === 'pre') e.language = t.language;
        out.entities.push(e);
      }
    } else if (t.kind === 'link') {
      const offset = out.text.length;
      emitInline(t.children, out);
      const length = out.text.length - offset;
      if (length > 0) {
        const m = t.url.match(/^tg:\/\/user\?id=(\d+)$/i);
        out.entities.push(m ? { type: 'mention_name', offset, length, userId: m[1] } : { type: 'text_url', offset, length, url: t.url });
      }
    } else if (t.pair !== undefined) {
      open.set(t.pair, out.text.length);
    } else if (t.closes && open.has(idx)) {
      const offset = open.get(idx);
      const length = out.text.length - offset;
      if (length > 0) out.entities.push({ type: DELIM_TYPES[t.marker], offset, length });
    } else {
      out.text += t.marker;
    }
  });
}

function parseInline(s, out) {
  emitInline(tokenize(s), out);
}

// Убирает пробелы по краям текста и поправляет сущности (Telegram их обрезает сам).
export function stripEntities(text, entities) {
  const lead = text.length - text.trimStart().length;
  const trimmed = text.trim();
  const out = [];
  for (const e of entities) {
    let start = e.offset - lead;
    let end = start + e.length;
    start = Math.max(0, start);
    end = Math.min(trimmed.length, end);
    if (end > start) out.push({ ...e, offset: start, length: end - start });
  }
  return { text: trimmed, entities: out };
}

export function parseMarkdown(input) {
  const out = { text: '', entities: [] };
  const lines = String(input ?? '').replace(/\r\n?/g, '\n').split('\n');
  let para = [];
  const flushPara = () => {
    if (!para.length) return;
    parseInline(para.join('\n'), out);
    para = [];
  };
  const newline = () => {
    out.text += '\n';
  };
  let first = true;
  const startBlock = () => {
    if (!first) newline();
    first = false;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s{0,3}```([\w+#.-]*)\s*$/);
    if (fence) {
      let end = i + 1;
      while (end < lines.length && !/^\s{0,3}```\s*$/.test(lines[end])) end++;
      if (end < lines.length) {
        flushPara();
        startBlock();
        const value = lines.slice(i + 1, end).join('\n');
        const offset = out.text.length;
        out.text += value;
        if (value.length) out.entities.push({ type: 'pre', offset, length: value.length, language: fence[1] || '' });
        i = end;
        continue;
      }
    }
    const quote = line.match(/^\s{0,3}>\s?(.*)$/);
    if (quote) {
      flushPara();
      const inner = [quote[1]];
      while (i + 1 < lines.length && /^\s{0,3}>/.test(lines[i + 1])) inner.push(lines[++i].replace(/^\s{0,3}>\s?/, ''));
      startBlock();
      const offset = out.text.length;
      parseInline(inner.join('\n'), out);
      const length = out.text.length - offset;
      if (length > 0) out.entities.push({ type: 'blockquote', offset, length });
      continue;
    }
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (heading) {
      flushPara();
      startBlock();
      const offset = out.text.length;
      parseInline(heading[1], out);
      const length = out.text.length - offset;
      if (length > 0) out.entities.push({ type: 'bold', offset, length });
      continue;
    }
    if (para.length === 0) startBlock();
    para.push(line);
    // Пустая строка разрывает абзац: разметка не тянется через абзацы.
    if (line.trim() === '') flushPara();
  }
  flushPara();
  out.entities.sort((a, b) => a.offset - b.offset || b.length - a.length);
  return stripEntities(out.text, out.entities);
}

// ───────────── Сущности Telegram → Markdown (для чтения сообщений) ─────────────

function entityType(e) {
  return e.type ?? CLASS_TO_TYPE[e.className] ?? null;
}

const MARKERS = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  underline: ['__', '__'],
  strike: ['~~', '~~'],
  spoiler: ['||', '||'],
  code: ['`', '`'],
};

export function toMarkdown(text, entities) {
  const s = String(text ?? '');
  if (!entities?.length) return s;
  const inserts = [];
  entities.forEach((e, order) => {
    const type = entityType(e);
    const start = e.offset;
    const end = e.offset + e.length;
    if (!type || e.length <= 0 || start < 0 || end > s.length) return;
    if (type === 'blockquote') {
      // «> » в начале каждой строки цитаты; цитата с середины строки — с новой строки.
      const lead = start > 0 && s[start - 1] !== '\n' ? '\n> ' : '> ';
      inserts.push({ pos: start, rank: 1, text: lead, len: e.length, order });
      for (let i = start; i < end - 1; i++) {
        if (s[i] === '\n') inserts.push({ pos: i + 1, rank: 1, text: '> ', len: e.length, order });
      }
      if (end < s.length && s[end] !== '\n' && s[end - 1] !== '\n') inserts.push({ pos: end, rank: 0, text: '\n', len: e.length, order });
      return;
    }
    let pair;
    if (MARKERS[type]) pair = MARKERS[type];
    else if (type === 'pre') pair = [`\`\`\`${e.language ?? ''}\n`, '\n\`\`\`'];
    else if (type === 'text_url') pair = ['[', `](${e.url})`];
    else if (type === 'mention_name') pair = ['[', `](tg://user?id=${String(e.userId?.userId ?? e.userId)})`];
    else return; // custom_emoji, formatted_date и прочие — текст как есть
    inserts.push({ pos: start, rank: 2, text: pair[0], len: e.length, order });
    inserts.push({ pos: end, rank: 0, text: pair[1], len: e.length, order });
  });
  // В одной позиции: сначала закрывающие (внутренние раньше внешних), затем «> »
  // цитат, затем открывающие (внешние раньше внутренних).
  inserts.sort((a, b) => {
    if (a.pos !== b.pos) return a.pos - b.pos;
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.rank === 0) return a.len - b.len || b.order - a.order;
    return b.len - a.len || a.order - b.order;
  });
  let out = '';
  let cursor = 0;
  for (const ins of inserts) {
    out += s.slice(cursor, ins.pos) + ins.text;
    cursor = ins.pos;
  }
  return out + s.slice(cursor);
}
