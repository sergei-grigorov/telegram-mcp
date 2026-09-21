import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { AccountManager, maskPhone } from '../server/accounts.js';
import { loadConfig } from '../server/config.js';
import { AccountStore, FileSession, validAccountName } from '../server/store.js';
import { Api, bigInt } from '../server/tg/lib.js';
import { API_ENV, fakeSessionString, FakeClient, silentLogger, tempDir, user } from './helpers.js';

test('имена аккаунтов', () => {
  for (const ok of ['work', 'Личный', 'a.b-c_d', 'user123']) assert.ok(validAccountName(ok), ok);
  for (const bad of ['', '.hidden', '../x', 'a/b', 'a b', 'x'.repeat(41), 'a..b']) assert.ok(!validAccountName(bad), bad);
});

test('файл аккаунта: права 0600, папка 0700, повреждённый файл пропускается', () => {
  const dir = path.join(tempDir(), 'accounts');
  const store = new AccountStore(dir, silentLogger);
  store.write('Work', { session: fakeSessionString(), user: { id: '1' } });
  const file = path.join(dir, 'work.json');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }
  assert.equal(store.read('work').name, 'Work');
  fs.writeFileSync(path.join(dir, 'broken.json'), '{');
  assert.deepEqual(store.list().map((a) => a.name), ['Work']);
  assert.ok(store.remove('WORK'));
  assert.deepEqual(store.list(), []);
});

test('FileSession сохраняет сессию и кэш сущностей и читает их обратно', async () => {
  const dir = path.join(tempDir(), 'accounts');
  const store = new AccountStore(dir, silentLogger);
  const session = fakeSessionString();
  store.write('main', { session, user: { id: '1000' } });
  const s = new FileSession({ store, name: 'main', data: store.read('main'), logger: silentLogger });
  s.processEntities({ users: [user(42, { username: 'Alice' })], chats: [] });
  // «min»-запись с нулевым хешем не затирает полноценную.
  s.processEntities({ users: [new Api.User({ id: bigInt(42), min: true, accessHash: bigInt(0), firstName: 'X' })] });
  s.flush();
  const data = store.read('main');
  assert.equal(data.session, session);
  assert.deepEqual(data.entities.find((e) => e[0] === '42'), ['42', '294', 'alice', null, 'User42']);
  const again = new FileSession({ store, name: 'main', data, logger: silentLogger });
  const row = again.getEntityRowsByUsername('alice');
  assert.equal(String(row[0]), '42');
  assert.equal(String(row[1]), '294');
  again.detach();
  again.processEntities({ users: [user(43)] });
  again.flush();
  assert.equal(store.read('main').entities.length, 1, 'после detach файл не пишется');
});

test('выбор аккаунта: явный, по умолчанию, единственный; только чтение', async () => {
  const dataDir = tempDir();
  const make = (env = {}) => {
    const config = loadConfig({ env: { ...API_ENV, TELEGRAM_DATA_DIR: dataDir, ...env }, argv: [] });
    return new AccountManager({ config, logger: silentLogger, createClient: () => new FakeClient() });
  };
  const m = make();
  assert.throws(() => m.resolveName(), /No Telegram accounts/);
  await m.addAccount({ name: 'work', sessionString: fakeSessionString(), user: { id: '1', username: 'worker', phone: '79991112233' } });
  assert.equal(m.resolveName(), 'work');
  await m.addAccount({ name: 'home', sessionString: fakeSessionString(), user: { id: '2' } });
  assert.throws(() => m.resolveName(), /Several accounts/);
  assert.equal(m.resolveName('@Worker'), 'work');
  assert.equal(m.resolveName('+7 999 111-22-33'), 'work');
  assert.throws(() => m.resolveName('nobody'), /Unknown account/);
  assert.equal(make({ TELEGRAM_DEFAULT_ACCOUNT: 'home' }).resolveName(), 'home');
  assert.throws(() => make({ TELEGRAM_DEFAULT_ACCOUNT: 'gone' }).resolveName(), /not connected/);

  const ro = make({ TELEGRAM_READ_ONLY_ACCOUNTS: 'work', TELEGRAM_DEFAULT_ACCOUNT: 'work' });
  await assert.rejects(ro.use(undefined, { write: true }), /read-only/);
  const ctx = await ro.use(undefined);
  assert.equal(ctx.name, 'work');
  assert.equal(ctx.selfId, '1000');
  assert.equal(await ro.use('work'), ctx, 'подключение переиспользуется');
  await ro.shutdown();
  assert.equal(maskPhone('79991112233'), '+79*******33');
});

test('отозванная сессия: понятная ошибка с советом войти заново', async () => {
  const dataDir = tempDir();
  const config = loadConfig({ env: { ...API_ENV, TELEGRAM_DATA_DIR: dataDir }, argv: [] });
  const client = new FakeClient();
  client.getMe = async () => {
    throw Object.assign(new Error('AUTH_KEY_UNREGISTERED'), { errorMessage: 'AUTH_KEY_UNREGISTERED', code: 401 });
  };
  const m = new AccountManager({ config, logger: silentLogger, createClient: () => client });
  await m.addAccount({ name: 'old', sessionString: fakeSessionString(), user: { id: '9' } });
  await assert.rejects(m.use('old'), /logged out.*open_login_page/);
  assert.match(m.status('old'), /logged out/);
});
