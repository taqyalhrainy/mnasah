import { apiMediaUrl } from './platformApi';
import { t } from '../i18n/preferences';

export type GroupSession = { roomId: string; token: string; id: string; host: boolean; name: string };
export type GroupMessage = { id: string; author_id: string; name: string; body: string; created: number };
export async function groupRequest<T>(path: string, body?: unknown, session?: GroupSession): Promise<T> {
  const response = await fetch(apiMediaUrl(`/api/group-calls${path}`), {
    cache: 'no-store', signal: AbortSignal.timeout(20000),
    headers: { ...(session ? { 'x-group-session': session.token } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(t(value.error || 'تعذر الاتصال بالخدمة. حاول مجددًا.'));
  return value;
}
export async function uploadGroupFile(session: GroupSession, file: File, params: Record<string, string>, signal?: AbortSignal) {
  const query = new URLSearchParams({ ...params, name: file.name, size: String(file.size), type: file.type });
  const response = await fetch(apiMediaUrl(`/api/group-calls/${session.roomId}/files?${query}`), {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-group-session': session.token }, body: file, signal,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(t(value.error || 'تعذر رفع الملف.'));
  return value as { url: string };
}
