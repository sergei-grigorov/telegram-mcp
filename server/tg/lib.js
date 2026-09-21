// Точка входа в teleproto (MTProto-клиент, преемник GramJS). Пакет собран как
// CommonJS, поэтому подключаем его через require и отдаём дальше только нужное.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// store2 внутри teleproto при загрузке трогает globalThis.localStorage, и Node 25+
// пишет в журнал ExperimentalWarning. Предупреждение бесполезно — глушим только его.
const emitWarning = process.emitWarning;
process.emitWarning = function filtered(warning, ...rest) {
  if (/localStorage/.test(String(warning?.message ?? warning))) return undefined;
  return emitWarning.call(this, warning, ...rest);
};
let teleproto;
try {
  teleproto = require('teleproto');
} finally {
  process.emitWarning = emitWarning;
}

export const { Api, TelegramClient, Logger, Rich } = teleproto;
export const utils = require('teleproto/Utils');
export const helpers = require('teleproto/Helpers');
export const { RPCError, FloodWaitError } = require('teleproto/errors');
export const { StringSession } = require('teleproto/sessions/StringSession');
export const { AuthKey } = require('teleproto/crypto/AuthKey');
export const { computeCheck } = require('teleproto/Password');
export const { HTMLParser } = require('teleproto/extensions/html');
export const { CustomFile } = require('teleproto/client/uploads');
export const { LAYER } = require('teleproto/tl/runtime/registry');
export const { UpdateConnectionState } = require('teleproto/network');
export const definitions = require('teleproto/tl/generated/api-definitions.js');
export const bigInt = require('big-integer');
export const TELEPROTO_VERSION = teleproto.version;
