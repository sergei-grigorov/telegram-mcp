// Сообщения: чтение, поиск, отправка, правка, пересылка, удаление, реакции,
// прочтение, закрепление, голосование в опросах.

import { ToolError } from '../mcp.js';
import { TOOL } from '../names.js';
import { toToolError } from '../tg/errors.js';
import { chatRef, describeMedia, formatMessage, markedIdString, parseDate } from '../tg/format.js';
import { Api, bigInt } from '../tg/lib.js';
import { cachedInputPeer } from '../tg/peers.js';
import { buildText, splitMessage } from '../tg/text.js';
import {
  ACCOUNT,
  CHAT,
  DESTRUCTIVE,
  MESSAGE_ID,
  PARSE_MODE,
  READ,
  WRITE,
  account,
  chat,
  fetchHistory,
  formatMessages,
  getMessage,
  getMessagesByIds,
  header,
  latestMessageId,
  messageIdFrom,
  messagesFromUpdates,
  reply,
  requireMessagesInChat,
  schema,
  sleep,
  visibleMessages,
} from './common.js';

const FILTERS = {
  photo: () => new Api.InputMessagesFilterPhotos(),
  video: () => new Api.InputMessagesFilterVideo(),
  photo_video: () => new Api.InputMessagesFilterPhotoVideo(),
  document: () => new Api.InputMessagesFilterDocument(),
  url: () => new Api.InputMessagesFilterUrl(),
  gif: () => new Api.InputMessagesFilterGif(),
  voice: () => new Api.InputMessagesFilterVoice(),
  music: () => new Api.InputMessagesFilterMusic(),
  round_video: () => new Api.InputMessagesFilterRoundVideo(),
  mentions: () => new Api.InputMessagesFilterMyMentions(),
  pinned: () => new Api.InputMessagesFilterPinned(),
  poll: () => new Api.InputMessagesFilterPoll(),
  location: () => new Api.InputMessagesFilterGeo(),
  contact: () => new Api.InputMessagesFilterContacts(),
  chat_photo: () => new Api.InputMessagesFilterChatPhotos(),
  call: () => new Api.InputMessagesFilterPhoneCalls({}),
};

const POLL_INTERVAL_MS = 1500;

function inputChannel(input) {
  return new Api.InputChannel({ channelId: input.channelId, accessHash: input.accessHash });
}

async function resolveUserInput(services, acc, ref) {
  const r = await chat(services, acc, ref, { track: false });
  return r.input;
}

export default function messageTools(services) {
  const { policy } = services;
  return [
    {
      name: TOOL.getMessages,
      title: 'Get messages',
      capability: 'read',
      annotations: READ,
      description:
        'Read messages of a Telegram chat, oldest→newest: text (Markdown), sender, replies, media, buttons, reactions. Without min_id: the latest messages; next_offset_id → pass as offset_id for older ones. With min_id: messages right after it, oldest first; next_min_id → pass as min_id for the following ones. thread: comments of a channel post or a forum topic. ids: specific messages. wait_seconds waits for new messages (after min_id, or after the latest one) — use after messaging a bot or pressing a button. Does not mark messages as read.',
      inputSchema: schema(
        {
          account: ACCOUNT,
          chat: CHAT,
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 20.' },
          offset_id: { type: 'integer', minimum: 0, description: 'Return messages older than this id.' },
          min_id: { type: 'integer', minimum: 0, description: 'Return only messages newer than this id.' },
          ids: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 100, description: 'Fetch exactly these message ids.' },
          thread: { type: 'integer', minimum: 1, description: 'Replies to this message: comments of a channel post, or a forum topic id.' },
          from_user: { type: ['string', 'integer'], description: 'Only messages from this user (id or @username).' },
          wait_seconds: { type: 'integer', minimum: 0, maximum: 40, description: 'If nothing newer than min_id yet, wait up to this long for new messages.' },
        },
        ['chat'],
      ),
      handler: async (args, { signal }) => {
        const acc = await account(services, args);
        const r = await chat(services, acc, args.chat);
        const thread = args.thread ?? r.topicId;
        const ids = args.ids ?? (r.messageId && args.offset_id === undefined && args.min_id === undefined ? [r.messageId] : undefined);
        let messages;
        let total;
        let full = false;
        let forward = false;
        const limit = args.limit ?? 20;
        if (ids?.length) {
          messages = await getMessagesByIds(acc, r.input, ids);
          messages.sort((a, b) => a.id - b.id);
        } else {
          const fromUser = args.from_user !== undefined ? await resolveUserInput(services, acc, args.from_user) : undefined;
          let minId = args.min_id ?? 0;
          const wait = args.wait_seconds ?? 0;
          if (wait > 0 && !minId) minId = await latestMessageId(acc, r.input, thread);
          forward = minId > 0 && !args.offset_id;
          const deadline = Date.now() + Math.min(wait * 1000, services.config.callBudgetMs);
          const page = () => fetchHistory(acc, r.input, { limit, offsetId: args.offset_id ?? 0, minId, thread, fromUser });
          let res = await page();
          while (wait > 0 && !(res.messages ?? []).length && Date.now() + POLL_INTERVAL_MS < deadline) {
            await sleep(POLL_INTERVAL_MS, signal);
            res = await page();
          }
          messages = (res.messages ?? []).slice().reverse();
          total = res.count;
          full = messages.length === limit;
        }
        const formatted = formatMessages(acc, messages);
        // Назад листаем от самого старого показанного, вперёд — от самого нового.
        const cursorFrom = (kept) => (forward ? { next_min_id: kept[kept.length - 1].id } : { next_offset_id: kept[0].id });
        return reply(
          services,
          {
            ...header(acc, r.entity),
            thread: thread || undefined,
            total,
            messages: formatted,
            ...(full && formatted.length ? cursorFrom(formatted) : {}),
            waited: args.wait_seconds && !messages.length ? `no new messages in ${args.wait_seconds} s` : undefined,
          },
          // Если ответ пришлось укоротить, недостающие сообщения достаются по курсору.
          { key: 'messages', keep: forward ? 'start' : 'end', cursor: ids?.length ? undefined : cursorFrom },
        );
      },
    },

    {
      name: TOOL.searchMessages,
      title: 'Search messages',
      capability: 'read',
      annotations: READ,
      description:
        'Search Telegram messages by text in one chat (with chat) or across all of the account\'s chats (without chat). Optional filters: sender (in-chat only), media type, dates. Results newest first; continue with next_offset.',
      inputSchema: schema({
        account: ACCOUNT,
        query: { type: 'string', description: 'Text to search for (may be empty when a filter is given).' },
        chat: { ...CHAT, description: 'Search only in this chat. Omit for a global search across all chats.' },
        from_user: { type: ['string', 'integer'], description: 'Only messages from this user (in-chat search only).' },
        filter: { type: 'string', enum: Object.keys(FILTERS), description: 'Only messages with this kind of content.' },
        min_date: { type: 'string', description: 'Not older than this date (ISO 8601).' },
        max_date: { type: 'string', description: 'Not newer than this date (ISO 8601).' },
        scope: { type: 'string', enum: ['all', 'users', 'groups', 'channels'], description: 'Global search only: kind of chats.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 20.' },
        offset: { type: 'string', description: 'next_offset from the previous page.' },
      }),
      handler: async (args) => {
        const acc = await account(services, args);
        const q = args.query ?? '';
        if (!q && !args.filter && !args.from_user) throw new ToolError('Give a query, a filter or from_user.');
        const limit = args.limit ?? 20;
        const filter = args.filter ? FILTERS[args.filter]() : new Api.InputMessagesFilterEmpty();
        const minDate = parseDate(args.min_date, 'min_date') ?? 0;
        const maxDate = parseDate(args.max_date, 'max_date') ?? 0;
        if (args.chat !== undefined) {
          const r = await chat(services, acc, args.chat);
          const fromId = args.from_user !== undefined ? await resolveUserInput(services, acc, args.from_user) : undefined;
          const offsetId = args.offset ? Number(args.offset) || 0 : 0;
          const res = await acc.invoke(
            new Api.messages.Search({
              peer: r.input,
              q,
              fromId,
              topMsgId: r.topicId,
              filter,
              minDate,
              maxDate,
              offsetId,
              addOffset: 0,
              limit,
              maxId: 0,
              minId: 0,
              hash: bigInt.zero,
            }),
          );
          const messages = formatMessages(acc, res.messages ?? []);
          const cursorFrom = (kept) => ({ next_offset: String(kept[kept.length - 1].id) });
          return reply(
            services,
            {
              ...header(acc, r.entity),
              query: q,
              total: res.count,
              messages,
              ...(messages.length === limit ? cursorFrom(messages) : {}),
            },
            { key: 'messages', keep: 'start', cursor: cursorFrom },
          );
        }
        if (args.from_user !== undefined) throw new ToolError('from_user works only together with chat.');
        // Курсор глобального поиска: rate:peer:id
        let offsetRate = 0;
        let offsetPeer = new Api.InputPeerEmpty();
        let offsetId = 0;
        if (args.offset) {
          const [rate, peer, id] = args.offset.split(':');
          offsetRate = Number(rate) || 0;
          offsetId = Number(id) || 0;
          offsetPeer = (peer && cachedInputPeer(acc, peer)) || offsetPeer;
        }
        const res = await acc.invoke(
          new Api.messages.SearchGlobal({
            q,
            filter,
            minDate,
            maxDate,
            offsetRate,
            offsetPeer,
            offsetId,
            limit,
            broadcastsOnly: args.scope === 'channels' || undefined,
            groupsOnly: args.scope === 'groups' || undefined,
            usersOnly: args.scope === 'users' || undefined,
          }),
        );
        const raw = res.messages ?? [];
        const messages = visibleMessages(services, acc, res, { withChat: true });
        // Курсор страницы — по последнему сообщению ответа (в том числе скрытому);
        // если ответ укорочен — по последнему показанному.
        const byKey = new Map(raw.map((m) => [`${markedIdString(m.peerId)}:${m.id}`, m]));
        const cursorOf = (m, rate) => `${rate ?? m.date}:${markedIdString(m.peerId)}:${m.id}`;
        const last = raw[raw.length - 1];
        const more = Boolean(res.nextRate) || raw.length === limit;
        return reply(
          services,
          {
            account: acc.name,
            query: q,
            scope: args.scope ?? 'all',
            total: res.count,
            messages,
            next_offset: more && last ? cursorOf(last, res.nextRate) : undefined,
          },
          {
            key: 'messages',
            keep: 'start',
            cursor: (kept) => {
              const k = kept[kept.length - 1];
              const m = byKey.get(`${k.chat?.id}:${k.id}`);
              return m ? { next_offset: cursorOf(m) } : {};
            },
          },
        );
      },
    },

    {
      name: TOOL.sendMessage,
      title: 'Send message',
      capability: 'send',
      annotations: WRITE,
      description:
        'Send a Telegram text message as the user (optionally as a reply, silently, into a forum topic, or scheduled). Texts over 4096 characters are split into several messages. Only send what the user asked for; if the recipient or wording is uncertain, confirm first.',
      inputSchema: schema(
        {
          account: ACCOUNT,
          chat: CHAT,
          text: { type: 'string', minLength: 1, maxLength: 40000, description: 'Message text.' },
          parse_mode: PARSE_MODE,
          reply_to: { type: 'integer', minimum: 1, description: 'Reply to this message id.' },
          quote: { type: 'string', description: 'With reply_to: quote this exact fragment of the replied message.' },
          topic: { type: 'integer', minimum: 1, description: 'Forum topic id (for forum groups).' },
          silent: { type: 'boolean', description: 'Send without notification.' },
          link_preview: { type: 'boolean', description: 'Show a link preview (default true).' },
          schedule_at: { type: 'string', description: 'Schedule for this time (ISO 8601) instead of sending now.' },
        },
        ['chat', 'text'],
      ),
      handler: async (args, { signal }) => {
        const acc = await account(services, args, 'send');
        const r = await chat(services, acc, args.chat, { write: true });
        if (args.reply_to) await requireMessagesInChat(acc, r, [args.reply_to]);
        const [text, entities] = await buildText(acc, args.text, args.parse_mode);
        if (!text) throw new ToolError('The message is empty after formatting.');
        const parts = splitMessage(text, entities);
        const schedule = parseDate(args.schedule_at, 'schedule_at');
        if (parts.length > services.config.actionsPerMinute) {
          throw new ToolError(
            `The text needs ${parts.length} messages, more than the connector allows per minute (${services.config.actionsPerMinute}, «Лимит действий в минуту»). Shorten it or send it in several calls.`,
          );
        }
        policy.takeActions(acc.name, parts.length);
        const sent = [];
        try {
          for (let i = 0; i < parts.length; i++) {
            // «Стоп» в Claude: оставшиеся части не отправляем.
            if (signal?.aborted) throw new ToolError('Cancelled.');
            const [t, e] = parts[i];
            const m = await acc.client.sendMessage(r.input, {
              message: t,
              formattingEntities: e,
              replyTo: i === 0 ? args.reply_to : undefined,
              quoteText: i === 0 && args.reply_to ? args.quote : undefined,
              topMsgId: args.topic ?? r.topicId,
              silent: args.silent,
              linkPreview: args.link_preview ?? true,
              schedule,
            });
            sent.push(m ? { id: m.id, date: formatMessage(m).date } : { status: 'sent; Telegram did not return the message id' });
          }
        } catch (err) {
          const e = toToolError(err);
          if (sent.length) e.message = `${e.message} (${sent.length} of ${parts.length} parts were sent before that: ids ${sent.map((s) => s.id).join(', ')}; do not resend them)`;
          throw e;
        }
        return reply(services, { ...header(acc, r.entity), scheduled: schedule ? true : undefined, sent });
      },
    },

    {
      name: TOOL.editMessage,
      title: 'Edit message',
      capability: 'send',
      annotations: WRITE,
      description: 'Edit the text (or caption) of a Telegram message sent by this account.',
      inputSchema: schema(
        {
          account: ACCOUNT,
          chat: CHAT,
          message_id: MESSAGE_ID,
          text: { type: 'string', minLength: 1, maxLength: 4096, description: 'New text.' },
          parse_mode: PARSE_MODE,
          link_preview: { type: 'boolean', description: 'Show a link preview (default true).' },
        },
        ['chat', 'text'],
      ),
      handler: async (args) => {
        const acc = await account(services, args, 'send');
        const r = await chat(services, acc, args.chat, { write: true });
        const id = messageIdFrom(args, r);
        const [text, entities] = await buildText(acc, args.text, args.parse_mode);
        if (!text) throw new ToolError('The text is empty after formatting.');
        await requireMessagesInChat(acc, r, [id]);
        policy.takeActions(acc.name);
        let m;
        try {
          m = await acc.client.editMessage(r.input, { message: id, text, formattingEntities: entities, linkPreview: args.link_preview ?? true });
        } catch (err) {
          throw toToolError(err);
        }
        return reply(services, { ...header(acc, r.entity), edited: m ? formatMessages(acc, [m])[0] : { id } });
      },
    },

    {
      name: TOOL.forwardMessages,
      title: 'Forward messages',
      capability: 'send',
      annotations: WRITE,
      description:
        'Forward Telegram messages from one chat to another. as_copy sends them without the "Forwarded from" header (like a copy). Protected chats do not allow forwarding.',
      inputSchema: schema(
        {
          account: ACCOUNT,
          from_chat: CHAT,
          message_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 100 },
          to_chat: CHAT,
          as_copy: { type: 'boolean', description: 'Hide the original author (send as a copy).' },
          drop_captions: { type: 'boolean', description: 'With as_copy: remove media captions.' },
          topic: { type: 'integer', minimum: 1, description: 'Forum topic id in the target chat.' },
          silent: { type: 'boolean' },
        },
        ['from_chat', 'message_ids', 'to_chat'],
      ),
      handler: async (args) => {
        const acc = await account(services, args, 'send');
        const from = await chat(services, acc, args.from_chat);
        const to = await chat(services, acc, args.to_chat, { write: true });
        await requireMessagesInChat(acc, from, args.message_ids);
        policy.takeActions(acc.name);
        const updates = await acc.invoke(
          new Api.messages.ForwardMessages({
            fromPeer: from.input,
            id: args.message_ids,
            toPeer: to.input,
            dropAuthor: args.as_copy || undefined,
            dropMediaCaptions: (args.as_copy && args.drop_captions) || undefined,
            silent: args.silent || undefined,
            topMsgId: args.topic ?? to.topicId,
          }),
        );
        const msgs = messagesFromUpdates(acc, updates);
        return reply(services, {
          account: acc.name,
          from: chatRef(from.entity),
          to: chatRef(to.entity),
          forwarded: msgs.map((m) => m.id),
        });
      },
    },

    {
      name: TOOL.deleteMessages,
      title: 'Delete messages',
      capability: 'delete',
      annotations: DESTRUCTIVE,
      description:
        'Delete Telegram messages. Destructive and irreversible: only on explicit user request. In private chats and groups, for_everyone (default true) deletes them for all participants; in channels and supergroups deletion is always for everyone (needs rights for others\' messages).',
      inputSchema: schema(
        {
          account: ACCOUNT,
          chat: CHAT,
          message_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 100 },
          for_everyone: { type: 'boolean', description: 'Default true.' },
        },
        ['chat', 'message_ids'],
      ),
      handler: async (args) => {
        const acc = await account(services, args, 'delete');
        const r = await chat(services, acc, args.chat, { write: true });
        // messages.deleteMessages удаляет по номерам во всём аккаунте — сначала убеждаемся,
        // что все сообщения из этого чата.
        await requireMessagesInChat(acc, r, args.message_ids);
        policy.takeActions(acc.name);
        let res;
        if (r.input instanceof Api.InputPeerChannel) {
          res = await acc.invoke(new Api.channels.DeleteMessages({ channel: inputChannel(r.input), id: args.message_ids }));
        } else {
          res = await acc.invoke(new Api.messages.DeleteMessages({ id: args.message_ids, revoke: args.for_everyone ?? true }));
        }
        return reply(services, { ...header(acc, r.entity), requested: args.message_ids.length, deleted: res.ptsCount });
      },
    },

    {
      name: TOOL.react,
      title: 'React to message',
      capability: 'send',
      annotations: WRITE,
      description: 'Put an emoji reaction on a Telegram message (e.g. "👍", "❤", "🔥"), or remove this account\'s reaction with an empty emoji. Paid reactions are not supported.',
      inputSchema: schema(
        {
          account: ACCOUNT,
          chat: CHAT,
          message_id: MESSAGE_ID,
          emoji: { type: 'string', maxLength: 16, description: 'Reaction emoji; empty string removes the reaction.' },
          big: { type: 'boolean', description: 'Big animated reaction (private chats).' },
        },
        ['chat', 'emoji'],
      ),
      handler: async (args) => {
        const acc = await account(services, args, 'send');
        const r = await chat(services, acc, args.chat, { write: true });
        const id = messageIdFrom(args, r);
        await requireMessagesInChat(acc, r, [id]);
        policy.takeActions(acc.name);
        const emoji = args.emoji.trim();
        await acc.invoke(
          new Api.messages.SendReaction({
            peer: r.input,
            msgId: id,
            reaction: emoji ? [new Api.ReactionEmoji({ emoticon: emoji })] : [],
            big: args.big || undefined,
            addToRecent: true,
          }),
        );
        return reply(services, { ...header(acc, r.entity), message_id: id, reaction: emoji || 'removed' });
      },
    },

    {
      name: TOOL.markRead,
      title: 'Mark as read',
      capability: 'send',
      annotations: WRITE,
      description: 'Mark a Telegram chat as read (senders will see read receipts), also clearing unread mentions and reactions.',
      inputSchema: schema(
        {
          account: ACCOUNT,
          chat: CHAT,
          max_id: { type: 'integer', minimum: 1, description: 'Read up to this message id (default: everything).' },
        },
        ['chat'],
      ),
      handler: async (args) => {
        const acc = await account(services, args, 'send');
        // Отметка о прочтении видна собеседникам — это действие, как и отправка.
        const r = await chat(services, acc, args.chat, { write: true });
        policy.takeActions(acc.name);
        const maxId = args.max_id ?? (await latestMessageId(acc, r.input));
        if (r.input instanceof Api.InputPeerChannel) {
          await acc.invoke(new Api.channels.ReadHistory({ channel: inputChannel(r.input), maxId }));
        } else {
          await acc.invoke(new Api.messages.ReadHistory({ peer: r.input, maxId }));
        }
        await acc.invoke(new Api.messages.ReadMentions({ peer: r.input })).catch(() => {});
        await acc.invoke(new Api.messages.ReadReactions({ peer: r.input })).catch(() => {});
        return reply(services, { ...header(acc, r.entity), read_up_to: maxId });
      },
    },

    {
      name: TOOL.pinMessage,
      title: 'Pin message',
      capability: 'send',
      annotations: WRITE,
      description: 'Pin or unpin a Telegram message (in groups and channels this needs the right to pin).',
      inputSchema: schema(
        {
          account: ACCOUNT,
          chat: CHAT,
          message_id: MESSAGE_ID,
          unpin: { type: 'boolean', description: 'Unpin instead of pin.' },
          notify: { type: 'boolean', description: 'Notify members about the pinned message (default false).' },
          for_me_only: { type: 'boolean', description: 'Private chats: pin only for this account.' },
        },
        ['chat'],
      ),
      handler: async (args) => {
        const acc = await account(services, args, 'send');
        const r = await chat(services, acc, args.chat, { write: true });
        const id = messageIdFrom(args, r);
        await requireMessagesInChat(acc, r, [id]);
        policy.takeActions(acc.name);
        await acc.invoke(
          new Api.messages.UpdatePinnedMessage({
            peer: r.input,
            id,
            unpin: args.unpin || undefined,
            silent: !args.notify || undefined,
            pmOneside: args.for_me_only || undefined,
          }),
        );
        return reply(services, { ...header(acc, r.entity), message_id: id, pinned: !args.unpin });
      },
    },

    {
      name: TOOL.votePoll,
      title: 'Vote in poll',
      capability: 'send',
      annotations: WRITE,
      description: 'Vote in a Telegram poll: options by 0-based index or exact answer text (several for multiple-choice polls). An empty list retracts the vote.',
      inputSchema: schema(
        {
          account: ACCOUNT,
          chat: CHAT,
          message_id: MESSAGE_ID,
          options: { type: 'array', items: { type: ['integer', 'string'] }, maxItems: 10, description: 'Answer indexes or texts.' },
        },
        ['chat', 'options'],
      ),
      handler: async (args) => {
        const acc = await account(services, args, 'send');
        const r = await chat(services, acc, args.chat, { write: true });
        const id = messageIdFrom(args, r);
        const m = await getMessage(acc, r, id);
        if (!(m.media instanceof Api.MessageMediaPoll)) throw new ToolError(`Message ${id} is not a poll.`);
        const answers = m.media.poll.answers;
        const textOf = (a) => (typeof a.text === 'string' ? a.text : a.text?.text ?? '');
        const options = args.options.map((o) => {
          if (typeof o === 'number') {
            if (!answers[o]) throw new ToolError(`No option ${o}: the poll has ${answers.length} options (0-based).`);
            return answers[o].option;
          }
          const a = answers.find((x) => textOf(x).trim().toLowerCase() === String(o).trim().toLowerCase());
          if (!a) throw new ToolError(`No option "${o}". Options: ${answers.map((x, i) => `${i}: ${textOf(x)}`).join('; ')}`);
          return a.option;
        });
        if (options.length > 1 && !m.media.poll.multipleChoice) throw new ToolError('This poll allows only one answer.');
        policy.takeActions(acc.name);
        const updates = await acc.invoke(new Api.messages.SendVote({ peer: r.input, msgId: id, options }));
        let poll = describeMedia(m.media);
        for (const u of updates?.updates ?? []) {
          if (u instanceof Api.UpdateMessagePoll && u.results) {
            poll = describeMedia(new Api.MessageMediaPoll({ poll: u.poll ?? m.media.poll, results: u.results }));
          }
        }
        return reply(services, { ...header(acc, r.entity), message_id: id, voted: options.length > 0, poll });
      },
    },
  ];
}
