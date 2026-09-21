// Страница входа: одна HTML-страница без внешних ресурсов. Скрипт и стили — с
// nonce из Content-Security-Policy. Данные вставляются только через textContent.

const STYLE = `
:root { --bg:#f5f6f8; --card:#fff; --text:#1c1d21; --muted:#6b7280; --line:#e3e5e8; --accent:#2a8bd8; --accent-2:#1f6fb0; --ok:#1f9d55; --err:#c83232; --warn-bg:#fff6e0; --warn-line:#f0c46b; }
@media (prefers-color-scheme: dark) { :root { --bg:#15171a; --card:#1e2125; --text:#eceef1; --muted:#9aa1ab; --line:#30343a; --accent:#4aa3ea; --accent-2:#7cbcf0; --ok:#4cc27d; --err:#ef6b6b; --warn-bg:#3a3120; --warn-line:#8a6d2c; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width:560px; margin:32px auto; padding:0 16px 48px; }
h1 { font-size:24px; margin:0 0 4px; }
h2 { font-size:16px; margin:0 0 12px; }
.sub, .muted { color:var(--muted); }
.sub { margin:0 0 20px; }
section { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px; margin:0 0 16px; }
label { display:block; margin:0 0 12px; font-weight:500; }
input { display:block; width:100%; margin-top:6px; padding:10px 12px; font:inherit; color:var(--text); background:transparent; border:1px solid var(--line); border-radius:10px; }
input:focus { outline:2px solid var(--accent); outline-offset:-1px; }
button { font:inherit; cursor:pointer; border:0; border-radius:10px; padding:10px 16px; background:var(--accent); color:#fff; font-weight:600; }
button:hover { background:var(--accent-2); }
button:disabled { opacity:.5; cursor:default; }
button.link { background:none; color:var(--muted); padding:6px 0; font-weight:500; }
button.link:hover { color:var(--text); }
button.danger { background:none; color:var(--err); border:1px solid var(--line); padding:6px 12px; font-weight:500; }
.tabs { display:flex; gap:6px; margin:0 0 14px; background:var(--bg); padding:4px; border-radius:12px; }
.tabs button { flex:1; background:none; color:var(--muted); }
.tabs button.active { background:var(--card); color:var(--text); box-shadow:0 1px 3px rgba(0,0,0,.12); }
ul { list-style:none; margin:0; padding:0; }
li.acc { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:10px 0; border-top:1px solid var(--line); }
li.acc:first-child { border-top:0; padding-top:0; }
.acc b { display:block; }
.hidden { display:none !important; }
.warn { background:var(--warn-bg); border:1px solid var(--warn-line); border-radius:12px; padding:12px 14px; margin:0 0 16px; }
.err { color:var(--err); min-height:1em; margin:8px 0 0; }
.ok { color:var(--ok); font-weight:600; }
#qrBox { width:240px; height:240px; margin:4px auto 12px; background:#fff; border-radius:12px; padding:8px; }
#qrBox svg { width:100%; height:100%; display:block; }
ol { padding-left:20px; margin:8px 0; }
.spinner { display:inline-block; width:16px; height:16px; border:2px solid var(--line); border-top-color:var(--accent); border-radius:50%; animation:spin 1s linear infinite; vertical-align:-3px; margin-right:8px; }
@keyframes spin { to { transform:rotate(360deg); } }
footer { color:var(--muted); font-size:13px; }
`;

const BODY = `
<main>
  <h1>Telegram для Claude</h1>
  <p class="sub">Вход в аккаунт для коннектора. Коды и облачный пароль уходят прямо в Telegram — Claude их не видит и нигде не сохраняет.</p>
  <div id="apiWarn" class="warn hidden">Сначала заполните <b>API ID</b> и <b>API Hash</b> в настройках расширения Telegram в Claude Desktop (их выдают на my.telegram.org → API development tools), затем откройте эту страницу снова.</div>

  <section>
    <h2>Подключённые аккаунты</h2>
    <ul id="accList"></ul>
    <p id="accEmpty" class="muted hidden">Пока нет ни одного.</p>
  </section>

  <section id="add">
    <h2>Добавить аккаунт</h2>
    <div id="startForm">
      <label>Имя аккаунта в коннекторе <span class="muted">(необязательно)</span>
        <input id="accName" maxlength="40" placeholder="например, work или личный" autocomplete="off">
      </label>
      <div class="tabs">
        <button type="button" data-method="qr" class="active">QR-код</button>
        <button type="button" data-method="phone">Номер телефона</button>
      </div>
      <div id="qrStart">
        <p class="muted">Понадобится Telegram на телефоне, где вы уже вошли в этот аккаунт.</p>
        <button id="qrGo" type="button">Показать QR-код</button>
      </div>
      <form id="phoneStart" class="hidden">
        <label>Номер телефона
          <input id="phone" type="tel" placeholder="+7 999 123-45-67" autocomplete="tel">
        </label>
        <button type="submit">Получить код</button>
      </form>
    </div>

    <div id="flow" class="hidden">
      <div id="stepWait"><span class="spinner"></span><span id="waitText">Связываюсь с Telegram…</span></div>
      <div id="stepQr" class="hidden">
        <div id="qrBox"></div>
        <ol>
          <li>Откройте Telegram на телефоне.</li>
          <li>Настройки → Устройства → Подключить устройство.</li>
          <li>Наведите камеру на этот код.</li>
        </ol>
        <p class="muted">Код обновляется сам каждые полминуты.</p>
      </div>
      <form id="stepPhone" class="hidden">
        <label>Номер телефона
          <input id="phoneAgain" type="tel" placeholder="+7 999 123-45-67" autocomplete="tel">
        </label>
        <button type="submit">Получить код</button>
      </form>
      <form id="stepCode" class="hidden">
        <label><span id="codeHint">Код из Telegram</span>
          <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12">
        </label>
        <button type="submit">Войти</button>
      </form>
      <form id="stepPassword" class="hidden">
        <label>Облачный пароль (двухэтапная аутентификация)<span id="pwHint" class="muted"></span>
          <input id="password" type="password" autocomplete="current-password">
        </label>
        <button type="submit">Продолжить</button>
      </form>
      <form id="stepEmail" class="hidden">
        <label>Telegram просит привязать почту для входа
          <input id="email" type="email" autocomplete="email">
        </label>
        <button type="submit">Отправить код на почту</button>
      </form>
      <form id="stepEmailCode" class="hidden">
        <label>Код из письма <span id="emailHint" class="muted"></span>
          <input id="emailCode" inputmode="numeric" autocomplete="one-time-code" maxlength="12">
        </label>
        <button type="submit">Подтвердить</button>
      </form>
      <div id="stepDone" class="hidden">
        <p class="ok" id="doneText"></p>
        <p id="doneNote" class="muted"></p>
        <p>Можно вернуться в Claude и попросить его поработать с Telegram.</p>
        <button id="again" type="button">Добавить ещё аккаунт</button>
      </div>
      <p class="err" id="flowErr"></p>
      <div id="stepError" class="hidden">
        <button id="restart" type="button">Начать заново</button>
      </div>
      <button id="cancel" type="button" class="link">Отменить</button>
    </div>
  </section>

  <footer>Страница работает только на этом компьютере и закроется сама через 30 минут без действий. Сессии хранятся в папке ~/.telegram-mcp; выйти можно здесь или в Telegram: Настройки → Устройства.</footer>
</main>
`;

const SCRIPT = `
(() => {
  const $ = (id) => document.getElementById(id);
  let method = 'qr';
  let flow = null;
  let timer = null;
  let busy = false;
  let dismissed = null; // завершённый вход, который пользователь закрыл

  async function api(path, body) {
    const res = await fetch('api/' + path, body === undefined ? { cache: 'no-store' } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  function show(id, on) { $(id).classList.toggle('hidden', !on); }

  function renderAccounts(list) {
    const ul = $('accList');
    ul.textContent = '';
    show('accEmpty', !list.length);
    for (const a of list) {
      const li = document.createElement('li');
      li.className = 'acc';
      const info = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = a.name;
      const s = document.createElement('span');
      s.className = 'muted';
      s.textContent = [a.user, a.username ? '@' + a.username : null, a.phone].filter(Boolean).join(' · ');
      info.append(b, s);
      const out = document.createElement('button');
      out.type = 'button';
      out.className = 'danger';
      out.textContent = 'Выйти';
      out.onclick = async () => {
        if (!confirm('Выйти из аккаунта «' + a.name + '»? Сессия будет завершена в Telegram, и коннектор забудет этот аккаунт.')) return;
        out.disabled = true;
        try { renderAccounts((await api('logout', { account: a.name })).accounts); } catch (e) { alert(e.message); out.disabled = false; }
      };
      li.append(info, out);
      ul.append(li);
    }
  }

  const STEPS = ['stepWait', 'stepQr', 'stepPhone', 'stepCode', 'stepPassword', 'stepEmail', 'stepEmailCode', 'stepDone', 'stepError'];
  const WAIT_TEXT = { starting: 'Связываюсь с Telegram…', sending_code: 'Отправляю код…', checking: 'Проверяю…', qr_wait: 'Получаю QR-код…' };

  function renderFlow(f) {
    const prevStep = flow && flow.step;
    flow = f;
    const active = f && !['cancelled'].includes(f.step);
    show('startForm', !active);
    show('flow', !!active);
    if (!active) return;
    const map = { qr: 'stepQr', phone: 'stepPhone', code: 'stepCode', password: 'stepPassword', email: 'stepEmail', email_code: 'stepEmailCode', done: 'stepDone', error: 'stepError' };
    const visible = map[f.step] || 'stepWait';
    for (const s of STEPS) show(s, s === visible);
    $('waitText').textContent = WAIT_TEXT[f.step] || 'Подождите…';
    $('flowErr').textContent = f.error || '';
    show('cancel', !['done', 'error'].includes(f.step));
    if (f.step === 'qr' && f.qr_svg) $('qrBox').innerHTML = f.qr_svg;
    if (f.step === 'code') {
      const hints = {
        app: 'Код пришёл в Telegram (на другом вашем устройстве, в чат «Telegram»)',
        sms: 'Код из SMS',
        call: 'Код продиктуют по телефону',
        flash_call: 'Последние цифры номера, с которого поступит звонок',
        missed_call: 'Последние цифры номера пропущенного звонка' + (f.pattern ? ' (номер начинается с ' + f.pattern + ')' : ''),
        fragment: 'Код в приложении Fragment' + (f.url ? ': ' + f.url : ''),
        sms_word: 'Слово из SMS' + (f.pattern ? ' (начинается с «' + f.pattern + '»)' : ''),
        sms_phrase: 'Фраза из SMS' + (f.pattern ? ' (начинается с «' + f.pattern + '»)' : ''),
      };
      $('codeHint').textContent = hints[f.via] || 'Код подтверждения';
      $('code').setAttribute('inputmode', f.via === 'sms_word' || f.via === 'sms_phrase' ? 'text' : 'numeric');
      $('code').maxLength = f.via === 'sms_word' || f.via === 'sms_phrase' ? 100 : 12;
    }
    if (f.step === 'password') $('pwHint').textContent = f.hint ? ' — подсказка: ' + f.hint : '';
    if (f.step === 'email_code') $('emailHint').textContent = f.pattern ? '(отправлен на ' + f.pattern + ')' : '';
    if (f.step === 'done') {
      $('doneText').textContent = '✓ Аккаунт «' + f.account + '» подключён' + (f.user ? ': ' + [f.user.name, f.user.username ? '@' + f.user.username : null].filter(Boolean).join(' ') : '');
      $('doneNote').textContent = f.renamed || '';
    }
    if (f.step !== prevStep) {
      const input = { phone: 'phoneAgain', code: 'code', password: 'password', email: 'email', email_code: 'emailCode' }[f.step];
      if (input) { $(input).value = ''; setTimeout(() => $(input).focus(), 0); }
    }
  }

  async function refresh() {
    try {
      const s = await api('state');
      show('apiWarn', !s.api_ok);
      renderAccounts(s.accounts);
      if (!busy) renderFlow(s.flow && s.flow.id === dismissed ? null : s.flow);
    } catch (e) { /* сервер мог закрыться */ }
    clearTimeout(timer);
    const active = flow && !['done', 'error', 'cancelled'].includes(flow.step);
    timer = setTimeout(refresh, active ? 1000 : 5000);
  }

  async function start() {
    busy = true;
    try {
      const r = await api('start', { method, account: $('accName').value.trim(), phone: $('phone').value.trim() });
      busy = false;
      renderFlow(r.flow);
    } catch (e) { busy = false; alert(e.message); }
    refresh();
  }

  async function submit(step, value) {
    if (!flow) return;
    busy = true;
    try {
      const r = await api('submit', { id: flow.id, step, value });
      busy = false;
      renderFlow(r.flow);
    } catch (e) { busy = false; $('flowErr').textContent = e.message; }
    refresh();
  }

  for (const btn of document.querySelectorAll('.tabs button')) {
    btn.onclick = () => {
      method = btn.dataset.method;
      for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b === btn);
      show('qrStart', method === 'qr');
      show('phoneStart', method === 'phone');
      if (method === 'phone') $('phone').focus();
    };
  }
  // Enter в поле отправляет форму и там, где браузер этого сам не делает (строгий CSP).
  for (const input of document.querySelectorAll('form input')) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); input.form.requestSubmit(); }
    });
  }
  $('qrGo').onclick = start;
  $('phoneStart').onsubmit = (e) => { e.preventDefault(); if ($('phone').value.trim()) start(); };
  $('stepPhone').onsubmit = (e) => { e.preventDefault(); submit('phone', $('phoneAgain').value); };
  $('stepCode').onsubmit = (e) => { e.preventDefault(); submit('code', $('code').value); };
  $('stepPassword').onsubmit = (e) => { e.preventDefault(); submit('password', $('password').value); $('password').value = ''; };
  $('stepEmail').onsubmit = (e) => { e.preventDefault(); submit('email', $('email').value); };
  $('stepEmailCode').onsubmit = (e) => { e.preventDefault(); submit('email_code', $('emailCode').value); };
  $('cancel').onclick = async () => { try { renderFlow((await api('cancel', {})).flow); } catch (e) { alert(e.message); } };
  const suggested = location.hash.match(/account=([^&]+)/);
  if (suggested) { try { $('accName').value = decodeURIComponent(suggested[1]).slice(0, 40); } catch (e) { /* битый адрес */ } }
  const reset = () => { dismissed = flow && flow.id; flow = null; renderFlow(null); };
  $('again').onclick = reset;
  $('restart').onclick = reset;
  refresh();
})();
`;

export function renderPage({ nonce }) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Telegram для Claude — вход</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>${BODY}
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}
