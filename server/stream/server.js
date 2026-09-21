// Локальный сервер потока сообщений: ws://127.0.0.1:<порт>/messages/<токен>.
// Слушает только 127.0.0.1, принимает только WebSocket, проверяет Host (защита от
// DNS rebinding) и не пускает браузеры: они всегда присылают Origin, а клиенту
// Monitor он не нужен. Кого пускать по токену, решает владелец (onConnection).

import http from 'node:http';

import { acceptUpgrade, checkUpgrade, rejectUpgrade } from './websocket.js';

const PATH_PREFIX = '/messages/';
const MAX_CONNECTIONS = 64;
const STOP_TIMEOUT_MS = 500;

export class StreamServer {
  // onConnection(token, conn) — соединение уже открыто; дальше его судьба —
  // забота владельца (например, закрыть с кодом 4004 для неизвестного токена).
  constructor({ logger, onConnection, connectionOptions = {} }) {
    this.logger = logger;
    this.onConnection = onConnection;
    this.connectionOptions = connectionOptions;
    this.server = null;
    this.port = null;
    this.starting = null;
    this.conns = new Set();
  }

  get running() {
    return Boolean(this.server);
  }

  url(token) {
    return `ws://127.0.0.1:${this.port}${PATH_PREFIX}${token}`;
  }

  async start() {
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
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return rejectUpgrade(socket, 403, 'Forbidden');
    if (req.headers.origin !== undefined) return rejectUpgrade(socket, 403, 'Forbidden');
    const bad = checkUpgrade(req);
    if (bad) return rejectUpgrade(socket, bad.status, bad.message, bad.headers);
    const path = String(req.url ?? '').split('?')[0];
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
