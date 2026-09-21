// Прямые вызовы Telegram API (MTProto) — для всего, чего нет в остальных
// инструментах. Включаются отдельной настройкой; опасные методы закрыты всегда.

import { ToolError } from '../mcp.js';
import { TOOL } from '../names.js';
import { toToolError } from '../tg/errors.js';
import { Api, bigInt, LAYER, utils } from '../tg/lib.js';
import {
  buildRequest,
  constructorsOf,
  describeDefinition,
  extraCapabilities,
  findConstructor,
  findMethod,
  scrubResponse,
  searchSchema,
  toJson,
} from '../tg/tljson.js';
import { ACCOUNT, DESTRUCTIVE, READ, account, chat, reply, schema } from './common.js';

// Методы приглашений: ссылка сверяется со списками чатов, как в join_chat.
const INVITE_METHODS = new Set(['messages.CheckChatInvite', 'messages.ImportChatInvite']);

// Сущность для сверки id со списками чатов: из памяти, иначе из кэша сессии
// (там есть username), иначе по одному id — тогда совпасть может только запись
// с этим id, и при списке «Только эти чаты» незнакомый чат закрыт.
export function entityForId(acc, id) {
  const key = String(id);
  const known = acc.lookup(key);
  if (known) return known;
  let peerId;
  let kind;
  try {
    [peerId, kind] = utils.resolveId(bigInt(key));
  } catch {
    return null;
  }
  const row = acc.session?._entities?.get(key);
  const username = row?.[2] || undefined;
  if (kind === Api.PeerUser) return new Api.User({ id: peerId, username, self: key === acc.selfId });
  if (kind === Api.PeerChat) return new Api.Chat({ id: peerId, title: '' });
  if (kind === Api.PeerChannel) return new Api.Channel({ id: peerId, username, title: '' });
  return null;
}

export default function rawTools(services) {
  const { policy } = services;
  return [
    {
      name: TOOL.searchApi,
      title: 'Search API methods',
      capability: 'raw',
      annotations: READ,
      description: `Search the Telegram API schema (layer ${LAYER}) by name: methods and constructors whose names contain the text. Then ${TOOL.describeApi} shows the parameters and ${TOOL.callApi} calls the method.`,
      inputSchema: schema({ query: { type: 'string', minLength: 1, description: 'Part of a method or constructor name, e.g. "history" or "setTyping".' } }, ['query']),
      handler: async (args) => reply(services, { layer: LAYER, ...searchSchema(args.query) }),
    },

    {
      name: TOOL.describeApi,
      title: 'Describe API method',
      capability: 'raw',
      annotations: READ,
      description: `Parameters of a Telegram API method (layer ${LAYER}), or the constructors of a type (e.g. InputPeer, MessagesFilter). Use before ${TOOL.callApi}.`,
      inputSchema: schema({
        method: { type: 'string', description: 'Method name, e.g. messages.getHistory.' },
        type: { type: 'string', description: 'Type or constructor name, e.g. InputPeer: lists the constructors of the type.' },
      }),
      handler: async (args) => {
        if (args.method) {
          const d = findMethod(args.method);
          if (!d) throw new ToolError(`Unknown method ${args.method}. Find the name with ${TOOL.searchApi}.`);
          return reply(services, { layer: LAYER, ...describeDefinition(d) });
        }
        if (args.type) {
          const c = findConstructor(args.type);
          const list = constructorsOf(c ? c.result : args.type);
          if (!list.length && c) return reply(services, { layer: LAYER, ...describeDefinition(c) });
          if (!list.length) throw new ToolError(`Unknown type ${args.type}. Find the name with ${TOOL.searchApi}.`);
          return reply(services, { layer: LAYER, type: c ? c.result : args.type, constructors: list });
        }
        throw new ToolError('Pass method or type.');
      },
    },

    {
      name: TOOL.callApi,
      title: 'Send API request',
      capability: 'raw',
      annotations: DESTRUCTIVE,
      description:
        `Call any Telegram API method directly, for things the other tools cannot do. params: JSON with parameter names from ${TOOL.describeApi} (snake_case or camelCase); peers can be given as ids, @usernames or links; nested objects as {"_": "constructorName", ...}; bytes as {"_bytes": base64}. This bypasses most of the connector's permission checks, so use it only for what the user explicitly asked. Hidden chats stay hidden (also in the response); delete/clear/leave methods also need the delete permission; login and account-security methods, payments, passkeys, push devices, business bots, update streams and methods that address messages by number without a chat are always refused.`,
      inputSchema: schema(
        {
          account: ACCOUNT,
          method: { type: 'string', description: 'e.g. messages.getHistory' },
          params: { type: 'object', description: 'Method parameters.' },
        },
        ['method'],
      ),
      handler: async (args) => {
        const acc = await account(services, args, 'raw');
        // Скрытые и служебный чаты недоступны и здесь: и как @username/id, и как
        // объект-пир или число chat_id, и в ответе.
        const visible = (id) => {
          const e = entityForId(acc, id);
          return Boolean(e) && policy.isVisible(e, acc);
        };
        const hidden = (id) => {
          const e = entityForId(acc, id);
          return !e || policy.isHidden(e, acc);
        };
        const ctx = {
          selfId: acc.selfId,
          resolvePeer: async (value) => chat(services, acc, value),
          checkPeerId: (id, path) => {
            if (!visible(id)) {
              throw new ToolError(`${path}: this chat is hidden by the connector settings («Скрытые чаты» / «Только эти чаты»), or unknown to the account while «Только эти чаты» is set.`);
            }
          },
        };
        const { request, definition } = await buildRequest(args.method, args.params ?? {}, ctx);
        for (const cap of extraCapabilities(definition)) policy.require(cap);
        if (INVITE_METHODS.has(definition.fullName)) {
          if (!/^[\w-]{1,64}$/.test(request.hash)) throw new ToolError('params.hash: expected the hash from a t.me/+… invite link.');
          await chat(services, acc, `https://t.me/+${request.hash}`, { allowInvite: true });
        }
        policy.takeActions(acc.name);
        let result;
        try {
          result = await acc.client.invoke(request);
        } catch (err) {
          throw toToolError(err, definition.fullName);
        }
        if (result && typeof result === 'object') acc.remember(result.users, result.chats);
        const clean = scrubResponse(result, { visible, hidden, selfId: acc.selfId });
        return reply(services, { account: acc.name, method: describeDefinition(definition).method, result: toJson(clean) });
      },
    },
  ];
}
