// Создание клиента teleproto с настройками коннектора.

import os from 'node:os';

import { Logger, TelegramClient } from './lib.js';

// Журнал teleproto → журнал коннектора (stderr). Сам teleproto пишет в stdout,
// что сломало бы протокол MCP.
class BridgeLogger extends Logger {
  constructor(logger) {
    super(logger.level === 'debug' ? 'debug' : 'warn');
    this._bridge = logger;
  }

  log(level, message, error) {
    const text = `[teleproto] ${message}`;
    if (level === 'error') this._bridge.error(text, error ?? '');
    else if (level === 'warn') this._bridge.warn(text, error ?? '');
    else this._bridge.debug(text, error ?? '');
  }
}

function systemLang() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale.split('-')[0] || 'en';
  } catch {
    return 'en';
  }
}

export function createTelegramClient({ config, session, logger }) {
  if (!config.hasApiCredentials) {
    const err = new Error(
      'API ID and API Hash are not set or invalid. The user must fill them in the Telegram connector settings (values from https://my.telegram.org → API development tools).',
    );
    err.exposed = true;
    throw err;
  }
  const lang = systemLang();
  // В «Устройствах» Telegram сессия видна как устройство «Claude» и приложение
  // «<название приложения с my.telegram.org> Connector» — при названии «Claude»
  // это «Claude Connector».
  const client = new TelegramClient(session, config.apiId, config.apiHash, {
    connectionRetries: 3,
    requestRetries: 3,
    retryDelay: 1000,
    autoReconnect: true,
    // Долгие ожидания FLOOD_WAIT не пересиживаем молча: Claude ждёт ответ меньше минуты,
    // а повтор после таймаута мог бы продублировать действие. Такие ошибки уходят модели.
    floodSleepThreshold: 5,
    // Проверки номеров сессий и повторов сообщений MTProto.
    securityChecks: true,
    timeout: 10,
    deviceModel: 'Claude',
    systemVersion: `${os.type()} ${os.release()}`,
    appVersion: 'Connector',
    langCode: lang,
    systemLangCode: lang,
    baseLogger: new BridgeLogger(logger),
    proxy: config.proxy ?? undefined,
    testServers: config.testServers || undefined,
  });
  client.setParseMode(undefined);
  return client;
}
