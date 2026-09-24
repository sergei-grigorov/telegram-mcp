// Локальная страница входа и управления аккаунтами: http://127.0.0.1:<порт>/<токен>/.
// Слушает только 127.0.0.1, требует секретный токен в адресе, проверяет Host и
// Origin (защита от DNS rebinding и чужих страниц), закрывается после простоя.
// У коннектора на сервере (publicUrl) своего порта нет: страница открывается по адресу
// <путь-коннектора>/accounts/ через общий HTTP-сервер (handleMounted), а пускает на неё
// шлюз — только владельца, вошедшего по паролю.

import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';

import { maskPhone } from '../accounts.js';
import { LoginFlow } from './flow.js';
import { renderPage } from './page.js';

const require = createRequire(import.meta.url);
const qrcode = require('qrcode-generator');

const IDLE_MS = 30 * 60_000;
const MAX_BODY = 16 * 1024;

export function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const margin = 4;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
  }
  const size = n + margin * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

// Терминальная версия QR-кода для CLI.
export function qrText(text) {
  const qr = qrcode(0, 'L');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
  const lines = [];
  for (let r = -2; r < n + 2; r += 2) {
    let line = '';
    for (let c = -2; c < n + 2; c++) {
      const top = dark(r, c);
      const bottom = dark(r + 1, c);
      line += top && bottom ? ' ' : top ? '▄' : bottom ? '▀' : '█';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

export function openBrowser(url, logger) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', (err) => logger?.warn(`не удалось открыть браузер: ${err.message}`));
    child.unref();
    return true;
  } catch (err) {
    logger?.warn(`не удалось открыть браузер: ${err.message}`);
    return false;
  }
}

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class LoginServer {
  constructor({ config, accounts, createClient, logger, checkPassword, publicUrl = null }) {
    this.config = config;
    this.publicUrl = publicUrl ? publicUrl.replace(/\/+$/, '') : null;
    this.accounts = accounts;
    this.createClient = createClient;
    this.logger = logger;
    this.checkPassword = checkPassword;
    this.server = null;
    this.token = null;
    this.port = null;
    this.flow = null;
    this.idleTimer = null;
    this.qrCache = { text: null, svg: null };
  }

  get url() {
    if (this.publicUrl) return `${this.publicUrl}/accounts/`;
    return this.server ? `http://127.0.0.1:${this.port}/${this.token}/` : null;
  }

  async start() {
    if (this.publicUrl) return this.url;
    if (this.server) {
      this.touch();
      return this.url;
    }
    this.token = randomBytes(24).toString('base64url');
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.logger.error(`страница входа: ${err?.stack ?? err}`);
        if (!res.headersSent) this.send(res, 500, { error: 'Внутренняя ошибка' });
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    this.port = this.server.address().port;
    this.server.unref();
    this.touch();
    this.logger.info(`страница входа: http://127.0.0.1:${this.port}/…`);
    return this.url;
  }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.flow?.active) return this.touch();
      this.stop();
    }, IDLE_MS);
    this.idleTimer.unref?.();
  }

  async stop() {
    clearTimeout(this.idleTimer);
    this.flow?.cancel();
    const s = this.server;
    this.server = null;
    this.token = null;
    this.port = null;
    if (s) await new Promise((resolve) => s.close(() => resolve()));
  }

  send(res, status, body, type = 'application/json; charset=utf-8', extraHeaders = {}) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      ...extraHeaders,
    });
    res.end(text);
  }

  async readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw Object.assign(new Error('too large'), { status: 413 });
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      throw Object.assign(new Error('bad json'), { status: 400 });
    }
  }

  accountsView() {
    return this.accounts.list().map((a) => ({
      name: a.name,
      user: a.user ? [a.user.first_name, a.user.last_name].filter(Boolean).join(' ') : null,
      username: a.user?.username ?? null,
      phone: maskPhone(a.user?.phone),
      status: this.accounts.status(a.name),
    }));
  }

  flowView() {
    if (!this.flow) return null;
    const s = { ...this.flow.state };
    delete s.pendingError;
    delete s.pendingErrorStep;
    if (s.qr) {
      if (this.qrCache.text !== s.qr) this.qrCache = { text: s.qr, svg: qrSvg(s.qr) };
      s.qr_svg = this.qrCache.svg;
      delete s.qr; // сам токен странице не нужен
    }
    return s;
  }

  async handle(req, res) {
    // Во время остановки токена уже нет: не отвечаем ничего (иначе «/null/…» совпало бы).
    if (!this.token || !this.server) return this.send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    this.touch();
    const host = String(req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return this.send(res, 403, { error: 'forbidden' });
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${this.port}` && origin !== `http://localhost:${this.port}`) {
      return this.send(res, 403, { error: 'forbidden' });
    }
    const url = new URL(req.url, `http://${host}`);
    const parts = url.pathname.split('/').filter(Boolean);
    if (!parts.length || !sameToken(parts[0], this.token)) return this.send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    // Без завершающего «/» относительные адреса api/… страницы не сработают.
    if (req.method === 'GET' && url.pathname === `/${this.token}`) {
      res.writeHead(302, { Location: `/${this.token}/`, 'Cache-Control': 'no-store' });
      return res.end();
    }
    return this.dispatch(req, res, `${req.method} /${parts.slice(1).join('/')}`);
  }

  // Коннектор на сервере: rest — путь после <путь-коннектора>/accounts. Владельца и
  // происхождение запроса (Origin) уже проверили шлюз и HTTP-сервер коннектора.
  async handleMounted(req, res, rest) {
    // Без завершающего «/» относительные адреса api/… страницы не сработают.
    if (req.method === 'GET' && rest === '') {
      res.writeHead(302, { Location: this.url, 'Cache-Control': 'no-store' });
      return res.end();
    }
    return this.dispatch(req, res, `${req.method} ${rest || '/'}`);
  }

  async dispatch(req, res, route) {
    if (route === 'GET /') {
      const nonce = randomBytes(16).toString('base64');
      const remote = this.publicUrl ? { settingsUrl: `${this.publicUrl}/settings` } : null;
      return this.send(res, 200, renderPage({ nonce, remote }), 'text/html; charset=utf-8', {
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
      });
    }
    if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return this.send(res, 415, { error: 'expected JSON' });
    }
    try {
      switch (route) {
        case 'GET /api/state':
          return this.send(res, 200, {
            api_ok: this.config.hasApiCredentials,
            test_servers: this.config.testServers || undefined,
            accounts: this.accountsView(),
            flow: this.flowView(),
          });
        case 'POST /api/start': {
          const body = await this.readJson(req);
          this.flow?.cancel();
          this.flow = new LoginFlow({
            method: body.method,
            accountName: typeof body.account === 'string' ? body.account : '',
            phone: typeof body.phone === 'string' ? body.phone : '',
            config: this.config,
            accounts: this.accounts,
            createClient: this.createClient,
            logger: this.logger,
            ...(this.checkPassword ? { checkPassword: this.checkPassword } : {}),
          });
          this.flow.run();
          return this.send(res, 200, { ok: true, flow: this.flowView() });
        }
        case 'POST /api/submit': {
          const body = await this.readJson(req);
          if (!this.flow || body.id !== this.flow.id) return this.send(res, 409, { error: 'Вход не начат или уже завершён. Начните заново.' });
          try {
            this.flow.submit(String(body.step ?? ''), body.value);
          } catch (err) {
            return this.send(res, 400, { error: err.message });
          }
          return this.send(res, 200, { ok: true, flow: this.flowView() });
        }
        case 'POST /api/cancel':
          this.flow?.cancel();
          return this.send(res, 200, { ok: true, flow: this.flowView() });
        case 'POST /api/logout': {
          const body = await this.readJson(req);
          const name = String(body.account ?? '');
          if (!this.accounts.find(name)) return this.send(res, 404, { error: 'Нет такого аккаунта.' });
          const out = await this.accounts.removeAccount(name, { logout: true });
          return this.send(res, 200, { ok: true, ...out, accounts: this.accountsView() });
        }
        default:
          return this.send(res, 404, { error: 'not found' });
      }
    } catch (err) {
      if (err.status) return this.send(res, err.status, { error: err.message });
      throw err;
    }
  }
}
