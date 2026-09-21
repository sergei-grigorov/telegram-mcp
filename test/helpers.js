// Общие заготовки тестов: временная папка данных, поддельный клиент Telegram,
// сервер с тестовыми настройками.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../server/index.js';
import { silentLogger } from '../server/log.js';
import { AccountStore } from '../server/store.js';
import { markedIdString } from '../server/tg/format.js';
import { Api, bigInt } from '../server/tg/lib.js';

export { silentLogger };

export const API_ENV = { TELEGRAM_API_ID: '12345', TELEGRAM_API_HASH: '0123456789abcdef0123456789abcdef' };

export function tempDir(prefix = 'tgmcp-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Строка сессии в формате teleproto: версия + base64(dc, длина адреса, адрес, порт, ключ).
export function fakeSessionString(dc = 2) {
  const addr = Buffer.from('149.154.167.51');
  const len = Buffer.alloc(2);
  len.writeInt16BE(addr.length);
  const port = Buffer.alloc(2);
  port.writeInt16BE(443);
  return `1${Buffer.concat([Buffer.from([dc]), len, addr, port, Buffer.alloc(256, 7)]).toString('base64')}`;
}

export const ME = new Api.User({
  id: bigInt(1000),
  self: true,
  accessHash: bigInt(1),
  firstName: 'Test',
  lastName: 'User',
  username: 'testuser',
  phone: '79990001122',
});

export function user(id, extra = {}) {
  return new Api.User({ id: bigInt(id), accessHash: bigInt(id * 7), firstName: `User${id}`, ...extra });
}

export function channel(id, extra = {}) {
  return new Api.Channel({ id: bigInt(id), accessHash: bigInt(id * 3), title: `Channel ${id}`, photo: new Api.ChatPhotoEmpty(), date: 0, ...extra });
}

export function message(id, peer, extra = {}) {
  return new Api.Message({ id, peerId: peer, date: 1_700_000_000 + id, message: `message ${id}`, ...extra });
}

export const peerUser = (id) => new Api.PeerUser({ userId: bigInt(id) });
export const peerChannel = (id) => new Api.PeerChannel({ channelId: bigInt(id) });

// Поддельный клиент teleproto: invoke раздаёт запросы обработчикам по className.
export class FakeClient {
  constructor(handlers = {}, { me = ME } = {}) {
    this.handlers = handlers;
    this.me = me;
    this.calls = [];
    this.sent = [];
    this.connected = false;
    this.eventHandlers = [];
    this.watched = [];
    this.caughtUp = 0;
    // Как client.updates в teleproto: watch держит каналы «открытыми».
    this.updates = {
      watch: (chats) => {
        const entry = { chats, stopped: false };
        this.watched.push(entry);
        return () => {
          entry.stopped = true;
        };
      },
    };
  }

  // Обновления, как в teleproto: обработчик без фильтра получает сырые объекты, а
  // пользователи и чаты из того же пакета лежат в update._entities.
  addEventHandler(fn) {
    this.eventHandlers.push(fn);
  }

  removeEventHandler(fn) {
    this.eventHandlers = this.eventHandlers.filter((h) => h !== fn);
  }

  async emit(update, entities = []) {
    update._entities = new Map(entities.map((e) => [markedIdString(e), e]));
    for (const h of [...this.eventHandlers]) await h(update);
  }

  async catchUp() {
    this.caughtUp++;
  }

  async connect() {
    this.connected = true;
    return true;
  }

  async destroy() {
    this.connected = false;
  }

  async getMe() {
    return this.me;
  }

  async invoke(request) {
    this.calls.push(request);
    const handler = this.handlers[request.className];
    if (!handler) throw new Error(`unexpected request ${request.className}`);
    return handler(request, this);
  }

  async getInputEntity(id) {
    const h = this.handlers.getInputEntity;
    if (h) return h(id);
    throw new Error(`Could not find the input entity for ${id}`);
  }

  async sendMessage(peer, params) {
    this.sent.push({ peer, ...params });
    if (this.handlers.sendMessage) return this.handlers.sendMessage(peer, params);
    return new Api.Message({ id: 500 + this.sent.length, peerId: peerUser(1), date: 1_700_000_500, message: params.message, out: true });
  }

  async editMessage(peer, params) {
    this.sent.push({ peer, edit: true, ...params });
    return new Api.Message({ id: params.message, peerId: peerUser(1), date: 1_700_000_500, message: params.text, out: true });
  }

  async uploadFile({ file, onProgress }) {
    this.uploaded = (this.uploaded ?? []).concat(file);
    if (this.handlers.uploadFile) return this.handlers.uploadFile(file, onProgress);
    return new Api.InputFile({ id: bigInt(1), parts: 1, name: file.name, md5Checksum: '' });
  }

  async sendFile(peer, params) {
    this.sent.push({ peer, file: true, ...params });
    if (this.handlers.sendFile) return this.handlers.sendFile(peer, params);
    return new Api.Message({ id: 900, peerId: peerUser(1), date: 1_700_000_900, message: params.caption ?? '', out: true });
  }

  async downloadMedia(media, params) {
    if (this.handlers.downloadMedia) return this.handlers.downloadMedia(media, params);
    return Buffer.from('fake');
  }

  async *iterDialogs() {
    for (const d of this.handlers.dialogs?.() ?? []) yield d;
  }

  async getDialogs() {
    return this.handlers.dialogs?.() ?? [];
  }
}

// Сервер с временной папкой данных, аккаунтами и поддельным клиентом.
export function makeServer({ env = {}, argv = [], handlers = {}, accounts = ['main'], client } = {}) {
  const dataDir = tempDir();
  const store = new AccountStore(path.join(dataDir, 'accounts'), silentLogger);
  for (const name of accounts) {
    store.write(name, { version: 1, session: fakeSessionString(), user: { id: '1000', first_name: 'Test', username: 'testuser', phone: '79990001122' } });
  }
  const fake = client ?? new FakeClient(handlers);
  const opened = [];
  const built = createServer({
    env: { ...API_ENV, TELEGRAM_DATA_DIR: dataDir, ...env },
    argv,
    logger: silentLogger,
    createClient: () => fake,
    openUrl: (url) => {
      opened.push(url);
      return true;
    },
  });
  return { ...built, client: fake, dataDir, store, opened };
}

export async function call(server, name, args = {}) {
  const r = await server.handle({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method: 'tools/call', params: { name, arguments: args } });
  if (r.error) throw new Error(`RPC error ${r.error.code}: ${r.error.message}`);
  const text = r.result.content.find((c) => c.type === 'text')?.text ?? '';
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // не JSON — сообщение об ошибке или подсказка
  }
  return { ...r.result, text, json };
}
