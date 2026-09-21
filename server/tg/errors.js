// Ошибки Telegram (RPC) → понятные модели объяснения с подсказкой, что делать.

import { ToolError } from '../mcp.js';

const RELOGIN = 'The session of this account is no longer valid (logged out from another device or revoked). Ask the user to log in again with open_login_page.';

// Точные коды ошибок.
const MESSAGES = {
  AUTH_KEY_UNREGISTERED: RELOGIN,
  AUTH_KEY_INVALID: RELOGIN,
  SESSION_REVOKED: RELOGIN,
  SESSION_EXPIRED: RELOGIN,
  USER_DEACTIVATED: 'This Telegram account has been deleted.',
  USER_DEACTIVATED_BAN: 'This Telegram account has been banned by Telegram.',
  PEER_FLOOD:
    'Telegram has limited this account for spam-like activity (PEER_FLOOD): it cannot message people or join chats for a while. Do not retry; the user can check the status with @SpamBot.',
  CHAT_WRITE_FORBIDDEN: 'This account cannot write in this chat (not a member, muted or read-only channel).',
  CHAT_RESTRICTED: 'This chat is restricted and cannot be written to.',
  CHAT_ADMIN_REQUIRED: 'This action requires admin rights in the chat.',
  CHAT_GUEST_SEND_FORBIDDEN: 'You must join the chat before writing in it (join_chat).',
  CHANNEL_PRIVATE: 'This channel/group is private or this account was banned from it.',
  CHANNEL_INVALID: 'Invalid channel: it may not exist or is not accessible to this account.',
  CHANNELS_TOO_MUCH: 'This account is in too many channels and groups; it must leave some before joining new ones.',
  CHANNEL_PUBLIC_GROUP_NA: 'This public group is not available.',
  USER_BANNED_IN_CHANNEL: 'This account is banned from sending messages in supergroups and channels.',
  USER_NOT_PARTICIPANT: 'This account is not a member of the chat.',
  USER_ALREADY_PARTICIPANT: 'This account is already a member of the chat.',
  USER_IS_BLOCKED: 'This user has blocked the account, or the account has blocked them.',
  YOU_BLOCKED_USER: 'This account has blocked the user; unblock first.',
  USER_IS_BOT: 'This action is not possible with a bot.',
  BOT_METHOD_INVALID: 'This method is not available here.',
  USER_PRIVACY_RESTRICTED: "The user's privacy settings do not allow this.",
  USER_NOT_MUTUAL_CONTACT: 'The user must be a mutual contact for this.',
  PRIVACY_PREMIUM_REQUIRED: 'This user accepts messages only from Telegram Premium users or contacts.',
  PREMIUM_ACCOUNT_REQUIRED: 'This action requires Telegram Premium.',
  USERNAME_NOT_OCCUPIED: 'No user, bot, group or channel has this username.',
  USERNAME_INVALID: 'Invalid username.',
  USERNAME_OCCUPIED: 'This username is already taken.',
  USERNAME_NOT_MODIFIED: 'This username is already set.',
  PEER_ID_INVALID: 'Invalid chat: this account does not know it (it may need to be opened by @username or link first).',
  INPUT_USER_DEACTIVATED: 'That user account has been deleted.',
  MESSAGE_ID_INVALID: 'No such message in this chat (wrong message_id, or it was deleted).',
  MESSAGE_IDS_EMPTY: 'No message ids given.',
  MESSAGE_NOT_MODIFIED: 'The message already has this content.',
  MESSAGE_EDIT_TIME_EXPIRED: 'This message can no longer be edited (too old).',
  MESSAGE_AUTHOR_REQUIRED: 'Only the author can edit this message.',
  MESSAGE_DELETE_FORBIDDEN: 'This account cannot delete this message.',
  MESSAGE_EMPTY: 'The message is empty.',
  MESSAGE_TOO_LONG: 'The message is too long (max 4096 characters).',
  MEDIA_CAPTION_TOO_LONG: 'The caption is too long (max 1024 characters, 4096 with Premium).',
  MEDIA_EMPTY: 'The file cannot be sent (empty or unsupported).',
  MEDIA_INVALID: 'Invalid media.',
  WEBPAGE_CURL_FAILED: 'Telegram could not download the file from this URL.',
  WEBPAGE_MEDIA_EMPTY: 'The URL does not point to a file Telegram can send.',
  EXTERNAL_URL_INVALID: 'Telegram cannot use this URL.',
  FILE_PARTS_INVALID: 'The file could not be uploaded (invalid size).',
  FILE_REFERENCE_EXPIRED: 'The file reference expired; fetch the message again and retry.',
  PHOTO_INVALID_DIMENSIONS: 'This image cannot be sent as a photo; send it as a document (as_document: true).',
  PHOTO_EXT_INVALID: 'Unsupported photo format; send it as a document (as_document: true).',
  IMAGE_PROCESS_FAILED: 'Telegram failed to process the image; send it as a document (as_document: true).',
  INVITE_HASH_EXPIRED: 'The invite link has expired or was revoked.',
  INVITE_HASH_INVALID: 'The invite link is invalid.',
  INVITE_HASH_EMPTY: 'The invite link is empty.',
  INVITE_REQUEST_SENT: 'A request to join has been sent; an admin must approve it.',
  BOT_RESPONSE_TIMEOUT: 'The bot did not answer the button press in time. It may still process it — check the chat with get_messages.',
  DATA_INVALID: 'The button data is invalid (the message may have changed).',
  BUTTON_DATA_INVALID: 'The button data is invalid.',
  REACTION_INVALID: 'This reaction is not allowed in this chat.',
  REACTION_EMPTY: 'Empty reaction.',
  REACTIONS_TOO_MANY: 'Too many different reactions on this message.',
  SCHEDULE_DATE_TOO_LATE: 'The scheduled date is too far in the future (max ~1 year).',
  SCHEDULE_DATE_INVALID: 'Invalid scheduled date.',
  SCHEDULE_TOO_MUCH: 'Too many scheduled messages in this chat.',
  TOPIC_CLOSED: 'This forum topic is closed.',
  TOPIC_DELETED: 'This forum topic was deleted.',
  TOPIC_ID_INVALID: 'Invalid forum topic id.',
  CHAT_FORWARDS_RESTRICTED: 'Forwarding and saving content from this chat is restricted (protected content).',
  MSG_ID_INVALID: 'Invalid message id.',
  POLL_VOTE_REQUIRED: 'Vote in the poll first.',
  MESSAGE_POLL_CLOSED: 'The poll is closed.',
  OPTION_INVALID: 'Invalid poll option.',
  REVOTE_NOT_ALLOWED: 'Changing the vote is not allowed in this poll.',
  QUIZ_ANSWER_MISSING: 'Quiz answer missing.',
  SLOWMODE_MULTI_MSGS_DISABLED: 'Slow mode is enabled: albums cannot be sent here.',
  YOU_BLOCKED_BOT: 'This account has blocked the bot; unblock it first.',
  BOT_INLINE_DISABLED: 'This bot does not support inline mode.',
  RESULT_ID_INVALID: 'Invalid inline result id: run get_inline_results again.',
  QUERY_ID_INVALID: 'The inline query expired: run get_inline_results again.',
  START_PARAM_INVALID: 'Invalid start parameter (only A-Z, a-z, 0-9, _ and -, up to 64 characters).',
  ADMINS_TOO_MUCH: 'There are too many admins in this chat.',
  RIGHT_FORBIDDEN: 'This account cannot grant these rights.',
  USER_ADMIN_INVALID: 'This account cannot change this admin.',
  PARTICIPANT_ID_INVALID: 'Invalid participant.',
  USERS_TOO_MUCH: 'The chat reached the member limit.',
  USER_CHANNELS_TOO_MUCH: 'The user is in too many channels and groups.',
  USER_KICKED: 'The user was removed from this chat and cannot be added back by you.',
  CHAT_TITLE_EMPTY: 'Chat title cannot be empty.',
  CHAT_ABOUT_TOO_LONG: 'The description is too long.',
  CHAT_NOT_MODIFIED: 'Nothing changed.',
  ABOUT_TOO_LONG: 'The bio is too long.',
  FIRSTNAME_INVALID: 'Invalid first name.',
  CONTACT_ID_INVALID: 'Invalid contact.',
  CONTACT_NAME_EMPTY: 'Contact name cannot be empty.',
  API_ID_INVALID: 'The API ID / API Hash in the connector settings are invalid. The user must copy them from my.telegram.org.',
  API_ID_PUBLISHED_FLOOD: 'This API ID was published publicly and is limited by Telegram. The user should create their own at my.telegram.org.',
  TAKEOUT_REQUIRED: 'This request requires a takeout session.',
  STARS_INSUFFICIENT: 'Not enough Telegram Stars.',
};

// Ошибки с числом в конце: FLOOD_WAIT_17, SLOWMODE_WAIT_30, ALLOW_PAYMENT_REQUIRED_50…
const PATTERNS = [
  [/^(?:FLOOD_WAIT|FLOOD_PREMIUM_WAIT)_(\d+)$/, (n) => `Telegram rate limit: this action is blocked for ${n} s. Do not retry before that; tell the user.`],
  [/^SLOWMODE_WAIT_(\d+)$/, (n) => `Slow mode in this chat: the next message can be sent in ${n} s.`],
  [/^ALLOW_PAYMENT_REQUIRED(?:_(\d+))?$/, (n) => `This chat charges ${n ? `${n} Telegram Stars` : 'Telegram Stars'} per message. The connector never spends Stars: the user can send it manually in Telegram.`],
  [/^PAYMENT_REQUIRED/, () => 'This action requires a payment; the connector does not make payments.'],
  [/^CHAT_SEND_(\w+)_FORBIDDEN$/, (kind) => `Sending ${kind.toLowerCase().replace(/_/g, ' ')} is not allowed in this chat.`],
  [/^(?:PHONE|NETWORK|USER|FILE|STATS)_MIGRATE_(\d+)$/, (n) => `Telegram asked to switch to data center ${n}; retry the request.`],
  [/^TAKEOUT_INIT_DELAY_(\d+)$/, (n) => `Data export is delayed for ${n} s.`],
];

export class TelegramToolError extends ToolError {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export function rpcCode(err) {
  return typeof err?.errorMessage === 'string' ? err.errorMessage : null;
}

export function isRpcError(err, ...codes) {
  const code = rpcCode(err);
  return Boolean(code) && (codes.length === 0 || codes.some((c) => (c instanceof RegExp ? c.test(code) : c === code)));
}

export function explainRpcError(err) {
  const code = rpcCode(err);
  if (!code) return null;
  if (MESSAGES[code]) return `${MESSAGES[code]} [${code}]`;
  for (const [re, fn] of PATTERNS) {
    const m = code.match(re);
    if (m) return `${fn(m[1])} [${code}]`;
  }
  return `Telegram error ${err.code ?? ''} ${code}`.replace(/\s+/g, ' ').trim();
}

// Ошибка из teleproto → ToolError с объяснением. Не-RPC ошибки пробрасываются как есть.
export function toToolError(err, prefix = '') {
  if (err?.name === 'ToolError' || err?.exposed) return err;
  const text = explainRpcError(err);
  if (text) return new TelegramToolError(prefix ? `${prefix}: ${text}` : text, rpcCode(err));
  if (err?.message === 'TIMEOUT' || /timed? ?out/i.test(err?.message ?? '')) {
    return new TelegramToolError(`${prefix ? `${prefix}: ` : ''}Telegram did not respond in time. Check the network or proxy and retry.`, 'TIMEOUT');
  }
  return err;
}
