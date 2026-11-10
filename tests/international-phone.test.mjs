import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone } from '../shared/phone.js';
import { registrationProfile } from '../shared/verification.js';

test('international phones normalize and validate Sweden, Jordan and country-specific lengths', () => {
  assert.equal(normalizePhone('079 123 4567'), '+962791234567');
  assert.equal(normalizePhone('962791234567'), '+962791234567');
  assert.equal(normalizePhone('+46 70 123 45 67'), '+46701234567');
  assert.equal(normalizePhone('0046 70 123 45 67'), '+46701234567');
  assert.equal(normalizePhone('0701234567', 'SE'), '+46701234567');
  assert.equal(normalizePhone('٠٧٩١٢٣٤٥٦٧'), '+962791234567');
  for (const value of ['+4670', '+99912345678', 'phone: +46701234567', '+46701234567 ext123', '+46 123456789012345']) assert.equal(normalizePhone(value), '');
});
test('student and teacher registration accept international contact numbers', () => {
  const base = { first_name: 'Test', father_name: 'Father', family_name: 'Student', birth_date: '2000-06-15', gender: 'male', phone: '+46701234567', accept_terms: true };
  assert.equal(registrationProfile(base, 'students').phone, '+46701234567');
  const teacher = registrationProfile({ ...base, qualifications: ['بكالوريوس'], teaching_languages: ['العربية'], professional_bio: 'Professional teacher with many years of experience', years_experience: 5, confirm_accuracy: true, accept_teaching_policy: true }, 'teachers');
  assert.equal(teacher.phone, '+46701234567');
});
