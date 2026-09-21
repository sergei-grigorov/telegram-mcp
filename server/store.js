// Хранилище аккаунтов: по файлу JSON на аккаунт в <папка данных>/accounts.
// В файле — строка сессии (ключ авторизации), сведения о пользователе и кэш
// сущностей (id → access_hash), чтобы после перезапуска находить чаты по id.
// Файл даёт полный доступ к аккаунту: права 0600, папка 0700.

import fs from 'node:fs';
import path from 'node:path';

import { AuthKey, bigInt, StringSession } from './tg/lib.js';

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,39}$/u;
const MAX_ENTITIES = 5000;
const FLUSH_DELAY_MS = 1500;

export function validAccountName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && !name.includes('..');
}

export function accountKey(name) {
  return String(name).toLowerCase();
}

function secureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Windows и чужие папки — права не меняем
  }
}

export function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // см. выше
  }
  fs.renameSync(tmp, file);
}

export class AccountStore {
  constructor(dir, logger) {
    this.dir = dir;
    this.logger = logger;
  }

  ensureDir() {
    secureDir(path.dirname(this.dir));
    secureDir(this.dir);
  }

  file(name) {
    if (!validAccountName(name)) throw new Error(`invalid account name: ${name}`);
    return path.join(this.dir, `${accountKey(name)}.json`);
  }

  list() {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const f of names.sort()) {
      if (!f.endsWith('.json')) continue;
      const base = f.slice(0, -5);
      if (!validAccountName(base)) continue;
      const data = this.read(base);
      if (data) out.push(data);
    }
    return out;
  }

  read(name) {
    let text;
    try {
      text = fs.readFileSync(this.file(name), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    try {
      const data = JSON.parse(text);
      if (!data || typeof data.session !== 'string' || !data.session) throw new Error('no session');
      if (!validAccountName(data.name) || accountKey(data.name) !== accountKey(name)) data.name = name;
      return data;
    } catch (err) {
      this.logger?.warn(`файл аккаунта ${name} повреждён: ${err.message}`);
      return null;
    }
  }

  write(name, data) {
    this.ensureDir();
    writeFileAtomic(this.file(name), `${JSON.stringify({ ...data, name, updated: new Date().toISOString() }, null, 1)}\n`);
  }

  remove(name) {
    try {
      fs.unlinkSync(this.file(name));
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }
}

// Сессия teleproto, которая сама сохраняется в файл аккаунта: ключ, дата-центр,
// ключи медиа-ДЦ и кэш сущностей. Запись отложенная и склеивает частые изменения.
export class FileSession extends StringSession {
  constructor({ store, name, data, logger }) {
    super(data.session);
    this._store = store;
    this._name = name;
    this._data = { ...data };
    this._logger = logger;
    this._timer = null;
    // Строка сессии в файле на момент загрузки (или нашей последней записи): по ней
    // видно, что файл поменял другой процесс. Ключ из файла считается рабочим.
    this.loadedSession = data.session;
    this._verifiedKeyHex = this._key ? Buffer.from(this._key).toString('hex') : null;
    for (const row of data.entities ?? []) {
      if (!Array.isArray(row) || row.length < 2 || row[0] == null) continue;
      const [id, hash, username, phone, title] = row;
      try {
        this._entities.set(String(id), [String(id), bigInt(String(hash)), username || undefined, phone || undefined, title || undefined]);
      } catch {
        // битая строка кэша — пропускаем
      }
    }
  }

  async load() {
    await super.load();
    for (const [dc, b64] of Object.entries(this._data.dc_keys ?? {})) {
      const id = Number(dc);
      if (!Number.isInteger(id) || id === this.dcId || typeof b64 !== 'string') continue;
      try {
        const key = new AuthKey();
        await key.setKey(Buffer.from(b64, 'base64'));
        this._dcAuthKeys.set(id, key);
      } catch {
        // повреждённый ключ медиа-ДЦ: создастся заново
      }
    }
  }

  get accountName() {
    return this._name;
  }

  get data() {
    return this._data;
  }

  processEntities(tlo) {
    const rows = this._entitiesToRows(tlo);
    let changed = false;
    for (const row of rows ?? []) {
      const id = String(row[0]);
      const prev = this._entities.get(id);
      const same = prev && String(prev[1]) === String(row[1]) && prev[2] === row[2] && prev[3] === row[3] && prev[4] === row[4];
      // Сущность с нулевым хешем («min»-пользователь) не должна затирать полноценную.
      if (prev && bigInt(row[1]).isZero() && !bigInt(prev[1]).isZero()) continue;
      this._entities.delete(id);
      this._entities.set(id, [id, row[1], row[2], row[3], row[4]]);
      if (!same) changed = true;
    }
    while (this._entities.size > MAX_ENTITIES) this._entities.delete(this._entities.keys().next().value);
    if (changed) this.markDirty();
  }

  setDC(dcId, serverAddress, port) {
    super.setDC(dcId, serverAddress, port);
    this.markDirty();
  }

  setAuthKey(authKey, dcId) {
    super.setAuthKey(authKey, dcId);
    this.markDirty();
  }

  get authKey() {
    return super.authKey;
  }

  set authKey(value) {
    super.authKey = value;
    this.markDirty();
  }

  save() {
    const s = super.save();
    this.markDirty();
    return s;
  }

  updateMeta(patch) {
    Object.assign(this._data, patch);
    this.markDirty();
  }

  currentKeyHex() {
    const key = this.authKey?.getKey?.() ?? this._key;
    return key ? Buffer.from(key).toString('hex') : null;
  }

  // teleproto пересоздаёт ключ после некоторых сбоев связи; новый ключ не
  // авторизован, и записать его в файл — значит потерять вход.
  keyChanged() {
    const current = this.currentKeyHex();
    return current !== null && current !== this._verifiedKeyHex;
  }

  // Вызывается после успешного авторизованного запроса с текущим ключом.
  markVerified() {
    this._verifiedKeyHex = this.currentKeyHex();
    this.markDirty();
  }

  markDirty() {
    if (!this._store || this._timer) return;
    this._timer = setTimeout(() => this.flush(), FLUSH_DELAY_MS);
    this._timer.unref?.();
  }

  flush() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    if (!this._store || this._closed) return;
    // Файл удалили (выход) или перезаписали (вход заново) в другом процессе — не трогаем.
    let onDisk;
    try {
      onDisk = this._store.read(this._name);
    } catch {
      onDisk = null;
    }
    if (!onDisk || onDisk.session !== this.loadedSession) {
      this._logger?.info(`сессия ${this._name} изменена в другом процессе — не перезаписываю`);
      this.detach();
      return;
    }
    // Непроверенный новый ключ не записываем; до load() ключ ещё не разобран — тогда
    // годится прежняя строка сессии.
    const current = this.keyChanged() ? '' : StringSession.prototype.save.call(this);
    const session = current || this._data.session;
    if (!session) return;
    const dcKeys = {};
    for (const [id, key] of this._dcAuthKeys) {
      const raw = key?.getKey?.();
      if (raw) dcKeys[String(id)] = Buffer.from(raw).toString('base64');
    }
    const entities = [...this._entities.values()].map(([id, hash, username, phone, title]) => [
      String(id),
      String(hash),
      username ?? null,
      phone ?? null,
      title ?? null,
    ]);
    this._data = { ...this._data, session, dc_keys: dcKeys, entities };
    try {
      this._store.write(this._name, this._data);
      this.loadedSession = session;
    } catch (err) {
      this._logger?.error(`не удалось сохранить сессию ${this._name}: ${err.message}`);
    }
  }

  // После выхода из аккаунта файл удалён — больше не пишем.
  detach() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._closed = true;
  }
}
