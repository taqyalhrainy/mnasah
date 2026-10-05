import { locale, t } from '../i18n/preferences';
export type Portal = 'admin' | 'teachers' | 'students';
export type Category = { id: string; name: string; description: string; icon: string; levels: string[]; subjects: string[] };
export type User = { id: string; email: string; name: string; role: Portal; status: string; subject: string; bio: string; mustChangePassword?: boolean };
export type Slot = { id: string; teacher_id: string; teacher_name?: string; bio?: string; teacher_subjects?: string; start: number; minutes: number; price: number; subject: string; status: string; available_until?: number };
export type Booking = Slot & { slot_id: string; student_id: string; student_name: string; teacher_name: string; notes: string; resource: string; paid: number; payment_ref: string; teacher_present_until?: number; student_present_until?: number };
export type Message = { id: string; body: string; created: number; name: string };
const apiBase = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
export async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${apiBase}/api/${path}`, { credentials: 'include', cache: 'no-store', signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  let data;
  try { data = await response.json(); } catch { throw new Error(t('تعذر الاتصال بالخدمة. حاول مجددًا.')); }
  if (!response.ok) throw new Error(t(data.error || 'تعذر تنفيذ الطلب.'));
  return data;
}
export const portalNames: Record<Portal, string> = { admin: 'الإدارة والأونر', teachers: 'بوابة الأساتذة', students: 'بوابة الطلاب' };
export const statusNames: Record<string, string> = { active: 'نشط', pending: 'بانتظار الموافقة', suspended: 'موقوف', confirmed: 'مؤكدة', completed: 'مكتملة', cancelled: 'ملغاة', open: 'متاح', booked: 'محجوز' };
export const date = (value: number) => new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(value);
export const money = (value: number) => new Intl.NumberFormat(locale(), { style: 'currency', currency: 'JOD' }).format(value / 100);
