import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import { MongoClient } from 'mongodb';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import webpush from 'web-push';
import { handleChat, ensureChat } from '../shared/chat.js';
import { mongoChatStore } from './chat-store.js';
import { paymentDay, paymentMidnight, paymentRange, paymentSummary } from '../shared/payments.js';
import { cancellationQuote } from '../shared/cancellation.js';
import { serveChatAttachment } from './chat-attachments.js';
import { serveVerificationFile, verificationBytes } from './verification-files.js';
import { serveWalletTopup, walletProofBytes } from './wallet-topups.js';
import { attachmentHeaders } from '../shared/chat-attachments.js';
import { parseCustomPackages, serializeCustomPackages } from '../shared/custom-packages.js';
import { parseVerification, registrationProfile } from '../shared/verification.js';
import { paymentSettings, publicTopup } from '../shared/wallet-topups.js';
import { GOOGLE_WEB_CLIENT_ID } from '../shared/google.js';
import { jordanCatalog } from '../shared/jordan-catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: CLIENT_ORIGIN_ALLOWED, credentials: true } });
function CLIENT_ORIGIN_ALLOWED(origin, callback) {
  callback(null, !origin || validChatOrigin(origin));
}
const PORT = Number(process.env.PORT || 8787);
const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DB = process.env.MONGODB_DB || 'mansah';
const MONGODB_USER = process.env.MONGODB_USER || '';
const MONGODB_PASSWORD = process.env.MONGODB_PASSWORD || '';
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '';
const OWNER_SETUP_TOKEN = process.env.OWNER_SETUP_TOKEN || 'local-testing-owner-token';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || GOOGLE_WEB_CLIENT_ID;
const VAPID_PUBLIC_KEY = String(process.env.VAPID_PUBLIC_KEY || '').trim();
const VAPID_PRIVATE_KEY = String(process.env.VAPID_PRIVATE_KEY || '').trim();
const VAPID_SUBJECT = String(process.env.VAPID_SUBJECT || 'mailto:support@mnasah.onrender.com').trim();
const pushReady = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushReady) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
function validChatOrigin(origin, req) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (req && url.host === req.headers.host) return true;
    return CLIENT_ORIGIN.split(',').map(value => value.trim()).includes(origin)
      || origin === 'https://mnasah.onrender.com' || origin === 'https://taqyalhrainy.github.io'
      || (process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname));
  } catch { return false; }
}

if (!MONGODB_URI) {
  console.warn('MONGODB_URI is not set. Add it to .env before using the backend with real data.');
}

app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && validChatOrigin(origin, req)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/public/config', (_req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID, vapidPublicKey: pushReady ? VAPID_PUBLIC_KEY : '' }));

let db;
let client;
let attachmentBytes;
let topupProofBytes;
async function connect() {
  if (db) return db;
  if (!MONGODB_URI) fail(500, 'MongoDB غير مضبوط على الخادم.');
  client = new MongoClient(MONGODB_URI, MONGODB_USER ? { auth: { username: MONGODB_USER, password: MONGODB_PASSWORD } } : {});
  await client.connect();
  db = client.db(MONGODB_DB);
  await Promise.all([
    db.collection('users').createIndex({ email: 1 }, { unique: true }),
    db.collection('users').createIndex({ role: 1 }),
    db.collection('sessions').createIndex({ token: 1 }, { unique: true }),
    db.collection('sessions').createIndex({ expires: 1 }, { expireAfterSeconds: 0 }),
    db.collection('password_resets').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    db.collection('password_resets').createIndex({ user_id: 1, created: -1 }),
    db.collection('slots').createIndex({ teacher_id: 1, start: 1 }),
    db.collection('slots').createIndex({ start: 1 }),
    db.collection('bookings').createIndex({ slot_id: 1 }),
    db.collection('bookings').createIndex({ student_id: 1 }),
    db.collection('bookings').createIndex({ student_id: 1, start: 1 }),
    db.collection('ratings').createIndex({ booking_id: 1, student_id: 1 }, { unique: true }),
    db.collection('ratings').createIndex({ teacher_id: 1, created: -1 }),
    db.collection('lesson_reports').createIndex({ id: 1 }, { unique: true }),
    db.collection('lesson_reports').createIndex({ status: 1, created: -1 }),
    db.collection('lesson_reports').createIndex({ booking_id: 1, reporter_id: 1, status: 1 }),
    db.collection('messages').createIndex({ booking_id: 1, created: 1 }),
    db.collection('conversations').createIndex({ id: 1 }, { unique: true }),
    db.collection('conversations').createIndex({ teacher_id: 1, student_id: 1 }, { unique: true }),
    db.collection('conversations').createIndex({ student_id: 1 }),
    db.collection('chat_members').createIndex({ thread_id: 1, user_id: 1 }, { unique: true }),
    db.collection('chat_settings').createIndex({ user_id: 1 }, { unique: true }),
    db.collection('direct_messages').createIndex({ id: 1 }, { unique: true }),
    db.collection('direct_messages').createIndex({ thread_id: 1, created: -1, id: -1 }),
    db.collection('chat_reactions').createIndex({ message_id: 1, user_id: 1, emoji: 1 }, { unique: true }),
    db.collection('chat_attachments').createIndex({ id: 1 }, { unique: true }),
    db.collection('chat_attachments').createIndex({ author_id: 1, created: 1 }),
    db.collection('chat_attachments').createIndex({ expires_at: 1 }),
    db.collection('verification_files').createIndex({ id: 1 }, { unique: true }),
    db.collection('verification_files').createIndex({ user_id: 1, kind: 1 }),
    db.collection('catalog').createIndex({ kind: 1, position: 1 }),
    db.collection('wallet_accounts').createIndex({ user_id: 1 }, { unique: true }),
    db.collection('wallet_transactions').createIndex({ reference: 1 }, { unique: true, sparse: true }),
    db.collection('wallet_topups').createIndex({ proof_hash: 1 }, { unique: true }),
    db.collection('wallet_topups').createIndex({ status: 1, created: -1 }),
    db.collection('lesson_packages').createIndex({ teacher_id: 1, status: 1 }),
    db.collection('package_purchases').createIndex({ student_id: 1, created: -1 }),
    db.collection('package_purchases').createIndex({ teacher_id: 1, status: 1 }),
    db.collection('push_subscriptions').createIndex({ endpoint: 1 }, { unique: true }),
    db.collection('push_subscriptions').createIndex({ user_id: 1, updated: -1 }),
  ]);
  await seedCatalog();
  return db;
}

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}
function field(value, max = 200, min = 1) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) fail(400, 'تحقق من الحقول المطلوبة وطول النص.');
  return value.trim();
}
const allowedDurations = [30, 45, 60, 90, 120];
function slotSubjects(body) {
  const values = Array.isArray(body.subjects) ? body.subjects : [body.subject];
  const subjects = [...new Set(values.map(value => field(value, 100)).filter(Boolean))];
  if (!subjects.length || subjects.length > 20) fail(400, 'اختر مادة واحدة على الأقل.');
  return subjects;
}
function slotOfferings(body) {
  const values = Array.isArray(body.offerings) && body.offerings.length ? body.offerings : [{ minutes: body.minutes, price: body.price }];
  const offerings = [...new Map(values.map(item => ({ minutes: Number(item?.minutes), price: Number(item?.price) })).map(item => [item.minutes, item])).values()].sort((left, right) => left.minutes - right.minutes);
  if (!offerings.length || offerings.length > allowedDurations.length || offerings.some(item => !allowedDurations.includes(item.minutes) || !Number.isInteger(item.price) || item.price < 0 || item.price > 100000)) fail(400, 'تحقق من مدد الحصة وأسعارها.');
  return offerings;
}
const storedSubjects = slot => Array.isArray(slot.subjects) && slot.subjects.length ? slot.subjects : [slot.subject].filter(Boolean);
const storedOfferings = slot => Array.isArray(slot.offerings) && slot.offerings.length ? slot.offerings : [{ minutes: slot.minutes, price: slot.price }];
const clockPattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
function weeklySchedule(body, required = true) {
  const rows = Array.isArray(body.weekly_schedule) ? body.weekly_schedule : [];
  if ((required && !rows.length) || rows.length > 7) fail(400, 'اختر يوماً واحداً على الأقل وحدد الفترة المتاحة للباقة.');
  const schedule = rows.map(row => ({ weekday: Number(row?.weekday), from: String(row?.from || ''), to: String(row?.to || '') }));
  if (schedule.some(row => !Number.isInteger(row.weekday) || row.weekday < 0 || row.weekday > 6 || !clockPattern.test(row.from) || !clockPattern.test(row.to) || row.from === row.to) || new Set(schedule.map(row => row.weekday)).size !== schedule.length) fail(400, 'تحقق من أيام الباقة وفترات التوفر.');
  return schedule.sort((left, right) => left.weekday - right.weekday);
}
const storedWeeklySchedule = row => weeklySchedule({ weekly_schedule: Array.isArray(row?.weekly_schedule) ? row.weekly_schedule : [] }, false);
const minutesOfDay = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const civilAdd = (day, amount) => { const value = new Date(`${day}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + amount); return value.toISOString().slice(0, 10); };
const civilWeekday = day => new Date(`${day}T12:00:00Z`).getUTCDay();
function packageWindow(day, row) {
  const start = paymentMidnight(day) + minutesOfDay(row.from) * 60000;
  let end = paymentMidnight(day) + minutesOfDay(row.to) * 60000;
  if (end <= start) end += 86400000;
  return { start, end };
}
async function catalogSubjectSet() {
  const rows = await categories();
  return new Set(rows.flatMap(row => Array.isArray(row.subjects) ? row.subjects : []));
}
function assertCatalogSubjects(subjects, allowed) {
  if (!subjects.length || subjects.some(subject => !allowed.has(subject))) fail(400, 'اختر المواد من القائمة التي أضافتها الإدارة فقط.');
}
function lessonPackageInput(body) {
  const lessonCount = Number(body.lesson_count), minutes = Number(body.minutes), price = Number(body.price), validityDays = Number(body.validity_days);
  const subjects = slotSubjects(body);
  if (!Number.isInteger(lessonCount) || lessonCount < 2 || lessonCount > 60) fail(400, 'عدد حصص الباقة يجب أن يكون بين حصتين و60 حصة.');
  if (!allowedDurations.includes(minutes)) fail(400, 'اختر مدة صحيحة للحصة.');
  if (!Number.isInteger(price) || price < 100 || price > 1000000) fail(400, 'تحقق من سعر الباقة.');
  if (!Number.isInteger(validityDays) || validityDays < 7 || validityDays > 365) fail(400, 'صلاحية الباقة يجب أن تكون بين 7 و365 يوماً.');
  return { name: field(body.name, 100), description: field(body.description || '', 500, 0), subjects, lesson_count: lessonCount, minutes, price, validity_days: validityDays, weekly_schedule: weeklySchedule(body) };
}
const storedSelectedSchedule = row => weeklySchedule({ weekly_schedule: Array.isArray(row?.selected_schedule) ? row.selected_schedule : [] }, false);
const publicLessonPackage = row => ({ id: row.id, teacher_id: row.teacher_id, teacher_name: row.teacher_name || '', name: row.name, description: row.description || '', subjects: row.subjects || [], lesson_count: Number(row.lesson_count), minutes: Number(row.minutes), price: Number(row.price), validity_days: Number(row.validity_days), weekly_schedule: storedWeeklySchedule(row), reserved_schedule: storedSelectedSchedule({ selected_schedule: row.reserved_schedule }), status: row.status || 'active', sold_count: Number(row.sold_count || 0), active_students: Number(row.active_students || 0), teacher_rating: row.teacher_rating ?? null, teacher_rating_count: Number(row.teacher_rating_count || 0), created: Number(row.created || 0), updated: Number(row.updated || 0) });
const publicPackagePurchase = row => ({ id: row.id, package_id: row.package_id, teacher_id: row.teacher_id, teacher_name: row.teacher_name || '', package_name: row.package_name || '', subjects: row.subjects || [], lesson_count: Number(row.lesson_count), remaining_lessons: Number(row.remaining_lessons), minutes: Number(row.minutes), price: Number(row.price), weekly_schedule: storedWeeklySchedule(row), selected_schedule: storedSelectedSchedule(row), status: row.status === 'completed' ? 'completed' : Number(row.expires_at) <= Date.now() ? 'expired' : row.status === 'scheduled' ? 'scheduled' : Number(row.remaining_lessons) <= 0 ? 'exhausted' : row.status || 'active', expires_at: Number(row.expires_at), created: Number(row.created || 0) });

function selectedPackageSchedule(body, offer) {
  const rows = Array.isArray(body.selections) ? body.selections : [];
  if (!rows.length || rows.length > 7) fail(400, 'اختر يوماً واحداً على الأقل من أيام الباقة قبل الشراء.');
  const available = storedWeeklySchedule(offer);
  const minutes = Number(offer.minutes);
  const selected = rows.map(value => ({ weekday: Number(value?.weekday), from: String(value?.from || ''), to: String(value?.to || '') }));
  if (new Set(selected.map(row => row.weekday)).size !== selected.length) fail(400, 'لا يمكن اختيار اليوم نفسه أكثر من مرة.');
  for (const row of selected) {
    if (!clockPattern.test(row.from) || !clockPattern.test(row.to)) fail(400, 'تحقق من وقت البداية والنهاية لأيام الباقة.');
    const source = available.find(item => item.weekday === row.weekday);
    if (!source) fail(400, 'أحد الأيام المختارة ليس ضمن الأيام التي أتاحها الأستاذ.');
    const sourceStart = minutesOfDay(source.from);
    let sourceEnd = minutesOfDay(source.to);
    if (sourceEnd <= sourceStart) sourceEnd += 1440;
    let start = minutesOfDay(row.from);
    if (start < sourceStart && sourceEnd > 1440) start += 1440;
    let end = minutesOfDay(row.to);
    while (end <= start) end += 1440;
    if (start % 15 || end % 15 || end - start !== minutes || start < sourceStart || end > sourceEnd) fail(400, `اختر فترة مدتها ${minutes} دقيقة ضمن وقت الأستاذ وبفواصل ربع ساعة.`);
  }
  return selected.sort((left, right) => left.weekday - right.weekday);
}

function selectedStartForDay(day, sourceRow, selectedRow) {
  const sourceStart = minutesOfDay(sourceRow.from);
  let sourceEnd = minutesOfDay(sourceRow.to);
  if (sourceEnd <= sourceStart) sourceEnd += 1440;
  let selectedStart = minutesOfDay(selectedRow.from);
  if (selectedStart < sourceStart && sourceEnd > 1440) selectedStart += 1440;
  return paymentMidnight(day) + selectedStart * 60000;
}

function plannedPackageStarts(offer, selected, expiresAt, earliest = Date.now() + 60000) {
  const schedule = storedWeeklySchedule(offer);
  const today = paymentDay();
  const result = [];
  const maximumDays = Math.min(Number(offer.validity_days) + 7, 372);
  for (let offset = 0; offset < maximumDays && result.length < Number(offer.lesson_count); offset++) {
    const day = civilAdd(today, offset);
    const weekday = civilWeekday(day);
    const selectedRow = selected.find(row => row.weekday === weekday);
    const sourceRow = schedule.find(row => row.weekday === weekday);
    if (!selectedRow || !sourceRow) continue;
    const start = selectedStartForDay(day, sourceRow, selectedRow);
    if (start >= earliest && start + Number(offer.minutes) * 60000 <= expiresAt) result.push(start);
  }
  return result.sort((left, right) => left - right).slice(0, Number(offer.lesson_count));
}
async function restorePackageLesson(booking) {
  if (!booking?.package_purchase_id) return false;
  const purchase = await db.collection('package_purchases').findOne({ id: booking.package_purchase_id, student_id: booking.student_id });
  if (!purchase || Number(purchase.remaining_lessons) >= Number(purchase.lesson_count)) return false;
  const status = Number(purchase.expires_at) > Date.now() ? 'active' : 'expired';
  await db.collection('package_purchases').updateOne({ id: purchase.id, remaining_lessons: purchase.remaining_lessons }, { $inc: { remaining_lessons: 1 }, $set: { status, updated: Date.now() } });
  return true;
}
const packageCancellationQuote = () => ({ tier: 'package_credit', hoursBefore: 0, refund: 0, teacherCompensation: 0, platformFee: 0, refundPercent: 0, packageCredit: true });
const slotHasAvailability = slot => {
  const clockTolerance = 1000;
  const minimum = Math.min(...storedOfferings(slot).map(item => Number(item.minutes))) * 60000;
  const end = Number(slot.available_until || slot.start + slot.minutes * 60000);
  let cursor = Math.max(Number(slot.start), Date.now());
  for (const range of [...(slot.booked_ranges || [])].sort((left, right) => left.start - right.start)) {
    if (range.end <= cursor) continue;
    if (range.start - cursor + clockTolerance >= minimum) return true;
    cursor = Math.max(cursor, range.end);
  }
  return end - cursor + clockTolerance >= minimum;
};
async function occupiedPackageRanges(teacherId, studentId) {
  const teacherSlots = await db.collection('slots').find({ teacher_id: teacherId }, { projection: { _id: 0, id: 1, start: 1, minutes: 1 } }).toArray();
  const slotMap = new Map(teacherSlots.map(slot => [slot.id, slot]));
  const teacherBookings = teacherSlots.length ? await db.collection('bookings').find({ slot_id: { $in: teacherSlots.map(slot => slot.id) }, status: 'confirmed' }, { projection: { _id: 0 } }).toArray() : [];
  const studentBookings = await db.collection('bookings').find({ student_id: studentId, status: 'confirmed' }, { projection: { _id: 0 } }).toArray();
  const toRange = booking => {
    const slot = slotMap.get(booking.slot_id) || {};
    const start = Number(booking.start || slot.start || 0);
    const minutes = Number(booking.minutes || slot.minutes || 0);
    return { id: booking.id, start, end: start + minutes * 60000 };
  };
  return [...new Map([...teacherBookings, ...studentBookings].map(booking => [booking.id, toRange(booking)])).values()];
}
async function packageAvailability(purchase, days = 35) {
  const schedule = storedWeeklySchedule(purchase);
  if (!schedule.length) return [];
  const occupied = await occupiedPackageRanges(purchase.teacher_id, purchase.student_id);
  const today = paymentDay();
  const now = Date.now() + 60000;
  const step = 15 * 60000;
  const result = [];
  for (let offset = 0; offset < days; offset++) {
    const day = civilAdd(today, offset);
    const row = schedule.find(item => item.weekday === civilWeekday(day));
    if (!row) continue;
    const window = packageWindow(day, row);
    const starts = [];
    const first = Math.max(window.start, Math.ceil(now / step) * step);
    for (let start = first; start + purchase.minutes * 60000 <= window.end && start + purchase.minutes * 60000 <= purchase.expires_at; start += step) {
      const end = start + purchase.minutes * 60000;
      if (!occupied.some(range => start < range.end && end > range.start)) starts.push(start);
    }
    if (starts.length) result.push({ day, weekday: row.weekday, starts });
  }
  return result;
}
const random = () => crypto.randomBytes(32).toString('hex');
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
function passwordHash(value, salt = random()) {
  return `${salt}:${crypto.pbkdf2Sync(value, salt, 100000, 32, 'sha256').toString('hex')}`;
}
function equal(a = '', b = '') {
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}
const sessionCookie = role => ['admin', 'teachers', 'students'].includes(role) ? `mansah_session_${role}` : 'mansah_session';
function cookie(req, name) {
  const raw = req.headers.cookie || '';
  return raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1] || '';
}
function publicUser(u) {
  return u ? { id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, subject: u.subject || '', bio: u.bio || '', academic_level: u.academic_level || '', phone: u.phone || '', avatar_url: u.role === 'teachers' ? `/api/media/avatar/${u.id}` : '', custom_packages: parseCustomPackages(u.custom_packages), verification: parseVerification(u.verification), auth_provider: u.auth_provider || 'password', email_verified: Boolean(u.email_verified), mustChangePassword: Boolean(u.must_change_password) } : null;
}
async function restoreExpiredSuspension(user) {
  if (user?.status !== 'suspended' || !Number(user.suspended_until || 0) || Number(user.suspended_until) > Date.now()) return user;
  await db.collection('users').updateOne({ id: user.id, status: 'suspended' }, { $set: { status: 'active' }, $unset: { suspended_until: '', suspension_reason: '' } });
  return { ...user, status: 'active', suspended_until: 0, suspension_reason: '' };
}

async function teacherRatingMap(teacherIds) {
  const ids = [...new Set((teacherIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await db.collection('ratings').find({ teacher_id: { $in: ids } }, { projection: { _id: 0, teacher_id: 1, student_id: 1, rating: 1, created: 1 } }).sort({ created: 1 }).toArray();
  const latestByStudent = new Map();
  for (const row of rows) latestByStudent.set(`${row.teacher_id}:${row.student_id}`, row);
  const grouped = new Map(ids.map(id => [id, []]));
  for (const row of latestByStudent.values()) grouped.get(row.teacher_id)?.push(Number(row.rating));
  return new Map(ids.map(id => {
    const values = grouped.get(id) || [];
    const count = values.length;
    return [id, { teacher_rating_count: count, teacher_rating: count ? Math.round(values.reduce((sum, value) => sum + value, 0) / count * 10) / 10 : null }];
  }));
}
async function googleIdentity(credential) {
  if (!GOOGLE_CLIENT_ID) fail(503, 'تسجيل Google غير مفعّل على الخادم بعد.');
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(field(credential, 5000))}`);
  const profile = await response.json().catch(() => ({}));
  if (!response.ok || profile.aud !== GOOGLE_CLIENT_ID || profile.email_verified !== 'true' || !profile.email) fail(401, 'تعذر التحقق من حساب Google.');
  return { email: String(profile.email).toLowerCase(), name: String(profile.name || '').trim(), sub: String(profile.sub || '') };
}
const normalizeJordanPhone = value => {
  const digits = String(value || '').replace(/\D/g, '');
  if (/^07[789]\d{7}$/.test(digits)) return digits;
  if (/^9627[789]\d{7}$/.test(digits)) return `0${digits.slice(3)}`;
  return '';
};
async function deliverPasswordReset(user, code) {
  if (user.email && process.env.RESEND_API_KEY && process.env.PASSWORD_RESET_FROM) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.PASSWORD_RESET_FROM,
        to: [user.email],
        subject: 'رمز استعادة كلمة المرور - امتداد العلم',
        html: `<div dir="rtl" style="font-family:Arial,sans-serif"><h2>استعادة كلمة المرور</h2><p>رمز التحقق الخاص بك:</p><p style="font-size:32px;font-weight:700;letter-spacing:8px">${code}</p><p>ينتهي الرمز خلال 10 دقائق. لا تشاركه مع أي شخص.</p></div>`,
      }),
    });
    if (!response.ok) throw new Error('تعذر إرسال رمز الاستعادة إلى البريد الإلكتروني.');
    return { channel: 'email', destination: user.email.replace(/^(.{2}).*(@.*)$/, '$1***$2') };
  }
  const phone = normalizeJordanPhone(user.phone);
  if (phone && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER) {
    const destination = `+962${phone.slice(1)}`;
    const form = new URLSearchParams({ To: destination, From: process.env.TWILIO_FROM_NUMBER, Body: `رمز استعادة كلمة المرور في امتداد العلم: ${code}. صالح لمدة 10 دقائق.` });
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(process.env.TWILIO_ACCOUNT_SID)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (!response.ok) throw new Error('تعذر إرسال رمز الاستعادة إلى رقم الهاتف.');
    return { channel: 'phone', destination: `${phone.slice(0, 3)}****${phone.slice(-2)}` };
  }
  if (process.env.NODE_ENV !== 'production') return { channel: 'development', destination: 'local', debugCode: code };
  fail(503, 'خدمة استعادة كلمة المرور غير مفعلة على الخادم بعد. راجع الدعم الفني.');
}
async function deliverPhoneVerification(phone, code) {
  const normalized = normalizeJordanPhone(phone);
  if (!normalized) fail(400, 'أدخل رقم هاتف أردنياً صحيحاً يبدأ بـ 077 أو 078 أو 079.');
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER) {
    const destination = `+962${normalized.slice(1)}`;
    const form = new URLSearchParams({ To: destination, From: process.env.TWILIO_FROM_NUMBER, Body: `رمز التحقق من رقمك في امتداد العلم: ${code}. صالح لمدة 10 دقائق.` });
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(process.env.TWILIO_ACCOUNT_SID)}/Messages.json`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    if (!response.ok) fail(503, 'تعذر إرسال رمز التحقق إلى الهاتف. حاول مجدداً أو تواصل مع الدعم الفني.');
    return { channel: 'phone', destination: `${normalized.slice(0, 3)}****${normalized.slice(-2)}` };
  }
  if (process.env.NODE_ENV !== 'production') return { channel: 'development', destination: normalized, debugCode: code };
  fail(503, 'خدمة التحقق من الهاتف غير مفعلة على الخادم. راجع الدعم الفني.');
}
async function consumePhoneVerification(id, code, phone) {
  const normalized = normalizeJordanPhone(phone), verification = await db.collection('phone_verifications').findOne({ id, phone: normalized, used_at: 0 });
  if (!verification || new Date(verification.expires_at).getTime() <= Date.now()) fail(400, 'رمز تحقق الهاتف منتهٍ أو غير صالح. اطلب رمزاً جديداً.');
  if (Number(verification.attempts || 0) >= 5) fail(429, 'تم تجاوز عدد محاولات التحقق. اطلب رمزاً جديداً.');
  const expected = digest(`${id}:${code}:${process.env.PHONE_VERIFICATION_SECRET || OWNER_SETUP_TOKEN}`);
  if (!/^\d{6}$/.test(String(code || '')) || !equal(expected, verification.code_hash)) { await db.collection('phone_verifications').updateOne({ id }, { $inc: { attempts: 1 } }); fail(400, 'رمز تحقق الهاتف غير صحيح.'); }
  await db.collection('phone_verifications').updateOne({ id, used_at: 0 }, { $set: { used_at: Date.now() } });
  return normalized;
}
function setSession(res, role, token, expires) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure; SameSite=None' : '; SameSite=Lax';
  res.setHeader('Set-Cookie', `${sessionCookie(role)}=${token}; Path=/; HttpOnly${secure}; Max-Age=${Math.max(0, Math.floor((expires - Date.now()) / 1000))}`);
}
function clearSession(res, role) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure; SameSite=None' : '; SameSite=Lax';
  res.setHeader('Set-Cookie', `${sessionCookie(role)}=; Path=/; HttpOnly${secure}; Max-Age=0`);
}
async function getUser(req, role) {
  const database = await connect();
  const token = cookie(req, sessionCookie(role)) || cookie(req, 'mansah_session');
  if (!token) return null;
  const session = await database.collection('sessions').findOne({ token: digest(token), expires: { $gt: Date.now() } });
  if (!session) return null;
  const user = await database.collection('users').findOne({ id: session.user_id });
  if (user?.status === 'suspended' && Number(user.suspended_until || 0) > 0 && Number(user.suspended_until) <= Date.now()) {
    await database.collection('users').updateOne({ id: user.id, status: 'suspended', suspended_until: { $lte: Date.now() } }, { $set: { status: 'active' }, $unset: { suspended_until: '', suspension_reason: '' } });
    return { ...user, status: 'active', suspended_until: 0, suspension_reason: '' };
  }
  return user;
}
io.use(async (socket, next) => {
  try {
    if (!validChatOrigin(socket.handshake.headers.origin, socket.request)) return next(new Error('Unauthorized'));
    const portal = socket.handshake.auth?.portal;
    if (!['students', 'teachers'].includes(portal)) return next(new Error('Unauthorized'));
    const user = await getUser(socket.request, portal);
    if (!user || user.role !== portal || user.status !== 'active' || user.must_change_password) return next(new Error('Unauthorized'));
    socket.data.userId = user.id;
    next();
  } catch { next(new Error('Unauthorized')); }
});
io.on('connection', socket => {
  socket.join(`chat:${socket.data.userId}`);
  // HTTP remains the authority for writes; sockets only signal clients to refresh.
  const expiry = setTimeout(() => socket.disconnect(true), 3600000);
  socket.on('disconnect', () => clearTimeout(expiry));
});
async function audit(actor, action, target) {
  await db.collection('audit').insertOne({ id: crypto.randomUUID(), actor, action, target, created: Date.now() });
}

async function sendDevicePush(userId, payload) {
  if (!pushReady || !userId) return;
  const rows = await db.collection('push_subscriptions').find({ user_id: userId }, { projection: { _id: 0 } }).limit(20).toArray();
  await Promise.all(rows.map(async row => {
    try { await webpush.sendNotification(row.subscription, JSON.stringify(payload), { TTL: 86400, urgency: 'high' }); }
    catch (error) {
      if ([404, 410].includes(Number(error?.statusCode))) await db.collection('push_subscriptions').deleteOne({ endpoint: row.endpoint, user_id: userId });
    }
  }));
}

const starterCatalog = jordanCatalog;
async function installJordanCatalog() {
  await db.collection('catalog').deleteMany({ kind: 'category' });
  await db.collection('catalog').insertMany(starterCatalog.map((item, position) => ({ ...item, kind: 'category', position, created: Date.now() })));
}
async function seedCatalog() {
  const migrationKey = 'jordan-catalog-2026';
  const migrated = await db.collection('platform_settings').findOne({ key: migrationKey });
  if (!migrated) {
    await installJordanCatalog();
    await db.collection('platform_settings').updateOne({ key: migrationKey }, { $set: { key: migrationKey, value: { installed_at: Date.now() } } }, { upsert: true });
    return;
  }
  if (!await db.collection('catalog').countDocuments({ kind: 'category' })) await installJordanCatalog();
}
async function categories() {
  return db.collection('catalog').find({ kind: 'category' }, { projection: { _id: 0 } }).sort({ position: 1, id: 1 }).toArray();
}
async function handleCatalog(user, write, body) {
  if (write) {
    if (user.role !== 'admin') fail(403, 'تعديل التصنيفات متاح للإدارة فقط.');
    const rows = await categories();
    if (body.action === 'install-jordan-curriculum') {
      await installJordanCatalog();
      await audit(user.id, 'catalog:install-jordan-curriculum', 'categories');
    } else if (body.action === 'reorder') {
      if (!Array.isArray(body.ids) || body.ids.length !== rows.length || new Set(body.ids).size !== body.ids.length) fail(409, 'تغيرت التصنيفات. حدث الصفحة وأعد المحاولة.');
      await Promise.all(body.ids.map((id, index) => db.collection('catalog').updateOne({ id, kind: 'category' }, { $set: { position: index } })));
      await audit(user.id, 'catalog:reorder', 'categories');
    } else if (body.action === 'delete') {
      await db.collection('catalog').deleteOne({ id: body.id, kind: 'category' });
      await audit(user.id, 'catalog:delete', body.id);
    } else if (body.action === 'save') {
      const list = value => {
        if (!Array.isArray(value) || value.length > 100) fail(400, 'تحقق من المستويات والمواد.');
        return [...new Set(value.map(item => field(item, 100)))];
      };
      const item = { name: field(body.name, 100), description: field(body.description || '', 300, 0), icon: field(body.icon || '', 20, 0), levels: list(body.levels), subjects: list(body.subjects) };
      if (body.id) await db.collection('catalog').updateOne({ id: body.id, kind: 'category' }, { $set: item });
      else await db.collection('catalog').insertOne({ ...item, id: crypto.randomUUID(), kind: 'category', position: rows.length, created: Date.now() });
    } else fail(400, 'عملية غير صحيحة.');
  }
  return { categories: await categories() };
}

async function bookingRows(filter = {}, limit = 500) {
  const bookings = await db.collection('bookings').find(filter, { projection: { _id: 0 } }).sort({ created: -1 }).limit(limit).toArray();
  return enrichBookings(bookings);
}
async function releaseCompletedPackageIfFinished(packagePurchaseId, now = Date.now()) {
  if (!packagePurchaseId) return false;
  const packageBookings = await db.collection('bookings').find({ package_purchase_id: packagePurchaseId }, { projection: { _id: 0, status: 1 } }).toArray();
  if (!packageBookings.length || !packageBookings.every(item => ['completed', 'cancelled'].includes(item.status))) return false;
  await db.collection('bookings').updateMany({ package_purchase_id: packagePurchaseId, status: 'completed' }, { $set: { payout_status: 'released', payout_released_at: now }, $unset: { payout_hold_reason: '' } });
  await db.collection('package_purchases').updateOne({ id: packagePurchaseId }, { $set: { status: 'completed', completed_at: now, updated: now } });
  return true;
}
async function finalizeEndedBookings(filter = {}) {
  const now = Date.now();
  const candidates = await db.collection('bookings').find({ ...filter, status: 'confirmed', start: { $lte: now } }, { projection: { _id: 0 } }).limit(500).toArray();
  for (const booking of candidates) {
    const graceEnd = Number(booking.start || 0) + Number(booking.minutes || 0) * 60000 + 5 * 60000;
    if (!Number(booking.start) || !Number(booking.minutes) || graceEnd > now) continue;
    const teacherJoined = Number(booking.teacher_joined_at || 0) > 0;
    const studentJoined = Number(booking.student_joined_at || 0) > 0;
    const bothJoined = teacherJoined && studentJoined;
    const packageStudentAbsent = Boolean(booking.package_purchase_id && teacherJoined && !studentJoined);
    if (!bothJoined && !packageStudentAbsent) continue;
    await db.collection('bookings').updateOne(
      { id: booking.id, status: 'confirmed' },
      { $set: { status: 'completed', completed_at: now, attendance_result: packageStudentAbsent ? 'student_absent' : 'attended', payout_status: booking.package_purchase_id ? 'held' : booking.payout_status === 'held' ? 'held' : 'released', room: random() } },
    );
    if (booking.package_purchase_id) await releaseCompletedPackageIfFinished(booking.package_purchase_id, now);
  }
}
async function ensureAutomaticNoShowReports(bookings) {
  const now = Date.now();
  const missing = bookings.filter(row => row.status === 'confirmed' && Number(row.start) + 10 * 60000 <= now && !Number(row.teacher_joined_at || 0) && Number(row.student_joined_at || 0) > 0);
  for (const row of missing) {
    const reportId = `auto-no-show:${row.id}`;
    const result = await db.collection('lesson_reports').updateOne(
      { id: reportId },
      { $setOnInsert: { id: reportId, booking_id: row.id, reporter_id: row.student_id, teacher_id: row.teacher_id, category: 'teacher_absent', note: 'تجاوز الأستاذ 10 دقائق من بداية الحصة دون الدخول.', status: 'pending', automatic: true, created: now, evidence: { lesson_start: Number(row.start), teacher_joined_at: 0, student_joined_at: Number(row.student_joined_at || 0) } } },
      { upsert: true },
    );
    if (result.upsertedCount) {
      if (row.package_purchase_id) {
        const refund = Math.max(0, Number(row.price || 0));
        const transactionId = `package-teacher-absence:${row.id}`;
        const transaction = await db.collection('wallet_transactions').updateOne({ id: transactionId }, { $setOnInsert: { id: transactionId, user_id: row.student_id, type: 'package_teacher_absence_refund', amount: refund, reference: `booking:${row.id}`, created: now } }, { upsert: true });
        if (transaction.upsertedCount && refund) {
          await walletAccount(row.student_id);
          await db.collection('wallet_accounts').updateOne({ user_id: row.student_id }, { $inc: { balance: refund }, $set: { updated: now } });
          await db.collection('package_purchases').updateOne({ id: row.package_purchase_id }, { $inc: { refunded_amount: refund }, $set: { updated: now } });
        }
        await db.collection('bookings').updateOne({ id: row.id, status: 'confirmed' }, { $set: { status: 'cancelled', cancelled_at: now, cancelled_by: 'system', cancellation_reason: 'teacher_absent', refund_amount: refund, payout_status: 'forfeited', payout_hold_reason: `report:${reportId}`, room: random() } });
        await releaseCompletedPackageIfFinished(row.package_purchase_id, now);
      } else await db.collection('bookings').updateOne({ id: row.id, status: 'confirmed' }, { $set: { payout_status: 'held', payout_hold_reason: `report:${reportId}` } });
    }
  }
}
async function enrichBookings(bookings) {
  const slotIds = [...new Set(bookings.map(b => b.slot_id))];
  const slots = await db.collection('slots').find({ id: { $in: slotIds } }, { projection: { _id: 0 } }).toArray();
  const slotMap = new Map(slots.map(s => [s.id, s]));
  const userIds = [...new Set(slots.flatMap(s => [s.teacher_id]).concat(bookings.map(b => b.student_id)))];
  const users = await db.collection('users').find({ id: { $in: userIds } }, { projection: { _id: 0, id: 1, name: 1, phone: 1, verification: 1, bio: 1, subject: 1 } }).toArray();
  const userMap = new Map(users.map(u => [u.id, u]));
  const ratings = await db.collection('ratings').find({ booking_id: { $in: bookings.map(row => row.id) } }, { projection: { _id: 0, booking_id: 1, rating: 1 } }).toArray();
  const ratingMap = new Map(ratings.map(row => [row.booking_id, Number(row.rating)]));
  return bookings.map(b => {
    const s = slotMap.get(b.slot_id) || {};
    const teacher = userMap.get(s.teacher_id) || {};
    const student = userMap.get(b.student_id) || {};
    const { room: _room, ...safeBooking } = b;
    const teacherPhone = teacher.phone || parseVerification(teacher.verification).phone || '';
    const studentPhone = student.phone || parseVerification(student.verification).phone || '';
    return { ...s, ...safeBooking, start: Number(b.start || s.start || 0), minutes: Number(b.minutes || s.minutes || 0), price: Number(b.price ?? s.price ?? 0), subject: b.subject || s.subject || '', teacher_id: s.teacher_id, teacher_name: teacher.name || '', teacher_phone: teacherPhone, student_name: student.name || '', student_phone: studentPhone, bio: teacher.bio || '', teacher_subjects: teacher.subject || '', student_rating: ratingMap.get(b.id) || 0 };
  });
}
async function walletBalance(userId) {
  return Number((await walletAccount(userId))?.balance || 0);
}
async function walletAccount(userId) {
  let account = await db.collection('wallet_accounts').findOne({ user_id: userId });
  if (!account) {
    const transactions = await db.collection('wallet_transactions').find({ user_id: userId }).toArray();
    const balance = transactions.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    await db.collection('wallet_accounts').updateOne({ user_id: userId }, { $setOnInsert: { user_id: userId, balance, updated: Date.now() } }, { upsert: true });
    account = await db.collection('wallet_accounts').findOne({ user_id: userId });
  }
  return account;
}

app.all('/api/auth/:action', async (req, res, next) => {
  try {
    await connect();
    const action = req.params.action;
    const body = req.body || {};
    const requestedRole = req.query.portal || body.role;
    if (action === 'me') {
      const account = await getUser(req, requestedRole);
      const visible = publicUser(account);
      if (account?.role === 'teachers') Object.assign(visible, (await teacherRatingMap([account.id])).get(account.id));
      return res.json({ user: visible });
    }
    if (action === 'logout') {
      const token = cookie(req, sessionCookie(requestedRole));
      if (token) await db.collection('sessions').deleteOne({ token: digest(token) });
      clearSession(res, requestedRole);
      return res.json({ user: null });
    }
    if (action === 'phone-code') {
      const phone = normalizeJordanPhone(body.phone);
      if (!phone) fail(400, 'أدخل رقم هاتف أردنياً صحيحاً يبدأ بـ 077 أو 078 أو 079.');
      const recent = await db.collection('phone_verifications').countDocuments({ phone, created: { $gt: Date.now() - 15 * 60000 } });
      if (recent >= 3) fail(429, 'تم إرسال عدة رموز مؤخراً. انتظر 15 دقيقة ثم حاول مجدداً.');
      const id = crypto.randomUUID(), code = String(crypto.randomInt(100000, 1000000));
      const delivery = await deliverPhoneVerification(phone, code);
      await db.collection('phone_verifications').insertOne({ id, phone, code_hash: digest(`${id}:${code}:${process.env.PHONE_VERIFICATION_SECRET || OWNER_SETUP_TOKEN}`), attempts: 0, used_at: 0, created: Date.now(), expires_at: new Date(Date.now() + 10 * 60000) });
      return res.json({ id, channel: delivery.channel, destination: delivery.destination, ...(delivery.debugCode ? { debugCode: delivery.debugCode } : {}) });
    }
    if (action === 'forgot-password') {
      const role = body.role;
      if (!['admin', 'teachers', 'students'].includes(role)) fail(400, 'القسم غير صحيح.');
      const identifier = field(body.identifier || body.email || body.phone, 254).toLowerCase();
      const phone = normalizeJordanPhone(identifier);
      const user = await db.collection('users').findOne({ role, ...(phone ? { phone: { $in: [phone, `+962${phone.slice(1)}`, `962${phone.slice(1)}`] } } : { email: identifier }) });
      const generic = { ok: true, message: 'إذا كانت البيانات مرتبطة بحساب، سيصلك رمز الاستعادة الآن.' };
      if (!user) return res.json(generic);
      const recent = await db.collection('password_resets').countDocuments({ user_id: user.id, created: { $gt: Date.now() - 15 * 60000 } });
      if (recent >= 3) fail(429, 'تم إرسال عدة رموز مؤخراً. انتظر 15 دقيقة ثم حاول مجدداً.');
      const code = String(crypto.randomInt(100000, 1000000));
      const resetId = crypto.randomUUID();
      const delivery = await deliverPasswordReset(user, code);
      await db.collection('password_resets').insertOne({ id: resetId, user_id: user.id, role, code_hash: digest(`${resetId}:${code}:${process.env.PASSWORD_RESET_SECRET || OWNER_SETUP_TOKEN}`), attempts: 0, created: Date.now(), expires_at: new Date(Date.now() + 10 * 60000), used_at: 0 });
      return res.json({ ...generic, resetId, channel: delivery.channel, destination: delivery.destination, ...(delivery.debugCode ? { debugCode: delivery.debugCode } : {}) });
    }
    if (action === 'reset-password') {
      const role = body.role;
      if (!['admin', 'teachers', 'students'].includes(role)) fail(400, 'القسم غير صحيح.');
      const resetId = field(body.resetId, 100), code = field(body.code, 6, 6), password = field(body.password, 128, 12);
      if (!/^\d{6}$/.test(code)) fail(400, 'رمز التحقق يجب أن يتكون من 6 أرقام.');
      const reset = await db.collection('password_resets').findOne({ id: resetId, role, used_at: 0 });
      if (!reset || new Date(reset.expires_at).getTime() <= Date.now()) fail(400, 'رمز الاستعادة منتهي أو غير صالح. اطلب رمزاً جديداً.');
      if (Number(reset.attempts || 0) >= 5) fail(429, 'تم تجاوز عدد المحاولات. اطلب رمزاً جديداً.');
      const expected = digest(`${resetId}:${code}:${process.env.PASSWORD_RESET_SECRET || OWNER_SETUP_TOKEN}`);
      if (!equal(expected, reset.code_hash)) {
        await db.collection('password_resets').updateOne({ id: resetId }, { $inc: { attempts: 1 } });
        fail(400, 'رمز التحقق غير صحيح.');
      }
      await db.collection('users').updateOne({ id: reset.user_id, role }, { $set: { password: passwordHash(password), must_change_password: 0, password_changed_at: Date.now() }, $unset: { temporary_password_expires: '' } });
      await db.collection('password_resets').updateOne({ id: resetId, used_at: 0 }, { $set: { used_at: Date.now() } });
      await db.collection('sessions').deleteMany({ user_id: reset.user_id });
      await audit(reset.user_id, 'user:self-password-reset', reset.user_id);
      return res.json({ ok: true });
    }
    if (!['login', 'register', 'setup', 'google'].includes(action)) fail(404, 'الطلب غير موجود.');
    const google = action === 'google' ? await googleIdentity(body.credential) : null;
    const email = google?.email || field(body.email, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'البريد الإلكتروني غير صحيح.');
    const password = action === 'google' ? '' : field(body.password, 128, 12);
    const role = body.role;
    if (!['admin', 'teachers', 'students'].includes(role)) fail(400, 'القسم غير صحيح.');
    let user;
    if (action === 'login') {
      user = await db.collection('users').findOne({ email });
      const hash = passwordHash(password, user?.password?.split(':')[0] || 'missing-account-salt');
      if (!user || user.role !== role || !equal(hash, user.password)) fail(401, 'بيانات الدخول غير صحيحة لهذا القسم.');
      user = await restoreExpiredSuspension(user);
      if (user.status === 'suspended') fail(403, 'الحساب موقوف. راجع الإدارة.');
    } else if (action === 'google') {
      user = await db.collection('users').findOne({ email });
      if (user && user.role !== role) fail(409, 'هذا البريد مرتبط بقسم مختلف.');
      if (!user) {
        if (body.loginOnly === true) fail(404, 'لا يوجد حساب مرتبط بهذا البريد في هذا القسم. أنشئ حساباً جديداً أولاً.');
        if (role === 'admin') fail(403, 'تسجيل Google غير متاح للإدارة.');
        const verification = registrationProfile(body, role);
        verification.phone = await consumePhoneVerification(field(body.phone_verification_id, 100), field(body.phone_verification_code, 6, 6), verification.phone);
        verification.phone_verified_at = Date.now();
        user = { id: crypto.randomUUID(), email, name: [verification.first_name, verification.father_name, verification.family_name].join(' '), role, status: role === 'teachers' ? 'pending' : 'active', password: passwordHash(random()), subject: '', bio: role === 'teachers' ? verification.professional_bio : '', phone: verification.phone, verification, auth_provider: 'google', email_verified: 1, google_sub: google.sub, created: Date.now(), must_change_password: 0 };
        try { await db.collection('users').insertOne(user); } catch { fail(409, 'البريد مستخدم مسبقاً.'); }
      } else {
        await db.collection('users').updateOne({ id: user.id }, { $set: { auth_provider: 'google', email_verified: 1, google_sub: google.sub } });
        user = { ...user, auth_provider: 'google', email_verified: 1, google_sub: google.sub };
      }
      user = await restoreExpiredSuspension(user);
      if (user.status === 'suspended') fail(403, 'الحساب موقوف. راجع الإدارة.');
    } else {
      if (action === 'setup') {
        if (String(body.token || '') !== OWNER_SETUP_TOKEN || role !== 'admin') fail(403, 'رابط تهيئة الإدارة غير صالح.');
        if (await db.collection('users').findOne({ role: 'admin' })) fail(409, 'تم إنشاء حساب الإدارة مسبقاً. سجل الدخول.');
      } else if (role === 'admin') fail(403, 'إنشاء حساب إدارة غير متاح للعامة.');
      const verification = role === 'admin' ? {} : registrationProfile(body, role);
      user = { id: role === 'admin' ? 'platform-owner' : crypto.randomUUID(), email, name: role === 'admin' ? field(body.name, 100) : [verification.first_name, verification.father_name, verification.family_name].join(' '), role, status: role === 'teachers' ? 'pending' : 'active', password: passwordHash(password), subject: '', bio: role === 'teachers' ? verification.professional_bio : '', phone: verification.phone || '', verification, auth_provider: 'password', email_verified: 0, created: Date.now(), must_change_password: 0 };
      try { await db.collection('users').insertOne(user); } catch { fail(409, 'البريد مستخدم مسبقاً أو حساب الإدارة موجود.'); }
    }
    const token = random();
    const expires = Date.now() + 604800000;
    await db.collection('sessions').deleteMany({ expires: { $lt: Date.now() } });
    await db.collection('sessions').insertOne({ token: digest(token), user_id: user.id, expires });
    setSession(res, role, token, expires);
    res.json({ user: publicUser(user) });
  } catch (error) { next(error); }
});

app.get('/api/media/avatar/:userId', async (req, res, next) => {
  try {
    await connect(); const teacher = await db.collection('users').findOne({ id: req.params.userId, role: 'teachers', status: 'active' }, { projection: { id: 1 } });
    if (!teacher) fail(404, 'الصورة غير موجودة.');
    const file = await db.collection('verification_files').findOne({ user_id: teacher.id, kind: 'avatar' }, { projection: { _id: 0 } }); if (!file) fail(404, 'الصورة غير موجودة.');
    res.set(attachmentHeaders({ ...file, preview_type: file.content_type }, true)); const stream = verificationBytes(db).read(file.id); res.once('close', () => stream.destroy()); stream.on('error', () => res.destroy()); stream.pipe(res);
  } catch (error) { next(error); }
});

app.all('/api/:portal/*path', async (req, res, next) => {
  try {
    await connect();
    const portal = req.params.portal;
    const path = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
    const write = req.method !== 'GET';
    const body = req.body || {};
    const user = await getUser(req, portal);
    if (!user) fail(401, 'يلزم تسجيل الدخول.');
    if (portal !== user.role) fail(403, 'هذا القسم غير متاح لحسابك.');
    if (user.status === 'suspended') fail(403, 'الحساب موقوف.');

    if (path === 'video/ice' && !write && ['teachers', 'students'].includes(user.role)) {
      const fallback = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478', 'stun:global.stun.twilio.com:3478'] }];
      const configuredUrls = String(process.env.VITE_TURN_URLS || process.env.TURN_URLS || '').split(',').map(value => value.trim()).filter(Boolean);
      if (configuredUrls.length && (process.env.VITE_TURN_USERNAME || process.env.TURN_USERNAME) && (process.env.VITE_TURN_CREDENTIAL || process.env.TURN_CREDENTIAL)) return res.json({ ice_servers: [...fallback, { urls: configuredUrls, username: process.env.VITE_TURN_USERNAME || process.env.TURN_USERNAME, credential: process.env.VITE_TURN_CREDENTIAL || process.env.TURN_CREDENTIAL }] });
      if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
        try {
          const authorization = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
          const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Tokens.json`, { method: 'POST', headers: { Authorization: `Basic ${authorization}` } });
          if (response.ok) {
            const token = await response.json();
            const twilioServers = Array.isArray(token.ice_servers) ? token.ice_servers.map(item => ({ urls: item?.urls || item?.url, ...(item?.username ? { username: item.username } : {}), ...(item?.credential ? { credential: item.credential } : {}) })).filter(item => item.urls) : [];
            if (twilioServers.length) return res.json({ ice_servers: twilioServers });
          }
        } catch { /* Fall back to STUN; the client will keep retrying and report media state. */ }
      }
      return res.json({ ice_servers: fallback });
    }

    if (await serveVerificationFile(req, res, { db, user, path })) return;
    if (await serveWalletTopup(req, res, { db, user, path, ...(topupProofBytes ? { bytes: topupProofBytes } : {}) })) return;
    if (path === 'verification/status' && !write && user.role === 'teachers') return res.json({ user: publicUser(user), files: await db.collection('verification_files').find({ user_id: user.id }, { projection: { _id: 0, declared_type: 0 } }).toArray() });
    if (path === 'verification/submit' && write && user.role === 'teachers') {
      const files = await db.collection('verification_files').find({ user_id: user.id }, { projection: { _id: 0 } }).toArray();
      if (!files.some(file => file.kind === 'intro_video') || !files.some(file => file.kind === 'credential')) fail(400, 'أكمل فيديو التحقق والمستند الداعم قبل إرسال الطلب.');
      const verification = { ...parseVerification(user.verification), verification_status: 'submitted', submitted_at: Date.now(), reviewed_at: 0, rejection_reason: '' };
      await db.collection('users').updateOne({ id: user.id }, { $set: { verification } });
      return res.json({ user: publicUser({ ...user, verification }) });
    }

    if (path === 'profile') {
      if (write) {
        const requestedPhone = body.phone === undefined ? user.phone || '' : normalizeJordanPhone(body.phone);
        if (body.phone !== undefined && !requestedPhone) fail(400, 'أدخل رقم هاتف أردنياً صحيحاً يبدأ بـ 077 أو 078 أو 079.');
        const profile = { name: field(body.name, 100), subject: field(body.subject || '', 4000, 0), bio: field(body.bio || '', 2000, 0), academic_level: field(body.academic_level || '', 100, 0), phone: requestedPhone };
        if (body.custom_packages !== undefined) profile.custom_packages = serializeCustomPackages(body.custom_packages);
        await db.collection('users').updateOne({ id: user.id }, { $set: profile });
      }
      const account = await db.collection('users').findOne({ id: user.id });
      const visible = publicUser(account);
      if (account?.role === 'teachers') Object.assign(visible, (await teacherRatingMap([account.id])).get(account.id));
      return res.json({ user: visible });
    }
    if (path === 'password' && write) {
      const old = field(body.current, 128, 12), nextPass = field(body.password, 128, 12);
      if (!equal(passwordHash(old, user.password.split(':')[0]), user.password)) fail(400, 'كلمة المرور الحالية غير صحيحة.');
      await db.collection('users').updateOne({ id: user.id }, { $set: { password: passwordHash(nextPass), must_change_password: 0 }, $unset: { temporary_password_expires: '' } });
      await db.collection('sessions').deleteMany({ user_id: user.id });
      return res.json({ ok: true });
    }
    if (user.status !== 'active') fail(403, 'هذا الحساب بانتظار موافقة الإدارة.');
    if (path === 'push/subscribe' && write) {
      if (!pushReady) fail(503, 'إشعارات الهاتف تحتاج مفاتيح VAPID على الخادم.');
      const subscription = body.subscription;
      const endpoint = field(subscription?.endpoint || '', 2000);
      const p256dh = field(subscription?.keys?.p256dh || '', 500);
      const auth = field(subscription?.keys?.auth || '', 500);
      if (!/^https:\/\//i.test(endpoint)) fail(400, 'اشتراك الإشعارات غير صالح.');
      await db.collection('push_subscriptions').updateOne({ endpoint }, { $set: { endpoint, user_id: user.id, portal: user.role, subscription: { endpoint, expirationTime: subscription.expirationTime || null, keys: { p256dh, auth } }, updated: Date.now() } }, { upsert: true });
      return res.json({ ok: true });
    }
    if (path === 'push/unsubscribe' && write) {
      await db.collection('push_subscriptions').deleteMany({ user_id: user.id, ...(body.endpoint ? { endpoint: field(body.endpoint, 2000) } : {}) });
      return res.json({ ok: true });
    }
    if (path.startsWith('chat/')) {
      if (!validChatOrigin(req.headers.origin, req)) fail(403, 'مصدر الطلب غير صالح.');
      if (await serveChatAttachment(req, res, { db, user, path, ...(attachmentBytes ? { bytes: attachmentBytes } : {}) })) return;
      const result = await handleChat({ store: mongoChatStore(db), user, path, write, body, query: req.query });
      for (const userId of result.notify) {
        if (path.endsWith('/typing')) io.to(`chat:${userId}`).emit('chat:typing', { threadId: path.split('/')[2], authorId: user.id, active: body.active === true });
        else io.to(`chat:${userId}`).emit('chat:changed', { threadId: path === 'chat/settings' ? null : result.threadId || path.split('/')[2] || null });
      }
      if (path.endsWith('/messages') && write) void Promise.all(result.notify.filter(userId => userId !== user.id).map(userId => sendDevicePush(userId, { title: user.name, body: field(body.body || 'أرسل لك رسالة جديدة', 180, 0) || 'أرسل لك ملفاً جديداً', tag: result.threadId || 'chat', url: `${user.role === 'teachers' ? 'students' : 'teachers'}?view=messages` })));
      return res.json(result.data);
    }
    if (path === 'catalog') return res.json(await handleCatalog(user, write, body));
    if (/^teachers\/[^/]+\/profile$/.test(path) && !write && user.role === 'students') {
      const teacherId = path.split('/')[1];
      const teacher = await db.collection('users').findOne({ id: teacherId, role: 'teachers', status: 'active' }, { projection: { _id: 0, password: 0 } });
      if (!teacher) fail(404, 'ملف الأستاذ غير موجود.');
      const rating = (await teacherRatingMap([teacherId])).get(teacherId) || { teacher_rating: null, teacher_rating_count: 0 };
      const reviews = await db.collection('ratings').find({ teacher_id: teacherId, review: { $exists: true, $ne: '' } }, { projection: { _id: 0, rating: 1, review: 1, student_id: 1, created: 1 } }).sort({ created: -1 }).limit(30).toArray();
      const students = await db.collection('users').find({ id: { $in: [...new Set(reviews.map(review => review.student_id))] } }, { projection: { _id: 0, id: 1, name: 1 } }).toArray();
      const names = new Map(students.map(student => [student.id, student.name]));
      const hasBooking = Boolean(await db.collection('slots').findOne({ teacher_id: teacherId, id: { $in: (await db.collection('bookings').find({ student_id: user.id }, { projection: { slot_id: 1 } }).toArray()).map(row => row.slot_id) } }));
      return res.json({ teacher: { ...publicUser(teacher), ...rating, phone: hasBooking ? teacher.phone || '' : '' }, reviews: reviews.map(review => ({ rating: Number(review.rating), review: review.review, created: Number(review.created), student_name: (names.get(review.student_id) || 'طالب').split(' ')[0] })) });
    }
    if (path === 'reports' && user.role === 'admin' && !write) {
      const reports = await db.collection('lesson_reports').find({}, { projection: { _id: 0 } }).sort({ created: -1 }).limit(500).toArray();
      const bookingDocs = await db.collection('bookings').find({ id: { $in: reports.map(report => report.booking_id) } }, { projection: { _id: 0 } }).toArray();
      const enriched = await enrichBookings(bookingDocs);
      const bookingMap = new Map(enriched.map(booking => [booking.id, booking]));
      return res.json({ reports: reports.map(report => ({ ...report, booking: bookingMap.get(report.booking_id) || null })) });
    }
    if (/^reports\/[^/]+\/resolve$/.test(path) && user.role === 'admin' && write) {
      const reportId = path.split('/')[1];
      const report = await db.collection('lesson_reports').findOne({ id: reportId, status: 'pending' });
      if (!report) fail(404, 'الشكوى غير موجودة أو تمت مراجعتها مسبقاً.');
      const resolution = body.resolution === 'upheld' ? 'upheld' : body.resolution === 'dismissed' ? 'dismissed' : '';
      if (!resolution) fail(400, 'اختر نتيجة صحيحة لمراجعة الشكوى.');
      const action = ['none', 'warning', 'suspend_7d', 'suspend_30d', 'ban'].includes(body.action) ? body.action : 'none';
      const booking = await db.collection('bookings').findOne({ id: report.booking_id });
      if (!booking) fail(404, 'الحصة المرتبطة بالشكوى غير موجودة.');
      const now = Date.now();
      await db.collection('lesson_reports').updateOne({ id: reportId, status: 'pending' }, { $set: { status: resolution, action, owner_note: field(body.note || '', 2000, 0), resolved_at: now, resolved_by: user.id } });
      await db.collection('bookings').updateOne({ id: booking.id }, { $set: { payout_status: resolution === 'dismissed' ? 'released' : 'forfeited', payout_reviewed_at: now } });
      if (resolution === 'upheld') {
        const teacherId = (await db.collection('slots').findOne({ id: booking.slot_id }))?.teacher_id;
        if (teacherId && action !== 'none') {
          const update = action === 'warning'
            ? { $inc: { moderation_warnings: 1 }, $set: { last_warning_at: now } }
            : { $set: { status: 'suspended', suspended_until: action === 'ban' ? 0 : now + (action === 'suspend_30d' ? 30 : 7) * 86400000, suspension_reason: `شكوى حصة مثبتة: ${reportId}` } };
          await db.collection('users').updateOne({ id: teacherId, role: 'teachers' }, update);
          await db.collection('sessions').deleteMany({ user_id: teacherId });
        }
      }
      await audit(user.id, `report:${resolution}:${action}`, reportId);
      return res.json({ ok: true });
    }
    if (path === 'payments' && !write && ['admin', 'teachers'].includes(user.role)) {
      await finalizeEndedBookings();
      const range = paymentRange(req.query);
      const slots = await db.collection('slots').find({ start: { $gte: range.from, $lt: range.until }, ...(user.role === 'teachers' ? { teacher_id: user.id } : {}) }, { projection: { id: 1 } }).toArray();
      const bookings = await db.collection('bookings').find({ slot_id: { $in: slots.map(slot => slot.id) }, $or: [{ status: 'completed' }, { status: 'cancelled', teacher_compensation: { $gt: 0 } }] }, { projection: { _id: 0 } }).toArray();
      const pendingPackages = await db.collection('package_purchases').find({ status: { $in: ['active', 'scheduled', 'exhausted'] }, expires_at: { $gt: Date.now() }, ...(user.role === 'teachers' ? { teacher_id: user.id } : {}) }, { projection: { _id: 0, teacher_id: 1, teacher_name: 1, package_name: 1, price: 1, refunded_amount: 1, lesson_count: 1, remaining_lessons: 1, created: 1 } }).toArray();
      const report = paymentSummary(await enrichBookings(bookings), range, process.env.PLATFORM_COMMISSION_PERCENT || 10);
      return res.json({ ...report, packagePending: pendingPackages.reduce((sum, item) => sum + Math.max(0, Number(item.price || 0) - Number(item.refunded_amount || 0)), 0), pendingPackages });
    }
    if (path === 'users' && user.role === 'admin' && !write) {
      const rows = await db.collection('users').find({}, { projection: { _id: 0 } }).sort({ created: -1 }).limit(1000).toArray();
      const files = await db.collection('verification_files').find({ user_id: { $in: rows.map(row => row.id) } }, { projection: { _id: 0, declared_type: 0 } }).toArray();
      return res.json({ users: rows.map(row => ({ ...publicUser(row), verification_files: files.filter(file => file.user_id === row.id) })) });
    }
    if (/^users\/[^/]+$/.test(path) && user.role === 'admin' && write) {
      const id = path.split('/')[1];
      const target = await db.collection('users').findOne({ id, role: { $ne: 'admin' } });
      if (!target) fail(404, 'الحساب غير موجود.');
      if (body.action === 'delete') {
        const slots = await db.collection('slots').find({ teacher_id: id }, { projection: { id: 1 } }).toArray();
        const slotIds = slots.map(row => row.id);
        const bookings = await db.collection('bookings').find({ $or: [{ student_id: id }, { slot_id: { $in: slotIds } }] }, { projection: { id: 1 } }).toArray();
        const bookingIds = bookings.map(row => row.id);
        const conversations = await db.collection('conversations').find({ $or: [{ teacher_id: id }, { student_id: id }] }, { projection: { id: 1 } }).toArray();
        const threadIds = conversations.map(row => row.id);
        const directMessages = await db.collection('direct_messages').find({ $or: [{ thread_id: { $in: threadIds } }, { author_id: id }] }, { projection: { id: 1 } }).toArray();
        const messageIds = directMessages.map(row => row.id);
        const attachments = await db.collection('chat_attachments').find({ $or: [{ thread_id: { $in: threadIds } }, { author_id: id }] }, { projection: { id: 1 } }).toArray();
        const verificationFiles = await db.collection('verification_files').find({ user_id: id }, { projection: { id: 1 } }).toArray();
        const topups = await db.collection('wallet_topups').find({ user_id: id }, { projection: { id: 1 } }).toArray();
        await Promise.all(verificationFiles.map(file => verificationBytes(db).remove(file.id)));
        if (attachmentBytes) await Promise.all(attachments.map(file => attachmentBytes.remove(file.id)));
        if (topupProofBytes) await Promise.all(topups.map(file => topupProofBytes.remove(file.id)));
        await db.collection('chat_reactions').deleteMany({ $or: [{ user_id: id }, { message_id: { $in: messageIds } }] });
        await db.collection('chat_attachments').deleteMany({ $or: [{ thread_id: { $in: threadIds } }, { author_id: id }] });
        await db.collection('direct_messages').deleteMany({ $or: [{ thread_id: { $in: threadIds } }, { author_id: id }] });
        await db.collection('chat_members').deleteMany({ $or: [{ thread_id: { $in: threadIds } }, { user_id: id }] });
        await db.collection('conversations').deleteMany({ id: { $in: threadIds } });
        await db.collection('chat_settings').deleteMany({ user_id: id });
        await db.collection('messages').deleteMany({ $or: [{ booking_id: { $in: bookingIds } }, { author_id: id }] });
        await db.collection('ratings').deleteMany({ $or: [{ booking_id: { $in: bookingIds } }, { student_id: id }, { teacher_id: id }] });
        await db.collection('lesson_reports').deleteMany({ $or: [{ booking_id: { $in: bookingIds } }, { reporter_id: id }] });
        await db.collection('bookings').deleteMany({ id: { $in: bookingIds } });
        await db.collection('slots').deleteMany({ teacher_id: id });
        await db.collection('lesson_packages').deleteMany({ teacher_id: id });
        await db.collection('package_purchases').deleteMany({ $or: [{ student_id: id }, { teacher_id: id }] });
        await db.collection('wallet_transactions').deleteMany({ user_id: id });
        await db.collection('wallet_accounts').deleteMany({ user_id: id });
        await db.collection('wallet_topups').deleteMany({ user_id: id });
        await db.collection('verification_files').deleteMany({ user_id: id });
        await db.collection('password_resets').deleteMany({ user_id: id });
        await db.collection('sessions').deleteMany({ user_id: id });
        await db.collection('users').deleteOne({ id });
        await audit(user.id, 'user:deleted', id);
        return res.json({ ok: true });
      }
      if (!['active', 'suspended'].includes(body.status)) fail(400, 'حالة غير صالحة.');
      const verification = parseVerification(target.verification);
      if (body.status === 'active' && target.role === 'teachers' && verification.verification_status !== 'submitted') fail(409, 'طلب الأستاذ غير مكتمل أو لم يُرسل للمراجعة بعد.');
      const update = { status: body.status };
      if (body.status === 'active' && target.role === 'teachers') update.verification = { ...verification, verification_status: 'approved', reviewed_at: Date.now(), reviewed_by: user.id };
      await db.collection('users').updateOne({ id }, { $set: update });
      await db.collection('sessions').deleteMany({ user_id: id });
      await audit(user.id, `user:${body.status}`, id);
      return res.json({ ok: true });
    }
    if (/^users\/[^/]+\/reset-password$/.test(path) && user.role === 'admin' && write) {
      if (!equal(passwordHash(field(body.adminPassword, 128, 12), user.password.split(':')[0]), user.password)) fail(403, 'كلمة مرور الأدمن غير صحيحة.');
      const id = path.split('/')[1];
      const temporaryPassword = random().slice(0, 24);
      const expires = Date.now() + 86400000;
      await db.collection('users').updateOne({ id, role: { $in: ['teachers', 'students'] } }, { $set: { password: passwordHash(temporaryPassword), must_change_password: 1, temporary_password_expires: expires } });
      await db.collection('sessions').deleteMany({ user_id: id });
      await audit(user.id, 'user:password-reset', id);
      return res.json({ temporaryPassword, expires });
    }
    if (path === 'audit' && user.role === 'admin' && !write) return res.json({ events: await db.collection('audit').find({}, { projection: { _id: 0 } }).sort({ created: -1 }).limit(100).toArray() });
    if (path === 'wallet' && user.role === 'students' && !write) {
      const settings = paymentSettings((await db.collection('platform_settings').findOne({ key: 'payments' }))?.value);
      return res.json({ balance: await walletBalance(user.id), payment: { ...settings, ready: Boolean(settings.cliq_alias) }, topups: (await db.collection('wallet_topups').find({ user_id: user.id }, { projection: { _id: 0, proof_hash: 0 } }).sort({ created: -1 }).limit(100).toArray()).map(publicTopup), transactions: await db.collection('wallet_transactions').find({ user_id: user.id }, { projection: { _id: 0 } }).sort({ created: -1 }).limit(100).toArray() });
    }
    if (path === 'wallet-topups' && user.role === 'admin' && !write) {
      const rows = await db.collection('wallet_topups').find({}, { projection: { _id: 0, proof_hash: 0 } }).sort({ created: -1 }).limit(500).toArray();
      const users = await db.collection('users').find({ role: 'students' }, { projection: { id: 1, name: 1, email: 1 } }).sort({ name: 1 }).limit(2000).toArray();
      const accounts = await db.collection('wallet_accounts').find({ user_id: { $in: users.map(row => row.id) } }, { projection: { _id: 0 } }).toArray();
      const accountMap = new Map(accounts.map(row => [row.user_id, row]));
      const names = new Map(users.map(row => [row.id, row]));
      const settings = paymentSettings((await db.collection('platform_settings').findOne({ key: 'payments' }))?.value);
      return res.json({ settings, topups: rows.map(row => publicTopup({ ...row, user_name: names.get(row.user_id)?.name, user_email: names.get(row.user_id)?.email })), accounts: users.map(row => ({ user_id: row.id, user_name: row.name, user_email: row.email, balance: Number(accountMap.get(row.id)?.balance || 0), updated: Number(accountMap.get(row.id)?.updated || 0) })) });
    }
    if (path === 'support' && ['students', 'teachers'].includes(user.role) && !write) {
      const settings = paymentSettings((await db.collection('platform_settings').findOne({ key: 'payments' }))?.value);
      return res.json({ whatsapp: settings.support_whatsapp || '0795764229' });
    }
    if (path === 'availability-preferences' && user.role === 'teachers') {
      if (!write) return res.json({ offerings: storedOfferings({ offerings: user.availability_offerings || [{ minutes: 60, price: 1000 }] }) });
      const offerings = slotOfferings({ offerings: body.offerings });
      await db.collection('users').updateOne({ id: user.id }, { $set: { availability_offerings: offerings, updated: Date.now() } });
      return res.json({ offerings });
    }
    if (path === 'wallet-adjustments' && user.role === 'admin' && write) {
      const studentId = field(body.user_id, 100);
      const amount = Math.round(Number(body.amount));
      const reason = field(body.reason, 300);
      if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > 1000000) fail(400, 'أدخل مبلغ تعديل صحيحاً.');
      const student = await db.collection('users').findOne({ id: studentId, role: 'students' }, { projection: { id: 1 } });
      if (!student) fail(404, 'حساب الطالب غير موجود.');
      await walletAccount(studentId);
      const reference = `admin-adjustment:${crypto.randomUUID()}`;
      const filter = amount < 0 ? { user_id: studentId, balance: { $gte: Math.abs(amount) } } : { user_id: studentId };
      const adjusted = await db.collection('wallet_accounts').updateOne(filter, { $inc: { balance: amount }, $set: { updated: Date.now() } });
      if (!adjusted.modifiedCount) fail(409, 'لا يمكن أن يصبح رصيد الطالب سالباً.');
      try {
        await db.collection('wallet_transactions').insertOne({ id: crypto.randomUUID(), user_id: studentId, type: 'admin_adjustment', amount, reference, note: reason, created: Date.now() });
      } catch (error) {
        await db.collection('wallet_accounts').updateOne({ user_id: studentId }, { $inc: { balance: -amount }, $set: { updated: Date.now() } });
        throw error;
      }
      await audit(user.id, 'wallet:adjustment', `${studentId}:${amount}:${reason}`);
      return res.json({ ok: true, balance: await walletBalance(studentId) });
    }
    if (path === 'wallet-topups/settings' && user.role === 'admin' && write) {
      const value = { cliq_alias: field(body.cliq_alias, 100), cliq_name: field(body.cliq_name || '', 100, 0), support_whatsapp: field(body.support_whatsapp || '', 30, 0).replace(/[^0-9+]/g, '') };
      await db.collection('platform_settings').updateOne({ key: 'payments' }, { $set: { key: 'payments', value } }, { upsert: true });
      await audit(user.id, 'wallet:settings', 'payments');
      return res.json({ settings: value });
    }
    if (/^wallet-topups\/[^/]+\/(approve|reject)$/.test(path) && user.role === 'admin' && write) {
      const [, id, action] = path.split('/');
      const update = action === 'approve' ? { status: 'approved', reviewed_at: Date.now(), reviewed_by: user.id, rejection_reason: '' } : { status: 'rejected', reviewed_at: Date.now(), reviewed_by: user.id, rejection_reason: field(body.reason, 300) };
      const result = await db.collection('wallet_topups').updateOne({ id, status: 'pending' }, { $set: update });
      if (!result.modifiedCount) fail(409, 'تمت مراجعة طلب الشحن مسبقاً.');
      const topup = await db.collection('wallet_topups').findOne({ id });
      if (action === 'approve') {
        await walletAccount(topup.user_id);
        await db.collection('wallet_accounts').updateOne({ user_id: topup.user_id }, { $inc: { balance: topup.amount }, $set: { updated: Date.now() } });
        try { await db.collection('wallet_transactions').insertOne({ id: crypto.randomUUID(), user_id: topup.user_id, type: 'cliq_topup', amount: topup.amount, reference: `wallet-topup:${id}`, created: Date.now() }); }
        catch (error) { await db.collection('wallet_accounts').updateOne({ user_id: topup.user_id }, { $inc: { balance: -topup.amount }, $set: { updated: Date.now() } }); await db.collection('wallet_topups').updateOne({ id, reviewed_by: user.id }, { $set: { status: 'pending', reviewed_at: 0, reviewed_by: '' } }); throw error; }
      }
      await audit(user.id, `wallet:topup-${action}`, id);
      return res.json({ ok: true });
    }
    if (path === 'lesson-packages' && !write) {
      const allowedSubjects = await catalogSubjectSet();
      if (user.role === 'teachers') {
        const packages = await db.collection('lesson_packages').find({ teacher_id: user.id }, { projection: { _id: 0 } }).sort({ created: -1 }).limit(100).toArray();
        const purchases = await db.collection('package_purchases').find({ teacher_id: user.id }, { projection: { _id: 0, package_id: 1, student_id: 1, remaining_lessons: 1, expires_at: 1 } }).toArray();
        return res.json({ packages: packages.map(item => publicLessonPackage({ ...item, subjects: (item.subjects || []).filter(subject => allowedSubjects.has(subject)), sold_count: purchases.filter(row => row.package_id === item.id).length, active_students: new Set(purchases.filter(row => row.package_id === item.id && row.remaining_lessons > 0 && row.expires_at > Date.now()).map(row => row.student_id)).size })) });
      }
      if (user.role !== 'students') fail(403, 'الباقات متاحة للأساتذة والطلاب فقط.');
      const packages = await db.collection('lesson_packages').find({ status: 'active' }, { projection: { _id: 0 } }).sort({ created: -1 }).limit(200).toArray();
      const teacherIds = [...new Set(packages.map(item => item.teacher_id))];
      const teachers = await db.collection('users').find({ id: { $in: teacherIds }, role: 'teachers', status: 'active' }, { projection: { _id: 0, id: 1, name: 1 } }).toArray();
      const teacherMap = new Map(teachers.map(item => [item.id, item.name]));
      const ratings = await teacherRatingMap(teacherIds);
      const purchases = await db.collection('package_purchases').find({ student_id: user.id }, { projection: { _id: 0 } }).sort({ created: -1 }).limit(200).toArray();
      const reservations = await db.collection('package_purchases').find({ teacher_id: { $in: teacherIds }, status: { $in: ['scheduled', 'active'] }, expires_at: { $gt: Date.now() } }, { projection: { _id: 0, teacher_id: 1, selected_schedule: 1 } }).toArray();
      const reservedByTeacher = new Map(teacherIds.map(id => [id, reservations.filter(row => row.teacher_id === id).flatMap(storedSelectedSchedule)]));
      return res.json({ offers: packages.filter(item => teacherMap.has(item.teacher_id)).map(item => publicLessonPackage({ ...item, subjects: (item.subjects || []).filter(subject => allowedSubjects.has(subject)), teacher_name: teacherMap.get(item.teacher_id), reserved_schedule: reservedByTeacher.get(item.teacher_id) || [], ...ratings.get(item.teacher_id) })).filter(item => item.subjects.length), purchases: purchases.map(item => publicPackagePurchase({ ...item, subjects: (item.subjects || []).filter(subject => allowedSubjects.has(subject)) })) });
    }
    if (path === 'lesson-packages' && write && user.role === 'teachers') {
      const values = lessonPackageInput(body), now = Date.now();
      assertCatalogSubjects(values.subjects, await catalogSubjectSet());
      if (body.id) {
        const id = field(body.id, 80);
        const updated = await db.collection('lesson_packages').updateOne({ id, teacher_id: user.id }, { $set: { ...values, updated: now } });
        if (!updated.modifiedCount) fail(404, 'الباقة غير موجودة.');
        await audit(user.id, 'package:update', id);
        return res.json({ package: publicLessonPackage(await db.collection('lesson_packages').findOne({ id }, { projection: { _id: 0 } })) });
      }
      const item = { id: crypto.randomUUID(), teacher_id: user.id, ...values, status: 'active', created: now, updated: now };
      await db.collection('lesson_packages').insertOne(item);
      await audit(user.id, 'package:create', item.id);
      return res.json({ package: publicLessonPackage(item) });
    }
    if (/^lesson-packages\/[^/]+\/(archive|activate)$/.test(path) && write && user.role === 'teachers') {
      const [, id, action] = path.split('/');
      const status = action === 'activate' ? 'active' : 'archived';
      const updated = await db.collection('lesson_packages').updateOne({ id, teacher_id: user.id }, { $set: { status, updated: Date.now() } });
      if (!updated.modifiedCount) fail(404, 'الباقة غير موجودة.');
      await audit(user.id, `package:${action}`, id);
      return res.json({ ok: true });
    }
    if (/^package-purchases\/[^/]+\/availability$/.test(path) && !write && user.role === 'students') {
      const purchaseId = path.split('/')[1];
      const purchase = await db.collection('package_purchases').findOne({ id: purchaseId, student_id: user.id, status: 'active', remaining_lessons: { $gt: 0 }, expires_at: { $gt: Date.now() } }, { projection: { _id: 0 } });
      if (!purchase) fail(404, 'الباقة غير موجودة أو لم يعد فيها حصص متاحة.');
      return res.json({ purchase: publicPackagePurchase(purchase), days: await packageAvailability(purchase) });
    }
    if (/^package-purchases\/[^/]+\/book$/.test(path) && write && user.role === 'students') {
      const purchaseId = path.split('/')[1];
      const purchase = await db.collection('package_purchases').findOne({ id: purchaseId, student_id: user.id, status: 'active', remaining_lessons: { $gt: 0 }, expires_at: { $gt: Date.now() } }, { projection: { _id: 0 } });
      if (!purchase) fail(409, 'الباقة غير موجودة أو لم يعد فيها حصص متاحة.');
      const allowedSubjects = await catalogSubjectSet();
      const requestedSubject = typeof body.subject === 'string' ? field(body.subject, 100) : '';
      const subjects = (purchase.subjects || []).filter(subject => allowedSubjects.has(subject));
      const subject = requestedSubject && subjects.includes(requestedSubject) ? requestedSubject : subjects.length === 1 ? subjects[0] : '';
      if (!subject) fail(400, 'اختر المادة التي تريد حجزها من مواد الباقة.');
      const lessonDuration = Number(purchase.minutes) * 60000;
      const lessonPrice = Math.round(Number(purchase.price) / Number(purchase.lesson_count));
      const requestedCount = body.recurring === true ? Number(purchase.remaining_lessons) : 1;
      const remainingAfterSchedule = Number(purchase.remaining_lessons) - requestedCount;
      const occupied = await occupiedPackageRanges(purchase.teacher_id, purchase.student_id);
      const selectedSchedule = Array.isArray(body.selections) && body.selections.length ? selectedPackageSchedule(body, purchase) : [];
      let starts = [];
      if (selectedSchedule.length) {
        starts = plannedPackageStarts({ ...purchase, lesson_count: 60, validity_days: Math.max(7, Math.ceil((Number(purchase.expires_at) - Date.now()) / 86400000)) }, selectedSchedule, Number(purchase.expires_at));
        starts = starts.filter(candidate => !occupied.some(range => candidate < range.end && candidate + lessonDuration > range.start)).slice(0, requestedCount);
      } else {
        const start = Number(body.start);
        const availableDays = await packageAvailability(purchase);
        if (!Number.isSafeInteger(start) || !availableDays.some(day => day.starts.includes(start))) fail(409, 'هذا الوقت لم يعد متاحاً. اختر وقتاً آخر من جدول الباقة.');
        for (let candidate = start; starts.length < requestedCount && candidate + lessonDuration <= Number(purchase.expires_at); candidate += 7 * 86400000) {
          const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(candidate));
          const row = storedWeeklySchedule(purchase).find(item => item.weekday === civilWeekday(day));
          if (!row) continue;
          const window = packageWindow(day, row);
          const end = candidate + lessonDuration;
          if (candidate < window.start || end > window.end || occupied.some(range => candidate < range.end && end > range.start)) continue;
          starts.push(candidate);
          occupied.push({ id: `planned:${candidate}`, start: candidate, end });
        }
      }
      if (starts.length < requestedCount) fail(409, `لا توجد مواعيد أسبوعية كافية لإكمال الباقة. المتاح حالياً ${starts.length} من ${requestedCount} حصص؛ اختر وقتاً آخر أو اطلب من الأستاذ توسيع أيام الباقة.`);
      const consumed = await db.collection('package_purchases').updateOne({ id: purchase.id, student_id: user.id, status: 'active', remaining_lessons: Number(purchase.remaining_lessons) }, { $set: { remaining_lessons: remainingAfterSchedule, status: remainingAfterSchedule > 0 ? 'active' : body.recurring === true ? 'scheduled' : 'exhausted', ...(body.recurring === true ? { selected_schedule: selectedSchedule, scheduled_starts: starts, scheduled_at: Date.now() } : {}), updated: Date.now() } });
      if (!consumed.modifiedCount) fail(409, 'تم جدولة هذه الباقة للتو من جهاز آخر.');
      const bookingIds = [];
      try {
        const now = Date.now();
        const slots = starts.map((lessonStart, index) => { const id = crypto.randomUUID(); bookingIds.push(id); return { id: `package:${id}`, teacher_id: purchase.teacher_id, start: lessonStart, available_until: lessonStart + lessonDuration, minutes: Number(purchase.minutes), price: lessonPrice, subject, subjects: [subject], offerings: [{ minutes: Number(purchase.minutes), price: lessonPrice }], status: 'booked', package_purchase_id: purchase.id, package_sequence: index + 1, created: now }; });
        const bookings = slots.map((slot, index) => ({ id: bookingIds[index], slot_id: slot.id, student_id: user.id, start: slot.start, minutes: Number(purchase.minutes), price: lessonPrice, subject, status: 'confirmed', room: random(), paid: 1, payment_ref: `package:${purchase.id}`, package_purchase_id: purchase.id, package_sequence: index + 1, payout_status: 'held', payout_hold_reason: `package:${purchase.id}`, notes: '', resource: '', created: now }));
        await db.collection('slots').insertMany(slots);
        await db.collection('bookings').insertMany(bookings);
      } catch (error) {
        await db.collection('package_purchases').updateOne({ id: purchase.id }, { $set: { remaining_lessons: Number(purchase.remaining_lessons), status: 'active', updated: Date.now() }, $unset: { selected_schedule: '', scheduled_starts: '', scheduled_at: '' } });
        await db.collection('bookings').deleteMany({ id: { $in: bookingIds } });
        await db.collection('slots').deleteMany({ id: { $in: bookingIds.map(id => `package:${id}`) } });
        throw error;
      }
      await ensureChat(mongoChatStore(db), purchase.teacher_id, user.id);
      io.to(`chat:${purchase.teacher_id}`).emit('chat:changed', {});
      const teacherAccount = await db.collection('users').findOne({ id: purchase.teacher_id }, { projection: { _id: 0, phone: 1, verification: 1 } });
      const bookingNotice = { id: bookingIds[0], subject, start: starts[0], minutes: Number(purchase.minutes), teacher_name: purchase.teacher_name || '', student_name: user.name, teacher_phone: teacherAccount?.phone || parseVerification(teacherAccount?.verification).phone || '', student_phone: user.phone || parseVerification(user.verification).phone || '', lesson_count: starts.length };
      io.to(`chat:${purchase.teacher_id}`).emit('booking:created', { ...bookingNotice, audience: 'teacher' });
      io.to(`chat:${user.id}`).emit('booking:created', { ...bookingNotice, audience: 'student' });
      void sendDevicePush(purchase.teacher_id, { title: 'تمت جدولة باقة جديدة', body: `حجز ${user.name} ${starts.length} حصص أسبوعية لمادة ${subject}`, tag: `package-${purchase.id}`, url: 'teachers' });
      void sendDevicePush(user.id, { title: 'تمت جدولة باقتك', body: `تم تثبيت ${starts.length} حصص أسبوعية بنجاح`, tag: `package-${purchase.id}`, url: 'students' });
      await audit(user.id, 'package:schedule', purchase.id);
      return res.json({ ok: true, id: bookingIds[0], ids: bookingIds, starts });
    }
    if (/^lesson-packages\/[^/]+\/purchase$/.test(path) && write && user.role === 'students') {
      const packageId = path.split('/')[1];
      const offer = await db.collection('lesson_packages').findOne({ id: packageId, status: 'active' }, { projection: { _id: 0 } });
      if (!offer) fail(409, 'هذه الباقة لم تعد متاحة للشراء.');
      const allowedSubjects = await catalogSubjectSet();
      const offerSubjects = (offer.subjects || []).filter(subject => allowedSubjects.has(subject));
      if (!offerSubjects.length) fail(409, 'مواد هذه الباقة لم تعد متاحة في قائمة الإدارة.');
      const requestedSubject = typeof body.subject === 'string' ? field(body.subject, 100) : '';
      const subject = requestedSubject && offerSubjects.includes(requestedSubject) ? requestedSubject : offerSubjects.length === 1 ? offerSubjects[0] : '';
      if (!subject) fail(400, 'اختر المادة التي تريد دراستها ضمن الباقة.');
      const selectedSchedule = selectedPackageSchedule(body, offer);
      const teacher = await db.collection('users').findOne({ id: offer.teacher_id, role: 'teachers', status: 'active' }, { projection: { _id: 0, id: 1, name: 1, phone: 1, verification: 1 } });
      if (!teacher) fail(409, 'الأستاذ غير متاح حالياً.');
      const now = Date.now();
      const expiresAt = now + Number(offer.validity_days) * 86400000;
      const starts = plannedPackageStarts(offer, selectedSchedule, expiresAt, now + 60000);
      if (starts.length < Number(offer.lesson_count)) fail(409, `الأيام المختارة لا تكفي لجدولة ${offer.lesson_count} حصة خلال صلاحية الباقة. اختر أياماً إضافية.`);
      const occupied = await occupiedPackageRanges(offer.teacher_id, user.id);
      const lessonDuration = Number(offer.minutes) * 60000;
      if (starts.some(start => occupied.some(range => start < range.end && start + lessonDuration > range.start))) fail(409, 'أحد الأوقات المختارة حُجز للتو. افتح تفاصيل الباقة واختر وقتاً آخر.');
      await walletAccount(user.id);
      const debit = await db.collection('wallet_accounts').updateOne({ user_id: user.id, balance: { $gte: offer.price } }, { $inc: { balance: -offer.price }, $set: { updated: Date.now() } });
      if (!debit.modifiedCount) fail(402, 'رصيد محفظتك غير كافٍ. اشحن محفظتك لإكمال شراء الباقة.');
      const purchase = { id: crypto.randomUUID(), package_id: offer.id, teacher_id: offer.teacher_id, teacher_name: teacher.name, student_id: user.id, package_name: offer.name, subjects: [subject], lesson_count: offer.lesson_count, remaining_lessons: 0, minutes: offer.minutes, price: offer.price, weekly_schedule: storedWeeklySchedule(offer), selected_schedule: selectedSchedule, scheduled_starts: starts, scheduled_at: now, status: 'scheduled', expires_at: expiresAt, created: now, updated: now };
      const bookingIds = starts.map(() => crypto.randomUUID());
      const lessonPrice = Math.round(Number(offer.price) / Number(offer.lesson_count));
      try {
        await db.collection('package_purchases').insertOne(purchase);
        await db.collection('wallet_transactions').insertOne({ id: crypto.randomUUID(), user_id: user.id, type: 'package_purchase', amount: -offer.price, reference: `package-purchase:${purchase.id}`, created: now });
        const slots = starts.map((start, index) => ({ id: `package:${bookingIds[index]}`, teacher_id: offer.teacher_id, start, available_until: start + lessonDuration, minutes: Number(offer.minutes), price: lessonPrice, subject, subjects: [subject], offerings: [{ minutes: Number(offer.minutes), price: lessonPrice }], status: 'booked', package_purchase_id: purchase.id, package_sequence: index + 1, created: now }));
        const bookings = slots.map((slot, index) => ({ id: bookingIds[index], slot_id: slot.id, student_id: user.id, start: slot.start, minutes: Number(offer.minutes), price: lessonPrice, subject, status: 'confirmed', room: random(), paid: 1, payment_ref: `package:${purchase.id}`, package_purchase_id: purchase.id, package_sequence: index + 1, payout_status: 'held', payout_hold_reason: `package:${purchase.id}`, notes: '', resource: '', created: now }));
        await db.collection('slots').insertMany(slots);
        await db.collection('bookings').insertMany(bookings);
      } catch (error) {
        await db.collection('wallet_accounts').updateOne({ user_id: user.id }, { $inc: { balance: offer.price }, $set: { updated: Date.now() } });
        await db.collection('package_purchases').deleteOne({ id: purchase.id });
        await db.collection('wallet_transactions').deleteMany({ reference: `package-purchase:${purchase.id}` });
        await db.collection('bookings').deleteMany({ id: { $in: bookingIds } });
        await db.collection('slots').deleteMany({ id: { $in: bookingIds.map(id => `package:${id}`) } });
        throw error;
      }
      await ensureChat(mongoChatStore(db), offer.teacher_id, user.id);
      io.to(`chat:${offer.teacher_id}`).emit('chat:changed', {});
      const teacherPhone = teacher.phone || parseVerification(teacher.verification).phone || '';
      const studentPhone = user.phone || parseVerification(user.verification).phone || '';
      const bookingNotice = { id: bookingIds[0], subject, start: starts[0], minutes: Number(offer.minutes), teacher_name: teacher.name || '', student_name: user.name, teacher_phone: teacherPhone, student_phone: studentPhone, lesson_count: starts.length };
      io.to(`chat:${offer.teacher_id}`).emit('booking:created', { ...bookingNotice, audience: 'teacher' });
      io.to(`chat:${user.id}`).emit('booking:created', { ...bookingNotice, audience: 'student' });
      void sendDevicePush(offer.teacher_id, { title: 'تم حجز باقة جديدة', body: `حجز ${user.name} ${starts.length} حصة لمادة ${subject}`, tag: `package-${purchase.id}`, url: 'teachers' });
      void sendDevicePush(user.id, { title: 'تم تثبيت باقتك', body: `تم حجز ${starts.length} حصة مع ${teacher.name}`, tag: `package-${purchase.id}`, url: 'students' });
      await audit(user.id, 'package:purchase', purchase.id);
      return res.json({ purchase: publicPackagePurchase(purchase) });
    }
    if (['overview', 'home', 'booked', 'available', 'history', 'reminders', 'rooms'].includes(path) && !write) {
      await finalizeEndedBookings();
      const bookings = await bookingRows(user.role === 'admin' ? {} : user.role === 'teachers' ? {} : { student_id: user.id });
      await ensureAutomaticNoShowReports(bookings);
      const owned = user.role === 'teachers' ? bookings.filter(b => b.teacher_id === user.id) : bookings;
      const slots = user.role === 'teachers' ? await db.collection('slots').find({ teacher_id: user.id }, { projection: { _id: 0 } }).sort({ start: -1 }).limit(500).toArray() : undefined;
      return res.json({ bookings: owned, ...(slots ? { slots } : {}) });
    }
    if (path === 'slots') {
      if (!write) {
        if (user.role === 'teachers') return res.json({ slots: await db.collection('slots').find({ teacher_id: user.id }, { projection: { _id: 0 } }).sort({ start: -1 }).limit(500).toArray() });
        const slots = await db.collection('slots').find({ status: 'open', available_until: { $gt: Date.now() } }, { projection: { _id: 0 } }).sort({ start: 1 }).limit(500).toArray();
        const allowedSubjects = await catalogSubjectSet();
        const teachers = await db.collection('users').find({ id: { $in: [...new Set(slots.map(s => s.teacher_id))] }, status: 'active' }, { projection: { _id: 0 } }).toArray();
        const teacherMap = new Map(teachers.map(t => [t.id, t]));
        const ratings = await teacherRatingMap(slots.map(slot => slot.teacher_id));
        const occupied = await db.collection('bookings').find({ slot_id: { $in: slots.map(slot => slot.id) }, status: 'confirmed' }, { projection: { _id: 0, slot_id: 1, start: 1, minutes: 1 } }).toArray();
        const available = slots.filter(s => teacherMap.has(s.teacher_id)).map(s => { const subjects = storedSubjects(s).filter(subject => allowedSubjects.has(subject)); return ({ ...s, subject: subjects.length === 1 ? subjects[0] : 'كل المواد المختارة', subjects, booked_ranges: occupied.filter(row => row.slot_id === s.id).map(row => ({ start: Number(row.start || s.start), end: Number(row.start || s.start) + Number(row.minutes || s.minutes) * 60000 })), teacher_name: teacherMap.get(s.teacher_id).name, bio: teacherMap.get(s.teacher_id).bio || '', teacher_subjects: teacherMap.get(s.teacher_id).subject || '', ...ratings.get(s.teacher_id) }); }).filter(slot => slot.subjects.length);
        return res.json({ slots: available.filter(slotHasAvailability) });
      }
      if (user.role !== 'teachers') fail(403, 'إضافة المواعيد متاحة للأساتذة فقط.');
      const start = Number(body.start), subjects = slotSubjects(body), offerings = slotOfferings(body);
      assertCatalogSubjects(subjects, await catalogSubjectSet());
      const defaultOffering = offerings[0], maxMinutes = Math.max(...offerings.map(item => item.minutes));
      const suppliedUntil = Number(body.available_until || body.availableUntil || 0);
      const hasAvailabilityWindow = Number.isSafeInteger(suppliedUntil) && suppliedUntil >= start + maxMinutes * 60000;
      const until = hasAvailabilityWindow ? suppliedUntil : start + maxMinutes * 60000;
      const now = Date.now();
      if (!Number.isSafeInteger(start) || start > now + 31536000000 || start < now - 60000 || until <= now) fail(400, 'تحقق من الموعد والفترة المتاحة.');
      const overlaps = await db.collection('slots').findOne({ teacher_id: user.id, status: { $ne: 'cancelled' }, start: { $lt: until }, $expr: { $gt: [{ $ifNull: ['$available_until', { $add: ['$start', { $multiply: ['$minutes', 60000] }] }] }, start] } });
      if (overlaps) fail(409, 'الموعد يتعارض مع موعد آخر.');
      await db.collection('slots').insertOne({ id: crypto.randomUUID(), teacher_id: user.id, start, minutes: defaultOffering.minutes, price: defaultOffering.price, subject: subjects.length === 1 ? subjects[0] : 'كل المواد المختارة', subjects, offerings, available_until: until, status: 'open', created: Date.now() });
      return res.json({ ok: true });
    }
    if (path.startsWith('slots/') && write) {
      const id = path.split('/')[1];
      if (user.role === 'teachers') {
        if (await db.collection('bookings').findOne({ slot_id: id, status: 'confirmed' })) fail(409, 'لا يمكن حذف فترة فيها حجز مؤكد. ألغِ الحصة أولاً.');
        const result = await db.collection('slots').updateOne({ id, teacher_id: user.id, status: 'open' }, { $set: { status: 'cancelled' } });
        if (!result.modifiedCount) fail(409, 'تعذر حذف الموعد لأنه غير متاح.');
        return res.json({ ok: true });
      }
      if (user.role !== 'students') fail(403, 'الحجز متاح للطلاب فقط.');
      const slot = await db.collection('slots').findOne({ id, status: 'open', available_until: { $gt: Date.now() } });
      if (!slot) fail(409, 'الموعد لم يعد متاحاً.');
      const subjects = storedSubjects(slot), offerings = storedOfferings(slot);
      const legacyAllSubjects = !Array.isArray(slot.subjects) && slot.subject === 'كل المواد المختارة';
      const requestedSubject = typeof body.subject === 'string' ? field(body.subject, 100) : '';
      const selectedSubject = requestedSubject && (subjects.includes(requestedSubject) || legacyAllSubjects) ? requestedSubject : subjects.length === 1 && !legacyAllSubjects ? subjects[0] : '';
      const selectedOffering = offerings.find(item => item.minutes === Number(body.minutes)) || (offerings.length === 1 ? offerings[0] : null);
      if (!selectedSubject) fail(400, 'اختر المادة التي تريد حجزها.');
      if (!selectedOffering) fail(400, 'اختر مدة الحصة التي تناسبك.');
      const hasSelectedStart = body.start !== undefined && body.start !== null && body.start !== '';
      const selectedStart = Number(hasSelectedStart ? body.start : slot.start);
      const selectedEnd = selectedStart + selectedOffering.minutes * 60000;
      if (!Number.isSafeInteger(selectedStart) || (hasSelectedStart && (selectedStart < Number(slot.start) || selectedEnd > Number(slot.available_until) || selectedStart <= Date.now()))) fail(400, 'اختر وقتاً متاحاً داخل الفترة التي حددها الأستاذ.');
      const studentBookings = await enrichBookings(await db.collection('bookings').find({ student_id: user.id, status: 'confirmed' }, { projection: { _id: 0 } }).toArray());
      if (studentBookings.some(row => selectedStart < row.start + row.minutes * 60000 && selectedEnd > row.start)) fail(409, 'لديك حصة أخرى تتعارض مع هذا الوقت.');
      const packagePurchaseId = typeof body.package_purchase_id === 'string' ? field(body.package_purchase_id, 80) : '';
      let packagePurchase = null;
      if (packagePurchaseId) {
        packagePurchase = await db.collection('package_purchases').findOne({ id: packagePurchaseId, student_id: user.id, teacher_id: slot.teacher_id, status: 'active', remaining_lessons: { $gt: 0 }, expires_at: { $gte: selectedEnd } }, { projection: { _id: 0 } });
        if (!packagePurchase) fail(409, 'هذه الباقة لا تغطي هذا الموعد أو لم يعد فيها حصص متاحة.');
        if (Number(packagePurchase.minutes) !== selectedOffering.minutes || !packagePurchase.subjects.includes(selectedSubject)) fail(400, 'اختر موعداً مطابقاً لمادة الباقة ومدتها.');
      }
      const bookingId = crypto.randomUUID();
      const reserved = await db.collection('slots').updateOne({ id, status: 'open', start: { $lte: selectedStart }, available_until: { $gte: selectedEnd }, $nor: [{ reservations: { $elemMatch: { start: { $lt: selectedEnd }, end: { $gt: selectedStart } } } }] }, { $push: { reservations: { booking_id: bookingId, start: selectedStart, end: selectedEnd } } });
      if (!reserved.modifiedCount) fail(409, 'هذا الوقت حُجز للتو. اختر وقتاً آخر من الفترة المتاحة.');
      if (packagePurchase) {
        const consumed = await db.collection('package_purchases').updateOne({ id: packagePurchase.id, student_id: user.id, status: 'active', remaining_lessons: { $gt: 0 }, expires_at: { $gte: selectedEnd } }, { $inc: { remaining_lessons: -1 }, $set: { updated: Date.now() } });
        if (!consumed.modifiedCount) { await db.collection('slots').updateOne({ id }, { $pull: { reservations: { booking_id: bookingId } } }); fail(409, 'تم استخدام آخر حصة من هذه الباقة للتو.'); }
      } else {
        await walletAccount(user.id);
        const debit = await db.collection('wallet_accounts').updateOne({ user_id: user.id, balance: { $gte: selectedOffering.price } }, { $inc: { balance: -selectedOffering.price }, $set: { updated: Date.now() } });
        if (!debit.modifiedCount) { await db.collection('slots').updateOne({ id }, { $pull: { reservations: { booking_id: bookingId } } }); fail(402, 'رصيد محفظتك غير كافٍ. اشحن محفظتك لإكمال عملية الشراء.'); }
      }
      const bookingPrice = packagePurchase ? Math.round(Number(packagePurchase.price) / Number(packagePurchase.lesson_count)) : selectedOffering.price;
      try {
        await db.collection('bookings').insertOne({ id: bookingId, slot_id: id, student_id: user.id, start: hasSelectedStart ? selectedStart : 0, minutes: selectedOffering.minutes, price: bookingPrice, subject: selectedSubject, status: 'confirmed', room: random(), paid: 1, payment_ref: packagePurchase ? `package:${packagePurchase.id}` : 'wallet', package_purchase_id: packagePurchase?.id || '', notes: '', resource: '', created: Date.now() });
        if (!packagePurchase) await db.collection('wallet_transactions').insertOne({ id: crypto.randomUUID(), user_id: user.id, type: 'lesson_payment', amount: -selectedOffering.price, reference: `lesson-payment:${bookingId}`, created: Date.now() });
        else {
          const fresh = await db.collection('package_purchases').findOne({ id: packagePurchase.id }, { projection: { _id: 0, remaining_lessons: 1 } });
          if (Number(fresh?.remaining_lessons || 0) <= 0) await db.collection('package_purchases').updateOne({ id: packagePurchase.id }, { $set: { status: 'exhausted', updated: Date.now() } });
        }
      } catch (error) {
        if (packagePurchase) await db.collection('package_purchases').updateOne({ id: packagePurchase.id }, { $inc: { remaining_lessons: 1 }, $set: { status: 'active', updated: Date.now() } });
        else await db.collection('wallet_accounts').updateOne({ user_id: user.id }, { $inc: { balance: selectedOffering.price }, $set: { updated: Date.now() } });
        await db.collection('bookings').deleteOne({ id: bookingId });
        await db.collection('slots').updateOne({ id }, { $pull: { reservations: { booking_id: bookingId } } }); throw error;
      }
      await ensureChat(mongoChatStore(db), slot.teacher_id, user.id);
      io.to(`chat:${slot.teacher_id}`).emit('chat:changed', {});
      const teacherAccount = await db.collection('users').findOne({ id: slot.teacher_id }, { projection: { _id: 0, name: 1, phone: 1, verification: 1 } });
      const bookingNotice = { id: bookingId, subject: selectedSubject, start: selectedStart, minutes: selectedOffering.minutes, teacher_name: slot.teacher_name || teacherAccount?.name || '', student_name: user.name, teacher_phone: teacherAccount?.phone || parseVerification(teacherAccount?.verification).phone || '', student_phone: user.phone || parseVerification(user.verification).phone || '' };
      io.to(`chat:${slot.teacher_id}`).emit('booking:created', { ...bookingNotice, audience: 'teacher' });
      io.to(`chat:${user.id}`).emit('booking:created', { ...bookingNotice, audience: 'student' });
      void sendDevicePush(slot.teacher_id, { title: 'حجز جديد', body: `حجز ${user.name} حصة ${selectedSubject}`, tag: `booking-${bookingId}`, url: 'teachers' });
      void sendDevicePush(user.id, { title: 'تم تأكيد حجزك', body: `تم حجز حصة ${selectedSubject} بنجاح`, tag: `booking-${bookingId}`, url: 'students' });
      return res.json({ ok: true, id: bookingId });
    }
    const [category, id, action] = path.split('/');
    if (category === 'bookings' && id) {
      if (action === 'room' || action === 'presence' || action === 'complete') await finalizeEndedBookings({ id });
      const row = (await enrichBookings([await db.collection('bookings').findOne({ id }, { projection: { _id: 0 } })]))[0];
      if (!row || (user.role !== 'admin' && row.teacher_id !== user.id && row.student_id !== user.id)) fail(404, 'الحصة غير موجودة.');
      if (action === 'room' && !write) {
        if (user.role === 'admin' || row.status !== 'confirmed') fail(403, 'الدخول متاح فقط لطرفي الحصة المؤكدة.');
        if (Date.now() < row.start - 900000) fail(403, 'يمكن دخول الحصة قبل موعدها بخمس عشرة دقيقة.');
        if (Date.now() >= Number(row.start) + Number(row.minutes) * 60000 + 5 * 60000) fail(403, 'انتهت الحصة وأُغلقت الغرفة. لا يمكن الدخول إليها مرة أخرى.');
        const bookingDocument = await db.collection('bookings').findOne({ id }, { projection: { _id: 0, room: 1 } });
        return res.json({ room: bookingDocument.room, role: user.role === 'teachers' ? 'teacher' : 'student' });
      }
      if (action === 'presence') {
        if (user.role === 'admin' || row.status !== 'confirmed') fail(403, 'الحضور المباشر متاح فقط لطرفي الحصة المؤكدة.');
        if (write) {
          const key = user.role === 'teachers' ? 'teacher_present_until' : 'student_present_until';
          const peerKey = user.role === 'teachers' ? 'teacher_peer_id' : 'student_peer_id';
          const joinedKey = user.role === 'teachers' ? 'teacher_joined_at' : 'student_joined_at';
          const seenKey = user.role === 'teachers' ? 'teacher_last_seen_at' : 'student_last_seen_at';
          const until = body.active === false ? 0 : Date.now() + 45000;
          const peerId = body.active === false ? '' : field(body.peerId || '', 160, 0);
          await db.collection('bookings').updateOne({ id }, { $set: { [key]: until, [peerKey]: peerId, [seenKey]: Date.now() } });
          if (body.active !== false) await db.collection('bookings').updateOne({ id, $or: [{ [joinedKey]: { $exists: false } }, { [joinedKey]: 0 }] }, { $set: { [joinedKey]: Date.now() } });
          row[key] = until;
          row[peerKey] = peerId;
          if (body.active !== false && !Number(row[joinedKey] || 0)) row[joinedKey] = Date.now();
        }
        const teacherLive = Number(row.teacher_present_until || 0) > Date.now();
        const studentLive = Number(row.student_present_until || 0) > Date.now();
        return res.json({
          teacherLive,
          studentLive,
          teacher_present_until: Number(row.teacher_present_until || 0),
          student_present_until: Number(row.student_present_until || 0),
          teacher_joined_at: Number(row.teacher_joined_at || 0),
          student_joined_at: Number(row.student_joined_at || 0),
          teacherPeerId: teacherLive ? row.teacher_peer_id || null : null,
          studentPeerId: studentLive ? row.student_peer_id || null : null,
        });
      }
      if (action === 'messages') {
        if (write) await db.collection('messages').insertOne({ id: crypto.randomUUID(), booking_id: id, author_id: user.id, body: field(body.body, 2000), created: Date.now() });
        const messages = await db.collection('messages').find({ booking_id: id }, { projection: { _id: 0 } }).sort({ created: 1 }).limit(500).toArray();
        const users = await db.collection('users').find({ id: { $in: [...new Set(messages.map(m => m.author_id))] } }).toArray();
        const names = new Map(users.map(u => [u.id, u.name]));
        return res.json({ messages: messages.map(m => ({ ...m, name: names.get(m.author_id) || '' })) });
      }
      if (action === 'feedback' && write && user.role === 'students') {
        if (row.student_id !== user.id || row.status === 'cancelled' || Date.now() < Number(row.start)) fail(409, 'يمكن إرسال تقييم الحصة أو الشكوى بعد بدء موعدها.');
        const rating = Number(body.rating || 0);
        if (rating && (!Number.isInteger(rating) || rating < 1 || rating > 5)) fail(400, 'اختر تقييماً بين 1 و5.');
        const review = field(body.review || '', 1500, 0);
        if (rating) await db.collection('ratings').updateOne({ booking_id: id, student_id: user.id }, { $set: { teacher_id: row.teacher_id, rating, review, updated: Date.now() }, $setOnInsert: { id: crypto.randomUUID(), booking_id: id, student_id: user.id, created: Date.now() } }, { upsert: true });
        if (body.report === true) {
          const category = ['teacher_absent', 'teacher_inactive', 'technical', 'conduct', 'content', 'other'].includes(body.category) ? body.category : 'other';
          if (!review) fail(400, 'اكتب ملاحظة توضح سبب الشكوى.');
          const existing = await db.collection('lesson_reports').findOne({ booking_id: id, reporter_id: user.id, status: 'pending' });
          if (!existing) {
            const report = { id: crypto.randomUUID(), booking_id: id, reporter_id: user.id, teacher_id: row.teacher_id, category, note: review, rating: rating || 0, status: 'pending', created: Date.now(), evidence: { lesson_start: Number(row.start), lesson_end: Number(row.start) + Number(row.minutes) * 60000, teacher_joined_at: Number(row.teacher_joined_at || 0), student_joined_at: Number(row.student_joined_at || 0), teacher_last_seen_at: Number(row.teacher_last_seen_at || 0), student_last_seen_at: Number(row.student_last_seen_at || 0), message_count: await db.collection('messages').countDocuments({ booking_id: id }) } };
            await db.collection('lesson_reports').insertOne(report);
            await db.collection('bookings').updateOne({ id }, { $set: { payout_status: 'held', payout_hold_reason: `report:${report.id}` } });
            await audit(user.id, 'booking:report', id);
          }
        }
        return res.json({ ok: true });
      }
      if (action === 'cancellation' && !write) {
        if (row.status !== 'confirmed') fail(409, 'الحصة لم تعد قابلة للإلغاء.');
        return res.json({ quote: row.package_purchase_id ? packageCancellationQuote() : cancellationQuote({ start: row.start, price: row.price, actorRole: user.role, commissionPercent: process.env.PLATFORM_COMMISSION_PERCENT || 10 }) });
      }
      if (action === 'cancel' && write) {
        if (row.status !== 'confirmed') fail(409, 'الحصة لم تعد قابلة للإلغاء.');
        if (user.role === 'students' && Number(row.start) <= Date.now()) fail(409, 'بعد بدء الحصة استخدم بلاغ عدم حضور الأستاذ إن لم يدخل خلال 10 دقائق.');
        const quote = row.package_purchase_id ? packageCancellationQuote() : cancellationQuote({ start: row.start, price: row.price, actorRole: user.role, commissionPercent: process.env.PLATFORM_COMMISSION_PERCENT || 10 });
        const cancellation = { status: 'cancelled', room: random(), cancelled_at: Date.now(), cancelled_by: user.role, cancellation_reason: field(body.reason || '', 300, 0), refund_amount: quote.refund, teacher_compensation: quote.teacherCompensation, platform_fee: quote.platformFee };
        const cancelled = await db.collection('bookings').updateOne({ id, status: 'confirmed' }, { $set: cancellation });
        if (!cancelled.modifiedCount) fail(409, 'الحصة لم تعد قابلة للإلغاء.');
        await db.collection('slots').updateOne({ id: row.slot_id }, { $pull: { reservations: { booking_id: id } } });
        if (row.payment_ref === 'wallet' && quote.refund > 0) {
          await walletAccount(row.student_id);
          await db.collection('wallet_accounts').updateOne({ user_id: row.student_id }, { $inc: { balance: quote.refund }, $set: { updated: Date.now() } });
          await db.collection('wallet_transactions').insertOne({ id: crypto.randomUUID(), user_id: row.student_id, type: 'lesson_refund', amount: quote.refund, reference: `lesson-refund:${id}`, created: Date.now() });
        }
        if (row.package_purchase_id) await restorePackageLesson(row);
        await audit(user.id, 'booking:cancel', id);
        return res.json({ ok: true, quote });
      }
      if (action === 'report-no-show' && write && user.role === 'students') {
        if (row.status !== 'confirmed') fail(409, 'هذه الحصة لم تعد قابلة لبلاغ عدم الحضور.');
        if (Date.now() < Number(row.start) + 10 * 60000) fail(409, 'يمكن تقديم البلاغ بعد مرور 10 دقائق من موعد الحصة.');
        if (Number(row.teacher_joined_at || 0) > 0) fail(409, 'سجل الحضور يبين أن الأستاذ دخل الغرفة. تواصل مع الدعم لمراجعة الحالة.');
        const quote = row.package_purchase_id ? packageCancellationQuote() : cancellationQuote({ start: row.start, price: row.price, actorRole: 'teachers' });
        const cancelled = await db.collection('bookings').updateOne({ id, status: 'confirmed', $or: [{ teacher_joined_at: 0 }, { teacher_joined_at: { $exists: false } }] }, { $set: { status: 'cancelled', room: random(), cancelled_at: Date.now(), cancelled_by: 'teacher_no_show', cancellation_reason: field(body.reason || 'عدم حضور الأستاذ', 300, 0), refund_amount: quote.refund, teacher_compensation: 0, platform_fee: 0 } });
        if (!cancelled.modifiedCount) fail(409, 'تعذر قبول البلاغ لأن حالة الحضور تغيّرت.');
        await db.collection('slots').updateOne({ id: row.slot_id }, { $pull: { reservations: { booking_id: id } } });
        if (row.payment_ref === 'wallet') {
          await walletAccount(row.student_id);
          await db.collection('wallet_accounts').updateOne({ user_id: row.student_id }, { $inc: { balance: row.price }, $set: { updated: Date.now() } });
          await db.collection('wallet_transactions').insertOne({ id: crypto.randomUUID(), user_id: row.student_id, type: 'lesson_refund', amount: row.price, reference: `lesson-no-show-refund:${id}`, created: Date.now() });
        }
        if (row.package_purchase_id) await restorePackageLesson(row);
        await db.collection('lesson_reports').updateOne(
          { booking_id: id, reporter_id: user.id, category: 'teacher_absent' },
          { $set: { teacher_id: row.teacher_id, note: field(body.reason || 'عدم حضور الأستاذ', 300, 0), status: 'upheld', automatic: true, resolved_at: Date.now(), evidence: { lesson_start: Number(row.start), teacher_joined_at: 0, student_joined_at: Number(row.student_joined_at || 0) } }, $setOnInsert: { id: crypto.randomUUID(), booking_id: id, reporter_id: user.id, category: 'teacher_absent', created: Date.now() } },
          { upsert: true },
        );
        await audit(user.id, 'booking:teacher-no-show', id);
        return res.json({ ok: true, quote });
      }
      if (action === 'complete' && write && ['teachers', 'students'].includes(user.role)) {
        const scheduledEnd = Number(row.start) + Number(row.minutes) * 60000;
        if (user.role === 'students' && Date.now() < scheduledEnd + 5 * 60000) fail(409, 'لا يمكن إنهاء الحصة تلقائياً قبل انتهاء وقتها الإضافي.');
        if (!Number(row.teacher_joined_at || 0) || !Number(row.student_joined_at || 0)) fail(409, 'لم يكتمل حضور طرفي الحصة، وستبقى قيد المراجعة.');
        await db.collection('bookings').updateOne({ id, status: 'confirmed' }, { $set: { status: 'completed', completed_at: Date.now(), payout_status: row.payout_status === 'held' ? 'held' : 'released', room: random() } });
        return res.json({ ok: true });
      }
      if (action === 'notes' && write && user.role === 'teachers') {
        await db.collection('bookings').updateOne({ id }, { $set: { notes: field(body.notes || '', 5000, 0), resource: field(body.resource || '', 1000, 0) } });
        return res.json({ ok: true });
      }
      if (action === 'rating' && write && user.role === 'students') {
        if (row.student_id !== user.id || row.status !== 'completed') fail(409, 'التقييم متاح بعد إكمال الحصة.');
        const rating = Number(body.rating);
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) fail(400, 'اختر تقييماً بين 1 و5.');
        await db.collection('ratings').updateOne({ booking_id: id, student_id: user.id }, { $set: { teacher_id: row.teacher_id, rating, review: field(body.review || '', 1000, 0), updated: Date.now() }, $setOnInsert: { id: crypto.randomUUID(), booking_id: id, student_id: user.id, created: Date.now() } }, { upsert: true });
        return res.json({ ok: true });
      }
      if (action === 'payment' && write && user.role === 'admin') {
        if (row.payment_ref === 'wallet' || row.package_purchase_id) fail(409, 'الدفعات الإلكترونية تُسجّل تلقائياً ولا يمكن تعديلها يدوياً.');
        await db.collection('bookings').updateOne({ id }, { $set: { paid: body.paid ? 1 : 0, payment_ref: field(body.reference || '', 200, body.paid ? 1 : 0) } });
        await audit(user.id, body.paid ? 'payment:received' : 'payment:reversed', id);
        return res.json({ ok: true });
      }
    }
    fail(404, 'الطلب غير موجود أو غير متاح لحسابك.');
  } catch (error) { next(error); }
});

app.use(express.static(path.join(root, 'dist/client'), {
  maxAge: '1y',
  immutable: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html') || filePath.endsWith('service-worker.js') || filePath.endsWith('manifest.webmanifest')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));
app.get('*path', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(root, 'dist/client/index.html'));
});
app.use((error, _req, res, _next) => {
  if (!error.status) console.error(error);
  res.status(error.status || 500).json({ error: error.status ? error.message : 'تعذر تنفيذ الطلب الآن. حاول مجدداً.' });
});

export function startPlatformServer({ database, attachmentStore, topupProofStore, port = PORT } = {}) {
  if (database) db = database;
  if (attachmentStore) attachmentBytes = attachmentStore;
  if (topupProofStore) topupProofBytes = topupProofStore;
  return new Promise(resolve => httpServer.listen(port, () => {
    console.log(`Imtidad backend listening on port ${httpServer.address().port}`);
    connect().then(() => console.log('MongoDB connection warmed.')).catch(error => {
      console.error('MongoDB warmup failed:', error.message);
    });
    resolve({ app, httpServer, io });
  }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void startPlatformServer();
  const shutdown = () => {
    io.close();
    httpServer.close();
    void client?.close();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
