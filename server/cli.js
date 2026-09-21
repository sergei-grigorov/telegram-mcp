#!/usr/bin/env node
// Управление аккаунтами из терминала — если удобнее, чем страница входа.
//
//   node server/cli.js login [--account имя] [--qr | --phone +79991234567]
//   node server/cli.js list
//   node server/cli.js logout <имя>
//   node server/cli.js import <имя>     — строка сессии GramJS/Telethon/teleproto
//
// API ID и API Hash берутся из TELEGRAM_API_ID / TELEGRAM_API_HASH или
// спрашиваются. Папка данных — TELEGRAM_DATA_DIR (по умолчанию ~/.telegram-mcp).

import readline from 'node:readline';

import { AccountManager, maskPhone, userInfo, withTimeout } from './accounts.js';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { chooseAccountName, LoginFlow } from './login/flow.js';
import { qrText } from './login/web.js';
import { createTelegramClient } from './tg/client.js';
import { Api, StringSession } from './tg/lib.js';

const out = (s = '') => process.stdout.write(`${s}\n`);

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let prompted = false;
    // Не выводим набранное: печатаем только сам вопрос.
    rl._writeToOutput = (s) => {
      if (!prompted) {
        process.stdout.write(s);
        prompted = true;
      }
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--qr') args.qr = true;
    else if (a === '--account' || a === '--phone') args[a.slice(2)] = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

async function loadCredentials(config) {
  if (config.hasApiCredentials) return config;
  out('Нужны API ID и API Hash с https://my.telegram.org → API development tools.');
  const apiId = Number(await ask('API ID: '));
  const apiHash = (await askHidden('API Hash: ')).trim();
  if (!Number.isInteger(apiId) || !/^[0-9a-f]{32}$/i.test(apiHash)) throw new Error('API ID — число, API Hash — 32 шестнадцатеричных символа.');
  return { ...config, apiId, apiHash, hasApiCredentials: true };
}

async function login(config, accounts, createClient, args) {
  const method = args.qr ? 'qr' : 'phone';
  const phone = method === 'phone' ? args.phone ?? (await ask('Номер телефона (+7…): ')) : '';
  const flow = new LoginFlow({ method, accountName: args.account ?? '', phone, config, accounts, createClient, logger: createLogger({ level: 'error' }) });
  const running = flow.run();
  let lastQr = null;
  const prompts = {
    phone: 'Номер телефона: ',
    code: 'Код из Telegram: ',
    email: 'Почта для входа: ',
    email_code: 'Код из письма: ',
  };
  while (flow.active) {
    const s = flow.state;
    if (s.step === 'qr' && s.qr && s.qr !== lastQr) {
      lastQr = s.qr;
      out('\nОтсканируйте в Telegram на телефоне: Настройки → Устройства → Подключить устройство.\n');
      out(qrText(s.qr));
      out('\n(код обновляется каждые ~30 с)');
    }
    if (flow.pending && flow.pending.step === s.step) {
      if (s.error) out(`! ${s.error}`);
      let value;
      if (s.step === 'password') value = await askHidden(`Облачный пароль${s.hint ? ` (подсказка: ${s.hint})` : ''}: `);
      else {
        if (s.step === 'code') out(s.via === 'app' ? 'Код отправлен в Telegram на другом вашем устройстве.' : 'Код отправлен по SMS.');
        value = await ask(prompts[s.step] ?? `${s.step}: `);
      }
      try {
        flow.submit(s.step, value);
      } catch (err) {
        out(`! ${err.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  await running;
  const s = flow.state;
  if (s.step === 'done') {
    out(`\nГотово: аккаунт «${s.account}» — ${[s.user?.name, s.user?.username ? `@${s.user.username}` : null].filter(Boolean).join(' ')}`);
    if (s.renamed) out(s.renamed);
    return 0;
  }
  out(`\nВход не выполнен: ${s.error ?? s.step}`);
  return 1;
}

async function importSession(config, accounts, createClient, name) {
  const text = (await askHidden('Строка сессии: ')).trim();
  const session = new StringSession(text);
  const client = createClient({ session, testServers: config.testServers });
  try {
    await withTimeout(client.connect(), 30_000, 'Нет связи с Telegram');
    const me = await withTimeout(client.getMe(), 30_000, 'Telegram не ответил');
    if (!(me instanceof Api.User)) throw new Error('Сессия недействительна');
    const info = userInfo(me);
    const finalName = chooseAccountName(name, info, accounts.list());
    await accounts.addAccount({ name: finalName, sessionString: client.session.save(), user: info, testServers: config.testServers });
    out(`Готово: аккаунт «${finalName}» — ${info.first_name ?? ''} ${info.username ? `@${info.username}` : ''}`);
    return 0;
  } finally {
    await client.destroy().catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command, target] = args._;
  if (!command || args.help) {
    out('node server/cli.js login [--account имя] [--qr | --phone +79991234567]');
    out('node server/cli.js list');
    out('node server/cli.js logout <имя>');
    out('node server/cli.js import <имя>');
    return command ? 0 : 1;
  }
  const logger = createLogger({ level: 'warn' });
  let config = loadConfig({ argv: [] });
  const needsApi = ['login', 'import', 'logout'].includes(command);
  if (needsApi) config = await loadCredentials(config);
  const createClient = ({ session, testServers }) =>
    createTelegramClient({ config: { ...config, testServers: testServers ?? config.testServers }, session, logger });
  const accounts = new AccountManager({ config, logger, createClient });
  try {
    switch (command) {
      case 'login':
        return await login(config, accounts, createClient, args);
      case 'list': {
        const list = accounts.list();
        if (!list.length) out('Аккаунтов нет. Войдите: node server/cli.js login');
        for (const a of list) {
          out(`${a.name}\t${[a.user?.first_name, a.user?.last_name].filter(Boolean).join(' ')}\t${a.user?.username ? `@${a.user.username}` : ''}\t${maskPhone(a.user?.phone) ?? ''}`);
        }
        out(`\nПапка: ${config.accountsDir}`);
        return 0;
      }
      case 'logout': {
        if (!target) throw new Error('Укажите имя аккаунта.');
        const r = await accounts.removeAccount(target, { logout: true });
        out(r.loggedOut ? `Аккаунт «${r.name}»: сессия завершена и удалена.` : `Аккаунт «${r.name}» удалён локально (завершить сессию в Telegram не удалось — сделайте это в Настройки → Устройства).`);
        return 0;
      }
      case 'import':
        if (!target) throw new Error('Укажите имя для аккаунта.');
        return await importSession(config, accounts, createClient, target);
      default:
        throw new Error(`Неизвестная команда: ${command}`);
    }
  } finally {
    await accounts.shutdown();
  }
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    process.stderr.write(`Ошибка: ${err.message}\n`);
    process.exit(1);
  },
);
