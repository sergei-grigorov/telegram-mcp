// Коннектор на сервере: настройки из manifest.json (без папок на диске), публичные
// адреса (страница входа, поток для Monitor, ссылки на файлы), MCP по HTTP за шлюзом.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';

import { createServer } from '../server/index.js';
import { McpServer, META, MODERN_PROTOCOL_VERSIONS } from '../server/mcp.js';
import { serveFiles } from '../server/remote/files.js';
import { RemoteHost } from '../server/remote/host.js';
import { SettingsStore } from '../server/remote/settings.js';
import { AccountStore } from '../server/store.js';
import { Api } from '../server/tg/lib.js';
import { API_ENV, call, fakeSessionString, FakeClient, message, peerUser, silentLogger, tempDir, user } from './helpers.js';

const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const SECRET = 's'.repeat(40);
const PUBLIC = 'https://agent.example.com/telegram';

function remoteServer({ handlers = {}, env = {} } = {}) {
  const dataDir = tempDir();
  const filesDir = tempDir();
  new AccountStore(path.join(dataDir, 'accounts'), silentLogger).write('main', {
    version: 1,
    session: fakeSessionString(),
    user: { id: '1000', first_name: 'Test', username: 'testuser', phone: '79990001122' },
  });
  const fake = new FakeClient(handlers);
  const opened = [];
  const built = createServer({
    env: { ...API_ENV, TELEGRAM_DATA_DIR: dataDir, TELEGRAM_DOWNLOAD_DIR: filesDir, TELEGRAM_UPLOAD_DIRS: JSON.stringify([filesDir]), ...env },
    argv: [],
    logger: silentLogger,
    createClient: () => fake,
    openUrl: (u) => opened.push(u),
    remote: { publicUrl: PUBLIC },
  });
  return { ...built, fake, dataDir, filesDir, opened };
}

test('настройки на сервере: папки скрыты и заданы сервером, API ID и API Hash обязательны', () => {
  const dir = tempDir();
  const s = new SettingsStore({
    file: path.join(dir, 'settings.json'),
    manifest,
    hidden: ['upload_dirs', 'download_dir'],
    fixedEnv: { TELEGRAM_DATA_DIR: '/data', TELEGRAM_DOWNLOAD_DIR: '/files', TELEGRAM_UPLOAD_DIRS: '["/files"]' },
  });
  s.load();
  const keys = s.fields.map((f) => f.key);
  assert.ok(!keys.includes('upload_dirs') && !keys.includes('download_dir'));
  assert.ok(keys.includes('api_id') && keys.includes('transcribe_api_key'));
  const missing = s.parseForm(new URLSearchParams({ allow_send: 'on' }));
  assert.ok(missing.errors.some((e) => /API ID/.test(e)));
  assert.ok(missing.errors.some((e) => /API Hash/.test(e)));
  const ok = s.parseForm(new URLSearchParams({ api_id: '12345', api_hash: '0123456789abcdef0123456789abcdef', allow_send: 'on', visible_chats: '@a\n@b' }));
  assert.deepEqual(ok.errors, []);
  s.save(ok.values);
  const env = s.env(s.values, { TELEGRAM_DOWNLOAD_DIR: '/tmp/evil' });
  assert.equal(env.TELEGRAM_API_ID, '12345');
  assert.equal(env.TELEGRAM_ALLOW_SEND, 'true');
  assert.equal(env.TELEGRAM_ALLOW_JOIN, 'false', 'снятый флажок');
  assert.equal(env.TELEGRAM_ALLOW_DELETE, 'false');
  assert.equal(env.TELEGRAM_VISIBLE_CHATS, '@a\n@b');
  assert.equal(env.TELEGRAM_DOWNLOAD_DIR, '/files', 'папки задаёт сервер');
  assert.equal(env.TELEGRAM_UPLOAD_DIRS, '["/files"]');
  assert.equal(env.TELEGRAM_DATA_DIR, '/data');
});

test('на сервере: публичные адреса страницы входа и потока, настройки — на странице коннектора', async (t) => {
  const { server, services, opened } = remoteServer();
  t.after(() => services.stream.stop());
  const login = await call(server, 'open_login_page', { account: 'work' });
  assert.match(login.text, /Login page: https:\/\/agent\.example\.com\/telegram\/accounts\/#account=work/);
  assert.match(login.text, /owner password/);
  assert.equal(opened.length, 0, 'браузер на сервере не открывается');
  const status = await call(server, 'connector_status');
  assert.equal(status.isError, false, status.text);
  const sub = await call(server, 'subscribe_to_messages', {});
  assert.equal(sub.isError, false, sub.text);
  assert.match(sub.json.monitor.ws.url, /^wss:\/\/agent\.example\.com\/telegram\/messages\/[A-Za-z0-9_-]{40,}$/);
  assert.equal(services.stream.server.port, null, 'своего порта у потока нет');
});

test('на сервере: сохранённый файл получает ссылку для владельца', async (t) => {
  const photo = new Api.Photo({ id: 1n, accessHash: 1n, fileReference: Buffer.alloc(0), date: 0, dcId: 2, sizes: [new Api.PhotoSize({ type: 'x', w: 800, h: 600, size: 10 })] });
  const friend = user(42, { username: 'friend', firstName: 'Friend' });
  const { server, services, filesDir } = remoteServer({
    handlers: {
      'contacts.ResolveUsername': () => new Api.contacts.ResolvedPeer({ peer: peerUser(42), users: [friend], chats: [] }),
      'messages.GetMessages': () => new Api.messages.Messages({ messages: [message(5, peerUser(42), { media: new Api.MessageMediaPhoto({ photo }) })], users: [friend], chats: [] }),
      downloadMedia: () => Buffer.from([0xff, 0xd8, 0xff]),
    },
  });
  t.after(() => services.stream.stop());
  const r = await call(server, 'download_media', { chat: '@friend', message_id: 5, save: true });
  assert.equal(r.isError, false, r.text);
  assert.equal(path.dirname(r.json.file.path), filesDir);
  assert.equal(r.json.file.url, `${PUBLIC}/files/${encodeURIComponent(path.basename(r.json.file.path))}`);
});

// Сырой запрос на WebSocket: свои Host и заголовки шлюза, ответ и первые кадры.
function rawUpgrade(port, pathname, headers) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => {
      const lines = [`GET ${pathname} HTTP/1.1`, 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13'];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      s.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    let buf = Buffer.alloc(0);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const head = buf.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      const status = Number(head.split(' ')[1]);
      const body = buf.subarray(head.indexOf('\r\n\r\n') + 4);
      // 101: ждём первый текстовый кадр (приветствие подписки).
      if (status === 101 && body.length < 2) return;
      s.destroy();
      resolve({ status, body });
    });
    s.on('error', reject);
  });
}

test('на сервере: поток сообщений через общий HTTP-сервер, страница аккаунтов и файлы — у владельца', async (t) => {
  const built = remoteServer();
  const { server, services, filesDir } = built;
  t.after(() => services.stream.stop());
  const settings = new SettingsStore({ file: path.join(tempDir(), 'settings.json'), manifest, hidden: ['upload_dirs', 'download_dir'] });
  const host = new RemoteHost({
    title: 'Telegram',
    publicUrl: PUBLIC,
    gatewaySecret: SECRET,
    settings,
    logger: silentLogger,
    createApp: async () => ({
      mcp: server,
      routes: {
        '/accounts': (req, res, { rest }) => services.login.handleMounted(req, res, rest),
        '/files': (req, res, { rest }) => serveFiles(req, res, { dir: filesDir, base: '/telegram/files', rest }),
      },
      upgrades: { '/messages': (req, socket, head) => services.stream.server.handleUpgrade(req, socket, head) },
      close: async () => {},
    }),
  });
  const { port } = await host.start({ host: '127.0.0.1', port: 0 });
  t.after(() => host.stop());
  const local = `http://127.0.0.1:${port}`;
  const owner = { 'X-Gateway-Secret': SECRET, 'X-Gateway-Auth': 'owner' };

  const sub = await call(server, 'subscribe_to_messages', {});
  const wsPath = new URL(sub.json.monitor.ws.url).pathname;
  const ok = await rawUpgrade(port, wsPath, { Host: 'agent.example.com', 'X-Gateway-Secret': SECRET });
  assert.equal(ok.status, 101);
  assert.match(ok.body.toString('utf8'), /subscribed|watching|subscription/i);
  assert.equal((await rawUpgrade(port, wsPath, { Host: `127.0.0.1:${port}`, 'X-Gateway-Secret': SECRET })).status, 403, 'чужой Host');
  assert.equal((await rawUpgrade(port, wsPath, { Host: 'agent.example.com' })).status, 403, 'без секрета шлюза');
  assert.equal((await rawUpgrade(port, wsPath, { Host: 'agent.example.com', 'X-Gateway-Secret': SECRET, Origin: 'https://evil.example' })).status, 403, 'браузер');

  const redirect = await fetch(`${local}/telegram/accounts`, { headers: owner, redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), `${PUBLIC}/accounts/`);
  assert.equal((await fetch(`${local}/telegram/accounts/`, { headers: { ...owner, 'X-Gateway-Auth': 'token' } })).status, 401);
  const page = await fetch(`${local}/telegram/accounts/`, { headers: owner });
  const html = await page.text();
  assert.match(html, /Страница доступна только владельцу/);
  assert.match(html, /https:\/\/agent\.example\.com\/telegram\/settings/);
  const state = await (await fetch(`${local}/telegram/accounts/api/state`, { headers: owner })).json();
  assert.deepEqual(state.accounts.map((a) => a.name), ['main']);

  fs.writeFileSync(path.join(filesDir, 'отчёт.pdf'), 'PDF');
  fs.writeFileSync(path.join(filesDir, '.hidden'), 'secret');
  const list = await (await fetch(`${local}/telegram/files/`, { headers: owner })).text();
  assert.match(list, /отчёт\.pdf/);
  assert.doesNotMatch(list, /\.hidden/);
  const file = await fetch(`${local}/telegram/files/${encodeURIComponent('отчёт.pdf')}`, { headers: owner });
  assert.equal(file.status, 200);
  assert.equal(await file.text(), 'PDF');
  assert.equal(file.headers.get('content-type'), 'application/octet-stream');
  assert.match(file.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''/);
  assert.match(file.headers.get('content-security-policy'), /sandbox/);
  for (const bad of ['/telegram/files/.hidden', '/telegram/files/..%2F..%2Fetc%2Fpasswd', '/telegram/files/%2E%2E/x', '/telegram/files/missing.txt']) {
    assert.equal((await fetch(`${local}${bad}`, { headers: owner })).status, 404, bad);
  }
  assert.equal((await fetch(`${local}/telegram/files/`, { headers: { 'X-Gateway-Secret': SECRET } })).status, 401, 'без входа владельца');
});

test('MCP по HTTP: обе эпохи на одном адресе', async () => {
  const mcp = new McpServer({ info: { name: 'toy', version: '0' }, instructions: 'x', tools: [], logger: silentLogger });
  const host = new RemoteHost({
    title: 'T',
    publicUrl: 'http://127.0.0.1:1/telegram',
    gatewaySecret: SECRET,
    settings: new SettingsStore({ file: path.join(tempDir(), 's.json'), manifest }),
    logger: silentLogger,
    createApp: async () => ({ mcp, close: async () => {} }),
  });
  const { port } = await host.start({ host: '127.0.0.1', port: 0 });
  try {
    const h = { 'X-Gateway-Secret': SECRET, 'X-Gateway-Auth': 'token', 'Content-Type': 'application/json' };
    const legacy = await fetch(`http://127.0.0.1:${port}/telegram`, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) });
    assert.equal((await legacy.json()).result.protocolVersion, '2025-06-18');
    const meta = { [META.protocolVersion]: MODERN_PROTOCOL_VERSIONS[0], [META.clientCapabilities]: {} };
    const modern = await fetch(`http://127.0.0.1:${port}/telegram/mcp`, {
      method: 'POST',
      headers: { ...h, 'MCP-Protocol-Version': MODERN_PROTOCOL_VERSIONS[0] },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: meta } }),
    });
    const body = await modern.json();
    assert.equal(body.result.resultType, 'complete');
    assert.equal(body.result.ttlMs, 0);
  } finally {
    await host.stop();
  }
});
