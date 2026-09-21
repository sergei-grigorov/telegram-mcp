// Боты: нажатие кнопок, inline-запросы, /start с параметром, ожидание ответа.

import { ToolError } from '../mcp.js';
import { TOOL } from '../names.js';
import { toToolError } from '../tg/errors.js';
import { buttonKind, chatRef, describeButton, formatMessage, markedIdString, truncate, usernamesOf } from '../tg/format.js';
import { Api, bigInt } from '../tg/lib.js';
import {
  ACCOUNT,
  CHAT,
  MESSAGE_ID,
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
} from './common.js';

const BOT = { type: 'string', description: 'Bot: @username, t.me link or id.' };

function toInputUser(input) {
  if (!(input instanceof Api.InputPeerUser)) throw new ToolError('This is not a bot.');
  return new Api.InputUser({ userId: input.userId, accessHash: input.accessHash });
}

// Кнопка по позиции (строка/столбец с нуля) или по тексту.
export function findButton(markup, { row, col, text }) {
  const rows = markup?.rows?.map((r) => r.buttons) ?? [];
  if (!rows.length) throw new ToolError('This message has no buttons.');
  const flat = rows.flatMap((buttons, r) => buttons.map((b, c) => ({ b, r, c })));
  const listing = () => rows.map((buttons, r) => buttons.map((b, c) => `[${r},${c}] ${b.text}`).join(' | ')).join('\n');
  if (text !== undefined && text !== null && text !== '') {
    const want = String(text).trim();
    const lower = want.toLowerCase();
    const found =
      flat.filter((x) => x.b.text === want)[0] ??
      flat.filter((x) => x.b.text.trim().toLowerCase() === lower)[0] ??
      (() => {
        const partial = flat.filter((x) => x.b.text.toLowerCase().includes(lower));
        if (partial.length > 1) throw new ToolError(`Several buttons contain "${want}":\n${partial.map((x) => `[${x.r},${x.c}] ${x.b.text}`).join('\n')}`);
        return partial[0];
      })();
    if (!found) throw new ToolError(`No button "${want}". Buttons:\n${listing()}`);
    return found;
  }
  if (row === undefined) {
    if (flat.length === 1) return flat[0];
    throw new ToolError(`Specify the button by text or row/col. Buttons:\n${listing()}`);
  }
  const b = rows[row]?.[col ?? 0];
  if (!b) throw new ToolError(`No button at [${row},${col ?? 0}]. Buttons:\n${listing()}`);
  return { b, r: row, c: col ?? 0 };
}

function markupKey(m) {
  return JSON.stringify(m?.replyMarkup?.rows?.map((r) => r.buttons.map((b) => b.text)) ?? null);
}

// Ждёт реакции бота: правки исходного сообщения и новые сообщения после baselineId.
async function awaitBot(acc, input, { messageId, before, baselineId, seconds, signal }) {
  const deadline = Date.now() + seconds * 1000;
  let updated = null;
  let fresh = [];
  let settledAt = 0;
  while (Date.now() < deadline) {
    await sleep(settledAt ? 1500 : 1000, signal);
    if (messageId) {
      const [cur] = await getMessagesByIds(acc, input, [messageId]);
      if (cur && !(cur instanceof Api.MessageEmpty) && (cur.editDate !== before?.editDate || cur.message !== before?.message || markupKey(cur) !== markupKey(before))) {
        updated = cur;
      }
    }
    const h = await fetchHistory(acc, input, { limit: 20, minId: baselineId });
    fresh = (h.messages ?? []).filter((m) => m.id > baselineId && m.id !== messageId).reverse();
    // Своё сообщение (/start, текст кнопки, контакт) — ещё не ответ бота.
    if (updated || fresh.some((m) => !m.out)) {
      if (settledAt) break;
      settledAt = Date.now(); // ещё один круг — бот может прислать несколько сообщений
    }
  }
  return { updated, fresh };
}

export default function botTools(services) {
  const { policy } = services;
  return [
    {
      name: TOOL.pressButton,
      title: 'Press button',
      capability: 'bots',
      annotations: WRITE,
      description:
        'Press a button under a Telegram message (inline keyboard) or on a bot\'s reply keyboard, chosen by text or by row/col (0-based, from the "buttons" of get_messages). Returns the bot\'s answer, the updated message and new messages. URL, login and Mini App buttons are not opened — their links are returned. Payment buttons and buttons that need the 2FA password are refused. Buttons can have real effects (orders, votes, subscriptions): press only what the user wants.',
      inputSchema: schema(
        {
          account: ACCOUNT,
          chat: CHAT,
          message_id: MESSAGE_ID,
          text: { type: 'string', description: 'Button text (exact, case-insensitive or a unique part).' },
          row: { type: 'integer', minimum: 0 },
          col: { type: 'integer', minimum: 0 },
          share_phone: { type: 'boolean', description: 'Allow a "share phone number" button to send this account\'s phone number (needs the profile permission).' },
          wait_seconds: { type: 'integer', minimum: 0, maximum: 30, description: 'How long to wait for the bot\'s reaction (default 5).' },
        },
        ['chat'],
      ),
      handler: async (args, { signal }) => {
        const acc = await account(services, args, 'bots');
        const r = await chat(services, acc, args.chat, { write: true });
        const id = messageIdFrom(args, r);
        const m = await getMessage(acc, r, id);
        const { b, r: row, c: col } = findButton(m.replyMarkup, args);
        const kind = buttonKind(b);
        const t = b.type ?? {};
        const pressed = { row, col, ...describeButton(b) };
        const out = { ...header(acc, r.entity), message_id: id, button: pressed };
        const wait = args.wait_seconds ?? 5;

        switch (kind) {
          case 'url':
            return reply(services, { ...out, url: t.url, note: 'Link button: nothing was opened. Give the link to the user or open it only if they want.' });
          case 'login_url':
            return reply(services, { ...out, url: t.url, note: 'Log-in-with-Telegram button: opening it would authorize a website with this account, so it was not done. The user can open it in Telegram.' });
          case 'web_app':
            return reply(services, { ...out, url: t.url, note: 'Mini App button: it cannot be run by the connector. The user can open it in Telegram.' });
          case 'switch_inline': {
            // Бот — тот, кто прислал сообщение, или тот, через кого оно отправлено (via @bot).
            const botId = m.viaBotId ? String(m.viaBotId) : m.fromId ? markedIdString(m.fromId) : r.entity instanceof Api.User ? String(r.entity.id) : '';
            const botName = usernamesOf(acc.lookup(botId) ?? {})[0];
            return reply(services, {
              ...out,
              inline_bot: botName ? `@${botName}` : undefined,
              query: t.query ?? '',
              note: 'This button switches to inline mode: use get_inline_results with this bot and query.',
            });
          }
          case 'user_profile':
            // userId — big-integer (объект), у кнопки для ввода — InputUser.
            return reply(services, { ...out, user_id: t.userId !== undefined && !t.userId?.className ? String(t.userId) : undefined });
          case 'copy':
            return reply(services, { ...out, copy_text: t.copyText });
          case 'buy':
            throw new ToolError('This is a payment button. The connector never makes payments; the user can pay in Telegram.');
          case 'disabled':
            throw new ToolError('This button is disabled.');
          case 'request_location':
          case 'request_poll':
          case 'request_chat':
            throw new ToolError(`This button asks to share a ${kind.replace('request_', '')}; that is not supported by the connector. The user can press it in Telegram.`);
          default:
            break;
        }

        // Сначала все отказы — действие засчитывается только за реальное нажатие.
        if (t.requiresPassword) throw new ToolError('This button requires the account\'s 2FA password (e.g. ownership transfer). The connector never does that.');
        if (kind === 'request_phone') {
          if (!args.share_phone) {
            throw new ToolError('This button shares the account\'s phone number with the bot. Ask the user; if they agree, call again with share_phone: true.');
          }
          policy.require('profile');
        }
        if (!['callback', 'game', 'text', 'request_phone'].includes(kind)) throw new ToolError(`Unsupported button type: ${kind}`);
        const baselineId = await latestMessageId(acc, r.input);
        policy.takeActions(acc.name);
        if (kind === 'callback' || kind === 'game') {
          let answer;
          try {
            answer = await acc.client.invoke(
              new Api.messages.GetBotCallbackAnswer({ peer: r.input, msgId: id, data: kind === 'callback' ? t.data : undefined, game: kind === 'game' || undefined }),
            );
          } catch (err) {
            if (err?.errorMessage === 'BOT_RESPONSE_TIMEOUT') answer = null;
            else throw toToolError(err);
          }
          const { updated, fresh } = await awaitBot(acc, r.input, { messageId: id, before: m, baselineId, seconds: wait, signal });
          return reply(services, {
            ...out,
            bot_answer: answer
              ? { text: answer.message || undefined, alert: answer.alert || undefined, url: answer.url || undefined }
              : 'the bot did not answer the press in time (it may still process it)',
            updated_message: updated ? formatMessage(updated, { lookup: acc.lookupFn, selfId: acc.selfId }) : undefined,
            new_messages: formatMessages(acc, fresh),
          });
        }
        if (kind === 'text') {
          try {
            await acc.client.sendMessage(r.input, { message: b.text });
          } catch (err) {
            throw toToolError(err);
          }
        } else {
          const me = acc.me;
          await acc.invoke(
            new Api.messages.SendMedia({
              peer: r.input,
              media: new Api.InputMediaContact({ phoneNumber: me.phone ?? '', firstName: me.firstName ?? '', lastName: me.lastName ?? '', vcard: '' }),
              message: '',
            }),
          );
        }
        const { fresh } = await awaitBot(acc, r.input, { baselineId, seconds: wait, signal });
        return reply(services, { ...out, new_messages: formatMessages(acc, fresh) });
      },
    },

    {
      name: TOOL.startBot,
      title: 'Start bot',
      capability: 'bots',
      annotations: WRITE,
      description:
        'Start a Telegram bot (/start), optionally with a start parameter (deep link t.me/bot?start=…; the link itself can be passed as bot), and return its first replies.',
      inputSchema: schema(
        {
          account: ACCOUNT,
          bot: BOT,
          start_param: { type: 'string', maxLength: 64, description: 'Deep-link parameter.' },
          wait_seconds: { type: 'integer', minimum: 0, maximum: 30, description: 'Wait for replies (default 5).' },
        },
        ['bot'],
      ),
      handler: async (args, { signal }) => {
        const acc = await account(services, args, 'bots');
        const r = await chat(services, acc, args.bot, { write: true });
        if (!(r.entity instanceof Api.User) || !r.entity.bot) throw new ToolError(`${chatRef(r.entity).title} is not a bot.`);
        const param = args.start_param ?? r.startParam;
        const baselineId = await latestMessageId(acc, r.input);
        policy.takeActions(acc.name);
        try {
          if (param) {
            await acc.client.invoke(new Api.messages.StartBot({ bot: toInputUser(r.input), peer: r.input, startParam: param }));
          } else {
            await acc.client.sendMessage(r.input, { message: '/start' });
          }
        } catch (err) {
          throw toToolError(err);
        }
        const { fresh } = await awaitBot(acc, r.input, { baselineId, seconds: args.wait_seconds ?? 5, signal });
        return reply(services, { ...header(acc, r.entity), started: true, start_param: param, messages: formatMessages(acc, fresh) });
      },
    },

    {
      name: TOOL.inlineQuery,
      title: 'Get inline results',
      capability: 'bots',
      annotations: { ...WRITE, destructiveHint: false },
      description:
        'Ask a Telegram inline bot (e.g. @gif, @wiki, @vote) for results, as when typing "@bot query" in a chat. The bot sees the query and this account. Send a result with send_inline_result.',
      inputSchema: schema(
        {
          account: ACCOUNT,
          bot: BOT,
          query: { type: 'string', maxLength: 256 },
          chat: { ...CHAT, description: 'Chat where the result will be sent (some bots adapt results). Default: Saved Messages.' },
          offset: { type: 'string', description: 'next_offset from the previous page.' },
        },
        ['bot', 'query'],
      ),
      handler: async (args) => {
        const acc = await account(services, args, 'bots');
        const botR = await chat(services, acc, args.bot, { track: false });
        if (!(botR.entity instanceof Api.User) || !botR.entity.bot) throw new ToolError(`${chatRef(botR.entity).title} is not a bot.`);
        const target = await chat(services, acc, args.chat ?? 'me');
        let res;
        try {
          res = await acc.client.invoke(
            new Api.messages.GetInlineBotResults({ bot: toInputUser(botR.input), peer: target.input, query: args.query, offset: args.offset ?? '' }),
          );
        } catch (err) {
          throw toToolError(err);
        }
        acc.remember(res.users);
        return reply(services, {
          account: acc.name,
          bot: chatRef(botR.entity),
          query_id: String(res.queryId),
          results: (res.results ?? []).map((x) => {
            const msg = x.sendMessage;
            return {
              id: x.id,
              type: x.type,
              title: x.title || undefined,
              description: x.description ? truncate(x.description, 200) : undefined,
              url: x.url || undefined,
              content_url: x.content?.url || undefined,
              has_media: Boolean(x.photo || x.document || x.content) || undefined,
              sends_text: msg?.message ? truncate(msg.message, 200) : undefined,
            };
          }),
          next_offset: res.nextOffset || undefined,
          gallery: res.gallery || undefined,
          switch_pm: res.switchPm ? { text: res.switchPm.text, start_param: res.switchPm.startParam } : undefined,
        });
      },
    },

    {
      name: TOOL.sendInlineResult,
      title: 'Send inline result',
      capability: ['bots', 'send'],
      annotations: WRITE,
      description: 'Send a result from get_inline_results (by query_id and result id) to a Telegram chat, "via @bot".',
      inputSchema: schema(
        {
          account: ACCOUNT,
          chat: CHAT,
          query_id: { type: 'string', description: 'query_id from get_inline_results.' },
          result_id: { type: 'string', description: 'Result id.' },
          reply_to: { type: 'integer', minimum: 1 },
          silent: { type: 'boolean' },
        },
        ['chat', 'query_id', 'result_id'],
      ),
      handler: async (args) => {
        const acc = await account(services, args, ['bots', 'send']);
        const r = await chat(services, acc, args.chat, { write: true });
        if (!/^-?\d+$/.test(args.query_id)) throw new ToolError('query_id must be the number from get_inline_results.');
        if (args.reply_to) await requireMessagesInChat(acc, r, [args.reply_to]);
        policy.takeActions(acc.name);
        const updates = await acc.invoke(
          new Api.messages.SendInlineBotResult({
            peer: r.input,
            queryId: bigInt(args.query_id),
            id: args.result_id,
            replyTo: args.reply_to ? new Api.InputReplyToMessage({ replyToMsgId: args.reply_to }) : undefined,
            silent: args.silent || undefined,
          }),
        );
        const msgs = messagesFromUpdates(acc, updates);
        return reply(services, { ...header(acc, r.entity), sent: formatMessages(acc, msgs) });
      },
    },
  ];
}
