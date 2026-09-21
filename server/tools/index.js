// Все инструменты коннектора. Инструменты, выключенные в настройках, модель
// не видит вовсе; если клиент всё же вызовет такой — обработчик откажет сам.

import { isAuthError } from '../accounts.js';
import { TOOL } from '../names.js';
import adminTools from './admin.js';
import botTools from './bots.js';
import chatTools from './chats.js';
import { callScope, newCallScope } from './common.js';
import mediaTools from './media.js';
import messageTools from './messages.js';
import profileTools from './profile.js';
import rawTools from './raw.js';
import statusTools from './status.js';
import streamTools from './stream.js';
import voiceTools from './voice.js';

export function allTools(services) {
  const tools = [
    ...statusTools(services),
    ...chatTools(services),
    ...messageTools(services),
    ...streamTools(services),
    ...mediaTools(services),
    ...voiceTools(services),
    ...botTools(services),
    ...adminTools(services),
    ...profileTools(services),
    ...rawTools(services),
  ];
  // Заголовок и в annotations.title — как в коннекторе Bybit (так его читают
  // клиенты, знающие только старую версию MCP).
  return tools.map((t) => ({ ...t, annotations: { title: t.title, ...t.annotations } }));
}

// Если Telegram сообщил, что сессия недействительна (например, её завершили с
// телефона), аккаунт помечается вышедшим — следующий вызов не будет работать со
// «мёртвым» подключением, а connector_status покажет, что нужен вход.
function watchAuthErrors(services, tool) {
  const { accounts } = services;
  return {
    ...tool,
    handler: async (args, extra) => {
      let name = null;
      try {
        name = accounts.resolveName(args?.account);
      } catch {
        // аккаунт не определить — ничего не помечаем
      }
      // Подключение этого вызова: если за время вызова аккаунт вошёл заново,
      // новое подключение не трогаем.
      const before = name ? accounts.current(name) : undefined;
      try {
        return await tool.handler(args, extra);
      } catch (err) {
        if (name && isAuthError(err)) {
          await accounts.markBroken(name, err.code ?? err.errorMessage, before ?? accounts.current(name)).catch(() => {});
        }
        throw err;
      }
    },
  };
}

function appendText(out, text) {
  const block = { type: 'text', text };
  if (typeof out === 'string') return { content: [{ type: 'text', text: out }, block] };
  if (Array.isArray(out?.content)) return { ...out, content: [...out.content, block] };
  return { content: [{ type: 'text', text: String(out?.text ?? '') }, block], isError: Boolean(out?.isError) };
}

// Пока агент работает с чатом (читает, отвечает), туда могут прийти новые сообщения.
// Если на чат есть подписка (subscribe_to_messages), пришедшее и ещё не отданное
// монитору добавляется к ответу инструмента отдельным блоком arrived_meanwhile —
// сигнал сразу, не дожидаясь события Monitor.
function withArrivedMessages(services, tool) {
  const { stream } = services;
  if (!stream || tool.name === TOOL.subscribe) return tool;
  return {
    ...tool,
    handler: (args, extra) => {
      const scope = newCallScope();
      return callScope.run(scope, async () => {
        const out = await tool.handler(args, extra);
        // Отменённый вызов ответа не получит: сообщения остаются монитору.
        if (extra?.signal?.aborted) return out;
        const arrived = await stream.takeArrived(scope, extra?.signal).catch(() => null);
        return arrived ? appendText(out, arrived) : out;
      });
    },
  };
}

export function buildTools(services) {
  const { policy } = services;
  return allTools(services)
    .filter((t) => [].concat(t.capability).every((c) => policy.enabled(c)))
    .map((t) => watchAuthErrors(services, withArrivedMessages(services, t)));
}

// Выключенные инструменты: имя → объяснение, какую настройку включить.
export function unavailableTools(services) {
  const { policy } = services;
  const out = new Map();
  for (const t of allTools(services)) {
    const off = [].concat(t.capability).filter((c) => !policy.enabled(c));
    if (!off.length) continue;
    try {
      policy.require(off[0]);
    } catch (err) {
      out.set(t.name, `${t.name} is turned off. ${err.message}`);
    }
  }
  return out;
}
