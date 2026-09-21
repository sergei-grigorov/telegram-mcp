import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { loadConfig } from '../server/config.js';
import { Policy } from '../server/policy.js';
import { Api, bigInt } from '../server/tg/lib.js';
import { API_ENV, channel, ME, tempDir, user } from './helpers.js';

function policy(env = {}, extra = {}) {
  return new Policy(loadConfig({ env: { ...API_ENV, ...env }, argv: extra.argv ?? [], home: extra.home ?? '/home/t' }), extra);
}

test('разрешения и текст отказа с названием настройки', () => {
  const p = policy({ TELEGRAM_ALLOW_SEND: 'false' });
  assert.equal(p.enabled('read'), true);
  assert.equal(p.enabled('send'), false);
  assert.throws(() => p.require('send'), /«Разрешить отправку сообщений»/);
  assert.throws(() => p.require('raw'), /«Разрешить прямые вызовы Telegram API»/);
  assert.doesNotThrow(() => p.require('bots'));
  const s = p.summary();
  assert.deepEqual(s.enabled.map((e) => e.capability), ['bots', 'join']);
});

test('служебный чат 777000 скрыт всегда', () => {
  const p = policy();
  const service = user(777000, { firstName: 'Telegram' });
  assert.equal(p.isVisible(service), false);
  assert.throws(() => p.requireVisible(service), /777000/);
  assert.equal(policy({ TELEGRAM_ALLOW_SERVICE_CHAT: 'true' }).isVisible(service), true);
});

test('скрытые чаты, «только эти» и «писать только в эти»', () => {
  const ch = channel(1234567890, { username: 'news', broadcast: true });
  const friend = user(42, { username: 'Friend' });
  const other = user(43);
  const hidden = policy({ TELEGRAM_HIDDEN_CHATS: '@friend, -1001234567890' });
  assert.equal(hidden.isVisible(friend), false);
  assert.equal(hidden.isVisible(ch), false);
  assert.equal(hidden.isVisible(other), true);

  const only = policy({ TELEGRAM_VISIBLE_CHATS: 'https://t.me/news me' });
  assert.equal(only.isVisible(ch), true);
  assert.equal(only.isVisible(ME), true);
  assert.equal(only.isVisible(friend), false);

  const writable = policy({ TELEGRAM_WRITABLE_CHATS: '42' });
  assert.equal(writable.isWritable(friend), true);
  assert.equal(writable.isVisible(other), true);
  assert.equal(writable.isWritable(other), false);
  assert.throws(() => writable.requireWritable(other), /«Писать только в эти чаты»/);

  // Сырой id канала без -100 тоже подходит.
  assert.equal(policy({ TELEGRAM_HIDDEN_CHATS: '1234567890' }).isVisible(ch), false);
  // Несколько username у канала.
  const multi = channel(5, { usernames: [new Api.Username({ username: 'Second', active: true })] });
  assert.equal(policy({ TELEGRAM_HIDDEN_CHATS: '@second' }).isVisible(multi), false);
  assert.equal(policy().isVisible(new Api.Chat({ id: bigInt(9), title: 'g', photo: new Api.ChatPhotoEmpty(), participantsCount: 2, date: 0, version: 1 })), true);
});

test('файлы для отправки: только разрешённые папки, без скрытых и без папки данных', () => {
  const root = tempDir();
  const allowed = path.join(root, 'allowed');
  const secret = path.join(root, 'secret');
  const data = path.join(allowed, 'data');
  fs.mkdirSync(path.join(allowed, '.hidden'), { recursive: true });
  fs.mkdirSync(secret);
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(allowed, 'photo.jpg'), 'x');
  fs.writeFileSync(path.join(allowed, '.env'), 'x');
  fs.writeFileSync(path.join(allowed, '.hidden', 'a.txt'), 'x');
  fs.writeFileSync(path.join(allowed, 'empty.txt'), '');
  fs.writeFileSync(path.join(secret, 'key.txt'), 'x');
  fs.writeFileSync(path.join(data, 'session.json'), 'x');
  fs.symlinkSync(path.join(secret, 'key.txt'), path.join(allowed, 'link.txt'));

  const p = policy({ TELEGRAM_DATA_DIR: data }, { argv: ['--upload-dirs', allowed] });
  const ok = p.checkUploadPath(path.join(allowed, 'photo.jpg'));
  assert.equal(ok.name, 'photo.jpg');
  assert.equal(ok.size, 1);
  assert.throws(() => p.checkUploadPath(path.join(secret, 'key.txt')), /outside the folders/);
  assert.throws(() => p.checkUploadPath(path.join(allowed, 'link.txt')), /outside the folders/, 'символическая ссылка наружу');
  assert.throws(() => p.checkUploadPath(path.join(allowed, '.env')), /Hidden/);
  assert.throws(() => p.checkUploadPath(path.join(allowed, '.hidden', 'a.txt')), /Hidden/);
  assert.throws(() => p.checkUploadPath(path.join(data, 'session.json')), /connector itself/);
  assert.throws(() => p.checkUploadPath(path.join(allowed, 'empty.txt')), /empty/);
  assert.throws(() => p.checkUploadPath(path.join(allowed, 'nope.jpg')), /not found/);
  assert.throws(() => p.checkUploadPath(allowed), /Not a regular file/);
  assert.throws(() => policy().checkUploadPath('/etc/hosts'), /disabled/);
});

test('лимит действий в минуту по аккаунтам', () => {
  let now = 1_000_000;
  const p = policy({ TELEGRAM_ACTIONS_PER_MINUTE: '3' }, { now: () => now });
  p.takeActions('main', 2);
  p.takeActions('Main');
  assert.throws(() => p.takeActions('main'), /at most 3 actions per minute.*Wait 60 s/);
  p.takeActions('other', 3);
  now += 30_000;
  assert.throws(() => p.takeActions('main'), /Wait 30 s/);
  now += 30_001;
  p.takeActions('main', 3);
});
