import { locale, t } from '../i18n/preferences';
export type Portal = 'admin' | 'teachers' | 'students';
export type Category = { id: string; name: string; description: string; icon: string; levels: string[]; subjects: string[] };
export type CustomPackage = { id: string; name: string; description: string; levels: string[] };
export type Verification = { first_name?: string; father_name?: string; family_name?: string; birth_date?: string; age?: number; gender?: string; phone?: string; qualifications?: string[]; other_qualification?: string; years_experience?: number; teaching_languages?: string[]; other_teaching_language?: string; professional_bio?: string; verification_status?: string; submitted_at?: number; reviewed_at?: number; rejection_reason?: string };
export type VerificationFile = { id: string; user_id?: string; kind: 'avatar' | 'intro_video' | 'credential'; name: string; size: number; content_type: string };
export type User = { id: string; email: string; name: string; role: Portal; status: string; subject: string; bio: string; phone?: string; avatar_url?: string; verification?: Verification; verification_files?: VerificationFile[]; auth_provider?: string; email_verified?: boolean; custom_packages?: CustomPackage[]; mustChangePassword?: boolean };
export type SlotOffering = { minutes: number; price: number };
export type Slot = { id: string; teacher_id: string; teacher_name?: string; bio?: string; teacher_subjects?: string; start: number; minutes: number; price: number; subject: string; subjects?: string[]; offerings?: SlotOffering[]; status: string; available_until?: number; booked_ranges?: Array<{ start: number; end: number }> };
export type Booking = Slot & { slot_id: string; student_id: string; student_name: string; teacher_name: string; teacher_phone?: string; student_phone?: string; notes: string; resource: string; paid: number; payment_ref: string; teacher_present_until?: number; student_present_until?: number; teacher_joined_at?: number; student_joined_at?: number; cancelled_at?: number; cancelled_by?: string; cancellation_reason?: string; refund_amount?: number; teacher_compensation?: number; platform_fee?: number };
export type Message = { id: string; body: string; created: number; name: string };
export type WalletTransaction = { id: string; type: 'cliq_topup' | 'lesson_payment' | 'lesson_refund' | 'admin_adjustment'; amount: number; reference: string; created: number };
export type WalletTopup = { id: string; user_id: string; user_name?: string; user_email?: string; amount: number; status: 'pending' | 'approved' | 'rejected'; transfer_reference: string; proof_name: string; proof_type: string; created: number; reviewed_at: number; rejection_reason: string };
export type PaymentSettings = { cliq_alias: string; cliq_name: string; support_whatsapp?: string; ready?: boolean };
export type WalletData = { balance: number; payment: PaymentSettings; topups: WalletTopup[]; transactions: WalletTransaction[] };
export type WalletAccountSummary = { user_id: string; user_name: string; user_email: string; balance: number; updated: number };
export type CancellationQuote = { tier: 'teacher_cancelled' | 'student_24h' | 'student_6h' | 'student_late'; hoursBefore: number; refund: number; teacherCompensation: number; platformFee: number; refundPercent: number };
const apiBase = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
export const apiUrl = (path: string) => `${apiBase}/api/${path}`;
export const apiMediaUrl = (value: string) => value.startsWith('/api/') ? `${apiBase}${value}` : value;
export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${apiBase}/api/${path}`, { credentials: 'include', cache: 'no-store', signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  let data;
  try { data = await response.json(); } catch { throw new Error(t('تعذر الاتصال بالخدمة. حاول مجددًا.')); }
  if (!response.ok) throw new ApiError(t(data.error || 'تعذر تنفيذ الطلب.'), response.status);
  return data;
}
export async function requestFile<T>(path: string, file: File, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const query = new URLSearchParams({ ...params, name: file.name, size: String(file.size), type: file.type });
  const response = await fetch(`${apiBase}/api/${path}?${query}`, { method: 'POST', credentials: 'include', cache: 'no-store', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal });
  let data; try { data = await response.json(); } catch { throw new Error(t('تعذر الاتصال بالخدمة. حاول مجددًا.')); }
  if (!response.ok) throw new ApiError(t(data.error || 'تعذر رفع الملف.'), response.status);
  return data;
}
export const portalNames: Record<Portal, string> = { admin: 'الإدارة والأونر', teachers: 'بوابة الأساتذة', students: 'بوابة الطلاب' };
export const statusNames: Record<string, string> = { active: 'نشط', pending: 'بانتظار الموافقة', suspended: 'موقوف', confirmed: 'مؤكدة', completed: 'مكتملة', cancelled: 'ملغاة', open: 'متاح', booked: 'محجوز' };
export const date = (value: number) => new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(value);
export const money = (value: number) => new Intl.NumberFormat(locale(), { style: 'currency', currency: 'JOD' }).format(value / 100);
