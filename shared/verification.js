export const qualificationOptions = [
  'دبلوم متوسط', 'بكالوريوس', 'دبلوم عالٍ', 'ماجستير', 'دكتوراه',
  'رخصة مزاولة تعليم', 'شهادة تدريب مهني', 'إجازة في القرآن الكريم', 'أخرى',
];

const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const clean = (value, max = 100, min = 1) => {
  if (typeof value !== 'string') fail('تحقق من بيانات طلب التسجيل.');
  const result = value.trim();
  if (result.length < min || result.length > max) fail('تحقق من بيانات طلب التسجيل.');
  return result;
};

export function jordanPhone(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  if (/^07[789]\d{7}$/.test(digits)) return `+962${digits.slice(1)}`;
  if (/^9627[789]\d{7}$/.test(digits)) return `+${digits}`;
  fail('أدخل رقم هاتف أردني صحيح يبدأ بـ 077 أو 078 أو 079.');
}

export function ageFromBirthDate(value, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return -1;
  const born = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(born.getTime()) || born.toISOString().slice(0, 10) !== value) return -1;
  let age = now.getUTCFullYear() - born.getUTCFullYear();
  const beforeBirthday = now.getUTCMonth() < born.getUTCMonth() || (now.getUTCMonth() === born.getUTCMonth() && now.getUTCDate() < born.getUTCDate());
  if (beforeBirthday) age--;
  return age;
}

export function registrationProfile(body, role) {
  const firstName = clean(body.first_name, 50, 2);
  const fatherName = clean(body.father_name, 50, 2);
  const familyName = clean(body.family_name, 50, 2);
  if (![firstName, fatherName, familyName].every(value => /^[\p{L} .'-]+$/u.test(value))) fail('استخدم الحروف فقط في الاسم.');
  const birthDate = clean(body.birth_date, 10);
  const age = ageFromBirthDate(birthDate);
  if (age < (role === 'teachers' ? 18 : 5) || age > 100) fail(role === 'teachers' ? 'يجب أن يكون عمر الأستاذ 18 سنة على الأقل.' : 'تحقق من تاريخ الميلاد.');
  const gender = clean(body.gender, 20);
  if (!['male', 'female', 'prefer_not'].includes(gender)) fail('اختر الجنس من الخيارات المتاحة.');
  const phone = jordanPhone(body.phone);
  if (body.accept_terms !== true) fail('يجب الموافقة على الشروط وسياسة الخصوصية.');
  const base = { first_name: firstName, father_name: fatherName, family_name: familyName, birth_date: birthDate, age, gender, phone };
  if (role !== 'teachers') return base;
  const qualifications = Array.isArray(body.qualifications) ? [...new Set(body.qualifications.map(String))] : [];
  if (!qualifications.length || qualifications.length > qualificationOptions.length || qualifications.some(value => !qualificationOptions.includes(value))) fail('اختر مؤهلاً واحداً على الأقل.');
  const otherQualification = qualifications.includes('أخرى') ? clean(body.other_qualification, 120, 2) : '';
  const yearsExperience = Number(body.years_experience);
  if (!Number.isInteger(yearsExperience) || yearsExperience < 0 || yearsExperience > 60) fail('تحقق من عدد سنوات الخبرة.');
  const languages = Array.isArray(body.teaching_languages) ? [...new Set(body.teaching_languages.map(String))] : [];
  if (!languages.length || languages.length > 5 || languages.some(value => !['العربية', 'الإنجليزية', 'الفرنسية', 'الألمانية', 'أخرى'].includes(value))) fail('اختر لغة تدريس واحدة على الأقل.');
  const nationalIdLast4 = clean(body.national_id_last4, 4);
  if (!/^\d{4}$/.test(nationalIdLast4)) fail('أدخل آخر 4 أرقام من الرقم الوطني.');
  const bio = clean(body.professional_bio, 800, 20);
  if (body.confirm_accuracy !== true || body.accept_teaching_policy !== true) fail('يجب تأكيد صحة البيانات والموافقة على سياسة التدريس.');
  return { ...base, qualifications, other_qualification: otherQualification, years_experience: yearsExperience, teaching_languages: languages, national_id_last4: nationalIdLast4, professional_bio: bio, verification_status: 'incomplete', submitted_at: 0, reviewed_at: 0, rejection_reason: '' };
}

export function parseVerification(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}
