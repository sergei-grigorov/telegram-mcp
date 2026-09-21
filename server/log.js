// Журнал коннектора. stdout занят протоколом MCP, поэтому всё пишется в stderr
// (Claude Desktop складывает его в mcp-server-*.log).

import { inspect } from 'node:util';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function render(args) {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack ?? a.message;
      return inspect(a, { depth: 4, breakLength: 160 });
    })
    .join(' ');
}

export function createLogger({ level = 'info', prefix = '[telegram-mcp]', stream = process.stderr } = {}) {
  let current = LEVELS[level] ?? LEVELS.info;
  const write = (lvl, tag, args) => {
    if (LEVELS[lvl] > current) return;
    stream.write(`${prefix}${tag} ${render(args)}\n`);
  };
  return {
    error: (...a) => write('error', ' ERROR', a),
    warn: (...a) => write('warn', ' WARN', a),
    info: (...a) => write('info', '', a),
    debug: (...a) => write('debug', ' DEBUG', a),
    setLevel(l) {
      if (l in LEVELS) current = LEVELS[l];
    },
    get level() {
      return Object.keys(LEVELS).find((k) => LEVELS[k] === current);
    },
  };
}

export const silentLogger = { error() {}, warn() {}, info() {}, debug() {}, setLevel() {}, level: 'error' };

// Любой console.log в зависимостях сломал бы протокол — уводим его в stderr.
export function guardStdout(logger) {
  console.log = (...a) => logger.info(...a);
  console.info = (...a) => logger.info(...a);
  console.debug = (...a) => logger.debug(...a);
  console.warn = (...a) => logger.warn(...a);
}
