// Чаты: список, папки, сведения, поиск, участники, контакты, вступление и выход.

import { ToolError } from '../mcp.js';
import { TOOL } from '../names.js';
import { toToolError } from '../tg/errors.js';
import { chatKind, chatRef, describeEntity, formatStatus, isoDate, markedIdString, previewMessage, senderRef, truncate } from '../tg/format.js';
import { Api, bigInt } from '../tg/lib.js';
import { checkInvite, parseChatRef } from '../tg/peers.js';
import { ACCOUNT, CHAT, DESTRUCTIVE, READ, WRITE, account, chat, reply, schema } from './common.js';

const MAX_SCAN = 3000;

function isMuted(dialog) {
  const until = dialog?.notifySettings?.muteUntil;
  return Boolean(until && until * 1000 > Date.now());
}

function inputChannel(input) {
  return new Api.InputChannel({ channelId: input.channelId, accessHash: input.accessHash });
}

function inputUser(input) {
  if (input instanceof Api.InputPeerSelf) return new Api.InputUserSelf();
  return new Api.InputUser({ userId: input.userId, accessHash: input.accessHash });
}

async function getFolders(acc) {
  const r = await acc.invoke(new Api.messages.GetDialogFilters());
  return (r.filters ?? r).filter((f) => f instanceof Api.DialogFilter || f instanceof Api.DialogFilterChatlist);
}

function folderTitle(f) {
  return typeof f.title === 'string' ? f.title : f.title?.text ?? '';
}

function peerIdOf(acc, input) {
  if (input instanceof Api.InputPeerSelf) return acc.selfId;
  try {
    return markedIdString(input);
  } catch {
    return null;
  }
}

// Входит ли диалог в папку: явные списки, затем категории и исключения.
export function folderMatcher(acc, f) {
  const ids = (list) => new Set((list ?? []).map((p) => peerIdOf(acc, p)).filter(Boolean));
  const pinned = ids(f.pinnedPeers);
  const include = ids(f.includePeers);
  const exclude = ids(f.excludePeers);
  return (d) => {
    const id = markedIdString(d.entity);
    if (pinned.has(id) || include.has(id)) return true;
    if (exclude.has(id) || f instanceof Api.DialogFilterChatlist) return false;
    const e = d.entity;
    let byCategory = false;
    if (e instanceof Api.User) {
      if (e.bot) byCategory = f.bots;
      else if (e.contact || e.self) byCategory = f.contacts;
      else byCategory = f.nonContacts;
    } else if (e instanceof Api.Chat || (e instanceof Api.Channel && !e.broadcast)) byCategory = f.groups;
    else if (e instanceof Api.Channel) byCategory = f.broadcasts;
    if (!byCategory) return false;
    if (f.excludeMuted && isMuted(d.dialog)) return false;
    if (f.excludeRead && !d.dialog?.unreadCount && !d.dialog?.unreadMark && !d.dialog?.unreadMentionsCount) return false;
    if (f.excludeArchived && d.dialog?.folderId === 1) return false;
    return true;
  };
}

async function findFolder(acc, ref) {
  const folders = await getFolders(acc);
  const s = String(ref).trim().toLowerCase();
  const f = folders.find((x) => String(x.id) === s) ?? folders.find((x) => folderTitle(x).toLowerCase() === s);
  if (!f) {
    throw new ToolError(`No folder "${ref}". Folders: ${folders.map((x) => `${x.id} "${folderTitle(x)}"`).join(', ') || 'none'}.`);
  }
  return f;
}

function typeMatches(entity, type) {
  if (!type || type === 'all') return true;
  const kind = chatKind(entity);
  if (type === 'users') return kind === 'user' || kind === 'self';
  if (type === 'bots') return kind === 'bot';
  if (type === 'groups') return kind === 'group' || kind === 'supergroup';
  if (type === 'channels') return kind === 'channel';
  return true;
}

function describeDialog(acc, d) {
  const out = chatRef(d.entity);
  const dl = d.dialog ?? {};
  if (dl.unreadCount) out.unread = dl.unreadCount;
  if (dl.unreadMentionsCount) out.mentions = dl.unreadMentionsCount;
  if (dl.unreadReactionsCount) out.reactions = dl.unreadReactionsCount;
  if (dl.unreadMark) out.marked_unread = true;
  if (dl.pinned) out.pinned = true;
  if (isMuted(dl)) out.muted = true;
  if (dl.folderId === 1) out.archived = true;
  const last = previewMessage(d.message, acc.lookupFn);
  if (last) out.last = last;
  return out;
}

export default function chatTools(services) {
  const { policy } = services;
  return [
    {
      name: TOOL.listChats,
      title: 'List chats',
      capability: 'read',
      annotations: READ,
      description:
        'List the account\'s chats (dialogs) newest first, like the Telegram chat list: id, type, title, @username, unread counters and a preview of the last message. Filters: unread_only, type, query (title/username substring), folder (chat folder id or title, see list_chat_folders), archived. Use offset for the next page.',
      inputSchema: schema({
        account: ACCOUNT,
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many chats to return (default 30).' },
        offset: { type: 'integer', minimum: 0, description: 'Skip this many matching chats (paging).' },
        unread_only: { type: 'boolean', description: 'Only chats with unread messages, mentions or an unread mark.' },
        type: { type: 'string', enum: ['all', 'users', 'bots', 'groups', 'channels'], description: 'Chat type filter.' },
        query: { type: 'string', description: 'Only chats whose title or @username contains this text (case-insensitive).' },
        folder: { type: ['string', 'integer'], description: 'Chat folder id or title.' },
        archived: { type: 'boolean', description: 'Archived chats instead of the main list.' },
      }),
      handler: async (args) => {
        const acc = await account(services, args);
        // Среди чатов мог появиться чат по ссылке-приглашению из списков чатов.
        await acc.refreshInvites?.();
        const limit = args.limit ?? 30;
        const offset = args.offset ?? 0;
        const folder = args.folder !== undefined ? await findFolder(acc, args.folder) : null;
        const inFolder = folder ? folderMatcher(acc, folder) : null;
        const q = args.query?.trim().toLowerCase();
        const iterParams = folder && args.archived === undefined ? {} : { archived: Boolean(args.archived) };
        const chats = [];
        let skipped = 0;
        let scanned = 0;
        let more = false;
        let stopped = null;
        const deadline = Date.now() + services.config.callBudgetMs - 5000;
        try {
          for await (const d of acc.client.iterDialogs(iterParams)) {
            scanned++;
            if (!d.entity) continue;
            acc.remember([d.entity, d.message?._sender, d.message?._forward?._sender].filter(Boolean));
            // Предел просмотра: без курсора, иначе следующая страница снова упрётся в него.
            if (scanned > MAX_SCAN || Date.now() > deadline) {
              stopped = `Only the first ${scanned - 1} chats were scanned (limit reached); narrow the filters (query, type, folder) to find the rest.`;
              break;
            }
            if (!policy.isVisible(d.entity, acc)) continue;
            if (!typeMatches(d.entity, args.type)) continue;
            const dl = d.dialog ?? {};
            if (args.unread_only && !dl.unreadCount && !dl.unreadMark && !dl.unreadMentionsCount) continue;
            if (q) {
              const hay = [chatRef(d.entity).title, ...(d.entity.usernames ?? []).map((u) => u.username), d.entity.username].filter(Boolean).join(' ').toLowerCase();
              if (!hay.includes(q)) continue;
            }
            if (inFolder && !inFolder(d)) continue;
            if (skipped < offset) {
              skipped++;
              continue;
            }
            if (chats.length >= limit) {
              more = true;
              break;
            }
            chats.push(describeDialog(acc, d));
          }
        } catch (err) {
          throw toToolError(err);
        }
        return reply(
          services,
          {
            account: acc.name,
            folder: folder ? `${folder.id} "${folderTitle(folder)}"` : undefined,
            chats,
            next_offset: more ? offset + chats.length : undefined,
            note: stopped ?? undefined,
          },
          { key: 'chats', keep: 'start', cursor: (kept) => ({ next_offset: offset + kept.length }) },
        );
      },
    },

    {
      name: TOOL.listFolders,
      title: 'List chat folders',
      capability: 'read',
      annotations: READ,
      description: 'List the Telegram account\'s chat folders (id, title, emoji). Pass a folder to list_chats to see its chats.',
      inputSchema: schema({ account: ACCOUNT }),
      handler: async (args) => {
        const acc = await account(services, args);
        const folders = await getFolders(acc);
        return reply(services, {
          account: acc.name,
          folders: folders.map((f) => ({
            id: f.id,
            title: folderTitle(f),
            emoji: f.emoticon || undefined,
            shared: f instanceof Api.DialogFilterChatlist || undefined,
            pinned_chats: f.pinnedPeers?.length || undefined,
            included_chats: f.includePeers?.length || undefined,
          })),
        });
      },
    },

    {
      name: TOOL.getChat,
      title: 'Get chat info',
      capability: 'read',
      annotations: READ,
      description:
        'Detailed info about a Telegram user, bot, group or channel: bio/description, members and online counts, linked discussion group, this account\'s status and rights, pinned message, bot commands, forum topics. Also previews an invite link without joining.',
      inputSchema: schema({ account: ACCOUNT, chat: CHAT }, ['chat']),
      handler: async (args) => {
        const acc = await account(services, args);
        const r = await chat(services, acc, args.chat, { allowInvite: true });
        if (r.invite) {
          const inv = r.invite;
          return reply(services, {
            account: acc.name,
            invite: {
              member: false,
              title: inv.title,
              type: inv.broadcast ? 'channel' : inv.megagroup ? 'supergroup' : 'group',
              about: inv.about,
              members: inv.participantsCount,
              public: inv.public || undefined,
              join_request_needed: inv.requestNeeded || undefined,
              paid_subscription: inv.subscriptionPricing ? true : undefined,
              verified: inv.verified || undefined,
              scam: inv.scam || undefined,
              fake: inv.fake || undefined,
              some_members: (inv.participants ?? []).slice(0, 10).map((u) => senderRef(u)),
            },
            hint: 'Not a member. join_chat with this link joins it (if the user wants).',
          });
        }
        const { entity, input } = r;
        const info = describeEntity(entity);
        try {
          if (entity instanceof Api.User) {
            const full = await acc.invoke(new Api.users.GetFullUser({ id: inputUser(input) }));
            const fu = full.fullUser;
            Object.assign(info, {
              bio: fu.about || undefined,
              common_chats: fu.commonChatsCount || undefined,
              blocked: fu.blocked || undefined,
              pinned_message_id: fu.pinnedMsgId || undefined,
              birthday: fu.birthday ? [fu.birthday.year, fu.birthday.month, fu.birthday.day].filter(Boolean).join('-') : undefined,
              personal_channel_id: fu.personalChannelId ? Number(`-100${fu.personalChannelId}`) : undefined,
              paid_message_stars: fu.sendPaidMessagesStars ? Number(fu.sendPaidMessagesStars) : info.paid_message_stars,
              contact_requires_premium: fu.contactRequirePremium || undefined,
              voice_messages_forbidden: fu.voiceMessagesForbidden || undefined,
            });
            if (fu.botInfo) {
              info.bot_info = {
                description: fu.botInfo.description ? truncate(fu.botInfo.description, 1500) : undefined,
                commands: (fu.botInfo.commands ?? []).map((c) => `/${c.command} — ${c.description}`),
                menu_button: fu.botInfo.menuButton instanceof Api.BotMenuButton ? fu.botInfo.menuButton.text : undefined,
              };
            }
          } else if (entity instanceof Api.Chat) {
            const full = await acc.invoke(new Api.messages.GetFullChat({ chatId: entity.id }));
            const fc = full.fullChat;
            Object.assign(info, {
              about: fc.about || undefined,
              pinned_message_id: fc.pinnedMsgId || undefined,
              invite_link: fc.exportedInvite?.link,
              join_requests_pending: fc.requestsPending || undefined,
            });
            const parts = fc.participants?.participants ?? [];
            if (parts.length) info.members = parts.length;
            if (fc.botInfo?.length) {
              info.bots = fc.botInfo.map((b) => ({ id: Number(b.userId), commands: (b.commands ?? []).map((c) => `/${c.command}`) }));
            }
          } else if (entity instanceof Api.Channel) {
            const full = await acc.invoke(new Api.channels.GetFullChannel({ channel: inputChannel(input) }));
            const fc = full.fullChat;
            Object.assign(info, {
              about: fc.about || undefined,
              members: fc.participantsCount ?? info.members,
              online: fc.onlineCount || undefined,
              admins: fc.adminsCount || undefined,
              banned: fc.bannedCount || undefined,
              linked_chat_id: fc.linkedChatId ? Number(`-100${fc.linkedChatId}`) : undefined,
              slow_mode_seconds: fc.slowmodeSeconds || undefined,
              pinned_message_id: fc.pinnedMsgId || undefined,
              unread: fc.unreadCount || undefined,
              invite_link: fc.exportedInvite?.link,
              join_requests_pending: fc.requestsPending || undefined,
              hidden_history_for_new_members: fc.hiddenPrehistory || undefined,
              members_hidden: fc.participantsHidden || undefined,
              can_view_members: fc.canViewParticipants || undefined,
            });
            if (entity.creator) info.my_role = 'creator';
            else if (entity.adminRights) {
              info.my_role = 'admin';
              info.my_rights = Object.keys(entity.adminRights).filter((k) => entity.adminRights[k] === true);
            } else if (entity.left) info.my_role = 'not a member';
            else info.my_role = entity.broadcast ? 'subscriber' : 'member';
            if (entity.bannedRights && !entity.broadcast) {
              info.my_restrictions = Object.keys(entity.bannedRights).filter((k) => entity.bannedRights[k] === true);
            }
            if (entity.defaultBannedRights && !entity.broadcast) {
              const denied = Object.keys(entity.defaultBannedRights).filter((k) => entity.defaultBannedRights[k] === true);
              if (denied.length) info.members_cannot = denied;
            }
            if (fc.botInfo?.length) {
              info.bots = fc.botInfo.map((b) => ({ id: Number(b.userId), commands: (b.commands ?? []).map((c) => `/${c.command}`) }));
            }
            if (entity.forum) {
              const topics = await acc.invoke(
                new Api.messages.GetForumTopics({ peer: input, offsetDate: 0, offsetId: 0, offsetTopic: 0, limit: 30 }),
              );
              info.topics = (topics.topics ?? [])
                .filter((t) => t instanceof Api.ForumTopic)
                .map((t) => ({ id: t.id, title: t.title, unread: t.unreadCount || undefined, closed: t.closed || undefined, pinned: t.pinned || undefined }));
            }
          }
        } catch (err) {
          const e = toToolError(err);
          info.full_info_error = e.message;
        }
        return reply(services, { account: acc.name, chat: info });
      },
    },

    {
      name: TOOL.searchChats,
      title: 'Search chats',
      capability: 'read',
      annotations: READ,
      description:
        'Find users, bots, groups and channels by name or @username: among the account\'s own chats and contacts, and globally in public Telegram. "member": true marks chats the account is already in.',
      inputSchema: schema(
        {
          account: ACCOUNT,
          query: { type: 'string', minLength: 1, description: 'Name or username to search for.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max results per group (default 20).' },
        },
        ['query'],
      ),
      handler: async (args) => {
        const acc = await account(services, args);
        const limit = args.limit ?? 20;
        const found = await acc.invoke(new Api.contacts.Search({ q: args.query, limit }));
        const describe = (peer, member) => {
          const e = acc.lookup(markedIdString(peer));
          if (!e || !policy.isVisible(e, acc)) return null;
          const out = describeEntity(e);
          const keep = { id: out.id, type: out.type, title: out.title, username: out.username, members: out.members, verified: out.verified, scam: out.scam, fake: out.fake };
          if (member || (!e.left && !(e instanceof Api.User) && !(e instanceof Api.ChannelForbidden))) keep.member = true;
          if (e instanceof Api.User) keep.contact = e.contact || undefined;
          return JSON.parse(JSON.stringify(keep));
        };
        const mine = found.myResults.map((p) => describe(p, true)).filter(Boolean);
        const global = found.results.map((p) => describe(p, false)).filter(Boolean);
        // Результаты — по убыванию соответствия: при обрезке остаются лучшие.
        return reply(services, { account: acc.name, query: args.query, my_chats_and_contacts: mine, global }, { keep: 'start' });
      },
    },

    {
      name: TOOL.getMembers,
      title: 'Get chat members',
      capability: 'read',
      annotations: READ,
      description:
        'Members of a Telegram group or channel with their role (creator/admin/member/banned), admin title and join date. Filter by query or kind. Channel subscribers are visible only to admins.',
      inputSchema: schema(
        {
          account: ACCOUNT,
          chat: CHAT,
          query: { type: 'string', description: 'Search members by name or username.' },
          filter: { type: 'string', enum: ['recent', 'admins', 'bots', 'banned', 'kicked', 'contacts'], description: 'Kind of members (default recent).' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50.' },
          offset: { type: 'integer', minimum: 0 },
        },
        ['chat'],
      ),
      handler: async (args) => {
        const acc = await account(services, args);
        const { entity, input } = await chat(services, acc, args.chat);
        const limit = args.limit ?? 50;
        const offset = args.offset ?? 0;
        const q = args.query ?? '';
        const members = [];
        let total;
        if (entity instanceof Api.Channel) {
          const filters = {
            recent: q ? new Api.ChannelParticipantsSearch({ q }) : new Api.ChannelParticipantsRecent(),
            admins: new Api.ChannelParticipantsAdmins(),
            bots: new Api.ChannelParticipantsBots(),
            banned: new Api.ChannelParticipantsBanned({ q }),
            kicked: new Api.ChannelParticipantsKicked({ q }),
            contacts: new Api.ChannelParticipantsContacts({ q }),
          };
          const r = await acc.invoke(
            new Api.channels.GetParticipants({ channel: inputChannel(input), filter: filters[args.filter ?? 'recent'], offset, limit, hash: bigInt.zero }),
          );
          total = r.count;
          for (const p of r.participants ?? []) {
            const peerId = p.userId !== undefined ? String(p.userId) : markedIdString(p.peer);
            const e = acc.lookup(peerId);
            const role = p instanceof Api.ChannelParticipantCreator
              ? 'creator'
              : p instanceof Api.ChannelParticipantAdmin
                ? 'admin'
                : p instanceof Api.ChannelParticipantBanned
                  ? (p.left ? 'kicked' : 'banned')
                  : p instanceof Api.ChannelParticipantLeft
                    ? 'left'
                    : 'member';
            members.push({
              ...(e ? senderRef(e) : { id: Number(peerId) }),
              role,
              rank: p.rank || undefined,
              since: p.date ? isoDate(p.date) : undefined,
              status: e instanceof Api.User ? formatStatus(e.status) : undefined,
            });
          }
        } else if (entity instanceof Api.Chat) {
          const full = await acc.invoke(new Api.messages.GetFullChat({ chatId: entity.id }));
          const parts = full.fullChat.participants?.participants ?? [];
          total = parts.length;
          const ql = q.toLowerCase();
          for (const p of parts) {
            const e = acc.lookup(String(p.userId));
            const ref = e ? senderRef(e) : { id: Number(p.userId) };
            if (ql && !`${ref.name ?? ''} ${ref.username ?? ''}`.toLowerCase().includes(ql)) continue;
            const role = p instanceof Api.ChatParticipantCreator ? 'creator' : p instanceof Api.ChatParticipantAdmin ? 'admin' : 'member';
            if (args.filter === 'admins' && role === 'member') continue;
            if (args.filter === 'bots' && !(e instanceof Api.User && e.bot)) continue;
            members.push({ ...ref, role, since: p.date ? isoDate(p.date) : undefined });
          }
          members.splice(0, offset);
          members.splice(limit);
        } else {
          throw new ToolError('This is a private chat, not a group or channel.');
        }
        return reply(
          services,
          { account: acc.name, chat: chatRef(entity), total, members, next_offset: total > offset + members.length ? offset + members.length : undefined },
          { key: 'members', keep: 'start', cursor: (kept) => ({ next_offset: offset + kept.length }) },
        );
      },
    },

    {
      name: TOOL.listContacts,
      title: 'List contacts',
      capability: 'read',
      annotations: READ,
      description: 'The account\'s Telegram contacts (optionally filtered by name). Phone numbers are included only with with_phones.',
      inputSchema: schema({
        account: ACCOUNT,
        query: { type: 'string', description: 'Filter by name or username.' },
        with_phones: { type: 'boolean', description: 'Include phone numbers (personal data; only when needed).' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Default 200.' },
      }),
      handler: async (args) => {
        const acc = await account(services, args);
        const r = await acc.invoke(new Api.contacts.GetContacts({ hash: bigInt.zero }));
        const q = args.query?.toLowerCase();
        const users = (r.users ?? [])
          .filter((u) => u instanceof Api.User && policy.isVisible(u, acc))
          .map((u) => ({
            ...senderRef(u),
            phone: args.with_phones && u.phone ? `+${u.phone}` : undefined,
            mutual: u.mutualContact || undefined,
            status: formatStatus(u.status),
          }))
          .filter((u) => !q || `${u.name ?? ''} ${u.username ?? ''}`.toLowerCase().includes(q))
          .sort((a, b) => String(a.name).localeCompare(String(b.name)));
        const limit = args.limit ?? 200;
        return reply(services, { account: acc.name, total: users.length, contacts: users.slice(0, limit) }, { key: 'contacts', keep: 'start' });
      },
    },

    {
      name: TOOL.joinChat,
      title: 'Join chat',
      capability: 'join',
      annotations: WRITE,
      description:
        'Join a public Telegram group or channel (@username or t.me link) or a private one by invite link (t.me/+… or t.me/joinchat/…). Only when the user asked for it. If the chat requires approval, a join request is sent.',
      inputSchema: schema({ account: ACCOUNT, chat: CHAT }, ['chat']),
      handler: async (args) => {
        const acc = await account(services, args, 'join');
        const parsed = parseChatRef(args.chat);
        if (!parsed) throw new ToolError('Pass a @username, t.me link or invite link.');
        let result;
        if (parsed.kind === 'invite') {
          policy.requireInviteNotHidden(parsed.hash);
          const check = await checkInvite(acc, parsed.hash);
          if (check.entity) {
            policy.requireVisible(check.entity, acc);
            if (check.member) return reply(services, { account: acc.name, already_member: true, chat: chatRef(check.entity) });
          } else {
            // Чат ещё неизвестен: сверяем саму ссылку со списками чатов.
            policy.requireInviteAllowed(parsed.hash);
          }
          policy.takeActions(acc.name);
          try {
            result = await acc.client.invoke(new Api.messages.ImportChatInvite({ hash: parsed.hash }));
          } catch (err) {
            if (err?.errorMessage === 'INVITE_REQUEST_SENT') {
              return reply(services, { account: acc.name, join_request_sent: true, note: 'An admin must approve the request.' });
            }
            if (err?.errorMessage === 'USER_ALREADY_PARTICIPANT') return reply(services, { account: acc.name, already_member: true });
            throw toToolError(err);
          }
        } else {
          const { entity, input } = await chat(services, acc, args.chat);
          if (!(entity instanceof Api.Channel)) {
            throw new ToolError(`${chatRef(entity).title} is a ${chatKind(entity)}, not a public group or channel. To talk to a user or bot just send a message (or start_bot).`);
          }
          if (!entity.left) return reply(services, { account: acc.name, already_member: true, chat: chatRef(entity) });
          policy.takeActions(acc.name);
          try {
            result = await acc.client.invoke(new Api.channels.JoinChannel({ channel: inputChannel(input) }));
          } catch (err) {
            if (err?.errorMessage === 'INVITE_REQUEST_SENT') {
              return reply(services, { account: acc.name, join_request_sent: true, chat: chatRef(entity), note: 'An admin must approve the request.' });
            }
            throw toToolError(err);
          }
        }
        if (result instanceof Api.messages.ChatInviteJoinResultWebView) {
          return reply(services, {
            account: acc.name,
            joined: false,
            note: 'Joining requires completing a bot check (Mini App). The user has to do it in the Telegram app.',
          });
        }
        const updates = result?.updates ?? result;
        acc.remember(updates?.users, updates?.chats);
        const joined = (updates?.chats ?? []).find((c) => c instanceof Api.Channel || c instanceof Api.Chat);
        if (joined && parsed.kind === 'invite') {
          acc.inviteIds.set(parsed.hash, markedIdString(joined));
          acc.unresolvedInvites?.delete(parsed.hash);
        }
        return reply(services, { account: acc.name, joined: true, chat: joined ? chatRef(joined) : undefined });
      },
    },

    {
      name: TOOL.leaveChat,
      title: 'Leave chat',
      capability: 'delete',
      annotations: DESTRUCTIVE,
      description:
        'Leave a Telegram group or channel, or delete a private chat / bot dialog from the chat list. Destructive: only on explicit user request. For private chats, for_everyone also deletes the history for the other side.',
      inputSchema: schema(
        {
          account: ACCOUNT,
          chat: CHAT,
          for_everyone: { type: 'boolean', description: 'Private chats only: delete the history for both sides.' },
        },
        ['chat'],
      ),
      handler: async (args) => {
        const acc = await account(services, args, 'delete');
        const { entity, input } = await chat(services, acc, args.chat, { write: true });
        policy.takeActions(acc.name);
        if (entity instanceof Api.Channel) {
          await acc.invoke(new Api.channels.LeaveChannel({ channel: inputChannel(input) }));
          return reply(services, { account: acc.name, left: chatRef(entity) });
        }
        if (entity instanceof Api.Chat) {
          await acc.invoke(new Api.messages.DeleteChatUser({ chatId: entity.id, userId: new Api.InputUserSelf() }));
          return reply(services, { account: acc.name, left: chatRef(entity) });
        }
        if (entity instanceof Api.User) {
          if (entity.self) throw new ToolError('Saved Messages cannot be deleted this way.');
          // Telegram удаляет длинную переписку порциями; укладываемся в отведённое время.
          const deadline = Date.now() + services.config.callBudgetMs - 5000;
          let offset = 0;
          do {
            const r = await acc.invoke(new Api.messages.DeleteHistory({ peer: input, maxId: 0, revoke: Boolean(args.for_everyone) }));
            offset = r.offset;
          } while (offset > 0 && Date.now() < deadline);
          return reply(services, {
            account: acc.name,
            deleted_chat: chatRef(entity),
            for_everyone: Boolean(args.for_everyone),
            note: offset > 0 ? 'The history is long: part of it is still there. Call again to continue deleting.' : undefined,
          });
        }
        throw new ToolError('Unsupported chat type.');
      },
    },
  ];
}
