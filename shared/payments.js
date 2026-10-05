export const PAYMENT_TIME_ZONE = 'Asia/Amman';
const DAY = 86400000;
const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: PAYMENT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
export function paymentDay(value = Date.now()) {
  const parts = dayFormatter.formatToParts(value);
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function paymentMidnight(key) {
  const target = Date.parse(`${key}T00:00:00Z`);
  // Resolve a civil day in Amman rather than using the server's local timezone.
  let instant = target;
  for (let index = 0; index < 3; index++) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: PAYMENT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
    const get = type => Number(parts.find(part => part.type === type).value);
    const civil = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    instant += target - civil;
  }
  return instant;
}
export function paymentRange(query, now = Date.now()) {
  const today = paymentDay(now);
  const day = new Date(`${today}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  const start = query.start || day.toISOString().slice(0, 10);
  const end = query.end || today;
  const valid = value => typeof value === 'string' && value >= '1970-01-01' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
  const count = (Date.parse(end) - Date.parse(start)) / DAY + 1;
  if (!valid(start) || !valid(end) || count < 1 || count > 31 || end > today) {
    const error = new Error('اختر فترة صحيحة لا تتجاوز 31 يوماً ولا تشمل أياماً مستقبلية.');
    error.status = 400; throw error;
  }
  const next = new Date(`${end}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
  return { start, end, from: paymentMidnight(start), until: paymentMidnight(next.toISOString().slice(0, 10)) };
}
export function paymentSummary(rows, range, percent = 15) {
  const commissionPercent = Number.isFinite(Number(percent)) ? Math.max(0, Math.min(90, Number(percent))) : 15;
  const bookings = rows.filter(row => row.status === 'completed' && row.start >= range.from && row.start < range.until).map(row => {
    const price = Math.max(0, Number(row.price) || 0);
    const fee = Math.round(price * commissionPercent / 100);
    return { ...row, price, fee, net: price - fee };
  }).sort((a, b) => b.start - a.start);
  const summarize = list => {
    const gross = list.reduce((sum, row) => sum + row.price, 0);
    const fee = list.reduce((sum, row) => sum + row.fee, 0);
    const minutes = list.reduce((sum, row) => sum + row.minutes, 0);
    const collected = list.filter(row => row.paid === 1).reduce((sum, row) => sum + row.price, 0);
    return { gross, fee, net: gross - fee, collected, uncollected: gross - collected, minutes, lessons: list.length, averageHourly: minutes ? Math.round(gross * 60 / minutes) : 0 };
  };
  const byTeacher = new Map(), byDay = new Map();
  for (const row of bookings) {
    const day = paymentDay(row.start);
    if (!byTeacher.has(row.teacher_id)) byTeacher.set(row.teacher_id, []);
    if (!byDay.has(day)) byDay.set(day, []);
    byTeacher.get(row.teacher_id).push(row); byDay.get(day).push(row);
  }
  const teachers = [...byTeacher].map(([id, rows]) => ({ id, name: rows[0].teacher_name, ...summarize(rows) })).sort((a, b) => b.net - a.net);
  const days = [...byDay].map(([day, rows]) => ({ day, ...summarize(rows) }));
  return { start: range.start, end: range.end, timezone: PAYMENT_TIME_ZONE, commissionPercent, summary: summarize(bookings), teachers, days, bookings };
}
