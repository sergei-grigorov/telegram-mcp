// Администрирование чатов и создание групп и каналов.

import { ToolError } from '../mcp.js';
import { TOOL } from '../names.js';
import { chatRef, isoDate, parseDate } from '../tg/format.js';
import { Api, CustomFile } from '../tg/lib.js';
import { ACCOUNT, CHAT, DESTRUCTIVE, account, chat, header, reply, schema } from './common.js';

const ADMIN_RIGHTS = {
  change_info: 'changeInfo',
  post_messages: 'postMessages',
  edit_messages: 'editMessages',
  delete_messages: 'deleteMessages',
  ban_users: 'banUsers',
  invite_users: 'inviteUsers',
  pin_messages: 'pinMessages',
  add_admins: 'addAdmins',
  anonymous: 'anonymous',
  manage_call: 'manageCall',
  manage_topics: 'manageTopics',
  post_stories: 'postStories',
  edit_stories: 'editStories',
  delete_stories: 'deleteStories',
};

const BANNED_RIGHTS = {
  send_messages: 'sendMessages',
  send_media: 'sendMedia',
  send_stickers: 'sendStickers',
  send_gifs: 'sendGifs',
  send_games: 'sendGames',
  send_inline: 'sendInline',
  embed_links: 'embedLinks',
  send_polls: 'sendPolls',
  change_info: 'changeInfo',
  invite_users: 'inviteUsers',
  pin_messages: 'pinMessages',
  manage_topics: 'manageTopics',
  send_photos: 'sendPhotos',
  send_videos: 'sendVideos',
  send_roundvideos: 'sendRoundvideos',
  send_audios: 'sendAudios',
  send_voices: 'sendVoices',
  send_docs: 'sendDocs',
  send_plain: 'sendPlain',
  send_reactions: 'sendReactions',
};

const DEFAULT_ADMIN = ['change_info', 'delete_messages', 'ban_users', 'invite_users', 'pin_messages', 'manage_call', 'manage_topics'];
const MUTE = ['send_messages', 'send_media', 'send_stickers', 'send_gifs', 'send_games', 'send_inline', 'send_polls', 'send_photos', 'send_videos', 'send_roundvideos', 'send_audios', 'send_voices', 'send_docs', 'send_plain'];

function rightsObject(names, table, label) {
  const out = {};
  for (const n of names) {
    const key = table[n];
    if (!key) throw new ToolError(`Unknown ${label} "${n}". Known: ${Object.keys(table).join(', ')}`);
    out[key] = true;
  }
  return out;
}

function inputChannel(input) {
  return new Api.InputChannel({ channelId: input.channelId, accessHash: input.accessHash });
}

function inputUser(input) {
  if (input instanceof Api.InputPeerSelf) return new Api.InputUserSelf();
  if (!(input instanceof Api.InputPeerUser)) throw new ToolError('Expected a user.');
  return new Api.InputUser({ userId: input.userId, accessHash: input.accessHash });
}

const ACTIONS = [
  'ban',
  'unban',
  'kick',
  'restrict',
  'unrestrict',
  'promote',
  'demote',
  'set_title',
  'set_description',
  'set_photo',
  'set_slow_mode',
  'set_default_permissions',
  'invite',
  'create_invite_link',
  'approve_join_request',
  'decline_join_request',
];

export default function adminTools(services) {
  const { policy } = services;

  async function userInput(acc, ref) {
    if (ref === undefined || ref === null || ref === '') throw new ToolError('"user" is required for this action.');
    const u = await chat(services, acc, ref, { track: false });
    if (!(u.entity instanceof Api.User)) throw new ToolError(`${chatRef(u.entity).title} is not a user.`);
    return u;
  }

  return [
    {
      name: TOOL.manageChat,
      title: 'Manage chat',
      capability: 'admin',
      annotations: DESTRUCTIVE,
      description:
        'Administer a Telegram group or channel where this account has the rights: ban/unban/kick/restrict/unrestrict a member, promote/demote an admin (rights, rank), set title/description/photo, slow mode, default member permissions, invite users, create an invite link, approve/decline join requests. Only on explicit user request.',
      inputSchema: schema(
        {
          account: ACCOUNT,
          chat: CHAT,
          action: { type: 'string', enum: ACTIONS },
          user: { type: ['string', 'integer'], description: 'Member for ban/unban/kick/restrict/promote/demote/join requests.' },
          users: { type: 'array', items: { type: ['string', 'integer'] }, maxItems: 50, description: 'Users to invite.' },
          until: { type: 'string', description: 'ban/restrict: end date (ISO 8601); omit for forever.' },
          rights: {
            type: 'array',
            items: { type: 'string' },
            description: `promote: admin rights (${Object.keys(ADMIN_RIGHTS).join(', ')}); default ${DEFAULT_ADMIN.join(', ')}. restrict/set_default_permissions: denied rights (${Object.keys(BANNED_RIGHTS).join(', ')}); default for restrict: mute.`,
          },
          rank: { type: 'string', maxLength: 16, description: 'promote: admin title.' },
          title: { type: 'string', maxLength: 128, description: 'set_title: new title; create_invite_link: link name.' },
          description: { type: 'string', maxLength: 255, description: 'set_description: new description.' },
          file: { type: 'string', description: 'set_photo: image path (inside the allowed folders).' },
          seconds: { type: 'integer', enum: [0, 10, 30, 60, 300, 900, 3600], description: 'set_slow_mode: delay between messages, 0 to disable.' },
          expire_at: { type: 'string', description: 'create_invite_link: expiry (ISO 8601).' },
          usage_limit: { type: 'integer', minimum: 1, maximum: 99999, description: 'create_invite_link: max joins.' },
          request_needed: { type: 'boolean', description: 'create_invite_link: joins need admin approval.' },
        },
        ['chat', 'action'],
      ),
      handler: async (args) => {
        const acc = await account(services, args, 'admin');
        const r = await chat(services, acc, args.chat, { write: true });
        const { entity, input } = r;
        const isChannel = entity instanceof Api.Channel;
        const isGroup = entity instanceof Api.Chat;
        if (!isChannel && !isGroup) throw new ToolError('This is a private chat, not a group or channel.');
        const out = { ...header(acc, entity), action: args.action };
        const untilDate = parseDate(args.until, 'until') ?? 0;
        policy.takeActions(acc.name);
        switch (args.action) {
          case 'ban':
          case 'kick': {
            const u = await userInput(acc, args.user);
            if (isGroup) {
              await acc.invoke(new Api.messages.DeleteChatUser({ chatId: entity.id, userId: inputUser(u.input) }));
            } else {
              const rights = new Api.ChatBannedRights({ ...rightsObject(Object.keys(BANNED_RIGHTS), BANNED_RIGHTS, 'right'), viewMessages: true, untilDate: args.action === 'kick' ? 0 : untilDate });
              await acc.invoke(new Api.channels.EditBanned({ channel: inputChannel(input), participant: u.input, bannedRights: rights }));
              if (args.action === 'kick') {
                await acc.invoke(new Api.channels.EditBanned({ channel: inputChannel(input), participant: u.input, bannedRights: new Api.ChatBannedRights({ untilDate: 0 }) }));
              }
            }
            return reply(services, { ...out, user: chatRef(u.entity), until: args.action === 'ban' && untilDate ? isoDate(untilDate) : undefined });
          }
          case 'unban':
          case 'unrestrict': {
            if (!isChannel) throw new ToolError('Basic groups have no ban list; add the user back with action "invite".');
            const u = await userInput(acc, args.user);
            await acc.invoke(new Api.channels.EditBanned({ channel: inputChannel(input), participant: u.input, bannedRights: new Api.ChatBannedRights({ untilDate: 0 }) }));
            return reply(services, { ...out, user: chatRef(u.entity) });
          }
          case 'restrict': {
            if (!isChannel || entity.broadcast) throw new ToolError('Restrictions work only in supergroups.');
            const u = await userInput(acc, args.user);
            const names = args.rights?.length ? args.rights : MUTE;
            const rights = new Api.ChatBannedRights({ ...rightsObject(names, BANNED_RIGHTS, 'right'), untilDate });
            await acc.invoke(new Api.channels.EditBanned({ channel: inputChannel(input), participant: u.input, bannedRights: rights }));
            return reply(services, { ...out, user: chatRef(u.entity), denied: names, until: untilDate ? isoDate(untilDate) : 'forever' });
          }
          case 'promote':
          case 'demote': {
            const u = await userInput(acc, args.user);
            if (isGroup) {
              await acc.invoke(new Api.messages.EditChatAdmin({ chatId: entity.id, userId: inputUser(u.input), isAdmin: args.action === 'promote' }));
              return reply(services, { ...out, user: chatRef(u.entity) });
            }
            const names = args.action === 'promote' ? (args.rights?.length ? args.rights : entity.broadcast ? ['change_info', 'post_messages', 'edit_messages', 'delete_messages', 'invite_users'] : DEFAULT_ADMIN) : [];
            await acc.invoke(
              new Api.channels.EditAdmin({
                channel: inputChannel(input),
                userId: inputUser(u.input),
                adminRights: new Api.ChatAdminRights(rightsObject(names, ADMIN_RIGHTS, 'admin right')),
                rank: args.action === 'promote' ? args.rank ?? '' : '',
              }),
            );
            return reply(services, { ...out, user: chatRef(u.entity), rights: names });
          }
          case 'set_title': {
            if (!args.title) throw new ToolError('"title" is required.');
            if (isChannel) await acc.invoke(new Api.channels.EditTitle({ channel: inputChannel(input), title: args.title }));
            else await acc.invoke(new Api.messages.EditChatTitle({ chatId: entity.id, title: args.title }));
            return reply(services, { ...out, title: args.title });
          }
          case 'set_description': {
            await acc.invoke(new Api.messages.EditChatAbout({ peer: input, about: args.description ?? '' }));
            return reply(services, { ...out, description: args.description ?? '' });
          }
          case 'set_photo': {
            if (!args.file) throw new ToolError('"file" is required.');
            const f = policy.checkUploadPath(args.file);
            const uploaded = await acc.client.uploadFile({ file: new CustomFile(f.name, f.size, f.path), workers: 2 });
            const photo = new Api.InputChatUploadedPhoto({ file: uploaded });
            if (isChannel) await acc.invoke(new Api.channels.EditPhoto({ channel: inputChannel(input), photo }));
            else await acc.invoke(new Api.messages.EditChatPhoto({ chatId: entity.id, photo }));
            return reply(services, { ...out, photo: f.name });
          }
          case 'set_slow_mode': {
            if (!isChannel || entity.broadcast) throw new ToolError('Slow mode works only in supergroups.');
            await acc.invoke(new Api.channels.ToggleSlowMode({ channel: inputChannel(input), seconds: args.seconds ?? 0 }));
            return reply(services, { ...out, seconds: args.seconds ?? 0 });
          }
          case 'set_default_permissions': {
            const names = args.rights ?? [];
            await acc.invoke(
              new Api.messages.EditChatDefaultBannedRights({ peer: input, bannedRights: new Api.ChatBannedRights({ ...rightsObject(names, BANNED_RIGHTS, 'right'), untilDate: 0 }) }),
            );
            return reply(services, { ...out, members_cannot: names });
          }
          case 'invite': {
            const refs = args.users ?? (args.user !== undefined ? [args.user] : []);
            if (!refs.length) throw new ToolError('"users" is required.');
            const users = [];
            for (const ref of refs) users.push(await userInput(acc, ref));
            const missing = [];
            if (isChannel) {
              const res = await acc.invoke(new Api.channels.InviteToChannel({ channel: inputChannel(input), users: users.map((u) => inputUser(u.input)) }));
              for (const m of res.missingInvitees ?? []) missing.push(Number(m.userId));
            } else {
              for (const u of users) {
                const res = await acc.invoke(new Api.messages.AddChatUser({ chatId: entity.id, userId: inputUser(u.input), fwdLimit: 100 }));
                for (const m of res.missingInvitees ?? []) missing.push(Number(m.userId));
              }
            }
            return reply(services, {
              ...out,
              invited: users.map((u) => chatRef(u.entity)).filter((u) => !missing.includes(u.id)),
              not_invited_privacy: missing.length ? missing : undefined,
              note: missing.length ? 'Some users do not allow being added to groups; send them an invite link instead.' : undefined,
            });
          }
          case 'create_invite_link': {
            const link = await acc.invoke(
              new Api.messages.ExportChatInvite({
                peer: input,
                title: args.title,
                expireDate: parseDate(args.expire_at, 'expire_at'),
                usageLimit: args.usage_limit,
                requestNeeded: args.request_needed || undefined,
              }),
            );
            return reply(services, { ...out, link: link.link, expires: link.expireDate ? isoDate(link.expireDate) : undefined, usage_limit: link.usageLimit });
          }
          case 'approve_join_request':
          case 'decline_join_request': {
            const u = await userInput(acc, args.user);
            await acc.invoke(new Api.messages.HideChatJoinRequest({ peer: input, userId: inputUser(u.input), approved: args.action === 'approve_join_request' || undefined }));
            return reply(services, { ...out, user: chatRef(u.entity) });
          }
          default:
            throw new ToolError(`Unknown action ${args.action}`);
        }
      },
    },

    {
      name: TOOL.createChat,
      title: 'Create chat',
      capability: 'admin',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description: 'Create a new Telegram group (supergroup) or channel owned by this account, optionally inviting users. Only on explicit user request.',
      inputSchema: schema(
        {
          account: ACCOUNT,
          type: { type: 'string', enum: ['group', 'channel'], description: 'group (supergroup) or channel.' },
          title: { type: 'string', minLength: 1, maxLength: 128 },
          description: { type: 'string', maxLength: 255 },
          forum: { type: 'boolean', description: 'group: enable forum topics.' },
          users: { type: 'array', items: { type: ['string', 'integer'] }, maxItems: 50, description: 'Users to invite.' },
        },
        ['type', 'title'],
      ),
      handler: async (args) => {
        const acc = await account(services, args, 'admin');
        const users = [];
        for (const ref of args.users ?? []) {
          const u = await chat(services, acc, ref, { track: false });
          if (!(u.entity instanceof Api.User)) throw new ToolError(`${chatRef(u.entity).title} is not a user.`);
          users.push(u);
        }
        policy.takeActions(acc.name);
        const updates = await acc.invoke(
          new Api.channels.CreateChannel({
            title: args.title,
            about: args.description ?? '',
            megagroup: args.type === 'group' || undefined,
            broadcast: args.type === 'channel' || undefined,
            forum: (args.type === 'group' && args.forum) || undefined,
          }),
        );
        const created = (updates.chats ?? []).find((c) => c instanceof Api.Channel);
        if (!created) throw new ToolError('Telegram did not return the new chat.');
        let missing = [];
        if (users.length) {
          const res = await acc.invoke(
            new Api.channels.InviteToChannel({
              channel: new Api.InputChannel({ channelId: created.id, accessHash: created.accessHash }),
              users: users.map((u) => inputUser(u.input)),
            }),
          );
          missing = (res.missingInvitees ?? []).map((m) => Number(m.userId));
        }
        return reply(services, {
          account: acc.name,
          created: chatRef(created),
          invited: users.map((u) => chatRef(u.entity)).filter((u) => !missing.includes(u.id)),
          not_invited_privacy: missing.length ? missing : undefined,
        });
      },
    },
  ];
}
