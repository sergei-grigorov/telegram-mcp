import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { AccountManager } from '../server/accounts.js';
import { loadConfig } from '../server/config.js';
import { chooseAccountName, LoginFlow } from '../server/login/flow.js';
import { LoginServer, qrSvg, qrText } from '../server/login/web.js';
import { renderPage } from '../server/login/page.js';
import { Api, bigInt } from '../server/tg/lib.js';
import { API_ENV, fakeSessionString, silentLogger, tempDir, user } from './helpers.js';

const rpcError = (code) => Object.assign(new Error(code), { errorMessage: code });

// Проверка облачного пароля без настоящего SRP: «правильный» пароль — right.
const checkPassword = async (info, password) => (password === 'right' ? 'srp-ok' : 'srp-bad');

// Клиент для входа: отвечает на запросы входа, как Telegram.
class LoginClient {
  constructor({ codeType, emailSetup = false, verifyResult } = {}) {
    this.session = { save: () => fakeSessionString() };
    this.destroyed = false;
    this.codeType = codeType ?? new Api.auth.SentCodeTypeApp({ length: 5 });
    this.emailSetup = emailSetup;
    this.verifyResult = verifyResult;
    this.requests = [];
  }

  async connect() {}

  async destroy() {
    this.destroyed = true;
  }

  async invoke(req) {
    this.requests.push(req.className);
    switch (req.className) {
      case 'auth.SendCode':
        assert.equal(req.apiId, 12345);
        this.phone = req.phoneNumber;
        if (req.phoneNumber === '+1') throw rpcError('PHONE_NUMBER_INVALID');
        return new Api.auth.SentCode({
          type: this.emailSetup ? new Api.auth.SentCodeTypeSetUpEmailRequired({}) : this.codeType,
          phoneCodeHash: 'hash-1',
        });
      case 'account.SendVerifyEmailCode':
        assert.equal(req.purpose.phoneCodeHash, 'hash-1');
        this.email = req.email;
        return new Api.account.SentEmailCode({ emailPattern: 'm***@example.com', length: 6 });
      case 'account.VerifyEmail':
        if (req.verification.code !== '123456') throw rpcError('EMAIL_CODE_INVALID');
        if (this.verifyResult) return this.verifyResult();
        return new Api.account.EmailVerifiedLogin({ email: this.email, sentCode: new Api.auth.SentCode({ type: new Api.auth.SentCodeTypeSms({ length: 5 }), phoneCodeHash: 'hash-2' }) });
      case 'auth.SignIn': {
        const code = req.phoneCode ?? req.emailVerification?.code;
        this.signedWith = req.emailVerification ? 'email' : 'phone';
        this.hash = req.phoneCodeHash;
        if (code !== '11111') throw rpcError(req.emailVerification ? 'EMAIL_CODE_INVALID' : 'PHONE_CODE_INVALID');
        throw rpcError('SESSION_PASSWORD_NEEDED');
      }
      case 'account.GetPassword':
        return { hint: 'подсказка' };
      case 'auth.CheckPassword':
        if (req.password !== 'srp-ok') throw rpcError('PASSWORD_HASH_INVALID');
        return new Api.auth.Authorization({ user: user(55, { firstName: 'New', username: 'newbie', phone: '79001234567' }) });
      default:
        throw new Error(`unexpected ${req.className}`);
    }
  }

  async signInUserWithQrCode(creds, p) {
    await p.qrCode({ token: Buffer.from('token-1'), expires: Math.floor(Date.now() / 1000) + 30 });
    await new Promise((resolve, reject) => {
      this.scan = resolve;
      p.abortSignal?.addEventListener('abort', () => reject(new Error('AbortError')));
    });
    return user(56, { firstName: 'Qr' });
  }
}

function setup(env = {}) {
  const dataDir = tempDir();
  const config = loadConfig({ env: { ...API_ENV, TELEGRAM_DATA_DIR: dataDir, ...env }, argv: [] });
  const clients = [];
  const createClient = () => {
    const c = new LoginClient();
    clients.push(c);
    return c;
  };
  const accounts = new AccountManager({ config, logger: silentLogger, createClient });
  return { config, accounts, createClient, clients };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

async function waitStep(flow, step) {
  for (let i = 0; i < 200 && flow.state.step !== step; i++) await tick();
  assert.equal(flow.state.step, step, JSON.stringify(flow.state));
}

test('вход по телефону: неверный код и пароль, затем успех; сессия сохранена', async () => {
  const { config, accounts, createClient, clients } = setup();
  const flow = new LoginFlow({ method: 'phone', accountName: 'Work', phone: '+7 999 000-00-00', config, accounts, createClient, logger: silentLogger, checkPassword });
  const done = flow.run();
  await waitStep(flow, 'code');
  assert.equal(flow.state.via, 'app');
  assert.throws(() => flow.submit('password', 'x'), /ожидается шаг/);
  assert.throws(() => flow.submit('code', 'abc'), /цифры/);
  flow.submit('code', '00000');
  await waitStep(flow, 'code');
  assert.match(flow.state.error, /Неверный код/);
  flow.submit('code', '11 111');
  await waitStep(flow, 'password');
  assert.equal(flow.state.hint, 'подсказка');
  flow.submit('password', 'wrong');
  await waitStep(flow, 'password');
  assert.match(flow.state.error, /Неверный облачный пароль/);
  flow.submit('password', 'right');
  await done;
  assert.equal(flow.state.step, 'done');
  assert.equal(flow.state.account, 'Work');
  assert.equal(clients[0].phone, '+79990000000');
  assert.ok(clients[0].destroyed, 'клиент входа закрыт');
  const saved = accounts.list();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].user.username, 'newbie');
  assert.equal(accounts.store.read('work').session, fakeSessionString());
  assert.doesNotMatch(JSON.stringify(flow.state), /right|11111/, 'коды и пароль в состояние не попадают');
  // Неверный код не заставил вводить номер заново: код запрошен один раз.
  assert.equal(clients[0].requests.filter((r) => r === 'auth.SendCode').length, 1);
});

test('вход по телефону: неверный номер спрашивается снова; код из письма уходит в auth.signIn', async () => {
  const { config, accounts } = setup();
  const client = new LoginClient({ codeType: new Api.auth.SentCodeTypeEmailCode({ emailPattern: 'i***@mail.ru', length: 5 }) });
  const flow = new LoginFlow({ method: 'phone', phone: '+1', config, accounts, createClient: () => client, logger: silentLogger, checkPassword });
  const done = flow.run();
  await waitStep(flow, 'phone');
  assert.match(flow.state.error, /Неверный номер/);
  flow.submit('phone', '+7 999 111 22 33');
  await waitStep(flow, 'email_code');
  assert.equal(flow.state.via, 'email');
  assert.equal(flow.state.pattern, 'i***@mail.ru');
  flow.submit('email_code', '11111');
  await waitStep(flow, 'password');
  assert.equal(client.signedWith, 'email');
  flow.submit('password', 'right');
  await done;
  assert.equal(flow.state.step, 'done');
});

test('вход по телефону с обязательной привязкой почты', async () => {
  const { config, accounts } = setup();
  const client = new LoginClient({ emailSetup: true });
  const flow = new LoginFlow({ method: 'phone', phone: '+79990000000', config, accounts, createClient: () => client, logger: silentLogger, checkPassword });
  const done = flow.run();
  await waitStep(flow, 'email');
  flow.submit('email', 'me@example.com');
  await waitStep(flow, 'email_code');
  flow.submit('email_code', '000000');
  await waitStep(flow, 'email_code');
  assert.match(flow.state.error, /Неверный код из письма/);
  flow.submit('email_code', '123456');
  await waitStep(flow, 'code');
  assert.equal(flow.state.via, 'sms');
  flow.submit('code', '11111');
  await waitStep(flow, 'password');
  assert.equal(client.hash, 'hash-2', 'после почты используется новый код входа');
  flow.submit('password', 'right');
  await done;
  assert.equal(flow.state.step, 'done');
});

test('после подтверждения почты: оплата Premium или ответ без кода входа — понятная ошибка', async () => {
  const paymentRequired = new Api.auth.SentCodePaymentRequired({
    storeProduct: 'premium',
    phoneCodeHash: 'hash-3',
    supportEmailAddress: '',
    supportEmailSubject: '',
    premiumDays: 30,
    currency: 'USD',
    amount: bigInt(100),
  });
  const cases = [
    [() => new Api.account.EmailVerifiedLogin({ email: 'me@example.com', sentCode: paymentRequired }), /Premium/],
    [() => new Api.account.EmailVerified({ email: 'me@example.com' }), /не прислал код входа/],
  ];
  for (const [verifyResult, expected] of cases) {
    const { config, accounts } = setup();
    const client = new LoginClient({ emailSetup: true, verifyResult });
    const flow = new LoginFlow({ method: 'phone', phone: '+79990000000', config, accounts, createClient: () => client, logger: silentLogger, checkPassword });
    const done = flow.run();
    await waitStep(flow, 'email');
    flow.submit('email', 'me@example.com');
    await waitStep(flow, 'email_code');
    flow.submit('email_code', '123456');
    await done;
    assert.equal(flow.state.step, 'error');
    assert.match(flow.state.error, expected);
    assert.ok(!client.requests.includes('auth.SignIn'), 'код входа не запрашивается');
    assert.equal(accounts.list().length, 0);
  }
});

test('страница входа: после неверного номера есть поле для нового номера', () => {
  const html = renderPage({ nonce: 'n' });
  assert.match(html, /<form id="stepPhone"/);
  assert.match(html, /phone: 'stepPhone'/);
  assert.match(html, /submit\('phone', \$\('phoneAgain'\)\.value\)/);
});

test('код словом из SMS принимается как есть', async () => {
  const { config, accounts } = setup();
  const client = new LoginClient({ codeType: new Api.auth.SentCodeTypeSmsWord({ beginning: 'ко' }) });
  const flow = new LoginFlow({ method: 'phone', phone: '+79990000000', config, accounts, createClient: () => client, logger: silentLogger, checkPassword });
  const done = flow.run();
  await waitStep(flow, 'code');
  assert.equal(flow.state.via, 'sms_word');
  flow.submit('code', 'котик');
  await waitStep(flow, 'code');
  assert.match(flow.state.error, /Неверный код/);
  flow.cancel();
  await done;
  assert.equal(flow.state.step, 'cancelled');
});

test('вход по QR и отмена', async () => {
  const { config, accounts } = setup();
  const client = new LoginClient();
  const flow = new LoginFlow({ method: 'qr', config, accounts, createClient: () => client, logger: silentLogger });
  const done = flow.run();
  await waitStep(flow, 'qr');
  assert.match(flow.state.qr, /^tg:\/\/login\?token=/);
  client.scan();
  await done;
  assert.equal(flow.state.step, 'done');
  assert.equal(flow.state.account, 'user56');

  const flow2 = new LoginFlow({ method: 'qr', config, accounts, createClient: () => new LoginClient(), logger: silentLogger });
  const done2 = flow2.run();
  await waitStep(flow2, 'qr');
  flow2.cancel();
  await done2;
  assert.equal(flow2.state.step, 'cancelled');
});

test('без API ID вход сразу сообщает, что делать', async () => {
  const { accounts, createClient } = setup();
  const config = loadConfig({ env: { TELEGRAM_DATA_DIR: tempDir() }, argv: [] });
  const flow = new LoginFlow({ method: 'qr', config, accounts, createClient, logger: silentLogger });
  await flow.run();
  assert.equal(flow.state.step, 'error');
  assert.match(flow.state.error, /API ID/);
});

test('имя аккаунта: не затирает чужой аккаунт, повторный вход сохраняет имя', () => {
  const existing = [{ name: 'work', user: { id: '1' } }, { name: 'work-2', user: { id: '2' } }];
  assert.equal(chooseAccountName('work', { id: '1' }, existing), 'work');
  assert.equal(chooseAccountName('work', { id: '3' }, existing), 'work-3');
  assert.equal(chooseAccountName('', { id: '2', username: 'x' }, existing), 'work-2');
  assert.equal(chooseAccountName('', { id: '4', username: 'Nick' }, existing), 'Nick');
  assert.equal(chooseAccountName('../bad', { id: '5' }, existing), 'user5');
});

function request(port, { path, method = 'GET', host = `127.0.0.1:${port}`, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host, ...headers } }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

test('страница входа: токен, Host, Origin, CSP, JSON; полный вход через API', async () => {
  const { config, accounts, createClient } = setup();
  const server = new LoginServer({ config, accounts, createClient, logger: silentLogger, checkPassword });
  const url = await server.start();
  const { port, pathname } = new URL(url);
  try {
    assert.equal((await request(port, { path: pathname, host: `evil.com:${port}` })).status, 403);
    assert.equal((await request(port, { path: '/wrong-token/' })).status, 404);
    assert.equal((await request(port, { path: '/' })).status, 404);
    const page = await request(port, { path: pathname });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /default-src 'none'; script-src 'nonce-/);
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.match(page.body, /Telegram для Claude/);
    const nonce = page.headers['content-security-policy'].match(/nonce-([^']+)/)[1];
    assert.ok(page.body.includes(`<script nonce="${nonce}">`));

    const api = (p, body, headers = { 'content-type': 'application/json' }) =>
      request(port, { path: `${pathname}api/${p}`, method: body === undefined ? 'GET' : 'POST', body, headers }).then((r) => ({ ...r, json: JSON.parse(r.body) }));
    assert.equal((await api('start', {}, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await api('start', {}, { 'content-type': 'application/json', origin: 'https://evil.com' })).status, 403);

    const started = await api('start', { method: 'phone', phone: '+79990000000', account: 'fresh' });
    assert.equal(started.status, 200);
    const id = started.json.flow.id;
    let state;
    for (let i = 0; i < 100; i++) {
      state = (await api('state')).json;
      if (state.flow.step === 'code') break;
      await tick();
    }
    assert.equal(state.flow.step, 'code');
    assert.equal((await api('submit', { id: 'other', step: 'code', value: '11111' })).status, 409);
    assert.equal((await api('submit', { id, step: 'code', value: '11111' })).status, 200);
    for (let i = 0; i < 100 && state.flow.step !== 'password'; i++) {
      await tick();
      state = (await api('state')).json;
    }
    assert.equal((await api('submit', { id, step: 'password', value: 'right' })).status, 200);
    for (let i = 0; i < 100 && state.flow.step !== 'done'; i++) {
      await tick();
      state = (await api('state')).json;
    }
    assert.equal(state.flow.step, 'done');
    assert.deepEqual(state.accounts.map((a) => [a.name, a.username, a.phone]), [['fresh', 'newbie', '+79*******67']]);
    const out = await api('logout', { account: 'fresh' });
    assert.deepEqual(out.json.accounts, []);
  } finally {
    await server.stop();
  }
});

test('QR-код: SVG для страницы и текст для терминала', () => {
  const svg = qrSvg('tg://login?token=abc');
  assert.match(svg, /^<svg[^>]+viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /<path d="M/);
  const text = qrText('tg://login?token=abc');
  assert.ok(text.split('\n').length > 10);
});
