// Проверка собранного пакета: распаковывает dist/telegram.mcpb во временную
// папку и запускает сервер оттуда, как это делает Claude Desktop.
//   node scripts/check-bundle.mjs [путь к .mcpb]

import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const bundle = path.resolve(process.argv[2] ?? new URL('../dist/telegram.mcpb', import.meta.url).pathname);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgmcp-bundle-'));
const unzip = spawnSync('unzip', ['-q', bundle, '-d', dir], { stdio: 'inherit' });
if (unzip.status !== 0) {
  const tar = spawnSync('tar', ['-xf', bundle, '-C', dir], { stdio: 'inherit' });
  if (tar.status !== 0) throw new Error('не удалось распаковать пакет');
}

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const entry = path.join(dir, manifest.server.entry_point);
const env = {
  ...process.env,
  TELEGRAM_API_ID: '1',
  TELEGRAM_API_HASH: '0123456789abcdef0123456789abcdef',
  TELEGRAM_DATA_DIR: path.join(dir, '.data'),
};
// Незаполненные поля Claude Desktop передаёт буквально — так и проверяем.
for (const [k, v] of Object.entries(manifest.server.mcp_config.env)) if (!(k in env)) env[k] = v;
const args = manifest.server.mcp_config.args.map((a) => a.replace('${__dirname}', dir));

const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
let out = '';
let err = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (err += d));
const requests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'check-bundle' } } },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'connector_status', arguments: {} } },
];
child.stdin.end(`${requests.map((r) => JSON.stringify(r)).join('\n')}\n`);
const code = await new Promise((resolve) => child.on('exit', resolve));
fs.rmSync(dir, { recursive: true, force: true });

const replies = out.trim() ? out.trim().split('\n').map((l) => JSON.parse(l)) : [];
const ok = code === 0 && replies.length === 3 && replies.every((r) => r.result) && !replies[2].result.isError;
process.stdout.write(`${ok ? 'OK' : 'FAIL'}: ${path.basename(bundle)}; инструментов: ${replies[1]?.result?.tools?.length ?? '—'}\n`);
if (!ok) {
  process.stdout.write(`код выхода ${code}\n--- stdout\n${out}\n--- stderr\n${err}\n`);
  process.exit(1);
}
