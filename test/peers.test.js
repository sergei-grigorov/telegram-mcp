import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseChatRef } from '../server/tg/peers.js';

test('id, «me», телефон, @username', () => {
  assert.deepEqual(parseChatRef(-1001234567890), { kind: 'id', id: '-1001234567890' });
  assert.deepEqual(parseChatRef('123456'), { kind: 'id', id: '123456' });
  assert.deepEqual(parseChatRef('me'), { kind: 'self' });
  assert.deepEqual(parseChatRef('Избранное'), { kind: 'self' });
  assert.deepEqual(parseChatRef('+7 (999) 123-45-67'), { kind: 'phone', phone: '79991234567' });
  assert.deepEqual(parseChatRef('@Durov'), { kind: 'username', username: 'durov' });
  assert.equal(parseChatRef(''), null);
  assert.equal(parseChatRef(0), null);
});

test('ссылки t.me', () => {
  assert.deepEqual(parseChatRef('https://t.me/durov'), { kind: 'username', username: 'durov' });
  assert.deepEqual(parseChatRef('t.me/durov/42'), { kind: 'username', username: 'durov', messageId: 42 });
  assert.deepEqual(parseChatRef('https://t.me/somegroup/5/77'), { kind: 'username', username: 'somegroup', messageId: 77, topicId: 5 });
  assert.deepEqual(parseChatRef('https://t.me/c/1234567890/456'), { kind: 'id', id: '-1001234567890', messageId: 456 });
  assert.deepEqual(parseChatRef('https://t.me/c/1234567890/3/456'), { kind: 'id', id: '-1001234567890', messageId: 456, topicId: 3 });
  assert.deepEqual(parseChatRef('https://t.me/+AbC_dEf-123'), { kind: 'invite', hash: 'AbC_dEf-123' });
  assert.deepEqual(parseChatRef('https://t.me/joinchat/AbCdEf'), { kind: 'invite', hash: 'AbCdEf' });
  assert.deepEqual(parseChatRef('https://t.me/somebot?start=ref_42'), { kind: 'username', username: 'somebot', startParam: 'ref_42' });
  assert.deepEqual(parseChatRef('https://t.me/s/channelname/10'), { kind: 'username', username: 'channelname', messageId: 10 });
  assert.deepEqual(parseChatRef('https://t.me/news/100?comment=5'), { kind: 'username', username: 'news', messageId: 100, commentId: 5 });
  assert.equal(parseChatRef('https://t.me/addstickers/pack'), null);
  assert.equal(parseChatRef('https://t.me/proxy?server=x'), null);
});

test('ссылки tg://', () => {
  assert.deepEqual(parseChatRef('tg://resolve?domain=durov&post=5'), { kind: 'username', username: 'durov', messageId: 5 });
  assert.deepEqual(parseChatRef('tg://join?invite=XYZ'), { kind: 'invite', hash: 'XYZ' });
  assert.deepEqual(parseChatRef('tg://privatepost?channel=123&post=9'), { kind: 'id', id: '-100123', messageId: 9 });
  assert.deepEqual(parseChatRef('tg://user?id=777'), { kind: 'id', id: '777' });
});

test('название чата: поиск по диалогам, при подходящем виде — ещё и username', () => {
  assert.deepEqual(parseChatRef('Мама'), { kind: 'title', title: 'Мама', username: undefined });
  assert.deepEqual(parseChatRef('Work chat'), { kind: 'title', title: 'Work chat', username: undefined });
  assert.deepEqual(parseChatRef('durov'), { kind: 'title', title: 'durov', username: 'durov' });
});
