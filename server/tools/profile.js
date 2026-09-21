// Профиль аккаунта и контакты.

import { ToolError } from '../mcp.js';
import { TOOL } from '../names.js';
import { chatRef } from '../tg/format.js';
import { Api, CustomFile } from '../tg/lib.js';
import { ACCOUNT, WRITE, account, chat, reply, schema } from './common.js';

export default function profileTools(services) {
  const { policy } = services;
  return [
    {
      name: TOOL.updateProfile,
      title: 'Update profile',
      capability: 'profile',
      annotations: WRITE,
      description: 'Change this Telegram account\'s first/last name, bio, username or profile photo. Only on explicit user request.',
      inputSchema: schema({
        account: ACCOUNT,
        first_name: { type: 'string', maxLength: 64 },
        last_name: { type: 'string', maxLength: 64, description: 'Empty string removes it.' },
        bio: { type: 'string', maxLength: 140, description: 'Empty string removes it (up to 70 characters without Premium).' },
        username: { type: 'string', maxLength: 32, description: 'New @username without @; empty string removes it.' },
        photo: { type: 'string', description: 'New profile photo: image path inside the allowed folders.' },
      }),
      handler: async (args) => {
        const acc = await account(services, args, 'profile');
        const changed = [];
        policy.takeActions(acc.name);
        if (args.first_name !== undefined || args.last_name !== undefined || args.bio !== undefined) {
          if (args.first_name !== undefined && !args.first_name.trim()) throw new ToolError('first_name cannot be empty.');
          const user = await acc.invoke(new Api.account.UpdateProfile({ firstName: args.first_name, lastName: args.last_name, about: args.bio }));
          if (user instanceof Api.User) acc.me = user;
          changed.push(...['first_name', 'last_name', 'bio'].filter((k) => args[k] !== undefined));
        }
        if (args.username !== undefined) {
          const user = await acc.invoke(new Api.account.UpdateUsername({ username: args.username.replace(/^@/, '') }));
          if (user instanceof Api.User) acc.me = user;
          changed.push('username');
        }
        if (args.photo !== undefined) {
          const f = policy.checkUploadPath(args.photo);
          const file = await acc.client.uploadFile({ file: new CustomFile(f.name, f.size, f.path), workers: 2 });
          await acc.invoke(new Api.photos.UploadProfilePhoto({ file }));
          changed.push('photo');
        }
        if (!changed.length) throw new ToolError('Nothing to change: pass first_name, last_name, bio, username or photo.');
        return reply(services, { account: acc.name, changed, me: chatRef(acc.me) });
      },
    },

    {
      name: TOOL.manageContact,
      title: 'Manage contact',
      capability: 'profile',
      annotations: WRITE,
      description:
        'Add a user to the Telegram contacts (optionally sharing this account\'s phone number with them), delete a contact, block or unblock a user or bot. Only on explicit user request.',
      inputSchema: schema(
        {
          account: ACCOUNT,
          action: { type: 'string', enum: ['add', 'delete', 'block', 'unblock'] },
          user: { type: ['string', 'integer'], description: 'User: id, @username, t.me link or phone of an existing contact.' },
          first_name: { type: 'string', maxLength: 64, description: 'add: name for the contact (default: their name).' },
          last_name: { type: 'string', maxLength: 64 },
          share_phone: { type: 'boolean', description: 'add: let them see this account\'s phone number.' },
        },
        ['action', 'user'],
      ),
      handler: async (args) => {
        const acc = await account(services, args, 'profile');
        const u = await chat(services, acc, args.user);
        if (!(u.entity instanceof Api.User) || u.entity.self) throw new ToolError('Expected another user.');
        const inputUser = new Api.InputUser({ userId: u.input.userId, accessHash: u.input.accessHash });
        policy.takeActions(acc.name);
        switch (args.action) {
          case 'add':
            await acc.invoke(
              new Api.contacts.AddContact({
                id: inputUser,
                firstName: args.first_name ?? u.entity.firstName ?? '',
                lastName: args.last_name ?? u.entity.lastName ?? '',
                phone: '',
                addPhonePrivacyException: args.share_phone || undefined,
              }),
            );
            break;
          case 'delete':
            await acc.invoke(new Api.contacts.DeleteContacts({ id: [inputUser] }));
            break;
          case 'block':
            await acc.invoke(new Api.contacts.Block({ id: u.input }));
            break;
          case 'unblock':
            await acc.invoke(new Api.contacts.Unblock({ id: u.input }));
            break;
          default:
            throw new ToolError(`Unknown action ${args.action}`);
        }
        return reply(services, { account: acc.name, action: args.action, user: chatRef(u.entity) });
      },
    },
  ];
}
