// Состояние коннектора и вход в аккаунты.

import { maskPhone } from '../accounts.js';
import { SETTING_TITLES } from '../config.js';
import { ToolError } from '../mcp.js';
import { TOOL } from '../names.js';
import { LAYER, TELEPROTO_VERSION } from '../tg/lib.js';
import { VERSION } from '../version.js';
import { reply, schema } from './common.js';

export default function statusTools(services) {
  const { config, accounts, policy, login, logger } = services;

  function accountList() {
    let defaultName = null;
    try {
      defaultName = accounts.list().length ? accounts.resolveName() : null;
    } catch {
      defaultName = null;
    }
    return accounts.list().map((a) => ({
      name: a.name,
      user: a.user ? [a.user.first_name, a.user.last_name].filter(Boolean).join(' ') || undefined : undefined,
      username: a.user?.username ? `@${a.user.username}` : undefined,
      id: a.user?.id ? Number(a.user.id) : undefined,
      phone: maskPhone(a.user?.phone) ?? undefined,
      default: a.name === defaultName || undefined,
      read_only: accounts.isReadOnly(a.name) || undefined,
      status: accounts.status(a.name),
    }));
  }

  return [
    {
      name: TOOL.status,
      title: 'Connector status',
      capability: 'always',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        'Connector state: connected Telegram accounts (which is the default, which are read-only), what the settings allow and forbid, chat restrictions, file folders and limits. check: true connects to each account to verify its session.',
      inputSchema: schema({ check: { type: 'boolean', description: 'Connect to every account and verify it is still logged in.' } }),
      handler: async (args) => {
        const list = accountList();
        if (args.check) {
          // Не просто подключение из кэша, а запрос к Telegram: так видно завершённые сессии.
          for (const a of list) {
            try {
              const ctx = await accounts.check(a.name);
              a.status = 'ok';
              a.premium = ctx.me.premium || undefined;
            } catch (err) {
              a.status = `error: ${err.message}`;
            }
          }
        }
        const lists = (entries) => (entries.length ? entries.map((e) => e.raw) : undefined);
        const problems = [...config.problems, ...accounts.inviteProblems()];
        return reply(services, {
          connector: `telegram-mcp ${VERSION} (teleproto ${TELEPROTO_VERSION}, API layer ${LAYER})`,
          api_credentials: config.hasApiCredentials ? 'set' : `missing: fill «${SETTING_TITLES.api_id}» and «${SETTING_TITLES.api_hash}» in the extension settings`,
          accounts: list,
          hint: list.length ? undefined : 'No accounts yet: call open_login_page and let the user log in on the page that opens.',
          permissions: policy.summary(),
          chats: {
            only_these_visible: lists(config.chats.visible),
            hidden: lists(config.chats.hidden),
            writable_only: lists(config.chats.writable),
            always_hidden: config.allowServiceChat ? undefined : 'Telegram service notifications (777000, login codes)',
          },
          files: {
            upload_folders: config.uploadDirs.length ? config.uploadDirs : 'none (sending local files is disabled)',
            download_folder: config.downloadDir,
          },
          limits: { actions_per_minute: config.actionsPerMinute },
          voice_transcription: config.transcription.enabled
            ? `${config.transcription.service} (${config.transcription.model})`
            : `off: the user can add a key in «${SETTING_TITLES.transcribe_api_key}»`,
          proxy: config.proxy ? (config.proxy.MTProxy ? 'MTProxy' : `SOCKS${config.proxy.socksType}`) : undefined,
          test_servers: config.testServers || undefined,
          settings_problems: problems.length ? problems : undefined,
        });
      },
    },

    {
      name: TOOL.login,
      title: 'Open login page',
      capability: 'always',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        'Open a local page (in the browser) where the user logs in to a Telegram account by QR code or phone number + code (+ 2FA password), or logs out of connected accounts. Codes and passwords go straight to Telegram, never through this chat — never ask the user for them here. Call when the user wants to add or re-login an account, or when a tool says the account is logged out.',
      inputSchema: schema({
        account: { type: 'string', maxLength: 40, description: 'Suggested name for the account (e.g. "work"); the user can change it on the page.' },
        open_browser: { type: 'boolean', description: 'Open the page in the default browser (default true).' },
      }),
      handler: async (args) => {
        if (!config.hasApiCredentials) {
          throw new ToolError(
            `API ID and API Hash are not set. Ask the user to create them at https://my.telegram.org (API development tools) and fill «${SETTING_TITLES.api_id}» and «${SETTING_TITLES.api_hash}» in the Telegram extension settings in Claude Desktop.`,
          );
        }
        const base = await login.start();
        const url = args.account ? `${base}#account=${encodeURIComponent(args.account)}` : base;
        const opened = args.open_browser === false ? false : services.openUrl(url, logger);
        return [
          `Login page: ${url}`,
          opened ? 'It has been opened in the browser.' : 'Give this link to the user to open in a browser on this computer.',
          'The user logs in there with a QR code (Telegram on the phone → Settings → Devices → Link Desktop Device) or with the phone number and the code from Telegram, plus the cloud password if set. Do not ask for codes or passwords in the chat.',
          'When the user says they are done, call connector_status to confirm the account is connected. The page works only on this computer and closes after 30 minutes of inactivity.',
        ].join('\n');
      },
    },
  ];
}
