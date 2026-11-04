import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTeachingChoices, serializeTeachingChoices } from '../src/features/portal/teachingChoices';

const catalog = [
  { id: 'basic', name: 'المنهاج الأردني | الأساسي', description: '', icon: '', subjects: ['الرياضيات', 'العربية'], levels: ['الصف الأول', 'الصف الثاني'] },
  { id: 'international', name: 'البريطاني والدولي | IGCSE / O Level', description: '', icon: '', subjects: ['الرياضيات'], levels: ['Year 10', 'Year 11'] },
];
test('previously saved choices survive category separators and multiple curricula', () => {
  const saved = 'المنهاج الأردني | الأساسي › الرياضيات › الصف الثاني | البريطاني والدولي | IGCSE / O Level › الرياضيات › Year 10، Year 11';
  const choices = parseTeachingChoices(saved, catalog);
  assert.deepEqual(choices.map(item => [item.categoryId, item.subject, item.levels]), [
    ['basic', 'الرياضيات', ['الصف الثاني']], ['international', 'الرياضيات', ['Year 10', 'Year 11']],
  ]);
  assert.deepEqual(parseTeachingChoices(serializeTeachingChoices(choices), catalog), choices);
});
test('legacy subjects still restore and unselected grades stay unchecked', () => {
  assert.deepEqual(parseTeachingChoices('العربية - الصف الأول', catalog)[0].levels, ['الصف الأول']);
  assert.deepEqual(parseTeachingChoices('', catalog), []);
});
