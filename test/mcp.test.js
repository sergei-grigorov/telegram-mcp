import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LEGACY_PROTOCOL_VERSIONS,
  McpServer,
  META,
  MODERN_PROTOCOL_VERSIONS,
  normalizeArgs,
  requestEra,
  SUPPORTED_PROTOCOL_VERSIONS,
  ToolError,
  UNSUPPORTED_PROTOCOL_VERSION,
  validateArgs,
} from '../server/mcp.js';
import { API_ENV, makeServer, silentLogger, tempDir } from './helpers.js';

const SERVER = fileURLToPath(new URL('../server/index.js', import.meta.url));

const INFO = { name: 'toy', version: '0' };

function toyServer(tools) {
  return new McpServer({ info: INFO, instructions: () => 'x', tools, logger: silentLogger });
}

// _meta современного запроса (протокол 2026-07-28).
function modernMeta(version = MODERN_PROTOCOL_VERSIONS[0]) {
  return {
    [META.protocolVersion]: version,
    [META.clientInfo]: { name: 'test-client', version: '1' },
    [META.clientCapabilities]: {},
  };
}

test('определение эпохи запроса', () => {
  assert.equal(requestEra('initialize', { _meta: modernMeta() }), 'legacy');
  assert.equal(requestEra('tools/list', { _meta: modernMeta() }), 'modern');
  assert.equal(requestEra('tools/list', {}), 'legacy');
  assert.equal(requestEra('server/discover', {}), 'modern');
});

test('современная эпоха: server/discover, список и вызов с картинкой', async () => {
  const s = toyServer([
    { name: 'img', inputSchema: { type: 'object' }, handler: async () => ({ content: [{ type: 'text', text: 'hi' }, { type: 'image', data: 'AAA=', mimeType: 'image/jpeg' }] }) },
  ]);
  const d = await s.handle({ jsonrpc: '2.0', id: 'd1', method: 'server/discover', params: { _meta: modernMeta() } });
  assert.deepEqual(d.result, {
    resultType: 'complete',
    supportedVersions: MODERN_PROTOCOL_VERSIONS,
    capabilities: { tools: { listChanged: false } },
    instructions: 'x',
    ttlMs: 0,
    cacheScope: 'private',
    _meta: { [META.serverInfo]: INFO },
  });
  const list = await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: modernMeta() } });
  assert.equal(list.result.resultType, 'complete');
  assert.equal(list.result.cacheScope, 'private');
  assert.equal(list.result.ttlMs, 0);
  const c = await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'img', arguments: {}, _meta: modernMeta() } });
  assert.equal(c.result.resultType, 'complete');
  assert.equal(c.result.content[1].type, 'image');
  assert.deepEqual(c.result._meta, { [META.serverInfo]: INFO });
});

test('современная эпоха: ошибки конверта и откат на initialize', async () => {
  const s = toyServer([]);
  const unsupported = await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: modernMeta('2099-01-01') } });
  assert.deepEqual(unsupported.error, {
    code: UNSUPPORTED_PROTOCOL_VERSION,
    message: 'Unsupported protocol version',
    data: { supported: [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS], requested: '2099-01-01' },
  });
  const bare = await s.handle({ jsonrpc: '2.0', id: 2, method: 'server/discover' });
  assert.equal(bare.error.code, -32602);
  // Прежняя версия в _meta: server/discover неизвестен — клиент перейдёт на initialize.
  const old = await s.handle({ jsonrpc: '2.0', id: 3, method: 'server/discover', params: { _meta: modernMeta('2025-06-18') } });
  assert.equal(old.error.code, -32601);
});

test('подписка subscriptions/listen: подтверждение и отмена', async () => {
  const s = toyServer([]);
  const sent = [];
  s.emit = (m) => sent.push(m);
  const pending = s.handle({ jsonrpc: '2.0', id: 'sub1', method: 'subscriptions/listen', params: { _meta: modernMeta(), notifications: { toolsListChanged: true } } });
  await new Promise((r) => setImmediate(r));
  assert.equal(sent[0].method, 'notifications/subscriptions/acknowledged');
  await s.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'sub1' } });
  assert.equal(await pending, null);
});

test('настоящий процесс, современная эпоха: проба, список и вызов без рукопожатия', async () => {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...API_ENV, TELEGRAM_DATA_DIR: tempDir() },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const meta = modernMeta();
  const requests = [
    { jsonrpc: '2.0', id: 'discover-1', method: 'server/discover', params: { _meta: meta } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: meta } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'connector_status', arguments: {}, _meta: meta } },
  ];
  child.stdin.end(`${requests.map((r) => JSON.stringify(r)).join('\n')}\n`);
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0, err);
  const byId = Object.fromEntries(out.trim().split('\n').map((l) => JSON.parse(l)).map((m) => [m.id, m]));
  assert.deepEqual(byId['discover-1'].result.supportedVersions, MODERN_PROTOCOL_VERSIONS);
  assert.equal(byId['discover-1'].result._meta[META.serverInfo].name, 'telegram');
  assert.match(byId['discover-1'].result.instructions, /No accounts are connected yet/);
  assert.equal(byId[2].result.tools.length, 26);
  assert.equal(byId[2].result.cacheScope, 'private');
  assert.equal(byId[3].result.resultType, 'complete');
  assert.match(err, /server\/discover: test-client 1, protocol 2026-07-28/);
});

test('обработчик, закончивший работу после отмены, ответа не отправляет', async () => {
  let finish;
  const s = toyServer([{ name: 'slow', inputSchema: { type: 'object' }, handler: () => new Promise((r) => (finish = r)) }]);
  const pending = s.handle({ jsonrpc: '2.0', id: 'x', method: 'tools/call', params: { name: 'slow', arguments: {} } });
  await new Promise((r) => setImmediate(r));
  await s.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'x' } });
  finish('done anyway');
  assert.equal(await pending, null);
});

test('согласование версии протокола и instructions', async () => {
  const s = toyServer([]);
  for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
    const r = await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v } });
    assert.equal(r.result.protocolVersion, v);
  }
  const r = await s.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
  assert.equal(r.result.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0]);
  assert.equal(r.result.instructions, 'x');
});

test('служебные методы и ошибки JSON-RPC', async () => {
  const s = toyServer([]);
  assert.deepEqual(await s.handle({ jsonrpc: '2.0', id: 1, method: 'ping' }), { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await s.handle({ jsonrpc: '2.0', id: 2, method: 'nope' })).error.code, -32601);
  assert.equal((await s.handle({ jsonrpc: '1.0', id: 3, method: 'ping' })).error.code, -32600);
  assert.equal((await s.handleLine('{oops')).error.code, -32700);
  assert.equal((await s.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'missing' } })).error.code, -32602);
});

test('аргументы: приведение типов, одиночное значение вместо массива, проверка', () => {
  const schema = {
    type: 'object',
    properties: {
      n: { type: 'integer', minimum: 1 },
      ids: { type: 'array', items: { type: 'integer' } },
      names: { type: 'array', items: { type: 'string' } },
      s: { type: 'string', maxLength: 3 },
      chat: { type: ['string', 'integer'] },
    },
    required: ['n'],
    additionalProperties: false,
  };
  assert.deepEqual(normalizeArgs(schema, { n: '3', ids: '1, 2,3', names: 'x', chat: -100, z: null }), { n: 3, ids: [1, 2, 3], names: ['x'], chat: -100 });
  assert.deepEqual(normalizeArgs(schema, { ids: 5 }), { ids: [5] });
  const problems = validateArgs(schema, { n: 0, s: 'long', extra: 1 });
  assert.deepEqual(problems, ['arguments.n: must be ≥ 1', 'arguments.s: at most 3 characters', 'arguments.extra: unknown argument']);
});

test('картинки в ответе инструмента и ToolError', async () => {
  const s = toyServer([
    { name: 'img', inputSchema: { type: 'object', properties: {} }, handler: async () => ({ content: [{ type: 'text', text: 'hi' }, { type: 'image', data: 'AAA=', mimeType: 'image/jpeg' }] }) },
    { name: 'bad', inputSchema: { type: 'object', properties: {} }, handler: async () => { throw new ToolError('понятная ошибка'); } },
    { name: 'boom', inputSchema: { type: 'object', properties: {} }, handler: async () => { throw new Error('secret internals'); } },
  ]);
  const img = await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'img', arguments: {} } });
  assert.equal(img.result.content[1].type, 'image');
  assert.equal(img.result.isError, false);
  const bad = await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bad', arguments: {} } });
  assert.deepEqual(bad.result, { content: [{ type: 'text', text: 'понятная ошибка' }], isError: true });
  const boom = await s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'boom', arguments: {} } });
  assert.equal(boom.result.isError, true);
  assert.match(boom.result.content[0].text, /^Internal error/);
});

test('список инструментов зависит от разрешений', async () => {
  const names = (tools) => tools.map((t) => t.name);
  const def = makeServer();
  assert.equal(def.tools.length, 26);
  assert.ok(names(def.tools).includes('send_message'));
  assert.ok(!names(def.tools).includes('delete_messages'));
  assert.ok(!names(def.tools).includes('send_api_request'));

  const readOnly = makeServer({ env: { TELEGRAM_ALLOW_SEND: 'false', TELEGRAM_ALLOW_BOTS: 'false', TELEGRAM_ALLOW_JOIN: 'false' } });
  const ro = names(readOnly.tools);
  assert.ok(ro.every((n) => !/send|edit|forward|react|mark_as_read|pin|vote|press|start_bot|inline|join/.test(n)), ro.join(','));
  assert.ok(ro.includes('get_messages') && ro.includes('download_media') && ro.includes('open_login_page'));
  // Подписка на сообщения — чтение: доступна и без разрешений на действия.
  assert.ok(ro.includes('subscribe_to_messages'));

  const all = makeServer({
    env: {
      TELEGRAM_ALLOW_DELETE: 'true',
      TELEGRAM_ALLOW_ADMIN: 'true',
      TELEGRAM_ALLOW_PROFILE: 'true',
      TELEGRAM_ALLOW_RAW_API: 'true',
    },
  });
  assert.equal(all.tools.length, 35);
  for (const t of all.tools) {
    assert.ok(t.description.length > 20, t.name);
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.ok(t.annotations && typeof t.annotations.readOnlyHint === 'boolean', t.name);
  }
  // Инструменты, отправляющие что-то наружу, не помечены как «только чтение».
  for (const n of ['send_message', 'press_button', 'join_chat', 'send_api_request']) {
    assert.equal(all.tools.find((t) => t.name === n).annotations.readOnlyHint, false, n);
  }
  for (const n of ['delete_messages', 'leave_chat', 'manage_chat', 'send_api_request']) {
    assert.equal(all.tools.find((t) => t.name === n).annotations.destructiveHint, true, n);
  }
});

test('имена инструментов — действия без приставки, как у коннектора Bybit', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { TOOL } = await import('../server/names.js');
  const all = makeServer({ env: { TELEGRAM_ALLOW_DELETE: 'true', TELEGRAM_ALLOW_ADMIN: 'true', TELEGRAM_ALLOW_PROFILE: 'true', TELEGRAM_ALLOW_RAW_API: 'true' } });
  const names = all.tools.map((t) => t.name);
  assert.deepEqual([...names].sort(), Object.values(TOOL).sort());
  for (const n of names) assert.match(n, /^(?!telegram_)[a-z]+(_[a-z]+)+$/, n);
  // Claude показывает имя, а не title: title повторяет имя словами.
  for (const t of all.tools) {
    assert.equal(t.title.toLowerCase(), t.name.replace(/_/g, ' '), t.name);
    // Как в Bybit: заголовок и в annotations.title.
    assert.equal(t.annotations.title, t.title, t.name);
  }
  // В текстах для модели нет старых имён с приставкой telegram_.
  const dirs = ['../server/', '../server/tools/', '../server/tg/', '../server/login/', '../server/stream/'];
  for (const dir of dirs) {
    for (const file of (await readdir(new URL(dir, import.meta.url))).filter((f) => f.endsWith('.js'))) {
      const src = await readFile(new URL(dir + file, import.meta.url), 'utf8');
      assert.doesNotMatch(src, /\btelegram_[a-z]/, `${dir}${file}`);
    }
  }
});

test('ключи настроек не меняются: при обновлении настройки и ключи API сохраняются', async () => {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'telegram');
  assert.deepEqual(Object.keys(manifest.user_config), [
    'api_id',
    'api_hash',
    'default_account',
    'allow_send',
    'allow_bots',
    'allow_join',
    'allow_delete',
    'allow_admin',
    'allow_profile',
    'allow_raw_api',
    'visible_chats',
    'hidden_chats',
    'writable_chats',
    'read_only_accounts',
    'upload_dirs',
    'download_dir',
    'actions_per_minute',
    'transcribe_api_key',
    'transcribe_api_url',
    'transcribe_model',
    'proxy',
  ]);
  const sensitive = Object.entries(manifest.user_config).filter(([, v]) => v.sensitive).map(([k]) => k);
  assert.deepEqual(sensitive, ['api_hash', 'transcribe_api_key', 'proxy']);
});

test('manifest.json перечисляет все инструменты', async () => {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const all = makeServer({ env: { TELEGRAM_ALLOW_DELETE: 'true', TELEGRAM_ALLOW_ADMIN: 'true', TELEGRAM_ALLOW_PROFILE: 'true', TELEGRAM_ALLOW_RAW_API: 'true' } });
  assert.deepEqual(manifest.tools.map((t) => t.name).sort(), all.tools.map((t) => t.name).sort());
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, pkg.version);
  // Каждая переменная из manifest читается сервером.
  const { readFile: rf } = await import('node:fs/promises');
  const configSrc = await rf(new URL('../server/config.js', import.meta.url), 'utf8');
  for (const name of Object.keys(manifest.server.mcp_config.env)) assert.ok(configSrc.includes(name) || /ALLOW_/.test(name), name);
  for (const key of Object.keys(manifest.user_config)) {
    if (key === 'upload_dirs') continue;
    assert.ok(Object.values(manifest.server.mcp_config.env).includes(`\${user_config.${key}}`), key);
  }
});

test('процесс сервера: stdio, в stdout только JSON-RPC', async () => {
  const dataDir = tempDir();
  const child = spawn(process.execPath, [SERVER, '--upload-dirs', '${user_config.upload_dirs}'], {
    env: { ...process.env, ...API_ENV, TELEGRAM_DATA_DIR: dataDir, TELEGRAM_ALLOW_SEND: '${user_config.allow_send}' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'connector_status', arguments: {} } },
  ];
  child.stdin.write(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  child.stdin.end();
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0, err);
  const replies = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(replies.map((r) => r.id), [1, 2, 3]);
  assert.equal(replies[1].result.tools.length, 26);
  assert.match(replies[2].result.content[0].text, /No accounts yet/);
  assert.doesNotMatch(err, /ExperimentalWarning/);
});
