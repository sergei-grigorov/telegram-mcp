// Вход в аккаунт Telegram: пошаговый сценарий поверх teleproto (номер → код →
// пароль 2FA, при необходимости e-mail; или QR-код). Страница входа и CLI
// показывают шаги пользователю и передают ответы через submit(). Коды и пароль
// идут прямо в Telegram и нигде не сохраняются.

import { randomUUID } from 'node:crypto';

import { userInfo } from '../accounts.js';
import { accountKey, validAccountName } from '../store.js';
import { Api, computeCheck, StringSession } from '../tg/lib.js';

// Как пришёл код: подсказка для страницы входа.
function codeHints(type) {
  const T = Api.auth;
  const via =
    type instanceof T.SentCodeTypeApp
      ? 'app'
      : type instanceof T.SentCodeTypeSms || type instanceof T.SentCodeTypeFirebaseSms
        ? 'sms'
        : type instanceof T.SentCodeTypeCall
          ? 'call'
          : type instanceof T.SentCodeTypeFlashCall
            ? 'flash_call'
            : type instanceof T.SentCodeTypeMissedCall
              ? 'missed_call'
              : type instanceof T.SentCodeTypeEmailCode
                ? 'email'
                : type instanceof T.SentCodeTypeFragmentSms
                  ? 'fragment'
                  : type instanceof T.SentCodeTypeSmsWord
                    ? 'sms_word'
                    : type instanceof T.SentCodeTypeSmsPhrase
                      ? 'sms_phrase'
                      : 'unknown';
  return { via, pattern: type?.emailPattern ?? type?.prefix ?? type?.beginning ?? type?.pattern ?? null, length: type?.length ?? null, url: type?.url ?? null };
}

const FLOW_TIMEOUT_MS = 15 * 60_000;

// Ошибки Telegram при входе → сообщение для человека и можно ли повторить шаг.
const LOGIN_ERRORS = {
  PHONE_NUMBER_INVALID: ['Неверный номер телефона. Введите его в международном формате, например +7 999 123-45-67.', true],
  PHONE_NUMBER_UNOCCUPIED: ['Этот номер не зарегистрирован в Telegram.', false],
  PHONE_NUMBER_BANNED: ['Этот номер заблокирован в Telegram.', false],
  PHONE_NUMBER_FLOOD: ['Слишком много попыток входа с этим номером. Попробуйте позже или войдите по QR-коду.', false],
  PHONE_CODE_INVALID: ['Неверный код. Проверьте его и введите ещё раз.', true],
  PHONE_CODE_EMPTY: ['Введите код.', true],
  PHONE_CODE_EXPIRED: ['Код устарел. Начните вход заново.', false],
  PHONE_CODE_HASH_EMPTY: ['Сессия входа устарела. Начните заново.', false],
  PASSWORD_HASH_INVALID: ['Неверный облачный пароль (2FA). Попробуйте ещё раз.', true],
  PASSWORD_EMPTY: ['Введите облачный пароль.', true],
  EMAIL_CODE_INVALID: ['Неверный код из письма.', true],
  CODE_INVALID: ['Неверный код из письма.', true],
  EMAIL_INVALID: ['Неверный адрес электронной почты.', true],
  EMAIL_NOT_ALLOWED: ['Этот адрес почты нельзя использовать.', true],
  API_ID_INVALID: ['API ID или API Hash в настройках расширения неверны. Скопируйте их заново с my.telegram.org.', false],
  API_ID_PUBLISHED_FLOOD: ['Этот API ID ограничен Telegram. Создайте собственный на my.telegram.org.', false],
  SIGN_UP_REQUIRED: ['Для этого номера нет аккаунта Telegram. Создайте аккаунт в официальном приложении, затем войдите здесь.', false],
  AUTH_RESTART: ['Telegram попросил начать вход заново.', false],
  SESSION_PASSWORD_NEEDED: ['Нужен облачный пароль.', true],
};

function describeLoginError(err) {
  const code = err?.errorMessage ?? err?.message ?? String(err);
  if (LOGIN_ERRORS[code]) return { message: LOGIN_ERRORS[code][0], retry: LOGIN_ERRORS[code][1], code };
  const flood = String(code).match(/^(?:FLOOD_WAIT|FLOOD_PREMIUM_WAIT|PHONE_PASSWORD_FLOOD)_?(\d+)?$/);
  if (flood) {
    const s = Number(flood[1] ?? 0);
    const wait = s > 3600 ? `${Math.ceil(s / 3600)} ч` : s > 60 ? `${Math.ceil(s / 60)} мин` : `${s} с`;
    return { message: `Telegram ограничил попытки входа: подождите ${wait}.`, retry: false, code };
  }
  if (/RECAPTCHA/.test(code)) {
    return { message: 'Telegram требует пройти проверку reCAPTCHA. Войдите по QR-коду — там её нет.', retry: false, code };
  }
  if (/TIMEOUT|ECONN|ENOTFOUND|EHOSTUNREACH|network/i.test(code)) {
    return { message: `Нет связи с Telegram (${code}). Проверьте интернет или прокси в настройках расширения.`, retry: false, code };
  }
  return { message: `Ошибка Telegram: ${code}`, retry: false, code };
}

const STEP_OF_ERROR = {
  PHONE_NUMBER_INVALID: 'phone',
  PHONE_CODE_INVALID: 'code',
  PHONE_CODE_EMPTY: 'code',
  PASSWORD_HASH_INVALID: 'password',
  PASSWORD_EMPTY: 'password',
  EMAIL_CODE_INVALID: 'email_code',
  CODE_INVALID: 'email_code',
  EMAIL_INVALID: 'email',
  EMAIL_NOT_ALLOWED: 'email',
};

// Имя нового аккаунта: заданное, иначе @username, иначе user<id>; без конфликтов
// с аккаунтами других людей.
export function chooseAccountName(wanted, user, existing) {
  const taken = new Map(existing.map((a) => [accountKey(a.name), a]));
  const sameUser = existing.find((a) => a.user?.id && a.user.id === user.id);
  if (!wanted && sameUser) return sameUser.name;
  let base = wanted && validAccountName(wanted) ? wanted : (user.username ?? `user${user.id}`).replace(/[^\p{L}\p{N}_.-]/gu, '').slice(0, 40);
  if (!validAccountName(base)) base = `user${user.id}`;
  const current = taken.get(accountKey(base));
  if (!current || current.user?.id === user.id) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base.slice(0, 36)}-${i}`;
    const t = taken.get(accountKey(candidate));
    if (!t || t.user?.id === user.id) return candidate;
  }
}

export class LoginFlow {
  constructor({ method, accountName, phone, config, accounts, createClient, logger, checkPassword = computeCheck }) {
    this.id = randomUUID();
    this.computeCheck = checkPassword; // SRP-проверка облачного пароля (в тестах — подмена)
    this.method = method === 'qr' ? 'qr' : 'phone';
    this.wantedName = accountName?.trim() || '';
    this.prefill = { phone: String(phone ?? '').replace(/[^\d+]/g, '') };
    this.config = config;
    this.accounts = accounts;
    this.createClient = createClient;
    this.logger = logger;
    this.pending = null;
    this.abort = new AbortController();
    this.client = null;
    this.stopped = false;
    this.fatal = null;
    this.state = { id: this.id, method: this.method, step: 'starting', account: this.wantedName || null };
    this.timer = setTimeout(() => this.cancel('Время на вход истекло. Начните заново.'), FLOW_TIMEOUT_MS);
    this.timer.unref?.();
  }

  get active() {
    return !['done', 'error', 'cancelled'].includes(this.state.step);
  }

  setStep(step, extra = {}) {
    this.state = { id: this.id, method: this.method, account: this.state.account, step, ...extra, error: extra.error ?? null };
  }

  // Ждёт ответа пользователя на шаге step.
  ask(step, extra = {}) {
    if (this.stopped) return Promise.reject(new Error('AUTH_USER_CANCEL'));
    if (step === 'phone' && this.prefill.phone) {
      const phone = this.prefill.phone;
      this.prefill.phone = '';
      this.setStep('sending_code');
      return Promise.resolve(phone);
    }
    const error = this.state.pendingError && this.state.pendingErrorStep === step ? this.state.pendingError : null;
    this.setStep(step, { ...extra, error });
    return new Promise((resolve, reject) => {
      this.pending = { step, resolve, reject };
    });
  }

  submit(step, value) {
    if (!this.pending || this.pending.step !== step) {
      throw new Error(`Сейчас ожидается шаг «${this.state.step}», а не «${step}».`);
    }
    const text = String(value ?? '').trim();
    if (!text) throw new Error('Пустое значение.');
    // Некоторые SMS содержат слово или фразу вместо цифр.
    const wordCode = step === 'code' && ['sms_word', 'sms_phrase'].includes(this.state.via);
    if (step === 'phone' && !/^\+?[\d\s()-]{6,20}$/.test(text)) throw new Error('Номер телефона — только цифры, в международном формате.');
    if ((step === 'code' || step === 'email_code') && !wordCode && !/^[\d\s-]{3,12}$/.test(text)) throw new Error('Код — это цифры из сообщения Telegram.');
    const { resolve } = this.pending;
    this.pending = null;
    let normalized = String(value);
    if (step === 'phone') normalized = text.replace(/[^\d+]/g, '');
    else if ((step === 'code' && !wordCode) || step === 'email_code') normalized = text.replace(/\D/g, '');
    else if (wordCode) normalized = text;
    this.setStep('checking');
    resolve(normalized);
  }

  onError(err) {
    const info = describeLoginError(err);
    this.logger.warn(`вход: ${info.code}`);
    if (this.stopped) return true;
    if (info.retry) {
      this.state.pendingError = info.message;
      this.state.pendingErrorStep = STEP_OF_ERROR[info.code];
      return false;
    }
    this.fatal = info.message;
    return true;
  }

  cancel(message = 'Вход отменён.') {
    if (!this.active) return;
    this.stopped = true;
    this.abort.abort();
    if (this.pending) {
      const { reject } = this.pending;
      this.pending = null;
      const err = new Error('AUTH_USER_CANCEL');
      reject(err);
    }
    this.setStep('cancelled', { error: message });
    this.finish();
  }

  finish() {
    clearTimeout(this.timer);
    const client = this.client;
    this.client = null;
    client?.destroy().catch(() => {});
  }

  // Ошибка шага, который можно повторить: показать её на том же шаге и спросить снова.
  retryable(err, ...steps) {
    const info = describeLoginError(err);
    if (!info.retry || !steps.includes(STEP_OF_ERROR[info.code])) return false;
    this.logger.warn(`вход: ${info.code}`);
    this.state.pendingError = info.message;
    this.state.pendingErrorStep = STEP_OF_ERROR[info.code];
    return true;
  }

  // Ответ на запрос кода: вход без кода, просьба оплатить Premium (не
  // поддерживается) или отправленный код.
  takeSentCode(sent) {
    if (sent instanceof Api.auth.SentCodeSuccess) return { user: sent.authorization.user };
    if (sent instanceof Api.auth.SentCodePaymentRequired) {
      this.fatal = 'Telegram просит оплатить Premium, чтобы прислать код на этот номер. Войдите по QR-коду.';
      throw new Error('PAYMENT_REQUIRED');
    }
    if (!(sent instanceof Api.auth.SentCode)) {
      this.fatal = 'Telegram не прислал код входа. Начните вход заново или войдите по QR-коду.';
      throw new Error('NO_LOGIN_CODE');
    }
    return { hash: sent.phoneCodeHash, type: sent.type };
  }

  // Вход по номеру — своими запросами, а не через signInUser из teleproto: так
  // неверный код не заставляет вводить номер заново, а код из письма уходит в
  // auth.signIn, как требует Telegram.
  async phoneLogin(creds) {
    let phone = await this.ask('phone');
    let sent;
    for (;;) {
      try {
        sent = await this.client.invoke(new Api.auth.SendCode({ phoneNumber: phone, apiId: creds.apiId, apiHash: creds.apiHash, settings: new Api.CodeSettings({}) }));
        break;
      } catch (err) {
        if (err?.errorMessage === 'AUTH_RESTART') continue;
        if (!this.retryable(err, 'phone')) throw err;
        phone = await this.ask('phone');
      }
    }
    let { user, hash, type } = this.takeSentCode(sent);
    if (user) return user;

    // Telegram требует сначала привязать почту: адрес → код из письма → новый код входа.
    if (type instanceof Api.auth.SentCodeTypeSetUpEmailRequired) {
      const purpose = () => new Api.EmailVerifyPurposeLoginSetup({ phoneNumber: phone, phoneCodeHash: hash });
      let emailSent;
      for (;;) {
        const email = await this.ask('email');
        try {
          emailSent = await this.client.invoke(new Api.account.SendVerifyEmailCode({ purpose: purpose(), email }));
          break;
        } catch (err) {
          if (!this.retryable(err, 'email')) throw err;
        }
      }
      for (;;) {
        const code = await this.ask('email_code', { pattern: emailSent.emailPattern ?? null });
        let verified;
        try {
          verified = await this.client.invoke(new Api.account.VerifyEmail({ purpose: purpose(), verification: new Api.EmailVerificationCode({ code }) }));
        } catch (err) {
          if (!this.retryable(err, 'email_code')) throw err;
          continue;
        }
        // После подтверждения почты Telegram присылает новый код входа.
        ({ user, hash, type } = this.takeSentCode(verified instanceof Api.account.EmailVerifiedLogin ? verified.sentCode : null));
        if (user) return user;
        break;
      }
    }

    // Код входа: из Telegram, SMS, звонка — или из письма, если у аккаунта привязана почта.
    let auth;
    for (;;) {
      const byEmail = type instanceof Api.auth.SentCodeTypeEmailCode;
      const code = await this.ask(byEmail ? 'email_code' : 'code', codeHints(type));
      try {
        auth = await this.client.invoke(
          new Api.auth.SignIn(
            byEmail
              ? { phoneNumber: phone, phoneCodeHash: hash, emailVerification: new Api.EmailVerificationCode({ code }) }
              : { phoneNumber: phone, phoneCodeHash: hash, phoneCode: code },
          ),
        );
        break;
      } catch (err) {
        if (err?.errorMessage === 'SESSION_PASSWORD_NEEDED') return this.passwordLogin();
        if (!this.retryable(err, 'code', 'email_code')) throw err;
      }
    }
    if (auth instanceof Api.auth.AuthorizationSignUpRequired) {
      throw Object.assign(new Error('SIGN_UP_REQUIRED'), { errorMessage: 'SIGN_UP_REQUIRED' });
    }
    return auth.user;
  }

  async passwordLogin() {
    for (;;) {
      const info = await this.client.invoke(new Api.account.GetPassword());
      const password = await this.ask('password', { hint: info.hint || null });
      try {
        const check = await this.computeCheck(info, password);
        const auth = await this.client.invoke(new Api.auth.CheckPassword({ password: check }));
        return auth.user;
      } catch (err) {
        if (!this.retryable(err, 'password')) throw err;
      }
    }
  }

  async run() {
    const creds = { apiId: this.config.apiId, apiHash: this.config.apiHash };
    try {
      if (!this.config.hasApiCredentials) {
        throw Object.assign(new Error('API_ID_INVALID'), { errorMessage: 'API_ID_INVALID' });
      }
      this.client = this.createClient({ session: new StringSession(''), testServers: this.config.testServers });
      await this.client.connect();
      let user;
      if (this.method === 'qr') {
        this.setStep('qr_wait');
        user = await this.client.signInUserWithQrCode(creds, {
          qrCode: async ({ token, expires }) => {
            if (this.stopped) return;
            this.setStep('qr', { qr: `tg://login?token=${Buffer.from(token).toString('base64url')}`, expires: Number(expires) * 1000 });
          },
          password: (hint) => this.ask('password', { hint: hint || null }),
          onError: (err) => this.onError(err),
          abortSignal: this.abort.signal,
        });
      } else {
        user = await this.phoneLogin(creds);
      }
      if (this.stopped) return;
      if (!user || user.bot) throw new Error('Вход не завершён.');
      const sessionString = this.client.session.save();
      const info = userInfo(user);
      const name = chooseAccountName(this.wantedName, info, this.accounts.list());
      await this.accounts.addAccount({ name, sessionString, user: info, testServers: this.config.testServers });
      this.logger.info(`вход выполнен: аккаунт ${name} (id ${info.id})`);
      this.setStep('done', {
        account: name,
        user: { name: [info.first_name, info.last_name].filter(Boolean).join(' '), username: info.username },
        renamed: this.wantedName && name !== this.wantedName ? `Имя «${this.wantedName}» уже занято другим аккаунтом, этот сохранён как «${name}».` : null,
      });
      this.state.account = name;
    } catch (err) {
      if (this.state.step === 'cancelled') return;
      const message = this.fatal ?? describeLoginError(err).message;
      this.setStep('error', { error: message });
    } finally {
      this.finish();
    }
  }
}
