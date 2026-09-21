// Расшифровка голосовых. Telegram расшифровывает их только с Premium, поэтому
// звук уходит в сервис распознавания речи с API, совместимым с OpenAI
// (POST …/audio/transcriptions): Groq, OpenAI или свой сервер Whisper.

import { SETTING_TITLES } from './config.js';
import { ToolError } from './mcp.js';

// Предел Groq и OpenAI для одного файла.
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;

// Форматы, которые принимают эти сервисы; формат они определяют по имени файла.
const EXTENSIONS = new Set(['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'wav', 'webm']);
const BY_MIME = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/webm': 'webm',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/mpeg': 'mpeg',
};

// Имя файла для сервиса: голосовые Telegram — Ogg/Opus, кружки — MP4.
// null — формат сервисы не принимают.
export function audioFileName(kind, mime, name) {
  let ext = (/\.([a-z0-9]+)$/i.exec(name ?? '')?.[1] ?? '').toLowerCase();
  if (ext === 'oga' || ext === 'opus') ext = 'ogg';
  if (!EXTENSIONS.has(ext)) ext = BY_MIME[String(mime ?? '').toLowerCase()] ?? '';
  if (!ext && kind === 'voice') ext = 'ogg';
  if (!ext && kind === 'video_note') ext = 'mp4';
  return ext ? `${kind}.${ext}` : null;
}

// Ошибка, после которой нет смысла пробовать остальные сообщения: ключ, адрес, сеть.
function fatalError(message) {
  return Object.assign(new ToolError(message), { fatal: true });
}

function httpError(cfg, status, detail, retryAfter) {
  const why = detail ? `: ${detail}` : '';
  const settings = 'the Telegram extension settings in Claude Desktop';
  if (status === 401) return fatalError(`${cfg.service} rejected the API key (401)${why}. The user should check «${SETTING_TITLES.transcribe_api_key}» in ${settings}.`);
  if (status === 403) return fatalError(`${cfg.service} refused the request (403)${why}. The service may be unavailable in the user's region, or the key has no access to the model.`);
  if (status === 404) return fatalError(`${cfg.service}: not found (404)${why}. Check «${SETTING_TITLES.transcribe_api_url}» and «${SETTING_TITLES.transcribe_model}» in ${settings}.`);
  if (status === 413) return new ToolError(`${cfg.service}: the file is too large (413)${why}.`);
  if (status === 429) return fatalError(`${cfg.service}: rate limit (429)${why}. ${retryAfter ? `Retry in ${retryAfter} s.` : 'Try again later.'}`);
  return new ToolError(`${cfg.service} error ${status}${why}.`);
}

// Один файл → текст. cfg — config.transcription.
export async function transcribe(cfg, { data, fileName, mime, language, signal }) {
  const form = new FormData();
  form.append('file', new Blob([data], { type: mime || 'application/octet-stream' }), fileName);
  form.append('model', cfg.model);
  form.append('response_format', 'json');
  if (language) form.append('language', language);
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal && AbortSignal.any ? AbortSignal.any([signal, timeout]) : timeout;
  let res;
  let body;
  try {
    res = await fetch(`${cfg.url}/audio/transcriptions`, {
      method: 'POST',
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
      body: form,
      signal: combined,
    });
    body = await res.text();
  } catch (err) {
    if (signal?.aborted) throw new ToolError('Cancelled.');
    if (timeout.aborted) throw fatalError(`${cfg.service} did not answer in ${REQUEST_TIMEOUT_MS / 1000} s.`);
    throw fatalError(`Could not reach the transcription service ${cfg.service}: ${err.cause?.code ?? err.cause?.message ?? err.message}.`);
  }
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    // не JSON — текст ошибки или сам текст расшифровки
  }
  if (!res.ok) {
    const detail = json?.error?.message ?? json?.error ?? json?.detail ?? body;
    throw httpError(cfg, res.status, String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300), res.headers.get('retry-after'));
  }
  const text = typeof json?.text === 'string' ? json.text : json === null ? body : null;
  if (text === null) throw new ToolError(`${cfg.service} returned an unexpected answer.`);
  return { text: text.trim(), language: typeof json?.language === 'string' ? json.language : undefined };
}
