#!/usr/bin/env node
// Коннектор Telegram на сервере: MCP по HTTP за шлюзом (gateway). Настройки — на
// странице коннектора, вход в аккаунты — на его странице /accounts/, сессии и файлы —
// в папках сервера. Подробности — README, раздел «На сервере».
//
// Переменные окружения:
//   PUBLIC_URL          — адрес коннектора для Claude, например https://agent.example.com/telegram
//   GATEWAY_SECRET      — общий секрет со шлюзом (или GATEWAY_SECRET_FILE — файл с ним)
//   DATA_DIR            — папка данных: settings.json и accounts/ (сессии), по умолчанию ~/.telegram-mcp
//   FILES_DIR           — папка скачанных и отправляемых файлов, по умолчанию <DATA_DIR>-files
//   HOST, PORT          — где слушать; по умолчанию 127.0.0.1:8080 (в контейнере — 0.0.0.0)
// Остальные переменные (TELEGRAM_LOG_LEVEL и т. п.) действуют как обычно; поля настроек
// из manifest.json → user_config задаются только на странице настроек.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setSettingsPlace } from './config.js';
import { createServer } from './index.js';
import { createLogger } from './log.js';
import { serveFiles } from './remote/files.js';
import { RemoteHost } from './remote/host.js';
import { escapeHtml } from './remote/page.js';
import { SettingsStore } from './remote/settings.js';
import { VERSION } from './version.js';

const logger = createLogger({ level: (process.env.TELEGRAM_LOG_LEVEL || 'info').toLowerCase() });

function fail(message) {
  logger.error(message);
  process.exit(1);
}

function readSecret() {
  if (process.env.GATEWAY_SECRET) return process.env.GATEWAY_SECRET.trim();
  const file = process.env.GATEWAY_SECRET_FILE;
  if (!file) return '';
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    return fail(`GATEWAY_SECRET_FILE: ${err.message}`);
  }
}

const publicUrl = process.env.PUBLIC_URL?.trim();
if (!publicUrl || !/^https?:\/\/[^/]+\/.+/.test(publicUrl)) fail('PUBLIC_URL: нужен адрес коннектора с путём, например https://agent.example.com/telegram');
const gatewaySecret = readSecret();
if (gatewaySecret.length < 32) fail('GATEWAY_SECRET: нужен общий секрет со шлюзом не короче 32 символов');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(os.homedir(), '.telegram-mcp'));
const filesDir = path.resolve(process.env.FILES_DIR || `${dataDir}-files`);
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const base = publicUrl.replace(/\/+$/, '');

setSettingsPlace(`the connector settings page ${base}/settings`);

// Папки на диске на сервере не настраиваются: сессии — в DATA_DIR, файлы — в FILES_DIR
// (туда же download_media сохраняет вложения, и оттуда их можно отправить снова).
const settings = new SettingsStore({
  file: path.join(dataDir, 'settings.json'),
  manifest,
  hidden: ['upload_dirs', 'download_dir'],
  fixedEnv: {
    TELEGRAM_DATA_DIR: dataDir,
    TELEGRAM_DOWNLOAD_DIR: filesDir,
    TELEGRAM_UPLOAD_DIRS: JSON.stringify([filesDir]),
  },
  logger,
});

async function createApp(env) {
  fs.mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  const { server, services, tools, config } = createServer({ env, argv: [], logger, remote: { publicUrl: base } });
  const { accounts, login, stream } = services;
  const on = Object.entries(config.permissions)
    .filter(([, v]) => v)
    .map(([k]) => k);
  logger.info(`аккаунтов: ${accounts.list().length}; разрешено: read${on.length ? `, ${on.join(', ')}` : ''}; инструментов: ${tools.length}`);
  for (const problem of config.problems) logger.warn(problem);
  return {
    mcp: server,
    problems: config.problems,
    routes: {
      '/accounts': (req, res, { rest }) => login.handleMounted(req, res, rest),
      '/files': (req, res, { rest }) => serveFiles(req, res, { dir: filesDir, base: `${new URL(base).pathname}/files`, rest }),
    },
    upgrades: {
      '/messages': (req, socket, head) => stream.server.handleUpgrade(req, socket, head),
    },
    async close() {
      server.closeSubscriptions();
      // Мониторам — кадр close с причиной: модель поймёт, что подписаться нужно заново.
      await stream.stop().catch(() => {});
      await login.stop().catch(() => {});
      await accounts.shutdown().catch(() => {});
    },
  };
}

const settingsPath = new URL(base).pathname;
const host = new RemoteHost({
  title: 'Telegram',
  publicUrl: base,
  gatewaySecret,
  settings,
  createApp,
  logger,
  fieldOptions: {
    visible_chats: { multiline: true },
    hidden_chats: { multiline: true },
    writable_chats: { multiline: true },
  },
  intro:
    `Адрес коннектора для Claude: <b>${escapeHtml(base)}</b>. Настройки, сессии Telegram и скачанные файлы хранятся на этом сервере. ` +
    'Пустое секретное поле оставляет сохранённое значение.',
  links: [
    { href: `${settingsPath}/accounts/`, text: 'Аккаунты Telegram', note: 'вход по QR-коду или номеру, выход' },
    { href: `${settingsPath}/files/`, text: 'Скачанные файлы' },
    { href: '/', text: 'Все коннекторы, подключённые приложения и пароль владельца' },
  ],
});

process.on('unhandledRejection', (err) => logger.error('необработанная ошибка (promise):', err));
process.on('uncaughtException', (err) => logger.error('необработанная ошибка:', err));

const address = await host.start({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 8080) });
logger.info(`v${VERSION} на Node ${process.version}: ${base} ← http://${address.address}:${address.port}; данные: ${dataDir}; файлы: ${filesDir}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 5000).unref();
  await host.stop().catch((err) => logger.error(`остановка: ${err?.message ?? err}`));
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
