// Аккаунты Telegram: выбор, подключение по требованию, кэш сущностей.

import { ToolError } from './mcp.js';
import { accountKey, AccountStore, FileSession, validAccountName } from './store.js';
import { isRpcError, rpcCode, toToolError } from './tg/errors.js';
import { markedIdString, maskPhone, usernamesOf } from './tg/format.js';
import { Api } from './tg/lib.js';

export { maskPhone };

const CONNECT_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 15_000;
const INVITE_TIMEOUT_MS = 5_000;
const INVITE_RETRY_MS = 60_000;
const CACHE_LIMIT = 5000;

// Ошибки, после которых сессия недействительна: вход нужно повторить.
export const AUTH_ERRORS = [
  'AUTH_KEY_UNREGISTERED',
  'AUTH_KEY_INVALID',
  'AUTH_KEY_DUPLICATED',
  'SESSION_REVOKED',
  'SESSION_EXPIRED',
  'USER_DEACTIVATED',
  'USER_DEACTIVATED_BAN',
];

export function isAuthError(err) {
  const code = rpcCode(err) ?? err?.code;
  return typeof code === 'string' && AUTH_ERRORS.includes(code);
}

export function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ToolError(message)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

export function userInfo(user) {
  if (!user) return null;
  return {
    id: String(user.id),
    first_name: user.firstName ?? null,
    last_name: user.lastName ?? null,
    username: usernamesOf(user)[0] ?? null,
    phone: user.phone ?? null,
    premium: Boolean(user.premium),
  };
}

// Подключённый аккаунт: клиент, сведения о себе и кэш пользователей и чатов.
export class AccountContext {
  constructor({ name, client, session, me }) {
    this.name = name;
    this.client = client;
    this.session = session;
    this.me = me;
    this.selfId = markedIdString(me);
    this.cache = new Map();
    this.cachedAt = new Map();
    this.dialogsWarmedAt = 0;
    this.inviteIds = new Map(); // хеш приглашения из списков чатов → id чата
    this.unresolvedInvites = new Map(); // хеш → 'not_member' | 'invalid' | 'error'
    this.invitesCheckedAt = 0;
    this.refreshInvites = null;
    this.onAuthError = null;
    this.remember([me]);
  }

  // Запоминает пользователей и чаты из ответа Telegram (users/chats).
  remember(...lists) {
    const now = Date.now();
    for (const list of lists) {
      for (const e of list ?? []) {
        if (!e || e instanceof Api.UserEmpty || e instanceof Api.ChatEmpty) continue;
        let id;
        try {
          id = markedIdString(e);
        } catch {
          continue;
        }
        // Урезанная («min») запись не должна вытеснять полную.
        const prev = this.cache.get(id);
        if (e.min && prev && !prev.min) continue;
        this.cache.delete(id);
        this.cache.set(id, e);
        this.cachedAt.set(id, now);
      }
    }
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
      this.cachedAt.delete(oldest);
    }
  }

  lookup(id) {
    return this.cache.get(String(id));
  }

  // Функция для format.js
  get lookupFn() {
    return (id) => this.cache.get(String(id));
  }

  async invoke(request) {
    try {
      const result = await this.client.invoke(request);
      if (result && typeof result === 'object') this.remember(result.users, result.chats);
      return result;
    } catch (err) {
      if (isAuthError(err)) this.onAuthError?.(err);
      throw toToolError(err);
    }
  }
}

export class AccountManager {
  constructor({ config, logger, createClient, store }) {
    this.config = config;
    this.logger = logger;
    this.createClient = createClient;
    this.store = store ?? new AccountStore(config.accountsDir, logger);
    this.contexts = new Map();
    this.pending = new Map();
    this.broken = new Map();
  }

  // Все аккаунты из папки данных (перечитывается при каждом вызове: вход мог
  // выполниться в другом процессе, например через CLI).
  list() {
    return this.store.list().map((data) => ({
      name: data.name,
      user: data.user ?? null,
      created: data.created ?? null,
      test_servers: Boolean(data.test_servers),
    }));
  }

  find(ref) {
    if (ref === undefined || ref === null || String(ref).trim() === '') return null;
    const raw = String(ref).trim();
    const key = raw.replace(/^@/, '').toLowerCase();
    const digits = raw.replace(/[\s()+-]/g, '');
    const all = this.list();
    return (
      all.find((a) => accountKey(a.name) === key) ??
      all.find((a) => a.user?.username && a.user.username.toLowerCase() === key) ??
      all.find((a) => a.user?.id && a.user.id === raw) ??
      (/^\d{7,15}$/.test(digits) ? all.find((a) => a.user?.phone && a.user.phone === digits) : undefined) ??
      null
    );
  }

  isReadOnly(name) {
    const a = this.find(name);
    const keys = [accountKey(name)];
    if (a?.user?.username) keys.push(a.user.username.toLowerCase());
    return keys.some((k) => this.config.readOnlyAccounts.has(k));
  }

  describeAvailable() {
    const all = this.list();
    if (!all.length) return 'No Telegram accounts are connected yet. Call open_login_page to add one.';
    return `Connected accounts: ${all.map((a) => a.name + (a.user?.username ? ` (@${a.user.username})` : '')).join(', ')}.`;
  }

  // Имя аккаунта для вызова: явно указанный, иначе из настроек, иначе единственный.
  resolveName(ref) {
    if (ref !== undefined && ref !== null && String(ref).trim() !== '') {
      const a = this.find(ref);
      if (!a) throw new ToolError(`Unknown account "${ref}". ${this.describeAvailable()}`);
      return a.name;
    }
    const all = this.list();
    if (this.config.defaultAccount) {
      const a = this.find(this.config.defaultAccount);
      if (a) return a.name;
      if (all.length === 1) return all[0].name;
      throw new ToolError(
        `The default account "${this.config.defaultAccount}" from the connector settings is not connected. ${this.describeAvailable()} Pass "account" explicitly.`,
      );
    }
    if (all.length === 1) return all[0].name;
    if (!all.length) throw new ToolError(this.describeAvailable());
    throw new ToolError(
      `Several accounts are connected and no default is set. ${this.describeAvailable()} Ask the user which one to use and pass "account".`,
    );
  }

  current(name) {
    return this.contexts.get(accountKey(name));
  }

  // Подключённый аккаунт для инструмента. write: действие что-то меняет.
  async use(ref, { write = false } = {}) {
    const name = this.resolveName(ref);
    if (write && this.isReadOnly(name)) {
      throw new ToolError(
        `Account "${name}" is read-only in the connector settings («Аккаунты только для чтения»). Only reading is allowed with it.`,
      );
    }
    const key = accountKey(name);
    const ready = this.contexts.get(key);
    if (ready) {
      // Вход заново или выход через CLI/страницу в другом процессе: файл изменился.
      const onDisk = this.store.read(name);
      if (onDisk && onDisk.session === ready.session.loadedSession) {
        if (ready.session.keyChanged()) await this.verify(ready);
        if (this.contexts.get(key) === ready) {
          await this.retryInvites(ready);
          return ready;
        }
      } else {
        await this.disconnect(name, { flush: false });
      }
    }
    if (this.pending.has(key)) return this.pending.get(key);
    const task = this._connect(name).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }

  async _connect(name) {
    const data = this.store.read(name);
    if (!data) throw new ToolError(`Account "${name}" not found. ${this.describeAvailable()}`);
    const session = new FileSession({ store: this.store, name: data.name, data, logger: this.logger });
    const client = this.createClient({ session, testServers: Boolean(data.test_servers) });
    try {
      await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, 'Could not connect to Telegram in 20 s. Check the internet connection or the proxy setting.');
      const me = await withTimeout(client.getMe(), REQUEST_TIMEOUT_MS, 'Telegram did not answer in 15 s.');
      if (!(me instanceof Api.User)) throw new ToolError(`Account "${name}": unexpected answer from Telegram.`);
      session.markVerified();
      const info = userInfo(me);
      if (JSON.stringify(info) !== JSON.stringify(data.user)) session.updateMeta({ user: info });
      const ctx = new AccountContext({ name: data.name, client, session, me });
      ctx.onAuthError = (err) => {
        this.markBroken(data.name, rpcCode(err), ctx);
      };
      ctx.refreshInvites = () => this.retryInvites(ctx, { force: true });
      await this.resolveInvites(ctx);
      this.contexts.set(accountKey(name), ctx);
      this.broken.delete(accountKey(name));
      this.logger.info(`аккаунт ${data.name} подключён (id ${info.id})`);
      return ctx;
    } catch (err) {
      session.detach();
      await client.destroy().catch(() => {});
      if (isAuthError(err)) {
        this.broken.set(accountKey(name), rpcCode(err));
        throw new ToolError(
          `Account "${name}" is logged out (${rpcCode(err)}): the session was terminated in Telegram. Call open_login_page to log in again.`,
        );
      }
      throw toToolError(err, `Account "${name}"`);
    }
  }

  // Ключ авторизации сменился (teleproto пересоздаёт его после сбоя): проверяем,
  // что он действует, прежде чем записать в файл; иначе аккаунт считается вышедшим.
  async verify(ctx) {
    try {
      await withTimeout(ctx.client.invoke(new Api.users.GetUsers({ id: [new Api.InputUserSelf()] })), REQUEST_TIMEOUT_MS, 'Telegram did not answer in 15 s.');
      ctx.session.markVerified();
      return true;
    } catch (err) {
      if (isAuthError(err)) {
        await this.markBroken(ctx.name, rpcCode(err), ctx);
        throw new ToolError(`Account "${ctx.name}" is logged out (${rpcCode(err)}). Call open_login_page to log in again.`);
      }
      throw toToolError(err, `Account "${ctx.name}"`);
    }
  }

  // Сессия завершена (например, с телефона): отключаемся, файл не трогаем.
  // failed — подключение, на котором случилась ошибка: если с тех пор аккаунт
  // вошёл заново (новое подключение), трогать новое нельзя.
  async markBroken(name, code, failed) {
    const key = accountKey(name);
    const ctx = this.contexts.get(key);
    if (failed && ctx !== failed) return;
    this.broken.set(key, code ?? 'logged out');
    if (!ctx) return;
    this.contexts.delete(key);
    ctx.session.detach();
    await ctx.client.destroy().catch(() => {});
    this.logger.warn(`аккаунт ${name}: сессия недействительна (${code})`);
  }

  // Проверка аккаунта запросом к Telegram (connector_status с check).
  async check(name) {
    const ctx = await this.use(name);
    await this.verify(ctx);
    return ctx;
  }

  inviteEntries() {
    const { visible, hidden, writable } = this.config.chats;
    return [...visible, ...hidden, ...writable].filter((e) => e.kind === 'invite');
  }

  // Приглашения из списков чатов («Скрытые чаты» и др.) → id чатов этого аккаунта.
  // Пока аккаунт не в чате, id по ссылке не узнать: такие ссылки проверяются
  // снова при загрузке диалогов и списка чатов и не реже раза в минуту.
  async resolveInvites(ctx, hashes = new Set(this.inviteEntries().map((e) => e.hash))) {
    ctx.invitesCheckedAt = Date.now();
    await Promise.allSettled(
      [...hashes].map(async (hash) => {
        try {
          const r = await withTimeout(ctx.client.invoke(new Api.messages.CheckChatInvite({ hash })), INVITE_TIMEOUT_MS, 'timeout');
          if (r?.chat) {
            ctx.remember([r.chat]);
            ctx.inviteIds.set(hash, markedIdString(r.chat));
            ctx.unresolvedInvites.delete(hash);
          } else if (!ctx.inviteIds.has(hash)) {
            ctx.unresolvedInvites.set(hash, 'not_member');
          }
        } catch (err) {
          const code = rpcCode(err);
          if (!ctx.inviteIds.has(hash)) ctx.unresolvedInvites.set(hash, code === 'INVITE_HASH_EXPIRED' || code === 'INVITE_HASH_INVALID' ? 'invalid' : 'error');
          this.logger.warn(`${ctx.name}: приглашение из списков чатов не распознано (${code ?? err.message})`);
        }
      }),
    );
  }

  async retryInvites(ctx, { force = false } = {}) {
    const hashes = [...ctx.unresolvedInvites].filter(([, why]) => why !== 'invalid').map(([hash]) => hash);
    if (!hashes.length || (!force && Date.now() - ctx.invitesCheckedAt < INVITE_RETRY_MS)) return;
    await this.resolveInvites(ctx, hashes);
  }

  // Ссылки из списков чатов, ещё не сопоставленные с чатами (для connector_status).
  inviteProblems() {
    const links = new Map(this.inviteEntries().map((e) => [e.hash, e.raw]));
    const out = [];
    for (const ctx of this.contexts.values()) {
      for (const [hash, why] of ctx.unresolvedInvites) {
        const link = links.get(hash) ?? `t.me/+${hash}`;
        out.push(
          why === 'invalid'
            ? `${ctx.name}: ссылка ${link} из списков чатов недействительна или устарела — укажите вместо неё @username или id чата`
            : `${ctx.name}: чат по ссылке ${link} из списков чатов пока не опознан (аккаунт не состоит в нём или Telegram не ответил); после вступления он опознаётся при следующей загрузке диалогов. Надёжнее указать @username или id чата`,
        );
      }
    }
    return out;
  }

  // Новый или повторный вход: сохраняет сессию и сбрасывает старое подключение.
  async addAccount({ name, sessionString, user, testServers = false }) {
    if (!validAccountName(name)) throw new ToolError(`Invalid account name "${name}"`);
    const prev = this.store.read(name);
    await this.disconnect(name, { flush: false });
    this.store.write(name, {
      version: 1,
      session: sessionString,
      user,
      test_servers: Boolean(testServers),
      created: prev?.created ?? new Date().toISOString(),
      entities: prev && prev.user?.id === user?.id ? prev.entities : [],
    });
    this.broken.delete(accountKey(name));
    return this.find(name);
  }

  // Выход: завершает сессию в Telegram (если получится) и удаляет файл.
  async removeAccount(name, { logout = true } = {}) {
    const a = this.find(name);
    if (!a) throw new ToolError(`Unknown account "${name}"`);
    let loggedOut = false;
    if (logout) {
      try {
        const ctx = await this.use(a.name);
        await withTimeout(ctx.client.invoke(new Api.auth.LogOut()), REQUEST_TIMEOUT_MS, 'timeout');
        loggedOut = true;
      } catch (err) {
        this.logger.warn(`выход из ${a.name} в Telegram не удался: ${err.message}`);
      }
    }
    await this.disconnect(a.name, { flush: false });
    this.store.remove(a.name);
    this.broken.delete(accountKey(a.name));
    return { name: a.name, loggedOut };
  }

  async disconnect(name, { flush = true } = {}) {
    const key = accountKey(name);
    const ctx = this.contexts.get(key);
    if (!ctx) return;
    this.contexts.delete(key);
    if (flush) ctx.session.flush();
    ctx.session.detach();
    await ctx.client.destroy().catch(() => {});
  }

  status(name) {
    const key = accountKey(name);
    if (this.contexts.has(key)) return 'connected';
    if (this.broken.has(key)) return `logged out (${this.broken.get(key)})`;
    return 'not connected yet';
  }

  async shutdown() {
    for (const ctx of this.contexts.values()) {
      try {
        ctx.session.flush();
      } catch {
        // при выходе — не важно
      }
    }
    await Promise.allSettled([...this.contexts.values()].map((c) => c.client.destroy()));
    this.contexts.clear();
  }
}
