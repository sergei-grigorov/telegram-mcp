// Все классы Api.*, упомянутые в коде, существуют в текущем слое teleproto:
// при обновлении библиотеки переименования слоя всплывут здесь, а не у пользователя.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Api } from '../server/tg/lib.js';

const ROOT = fileURLToPath(new URL('../server', import.meta.url));

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
}

test('ссылки на классы Api в коде сервера', () => {
  const missing = [];
  for (const file of files(ROOT)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const [full, a, b] of src.matchAll(/\bApi\.([A-Za-z]\w*)(?:\.([A-Z]\w*))?/g)) {
      const obj = b ? Api[a]?.[b] : Api[a];
      if (obj === undefined) missing.push(`${path.relative(ROOT, file)}: ${full}`);
    }
  }
  assert.deepEqual(missing, []);
});
