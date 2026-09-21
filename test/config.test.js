import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { expandPath, loadConfig, parseChatList, parseProxy } from '../server/config.js';
import { API_ENV } from './helpers.js';

const HOME = '/home/tester';

test('пустые поля Claude Desktop (${user_config.x}) считаются незаданными', () => {
  const c = loadConfig({
    env: {
      ...API_ENV,
      TELEGRAM_DEFAULT_ACCOUNT: '${user_config.default_account}',
      TELEGRAM_ALLOW_SEND: '${user_config.allow_send}',
      TELEGRAM_PROXY: '${user_config.proxy}',
      TELEGRAM_HIDDEN_CHATS: '${user_config.hidden_chats}',
    },
    argv: ['--upload-dirs', '${user_config.upload_dirs}'],
    home: HOME,
  });
  assert.equal(c.defaultAccount, '');
  assert.equal(c.permissions.send, true);
  assert.equal(c.proxy, null);
  assert.deepEqual(c.chats.hidden, []);
  assert.deepEqual(c.uploadDirs, []);
  assert.deepEqual(c.problems, []);
  assert.equal(c.hasApiCredentials, true);
});

test('разрешения по умолчанию: чтение, отправка, боты, вступление; остальное выключено', () => {
  const c = loadConfig({ env: API_ENV, argv: [], home: HOME });
  assert.deepEqual(c.permissions, { send: true, bots: true, join: true, delete: false, admin: false, profile: false, raw: false });
  const d = loadConfig({ env: { ...API_ENV, TELEGRAM_ALLOW_SEND: 'false', TELEGRAM_ALLOW_RAW_API: 'true', TELEGRAM_ALLOW_ADMIN: 'maybe' }, argv: [], home: HOME });
  assert.equal(d.permissions.send, false);
  assert.equal(d.permissions.raw, true);
  assert.equal(d.permissions.admin, false);
  assert.match(d.problems.join('\n'), /TELEGRAM_ALLOW_ADMIN/);
  assert.doesNotMatch(d.problems.join('\n'), /maybe/, 'значение поля в сообщение не попадает');
});

test('API ID и API Hash проверяются', () => {
  const c = loadConfig({ env: { TELEGRAM_API_ID: 'abc', TELEGRAM_API_HASH: 'short' }, argv: [], home: HOME });
  assert.equal(c.hasApiCredentials, false);
  assert.equal(c.problems.length, 3);
  const none = loadConfig({ env: {}, argv: [], home: HOME });
  assert.equal(none.hasApiCredentials, false);
});

test('папки: аргументы после --upload-dirs, ${HOME} и ~ раскрываются', () => {
  const c = loadConfig({
    env: { ...API_ENV, TELEGRAM_DOWNLOAD_DIR: '${HOME}/Downloads/tg' },
    argv: ['--upload-dirs', '${HOME}/Desktop', '~/Pictures', '/tmp/x', '--other'],
    home: HOME,
  });
  assert.deepEqual(c.uploadDirs, [path.resolve('/home/tester/Desktop'), path.resolve('/home/tester/Pictures'), path.resolve('/tmp/x')]);
  assert.equal(c.downloadDir, path.resolve('/home/tester/Downloads/tg'));
  assert.equal(c.dataDir, path.resolve('/home/tester/.telegram-mcp'));
  const e = loadConfig({ env: { ...API_ENV, TELEGRAM_UPLOAD_DIRS: '/a:/b' }, argv: [], home: HOME });
  assert.deepEqual(e.uploadDirs, path.delimiter === ':' ? ['/a', '/b'] : [path.resolve('/a:/b')]);
  assert.equal(expandPath('${DOWNLOADS}', HOME), path.resolve('/home/tester/Downloads'));
  assert.equal(expandPath('${UNKNOWN}/x', HOME), '');
});

test('списки чатов: id, @username, ссылки, me; мусор — в problems', () => {
  const problems = [];
  const list = parseChatList('@Durov, https://t.me/telegram; -1001234567890 me\n12345, t.me/+AbCdEf, какой-то чат', 'X', problems);
  assert.deepEqual(
    list.map((e) => [e.kind, e.username ?? e.id ?? '']),
    [
      ['username', 'durov'],
      ['username', 'telegram'],
      ['id', '-1001234567890'],
      ['self', ''],
      ['id', '12345'],
    ],
  );
  assert.equal(problems.length, 3);
});

test('прокси: SOCKS5 с паролем, SOCKS4, MTProxy (tg:// и t.me), ошибки', () => {
  assert.deepEqual(parseProxy('socks5://u%40x:p@127.0.0.1:1080'), { socksType: 5, ip: '127.0.0.1', port: 1080, username: 'u@x', password: 'p' });
  assert.deepEqual(parseProxy('127.0.0.1:9050'), { socksType: 5, ip: '127.0.0.1', port: 9050 });
  assert.deepEqual(parseProxy('socks4://proxy.local:1080'), { socksType: 4, ip: 'proxy.local', port: 1080 });
  assert.deepEqual(parseProxy('tg://proxy?server=1.2.3.4&port=443&secret=ee00'), { MTProxy: true, ip: '1.2.3.4', port: 443, secret: 'ee00' });
  assert.deepEqual(parseProxy('https://t.me/proxy?server=h.example&port=8443&secret=dd11'), { MTProxy: true, ip: 'h.example', port: 8443, secret: 'dd11' });
  assert.deepEqual(parseProxy('mtproxy://abcd@h.example:443'), { MTProxy: true, ip: 'h.example', port: 443, secret: 'abcd' });
  assert.throws(() => parseProxy('http://h:80'), /не поддерживается/);
  assert.throws(() => parseProxy('socks5://h'), /порт/);
  const c = loadConfig({ env: { ...API_ENV, TELEGRAM_PROXY: 'http://h:80' }, argv: [], home: HOME });
  assert.equal(c.proxy, null);
  assert.match(c.problems[0], /TELEGRAM_PROXY/);
});

test('лимиты и аккаунты только для чтения', () => {
  const c = loadConfig({ env: { ...API_ENV, TELEGRAM_ACTIONS_PER_MINUTE: '5', TELEGRAM_READ_ONLY_ACCOUNTS: 'Work, @Main' }, argv: [], home: HOME });
  assert.equal(c.actionsPerMinute, 5);
  assert.deepEqual([...c.readOnlyAccounts], ['work', 'main']);
  const bad = loadConfig({ env: { ...API_ENV, TELEGRAM_ACTIONS_PER_MINUTE: '0' }, argv: [], home: HOME });
  assert.equal(bad.actionsPerMinute, 20);
});
