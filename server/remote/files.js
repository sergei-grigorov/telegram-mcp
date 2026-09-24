// Коннектор на сервере: файлы, которые download_media сохранил в папку скачиваний,
// доступны владельцу в браузере по адресу <путь-коннектора>/files/<имя>. Пускает сюда
// только шлюз (владельца, вошедшего по паролю). Файлы отдаются на скачивание, а не
// открываются: содержимое чужое, и страница из него не должна исполняться на домене.

import fs from 'node:fs';
import path from 'node:path';

import { escapeHtml, newNonce, pageHeaders, layout } from './page.js';

function text(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`${body}\n`);
}

function humanSize(n) {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / 1048576).toFixed(1)} МБ`;
}

function listing(res, dir, base) {
  let entries = [];
  try {
    entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.') && !e.name.endsWith('.part'))
      .map((e) => ({ name: e.name, stat: fs.statSync(path.join(dir, e.name)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, 500);
  } catch {
    // папки ещё нет — список пуст
  }
  const nonce = newNonce();
  const rows = entries.length
    ? entries
        .map((e) => `<li><a href="${escapeHtml(`${base}/${encodeURIComponent(e.name)}`)}">${escapeHtml(e.name)}</a> <span class="muted">${humanSize(e.stat.size)}, ${e.stat.mtime.toISOString().replace('T', ' ').slice(0, 16)} UTC</span></li>`)
        .join('')
    : '<li class="muted">Пока пусто: файлы появляются здесь, когда Claude сохраняет вложения из Telegram (download_media).</li>';
  res.writeHead(200, pageHeaders(nonce));
  res.end(layout({ title: 'Telegram: скачанные файлы', nonce, body: `<h1>Скачанные файлы</h1><section><ul class="links">${rows}</ul></section>` }));
}

export function serveFiles(req, res, { dir, base, rest }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'Method not allowed');
  if (rest === '' || rest === '/') return listing(res, dir, base);
  let name;
  try {
    name = rest
      .slice(1)
      .split('/')
      .map((s) => decodeURIComponent(s))
      .join(path.sep);
  } catch {
    return text(res, 400, 'Bad file name');
  }
  if (!name || name.split(path.sep).some((seg) => !seg || seg.startsWith('.'))) return text(res, 404, 'Not found');
  let root;
  let real;
  try {
    root = fs.realpathSync(dir);
    real = fs.realpathSync(path.join(root, name));
  } catch {
    return text(res, 404, 'Not found');
  }
  if (!real.startsWith(root + path.sep)) return text(res, 404, 'Not found');
  const st = fs.statSync(real);
  if (!st.isFile()) return text(res, 404, 'Not found');
  const encodedName = encodeURIComponent(path.basename(real));
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': st.size,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodedName}`,
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(real).on('error', () => res.destroy()).pipe(res);
}
