// Серверная сторона WebSocket (RFC 6455) — ровно то, что нужно потоку событий:
// рукопожатие, текстовые кадры сервер → клиент, ping/pong и закрытие. Кадры от
// клиента принимаются (обязательно маскированные), но их данные не нужны:
// поток односторонний. Расширения (сжатие) и подпротоколы не поддерживаются —
// клиент без них обязан работать.

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

// Коды закрытия: стандартные и свои (4000–4999 — для приложений).
export const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  policyViolation: 1008,
  tooBig: 1009,
  abnormal: 1006,
};

const MAX_CONTROL_PAYLOAD = 125;
const MAX_REASON_BYTES = 123;
const CLOSE_TIMEOUT_MS = 3000;

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function acceptKey(key) {
  return createHash('sha1').update(`${key}${GUID}`).digest('base64');
}

function headerHas(value, token) {
  return String(value ?? '')
    .toLowerCase()
    .split(',')
    .some((part) => part.trim() === token);
}

// Годится ли запрос для перехода на WebSocket: null или { status, message }.
export function checkUpgrade(req) {
  if (req.method !== 'GET') return { status: 405, message: 'WebSocket handshake must be a GET request' };
  if (!headerHas(req.headers.upgrade, 'websocket')) return { status: 426, message: 'Expected Upgrade: websocket' };
  if (!headerHas(req.headers.connection, 'upgrade')) return { status: 400, message: 'Expected Connection: Upgrade' };
  if (String(req.headers['sec-websocket-version'] ?? '').trim() !== '13') {
    return { status: 426, message: 'Unsupported WebSocket version: 13 is required', headers: { 'Sec-WebSocket-Version': '13' } };
  }
  const key = String(req.headers['sec-websocket-key'] ?? '').trim();
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, 'base64').length !== 16) {
    return { status: 400, message: 'Invalid Sec-WebSocket-Key' };
  }
  return null;
}

const STATUS_TEXT = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  426: 'Upgrade Required',
  503: 'Service Unavailable',
};

// Ответ на апгрейд без перехода: обычный HTTP, затем сокет закрывается.
export function rejectUpgrade(socket, status, message, headers = {}) {
  // У сокета апгрейда нет обработчика ошибок: сброс соединения клиентом уронил бы процесс.
  if (!socket.listenerCount('error')) socket.on('error', () => {});
  const body = `${message}\n`;
  const lines = [
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}`,
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Cache-Control: no-store',
    'Connection: close',
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
  ];
  socket.end(`${lines.join('\r\n')}\r\n\r\n${body}`);
}

export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode; // FIN: сервер кадры не дробит
  return Buffer.concat([head, data]);
}

function closePayload(code, reason = '') {
  let text = Buffer.from(String(reason), 'utf8');
  // Причина — не больше 123 байт и без разрезанного пополам символа UTF-8.
  if (text.length > MAX_REASON_BYTES) {
    let s = String(reason);
    while (Buffer.byteLength(s) > MAX_REASON_BYTES) s = s.slice(0, -1);
    text = Buffer.from(s, 'utf8');
  }
  const out = Buffer.alloc(2 + text.length);
  out.writeUInt16BE(code, 0);
  text.copy(out, 2);
  return out;
}

// Коды, которые можно передавать в кадре закрытия (RFC 6455, 7.4).
function validCloseCode(code) {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
}

// Разбор кадров от клиента. Буферизует неполные кадры; бросает ProtocolError.
export class FrameParser {
  constructor({ maxPayload = 64 * 1024, requireMask = true } = {}) {
    this.maxPayload = maxPayload;
    this.requireMask = requireMask;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const frames = [];
    for (;;) {
      const frame = this.next();
      if (!frame) break;
      frames.push(frame);
    }
    return frames;
  }

  next() {
    const b = this.buffer;
    if (b.length < 2) return null;
    const fin = Boolean(b[0] & 0x80);
    if (b[0] & 0x70) throw new ProtocolError(CLOSE.protocolError, 'reserved bits are set');
    const opcode = b[0] & 0x0f;
    if (![0x0, 0x1, 0x2, 0x8, 0x9, 0xa].includes(opcode)) throw new ProtocolError(CLOSE.protocolError, `unknown opcode ${opcode}`);
    const masked = Boolean(b[1] & 0x80);
    if (this.requireMask && !masked) throw new ProtocolError(CLOSE.protocolError, 'client frames must be masked');
    let len = b[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(this.maxPayload)) throw new ProtocolError(CLOSE.tooBig, 'frame is too big');
      len = Number(big);
      offset = 10;
    }
    if (opcode >= 0x8) {
      if (!fin) throw new ProtocolError(CLOSE.protocolError, 'fragmented control frame');
      if (len > MAX_CONTROL_PAYLOAD) throw new ProtocolError(CLOSE.protocolError, 'control frame is too big');
    }
    if (len > this.maxPayload) throw new ProtocolError(CLOSE.tooBig, 'frame is too big');
    const maskLen = masked ? 4 : 0;
    if (b.length < offset + maskLen + len) return null;
    const payload = Buffer.from(b.subarray(offset + maskLen, offset + maskLen + len));
    if (masked) {
      const mask = b.subarray(offset, offset + 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    this.buffer = b.subarray(offset + maskLen + len);
    return { fin, opcode, payload };
  }
}

// Одно соединение. События: 'close' (code, reason) — ровно один раз.
export class WsConnection extends EventEmitter {
  constructor(socket, { maxPayload = 64 * 1024, pingIntervalMs = 30_000, pongTimeoutMs = 75_000, maxBufferedBytes = 4 * 1024 * 1024 } = {}) {
    super();
    this.socket = socket;
    this.parser = new FrameParser({ maxPayload });
    this.maxBufferedBytes = maxBufferedBytes;
    this.state = 'open'; // open → closing (мы отправили close) → closed
    this.closeInfo = null;
    this.lastSeen = Date.now();
    this.closeTimer = null;
    socket.setNoDelay?.(true);
    socket.setKeepAlive?.(true, 30_000);
    socket.on('data', (chunk) => this.onData(chunk));
    // Сброс после обмена кадрами close — обычное дело: код берём из кадра.
    socket.on('error', () => this.finish(this.closeInfo?.code ?? CLOSE.abnormal, this.closeInfo?.reason ?? 'connection error'));
    socket.on('close', () => this.finish(this.closeInfo?.code ?? CLOSE.abnormal, this.closeInfo?.reason ?? ''));
    socket.on('end', () => socket.end());
    this.pingTimer = setInterval(() => {
      if (this.state !== 'open') return;
      if (Date.now() - this.lastSeen > pongTimeoutMs) {
        this.terminate(CLOSE.abnormal, 'no answer to ping');
        return;
      }
      this.write(OPCODE.ping, Buffer.alloc(0));
    }, pingIntervalMs);
    this.pingTimer.unref?.();
  }

  // Клиент мог закрыть свою сторону (FIN без кадра close): писать уже некуда.
  get open() {
    return this.state === 'open' && this.socket.writable && !this.socket.destroyed;
  }

  write(opcode, payload) {
    if (this.socket.destroyed || !this.socket.writable) return false;
    // Клиент не читает: не копим память бесконечно.
    if (this.socket.writableLength > this.maxBufferedBytes) {
      this.terminate(CLOSE.abnormal, 'client is not reading');
      return false;
    }
    this.socket.write(encodeFrame(opcode, payload));
    return true;
  }

  sendText(text) {
    if (!this.open) return false;
    return this.write(OPCODE.text, Buffer.from(text, 'utf8'));
  }

  // Закрытие по правилам: кадр close, ждём ответный close, потом рвём сокет.
  close(code = CLOSE.normal, reason = '') {
    if (this.state !== 'open') return;
    this.state = 'closing';
    this.closeInfo = { code, reason };
    this.write(OPCODE.close, closePayload(code, reason));
    this.closeTimer = setTimeout(() => this.socket.destroy(), CLOSE_TIMEOUT_MS);
    this.closeTimer.unref?.();
  }

  terminate(code = CLOSE.abnormal, reason = '') {
    if (!this.closeInfo) this.closeInfo = { code, reason };
    this.socket.destroy();
    this.finish(code, reason);
  }

  onData(chunk) {
    this.lastSeen = Date.now();
    // После ошибки протокола данные не разбираем: иначе испорченный заголовок так и
    // лежал бы в начале буфера, а всё присланное копилось бы за ним.
    if (!this.parser || this.state === 'closed') return;
    let frames;
    try {
      frames = this.parser.push(chunk);
    } catch (err) {
      this.parser = null;
      if (err instanceof ProtocolError) {
        this.close(err.code, err.message);
      } else {
        this.terminate(CLOSE.abnormal, err.message);
      }
      return;
    }
    for (const f of frames) {
      if (this.state === 'closed') return;
      if (f.opcode === OPCODE.ping) {
        if (this.state === 'open') this.write(OPCODE.pong, f.payload);
      } else if (f.opcode === OPCODE.close) {
        const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : CLOSE.normal;
        const reason = f.payload.length > 2 ? f.payload.subarray(2).toString('utf8') : '';
        if (this.state === 'open') {
          // Клиент закрывает первым: отвечаем тем же кодом и закрываем сокет.
          this.state = 'closing';
          this.closeInfo = { code: f.payload.length >= 2 ? code : CLOSE.normal, reason };
          this.write(OPCODE.close, f.payload.length >= 2 && validCloseCode(code) ? closePayload(code) : Buffer.alloc(0));
        }
        this.socket.end();
        this.closeTimer ??= setTimeout(() => this.socket.destroy(), CLOSE_TIMEOUT_MS);
        this.closeTimer.unref?.();
        return;
      }
      // Текстовые и двоичные кадры, pong: поток односторонний, содержимое не нужно.
    }
  }

  finish(code, reason) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    clearInterval(this.pingTimer);
    clearTimeout(this.closeTimer);
    this.emit('close', code, reason);
  }
}

// Переход на WebSocket: ответ 101 и соединение. head — уже прочитанные байты после заголовков.
export function acceptUpgrade(req, socket, head, options) {
  const accept = acceptKey(String(req.headers['sec-websocket-key']).trim());
  socket.write(
    ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'),
  );
  const conn = new WsConnection(socket, options);
  if (head?.length) conn.onData(head);
  return conn;
}
