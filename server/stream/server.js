// Локальный сервер потока сообщений: ws://127.0.0.1:<порт>/messages/<токен>.
// Слушает только 127.0.0.1, принимает только WebSocket, проверяет Host (защита от
// DNS rebinding) и не пускает браузеры: они всегда присылают Origin, а клиенту
// Monitor он не нужен. Кого пускать по токену, решает владелец (onConnection).
// У коннектора на сервере (publicUrl) своего порта нет: запросы на WebSocket передаёт
// общий HTTP-сервер (handleUpgrade), адрес для Monitor — публичный
// (wss://хост/путь-коннектора/messages/<токен>), Host сверяется с ним.

import http from 'node:http';

import { acceptUpgrade, checkUpgrade, rejectUpgrade } from './websocket.js';

const PATH_PREFIX = '/messages/';
const MAX_CONNECTIONS = 64;
const STOP_TIMEOUT_MS = 500;

export class StreamServer {
  // onConnection(token, conn) — соединение уже открыто; дальше его судьба —
  // забота владельца (например, закрыть с кодом 4004 для неизвестного токена).
  constructor({ logger, onConnection, connectionOptions = {}, publicUrl = null }) {
    this.logger = logger;
    this.onConnection = onConnection;
    this.connectionOptions = connectionOptions;
    this.server = null;
    this.port = null;
    this.starting = null;
    this.conns = new Set();
    this.public = publicUrl ? new URL(publicUrl) : null;
    this.basePath = this.public ? this.public.pathname.replace(/\/+$/, '') : '';
  }

  get running() {
    return Boolean(this.server || this.public);
  }

  url(token) {
    if (this.public) return `${this.public.protocol === 'https:' ? 'wss:' : 'ws:'}//${this.public.host}${this.basePath}${PATH_PREFIX}${token}`;
    return `ws://127.0.0.1:${this.port}${PATH_PREFIX}${token}`;
  }

  async start() {
    if (this.public) return null;
    if (this.server) return this.port;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const server = http.createServer((req, res) => {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Not found\n');
      });
      server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
      server.on('clientError', (err, socket) => socket.destroy());
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      server.unref();
      this.server = server;
      this.port = server.address().port;
      this.logger.info(`поток сообщений: ws://127.0.0.1:${this.port}/…`);
      return this.port;
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  handleUpgrade(req, socket, head) {
    // Сокет апгрейда приходит без обработчика ошибок: сброс соединения уронил бы процесс.
    socket.on('error', () => {});
    const host = String(req.headers.host ?? '').toLowerCase();
    const hosts = this.public ? [this.public.host.toLowerCase()] : [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
    if (!hosts.includes(host)) return rejectUpgrade(socket, 403, 'Forbidden');
    if (req.headers.origin !== undefined) return rejectUpgrade(socket, 403, 'Forbidden');
    const bad = checkUpgrade(req);
    if (bad) return rejectUpgrade(socket, bad.status, bad.message, bad.headers);
    let path = String(req.url ?? '').split('?')[0];
    if (this.basePath) {
      if (!path.startsWith(`${this.basePath}/`)) return rejectUpgrade(socket, 404, 'Not found');
      path = path.slice(this.basePath.length);
    }
    if (!path.startsWith(PATH_PREFIX)) return rejectUpgrade(socket, 404, 'Not found');
    if (this.conns.size >= MAX_CONNECTIONS) return rejectUpgrade(socket, 503, 'Too many connections');
    const token = path.slice(PATH_PREFIX.length);
    const conn = acceptUpgrade(req, socket, head, this.connectionOptions);
    this.conns.add(conn);
    conn.once('close', () => this.conns.delete(conn));
    try {
      this.onConnection(token, conn);
    } catch (err) {
      this.logger.error(`поток сообщений: ${err?.stack ?? err}`);
      conn.close(1011, 'Internal error');
    }
  }

  // Соединения после апгрейда сервер не закрывает сам и ждёт их в close(): рвём все
  // (вежливое закрытие — забота владельца, до вызова stop) и ждём недолго.
  async stop() {
    const s = this.server;
    this.server = null;
    this.port = null;
    for (const conn of this.conns) conn.terminate(1001, 'server stopped');
    this.conns.clear();
    if (!s) return;
    s.closeAllConnections?.();
    await Promise.race([new Promise((resolve) => s.close(() => resolve())), new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS))]);
  }
}
