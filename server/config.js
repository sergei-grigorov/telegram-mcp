// Настройки коннектора. Источник — переменные окружения и аргументы командной
// строки: Claude Desktop заполняет их из настроек расширения (manifest.json →
// user_config), при ручном подключении их задают в конфигурации клиента.
// Незаполненное необязательное поле Claude Desktop передаёт буквальной строкой
// «${user_config.…}» — такое значение считаем пустым.

import os from 'node:os';
import path from 'node:path';

// Названия настроек так, как их видит пользователь в окне настроек расширения.
export const SETTING_TITLES = {
  api_id: 'API ID',
  api_hash: 'API Hash',
  default_account: 'Аккаунт по умолчанию',
  read_only_accounts: 'Аккаунты только для чтения',
  allow_send: 'Разрешить отправку сообщений',
  allow_bots: 'Разрешить работу с ботами',
  allow_join: 'Разрешить вступать в чаты',
  allow_delete: 'Разрешить удаление и выход из чатов',
  allow_admin: 'Разрешить администрирование чатов',
  allow_profile: 'Разрешить менять профиль и контакты',
  allow_raw_api: 'Разрешить прямые вызовы Telegram API',
  visible_chats: 'Только эти чаты',
  hidden_chats: 'Скрытые чаты',
  writable_chats: 'Писать только в эти чаты',
  upload_dirs: 'Папки для отправки файлов',
  download_dir: 'Папка для скачанных файлов',
  actions_per_minute: 'Лимит действий в минуту',
  proxy: 'Прокси',
};

// Разрешения: ключ → переменная окружения и значение по умолчанию.
export const PERMISSIONS = {
  send: { setting: 'allow_send', env: 'TELEGRAM_ALLOW_SEND', default: true },
  bots: { setting: 'allow_bots', env: 'TELEGRAM_ALLOW_BOTS', default: true },
  join: { setting: 'allow_join', env: 'TELEGRAM_ALLOW_JOIN', default: true },
  delete: { setting: 'allow_delete', env: 'TELEGRAM_ALLOW_DELETE', default: false },
  admin: { setting: 'allow_admin', env: 'TELEGRAM_ALLOW_ADMIN', default: false },
  profile: { setting: 'allow_profile', env: 'TELEGRAM_ALLOW_PROFILE', default: false },
  raw: { setting: 'allow_raw_api', env: 'TELEGRAM_ALLOW_RAW_API', default: false },
};

// Служебный чат Telegram: сюда приходят коды входа. Скрыт всегда.
export const SERVICE_CHAT_ID = '777000';

export function readVar(env, name) {
  const value = env[name];
  if (value == null) return '';
  const s = String(value).trim();
  if (s === '' || /^\$\{[^}]*\}$/.test(s)) return '';
  return s;
}

function readBool(env, name, fallback, problems) {
  const s = readVar(env, name).toLowerCase();
  if (!s) return fallback;
  if (['1', 'true', 'yes', 'on', 'да'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'нет'].includes(s)) return false;
  // Само значение не выводим: в поле мог по ошибке попасть секрет.
  problems.push(`${name}: ожидается true или false; использую ${fallback}`);
  return fallback;
}

function readInt(env, name, fallback, min, max, problems) {
  const s = readVar(env, name);
  if (!s) return fallback;
  const n = Number(s);
  if (!Number.isFinite(n) || n < min || n > max) {
    problems.push(`${name}: ожидается число от ${min} до ${max}; использую ${fallback}`);
    return fallback;
  }
  return Math.round(n);
}

// ${HOME}, ${DOWNLOADS} и ~ в путях: Claude Desktop не всегда подставляет их
// в значения по умолчанию, поэтому раскрываем сами.
export function expandPath(p, home = os.homedir()) {
  let s = String(p).trim();
  if (!s) return '';
  const dirs = {
    HOME: home,
    DESKTOP: path.join(home, 'Desktop'),
    DOCUMENTS: path.join(home, 'Documents'),
    DOWNLOADS: path.join(home, 'Downloads'),
    '/': path.sep,
    pathSeparator: path.sep,
  };
  s = s.replace(/\$\{(HOME|DESKTOP|DOCUMENTS|DOWNLOADS|\/|pathSeparator)\}/g, (_, k) => dirs[k]);
  if (s === '~') s = home;
  else if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(home, s.slice(2));
  if (/\$\{[^}]*\}/.test(s)) return '';
  return path.resolve(s);
}

// Записи списков чатов: @username, t.me/username, числовой id (как в Bot API:
// -100… для каналов и супергрупп, -… для групп), me — «Избранное».
export function parseChatList(value, name, problems) {
  const entries = [];
  if (!value) return entries;
  for (const raw of value.split(/[\s,;]+/)) {
    const item = raw.trim();
    if (!item) continue;
    const lower = item.toLowerCase();
    if (['me', 'self', 'saved', 'избранное'].includes(lower)) {
      entries.push({ kind: 'self', raw: item });
      continue;
    }
    if (/^-?\d{1,20}$/.test(item)) {
      entries.push({ kind: 'id', id: item.replace(/^(-?)0+(?=\d)/, '$1'), raw: item });
      continue;
    }
    // Ссылка на сообщение закрытого канала или группы: t.me/c/<id>/… → -100<id>.
    const privateLink = lower.match(/^(?:https?:\/\/)?(?:www\.)?(?:t(?:elegram)?\.me|telegram\.dog)\/c\/(\d{1,20})(?:\/.*)?$/);
    if (privateLink) {
      entries.push({ kind: 'id', id: `-100${privateLink[1]}`, raw: item });
      continue;
    }
    // Приглашение: чат по нему узнаётся после подключения аккаунта (регистр хеша важен).
    const invite = item.match(/^(?:https?:\/\/)?(?:www\.)?(?:t(?:elegram)?\.me|telegram\.dog)\/(?:\+|joinchat\/)([\w-]{8,})\/?$/i);
    if (invite) {
      entries.push({ kind: 'invite', hash: invite[1], raw: item });
      continue;
    }
    const link = lower.match(/^(?:https?:\/\/)?(?:www\.)?(?:t(?:elegram)?\.me|telegram\.dog)\/([a-z0-9_]{3,32})\/?$/);
    const username = link ? link[1] : lower.replace(/^@/, '');
    if (/^[a-z][a-z0-9_]{2,31}$/.test(username) && !['joinchat', 'c', 's', 'proxy', 'addstickers', 'share'].includes(username)) {
      entries.push({ kind: 'username', username, raw: item });
      continue;
    }
    problems.push(`${name}: «${item.slice(0, 40)}» не похоже на @username, ссылку t.me или числовой id — пропускаю`);
  }
  return entries;
}

function splitNames(value) {
  return value
    .split(/[\s,;]+/)
    .map((s) => s.trim().replace(/^@/, '').toLowerCase())
    .filter(Boolean);
}

// Прокси: socks5://[user:pass@]host:port, socks4://host:port,
// mtproxy://secret@host:port, tg://proxy?server=…&port=…&secret=… (и https://t.me/proxy?…).
export function parseProxy(value) {
  const s = value.trim();
  let url;
  try {
    url = new URL(s.includes('://') ? s : `socks5://${s}`);
  } catch {
    throw new Error('не удалось разобрать адрес прокси');
  }
  const proto = url.protocol.replace(':', '').toLowerCase();
  const isProxyLink = (proto === 'tg' && (url.hostname === 'proxy' || url.pathname.replace(/^\/+/, '') === 'proxy')) ||
    (['http', 'https'].includes(proto) && /^(t\.me|telegram\.me)$/i.test(url.hostname) && url.pathname.replace(/\/+$/, '') === '/proxy');
  if (isProxyLink) {
    const server = url.searchParams.get('server');
    const port = Number(url.searchParams.get('port'));
    const secret = url.searchParams.get('secret');
    if (!server || !port || !secret) throw new Error('в ссылке на прокси нужны server, port и secret');
    return { MTProxy: true, ip: server, port, secret };
  }
  if (!['socks5', 'socks', 'socks5h', 'socks4', 'mtproxy', 'mtproto'].includes(proto)) {
    throw new Error(`тип прокси ${proto} не поддерживается: нужен socks5, socks4 или MTProxy`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('у прокси нужен адрес и порт');
  if (proto === 'socks5' || proto === 'socks' || proto === 'socks5h') {
    const out = { socksType: 5, ip: host, port };
    if (url.username) out.username = decodeURIComponent(url.username);
    if (url.password) out.password = decodeURIComponent(url.password);
    return out;
  }
  if (proto === 'socks4') return { socksType: 4, ip: host, port };
  if (proto === 'mtproxy' || proto === 'mtproto') {
    const secret = decodeURIComponent(url.username || url.searchParams.get('secret') || '');
    if (!secret) throw new Error('у MTProxy нужен secret: mtproxy://secret@host:port');
    return { MTProxy: true, ip: host, port, secret };
  }
  return null;
}

// Папки из аргументов: всё после --upload-dirs до следующего ключа.
function readArgList(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  const out = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j]);
  return out;
}

function readUploadDirs(env, argv, home, problems) {
  let list = readArgList(argv, '--upload-dirs');
  if (list === null) {
    const s = readVar(env, 'TELEGRAM_UPLOAD_DIRS');
    if (!s) return [];
    if (s.startsWith('[')) {
      try {
        list = JSON.parse(s);
      } catch {
        problems.push('TELEGRAM_UPLOAD_DIRS: не удалось разобрать JSON-массив');
        return [];
      }
    } else {
      // Как PATH: через «:» (в Windows — через «;») или с новой строки.
      list = s.split(path.delimiter === ';' ? /[;\n]/ : /[:\n]/);
    }
  }
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string' || /^\$\{[^}]*\}$/.test(item.trim())) continue;
    const p = expandPath(item, home);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

export function loadConfig({ env = process.env, argv = process.argv.slice(2), home = os.homedir() } = {}) {
  const problems = [];

  const apiIdRaw = readVar(env, 'TELEGRAM_API_ID');
  let apiId = null;
  if (apiIdRaw) {
    if (/^\d{1,12}$/.test(apiIdRaw)) apiId = Number(apiIdRaw);
    else problems.push('TELEGRAM_API_ID: ожидается число с my.telegram.org');
  }
  const apiHash = readVar(env, 'TELEGRAM_API_HASH');
  if (apiHash && !/^[0-9a-f]{32}$/i.test(apiHash)) problems.push('TELEGRAM_API_HASH: ожидается 32 шестнадцатеричных символа с my.telegram.org');
  if (!apiId || !apiHash) problems.push('Не заданы API ID и API Hash — вход в аккаунты и работа с Telegram невозможны');

  const permissions = {};
  for (const [key, p] of Object.entries(PERMISSIONS)) permissions[key] = readBool(env, p.env, p.default, problems);

  const dataDir = expandPath(readVar(env, 'TELEGRAM_DATA_DIR') || path.join(home, '.telegram-mcp'), home);
  const downloadDir = expandPath(readVar(env, 'TELEGRAM_DOWNLOAD_DIR'), home) || path.join(home, 'Downloads');

  let proxy = null;
  const proxyRaw = readVar(env, 'TELEGRAM_PROXY');
  if (proxyRaw) {
    try {
      proxy = parseProxy(proxyRaw);
    } catch (err) {
      problems.push(`TELEGRAM_PROXY: ${err.message}; работаю без прокси`);
    }
  }

  const logLevel = (readVar(env, 'TELEGRAM_LOG_LEVEL') || 'info').toLowerCase();

  return {
    apiId,
    apiHash,
    hasApiCredentials: Boolean(apiId && apiHash && /^[0-9a-f]{32}$/i.test(apiHash)),
    dataDir,
    accountsDir: path.join(dataDir, 'accounts'),
    defaultAccount: readVar(env, 'TELEGRAM_DEFAULT_ACCOUNT').replace(/^@/, ''),
    readOnlyAccounts: new Set(splitNames(readVar(env, 'TELEGRAM_READ_ONLY_ACCOUNTS'))),
    permissions,
    chats: {
      visible: parseChatList(readVar(env, 'TELEGRAM_VISIBLE_CHATS'), 'TELEGRAM_VISIBLE_CHATS', problems),
      hidden: parseChatList(readVar(env, 'TELEGRAM_HIDDEN_CHATS'), 'TELEGRAM_HIDDEN_CHATS', problems),
      writable: parseChatList(readVar(env, 'TELEGRAM_WRITABLE_CHATS'), 'TELEGRAM_WRITABLE_CHATS', problems),
    },
    allowServiceChat: readBool(env, 'TELEGRAM_ALLOW_SERVICE_CHAT', false, problems),
    uploadDirs: readUploadDirs(env, argv, home, problems),
    downloadDir,
    actionsPerMinute: readInt(env, 'TELEGRAM_ACTIONS_PER_MINUTE', 20, 1, 1000, problems),
    maxOutputChars: readInt(env, 'TELEGRAM_MAX_OUTPUT_CHARS', 60000, 5000, 1000000, problems),
    maxDownloadMb: readInt(env, 'TELEGRAM_MAX_DOWNLOAD_MB', 500, 1, 4096, problems),
    callBudgetMs: readInt(env, 'TELEGRAM_CALL_BUDGET_MS', 45000, 5000, 600000, problems),
    proxy,
    testServers: readBool(env, 'TELEGRAM_TEST_SERVERS', false, problems),
    logLevel: ['error', 'warn', 'info', 'debug'].includes(logLevel) ? logLevel : 'info',
    home,
    problems,
  };
}
