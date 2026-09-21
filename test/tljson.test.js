import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Api, bigInt } from '../server/tg/lib.js';
import { buildRequest, constructorsOf, describeDefinition, findMethod, searchSchema, toJson } from '../server/tg/tljson.js';

const ctx = {
  resolvePeer: async (value) => {
    if (value === '@durov') return { input: new Api.InputPeerUser({ userId: bigInt(1), accessHash: bigInt(2) }) };
    if (value === -1005) return { input: new Api.InputPeerChannel({ channelId: bigInt(5), accessHash: bigInt(6) }) };
    throw new Error(`unknown ${value}`);
  },
};

test('поиск и описание методов', () => {
  assert.equal(findMethod('messages.getHistory').fullName, 'messages.GetHistory');
  assert.equal(findMethod('Messages.GetHistory').fullName, 'messages.GetHistory');
  assert.equal(findMethod('messages.nope'), null);
  const d = describeDefinition(findMethod('messages.getHistory'));
  assert.equal(d.method, 'messages.getHistory');
  assert.ok(d.params.some((p) => p.name === 'offset_id' && p.type === 'int'));
  assert.ok(constructorsOf('MessagesFilter').some((c) => c.constructor === 'inputMessagesFilterPhotos'));
  assert.ok(searchSchema('gethistory').methods.includes('messages.getHistory'));
});

test('JSON → запрос: snake_case, пиры по ссылке, вложенные конструкторы, байты, значения по умолчанию', async () => {
  const { request } = await buildRequest('messages.search', { peer: '@durov', q: 'hi', filter: { _: 'inputMessagesFilterPhotos' }, limit: 5, min_date: '2023-11-14T22:13:20Z' }, ctx);
  assert.equal(request.className, 'messages.Search');
  assert.ok(request.peer instanceof Api.InputPeerUser);
  assert.ok(request.filter instanceof Api.InputMessagesFilterPhotos);
  assert.equal(request.minDate, 1_700_000_000);
  assert.equal(request.offsetId, 0);
  assert.ok(bigInt.isInstance(request.hash));

  const { request: ch } = await buildRequest('channels.getFullChannel', { channel: -1005 }, ctx);
  assert.ok(ch.channel instanceof Api.InputChannel);

  const { request: cb } = await buildRequest('messages.getBotCallbackAnswer', { peer: '@durov', msg_id: 3, data: { _bytes: Buffer.from('ok').toString('base64') } }, ctx);
  assert.equal(cb.data.toString(), 'ok');
});

test('ошибки: неизвестный параметр, не хватает параметров, тип конструктора', async () => {
  await assert.rejects(buildRequest('messages.getHistory', { peer: '@durov', limit: 1, bogus: 1 }, ctx), /unknown parameter "bogus"/);
  await assert.rejects(buildRequest('messages.sendMessage', { message: 'x' }, ctx), /missing required parameter\(s\).*peer/);
  await assert.rejects(buildRequest('messages.search', { peer: '@durov', q: '', filter: { _: 'inputPeerSelf' }, limit: 1 }, ctx), /InputPeer, but MessagesFilter is expected/);
  await assert.rejects(buildRequest('messages.nothing', {}, ctx), /Unknown method/);
});

test('опасные методы закрыты всегда', async () => {
  for (const m of ['auth.acceptLoginToken', 'auth.logOut', 'account.deleteAccount', 'account.updatePasswordSettings', 'messages.editChatCreator', 'payments.sendStarsForm', 'messages.acceptUrlAuth', 'account.acceptAuthorization', 'messages.sendPaidReaction']) {
    await assert.rejects(buildRequest(m, {}, ctx), /never available/, m);
  }
  await assert.rejects(buildRequest('messages.sendMessage', { peer: '@durov', message: 'x', allow_paid_stars: 10 }, ctx), /Stars/);
  await assert.rejects(
    buildRequest('messages.getBotCallbackAnswer', { peer: '@durov', msg_id: 1, password: { _: 'inputCheckPasswordEmpty' } }, ctx),
    /cloud password/,
  );
  const { request } = await buildRequest('payments.getStarsStatus', { peer: '@durov' }, ctx);
  assert.equal(request.className, 'payments.GetStarsStatus');
});

test('TL → JSON', () => {
  const user = new Api.User({ id: bigInt('123456789012'), firstName: 'A', accessHash: bigInt(-5), bot: false });
  assert.deepEqual(toJson(user), { _: 'User', id: '123456789012', accessHash: '-5', firstName: 'A' });
  const big = toJson(Buffer.alloc(1000, 1), { maxBytes: 4 });
  assert.equal(big._bytes_total, 1000);
  assert.equal(toJson([1, 2, 3], { maxItems: 2 }).length, 3);
});
