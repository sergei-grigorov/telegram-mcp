import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseMarkdown, toMarkdown } from '../server/tg/markdown.js';
import { Api } from '../server/tg/lib.js';

const types = (r) => r.entities.map((e) => `${e.type}:${e.offset}+${e.length}`);

test('основная разметка', () => {
  const r = parseMarkdown('**жирный** *курсив* _тоже_ __подчёркнутый__ ~~зачёркнутый~~ ||спойлер|| `код`');
  assert.equal(r.text, 'жирный курсив тоже подчёркнутый зачёркнутый спойлер код');
  assert.deepEqual(types(r), ['bold:0+6', 'italic:7+6', 'italic:14+4', 'underline:19+12', 'strike:32+11', 'spoiler:44+7', 'code:52+3']);
});

test('обычный текст не превращается в разметку', () => {
  for (const s of ['2 * 3 * 4 = 24', 'snake_case_name и file_name.txt', 'a || b', 'цена ~ 100', 'Unclosed **bold', '*', '|table| x |']) {
    const r = parseMarkdown(s);
    assert.equal(r.text, s.trim(), s);
    assert.deepEqual(r.entities, [], s);
  }
});

test('экранирование и вложенность', () => {
  assert.equal(parseMarkdown('\\*не курсив\\*').text, '*не курсив*');
  const r = parseMarkdown('***оба***');
  assert.equal(r.text, 'оба');
  assert.deepEqual(types(r).sort(), ['bold:0+3', 'italic:0+3']);
  const link = parseMarkdown('[**жирная** ссылка](https://ex.com/a_(b)) и [Иван](tg://user?id=42)');
  assert.equal(link.text, 'жирная ссылка и Иван');
  assert.deepEqual(link.entities, [
    { type: 'text_url', offset: 0, length: 13, url: 'https://ex.com/a_(b)' },
    { type: 'bold', offset: 0, length: 6 },
    { type: 'mention_name', offset: 16, length: 4, userId: '42' },
  ]);
});

test('блоки: код с языком, цитата, заголовок; смещения в UTF-16', () => {
  const r = parseMarkdown('# Итог 🎉\n\n> цитата\n> вторая\n\n```js\nconst a = 1;\n```\nконец');
  assert.equal(r.text, 'Итог 🎉\n\nцитата\nвторая\n\nconst a = 1;\nконец');
  assert.deepEqual(types(r), ['bold:0+7', 'blockquote:9+13', 'pre:24+12']);
  assert.equal(r.entities[2].language, 'js');
  const emoji = parseMarkdown('😀 **x**');
  assert.deepEqual(types(emoji), ['bold:3+1']);
});

test('пробелы по краям обрезаются вместе с сущностями', () => {
  const r = parseMarkdown('  **x**  ');
  assert.equal(r.text, 'x');
  assert.deepEqual(types(r), ['bold:0+1']);
});

test('сущности Telegram → Markdown', () => {
  const text = 'Hello bold link quoted\nline code';
  const entities = [
    new Api.MessageEntityBold({ offset: 6, length: 4 }),
    new Api.MessageEntityTextUrl({ offset: 11, length: 4, url: 'https://x.y' }),
    new Api.MessageEntityBlockquote({ offset: 16, length: 11 }),
    new Api.MessageEntityCode({ offset: 28, length: 4 }),
    new Api.MessageEntityMention({ offset: 0, length: 5 }),
  ];
  // Цитата с середины строки начинается с новой строки и заканчивается переносом.
  assert.equal(toMarkdown(text, entities), 'Hello **bold** [link](https://x.y) \n> quoted\n> line\n `code`');
  // Символы \x01 и \x02 в тексте — просто текст, а не служебные метки.
  assert.equal(toMarkdown('a\x01b\x02c', [new Api.MessageEntityBlockquote({ offset: 0, length: 5 })]), '> a\x01b\x02c');
  assert.equal(toMarkdown('plain', []), 'plain');
  const pre = toMarkdown('x = 1', [new Api.MessageEntityPre({ offset: 0, length: 5, language: 'py' })]);
  assert.equal(pre, '```py\nx = 1\n```');
  const mention = toMarkdown('Ann', [new Api.MessageEntityMentionName({ offset: 0, length: 3, userId: 7n })]);
  assert.equal(mention, '[Ann](tg://user?id=7)');
});

test('туда и обратно', () => {
  for (const s of ['**a** *b* __c__ ~~d~~ ||e|| `f`', '[t](https://ex.com) ok', '> q1\n> q2\n\ntext']) {
    const r = parseMarkdown(s);
    assert.equal(toMarkdown(r.text, r.entities), s);
  }
});
