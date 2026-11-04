import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { educationCatalog, educationGroups } from '../shared/jordan-catalog.js';
import { registrationProfile } from '../shared/verification.js';
test('new registrations accept male or female only', () => {
  const profile = { first_name: 'Test', father_name: 'Account', family_name: 'Student', birth_date: '2008-01-01', phone: '0791234567', accept_terms: true };
  for (const gender of ['male', 'female']) assert.equal(registrationProfile({ ...profile, gender }, 'students').gender, gender);
  assert.throws(() => registrationProfile({ ...profile, gender: 'prefer_not' }, 'students'));
});
test('all literal UI translations and bundled curriculum labels have English copy', () => {
  const dictionary = {};
  for (const name of ['messages', 'additionalMessages']) {
    const box = { exports: {} };
    vm.runInNewContext(ts.transpile(fs.readFileSync(`src/i18n/${name}.ts`, 'utf8'), { module: ts.ModuleKind.CommonJS }), box);
    Object.assign(dictionary, ...Object.values(box.exports));
  }
  const missing = new Set();
  const check = value => { if (typeof value === 'string' && /[\u0600-\u06ff]/.test(value) && !dictionary[value.trim()]) missing.add(value); };
  function walk(path) {
    for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
      const file = `${path}/${entry.name}`;
      if (entry.isDirectory()) { if (entry.name !== 'i18n') walk(file); continue; }
      if (!/\.tsx?$/.test(file)) continue;
      const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node) {
        if (ts.isCallExpression(node) && ['t', 'catalogText'].includes(node.expression.getText(tree))) {
          const inspect = child => { if (ts.isStringLiteralLike(child)) check(child.text); else ts.forEachChild(child, inspect); };
          if (node.arguments[0]) inspect(node.arguments[0]);
        }
        ts.forEachChild(node, visit);
      }
      visit(tree);
    }
  }
  walk('src');
  const catalog = value => { if (Array.isArray(value)) value.forEach(catalog); else if (value && typeof value === 'object') Object.values(value).forEach(catalog); else check(value); };
  catalog([educationGroups, educationCatalog]);
  assert.deepEqual([...missing], []);
});
