// Разрешения коннектора: какие действия включены, какие чаты видны и где можно
// писать, какие файлы можно отправлять, сколько действий в минуту.

import fs from 'node:fs';
import path from 'node:path';

import { expandPath, PERMISSIONS, SERVICE_CHAT_ID, SETTING_TITLES } from './config.js';
import { ToolError } from './mcp.js';
import { markedIdString, usernamesOf } from './tg/format.js';
import { Api } from './tg/lib.js';

// Что входит в каждое разрешение — для connector_status и сообщений об отказе.
export const CAPABILITIES = {
  read: 'read chats, messages, members, contacts; search; download media',
  send: 'send, reply, edit, forward, react, pin, vote in polls, mark as read, send files',
  bots: 'press bot buttons, inline queries, start bots',
  join: 'join groups and channels (public or by invite link)',
  delete: 'delete messages, leave chats, delete private chats',
  admin: 'administer chats: ban/restrict/promote members, edit title/description/photo, invite links, create groups and channels',
  profile: 'change own profile, add/delete/block contacts, share own phone number with bots',
  raw: 'call any Telegram API method directly (bypasses the other restrictions)',
};

function settingOf(cap) {
  return `«${SETTING_TITLES[PERMISSIONS[cap].setting]}»`;
}

export class Policy {
  constructor(config, { now = () => Date.now() } = {}) {
    this.config = config;
    this.now = now;
    this.windows = new Map();
  }

  enabled(cap) {
    if (cap === 'read' || cap === 'always') return true;
    return Boolean(this.config.permissions[cap]);
  }

  require(cap) {
    if (this.enabled(cap)) return;
    throw new ToolError(
      `Not allowed by the connector settings: "${CAPABILITIES[cap]}" is disabled. The user can enable ${settingOf(cap)} in the Telegram extension settings in Claude Desktop. Do not try to work around this.`,
    );
  }

  summary() {
    const enabled = [];
    const disabled = [];
    for (const cap of Object.keys(PERMISSIONS)) {
      (this.enabled(cap) ? enabled : disabled).push({ capability: cap, allows: CAPABILITIES[cap], setting: SETTING_TITLES[PERMISSIONS[cap].setting] });
    }
    return { enabled, disabled };
  }

  // ───────────── Списки чатов ─────────────

  identity(entity, acc) {
    const marked = markedIdString(entity);
    const raw = entity.id !== undefined ? String(entity.id) : marked;
    return {
      marked,
      raw,
      self: Boolean(entity.self) || (acc?.selfId !== undefined && marked === acc.selfId),
      usernames: usernamesOf(entity).map((u) => u.toLowerCase()),
      invites: acc?.inviteIds,
    };
  }

  // lenient: «сырой» id (без -100) тоже подходит. Так сверяем только «Скрытые
  // чаты», где лишнее совпадение безопасно; разрешающие списки — строго.
  static matches(entry, ident, lenient = false) {
    if (entry.kind === 'self') return ident.self;
    if (entry.kind === 'username') return ident.usernames.includes(entry.username);
    if (entry.kind === 'id') return entry.id === ident.marked || (lenient && entry.id === ident.raw);
    if (entry.kind === 'invite') return ident.invites?.get(entry.hash) === ident.marked;
    return false;
  }

  inList(list, entity, acc, lenient = false) {
    if (!list.length || !entity) return false;
    const ident = this.identity(entity, acc);
    return list.some((e) => Policy.matches(e, ident, lenient));
  }

  isServiceChat(entity) {
    return entity instanceof Api.User && String(entity.id) === SERVICE_CHAT_ID;
  }

  // Явно закрытый чат: служебный или из «Скрытых чатов».
  isHidden(entity, acc) {
    if (!entity) return false;
    if (!this.config.allowServiceChat && this.isServiceChat(entity)) return true;
    return this.inList(this.config.chats.hidden, entity, acc, true);
  }

  isVisible(entity, acc) {
    if (!entity || this.isHidden(entity, acc)) return false;
    const { visible } = this.config.chats;
    return !visible.length || this.inList(visible, entity, acc);
  }

  isWritable(entity, acc) {
    if (!this.isVisible(entity, acc)) return false;
    const { writable } = this.config.chats;
    return !writable.length || this.inList(writable, entity, acc);
  }

  requireVisible(entity, acc) {
    if (this.isVisible(entity, acc)) return;
    if (entity && this.isServiceChat(entity)) {
      throw new ToolError('The Telegram service notifications chat (777000, login codes) is always hidden by the connector.');
    }
    throw new ToolError(
      'This chat is hidden by the connector settings («Скрытые чаты» / «Только эти чаты»). It cannot be read or used; do not try to access it another way.',
    );
  }

  requireWritable(entity, acc) {
    this.requireVisible(entity, acc);
    if (this.isWritable(entity, acc)) return;
    throw new ToolError(
      'Writing to this chat is not allowed by the connector settings («Писать только в эти чаты»). Reading is allowed.',
    );
  }

  // Ссылка-приглашение из «Скрытых чатов» закрыта всегда — и когда аккаунт уже
  // в чате (даже если id чата по ней ещё не узнан).
  requireInviteNotHidden(hash) {
    if (this.config.chats.hidden.some((e) => e.kind === 'invite' && e.hash === hash)) {
      throw new ToolError('This chat is hidden by the connector settings («Скрытые чаты»).');
    }
  }

  // Приглашение в чат, где аккаунт ещё не состоит: id чата неизвестен, сверяем по ссылке.
  requireInviteAllowed(hash) {
    this.requireInviteNotHidden(hash);
    const { visible } = this.config.chats;
    if (visible.length && !visible.some((e) => e.kind === 'invite' && e.hash === hash)) {
      throw new ToolError('Only the chats listed in «Только эти чаты» are available, and this invite link is not among them.');
    }
  }

  // ───────────── Файлы для отправки ─────────────

  allowedUploadDirs() {
    const out = [];
    for (const d of this.config.uploadDirs) {
      try {
        out.push(fs.realpathSync(d));
      } catch {
        // папки нет — пропускаем
      }
    }
    return out;
  }

  checkUploadPath(p) {
    const dirs = this.allowedUploadDirs();
    if (!dirs.length) {
      throw new ToolError('Sending local files is disabled: no existing folders are set in «Папки для отправки файлов» in the connector settings.');
    }
    const abs = expandPath(p, this.config.home);
    if (!abs) throw new ToolError(`Invalid file path: ${p}`);
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch {
      throw new ToolError(`File not found: ${abs}`);
    }
    const st = fs.statSync(real);
    if (!st.isFile()) throw new ToolError(`Not a regular file: ${abs}`);
    const root = dirs.find((d) => real === d || real.startsWith(d.endsWith(path.sep) ? d : d + path.sep));
    if (!root) {
      throw new ToolError(`The file is outside the folders allowed for sending (${dirs.join(', ')}). The user can add a folder in «Папки для отправки файлов».`);
    }
    const rel = path.relative(root, real);
    if (rel.split(path.sep).some((seg) => seg.startsWith('.'))) {
      throw new ToolError('Hidden files and files inside hidden folders are never sent.');
    }
    let dataDir = this.config.dataDir;
    try {
      dataDir = fs.realpathSync(dataDir);
    } catch {
      // папки данных ещё нет
    }
    // На macOS и Windows файловая система обычно не различает регистр:
    // …/TG-DATA/… — та же папка, что …/tg-data/….
    const fold = (p) => (process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p);
    if (fold(real) === fold(dataDir) || fold(real).startsWith(fold(dataDir) + path.sep)) {
      throw new ToolError('Files of the connector itself (sessions) are never sent.');
    }
    if (st.size === 0) throw new ToolError(`The file is empty: ${real}`);
    return { path: real, size: st.size, name: path.basename(real) };
  }

  // ───────────── Лимит действий ─────────────

  takeActions(account, n = 1) {
    const limit = this.config.actionsPerMinute;
    const now = this.now();
    const key = String(account).toLowerCase();
    const recent = (this.windows.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length + n > limit) {
      const wait = recent.length ? Math.max(1, Math.ceil((60_000 - (now - recent[0])) / 1000)) : 60;
      this.windows.set(key, recent);
      throw new ToolError(
        `Connector rate limit: at most ${limit} actions per minute per account («Лимит действий в минуту»). Wait ${wait} s. This protects the account from Telegram's anti-spam.`,
      );
    }
    for (let i = 0; i < n; i++) recent.push(now);
    this.windows.set(key, recent);
  }
}
