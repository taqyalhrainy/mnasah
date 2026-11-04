import { all, run, statement, field, fail, auditEntry } from './db.js';
import { educationCatalog, educationGroups } from '../shared/jordan-catalog.js';

const catalogDefinitions = new Map(educationCatalog.map(item => [item.id, item]));
const parseJson = (value, fallback) => { try { const parsed = JSON.parse(value || ''); return parsed && typeof parsed === 'object' ? parsed : fallback; } catch { return fallback; } };
const list = value => {
  if (!Array.isArray(value) || value.length > 100) fail(400, 'تحقق من المستويات والمواد.');
  return [...new Set(value.map(item => field(item, 100)))];
};

async function ensureGroups(env) {
  const existing = await all(env, "SELECT id FROM catalog WHERE kind='group' LIMIT 1");
  if (existing.length) return;
  const created = Date.now();
  await env.DB.batch([
    ...educationGroups.map((item, position) => statement(env, "INSERT OR IGNORE INTO catalog (name,description,icon,levels,subjects,level_subjects,id,kind,parent_id,position,created) VALUES (?,?,?,?,?,?,?,'group','',?,?)", item.name, item.description, item.icon, '[]', '[]', '{}', item.id, position, created)),
    statement(env, "UPDATE catalog SET parent_id='curriculum-jordan' WHERE kind='category' AND (id='jordan' OR id LIKE 'jordan-%') AND parent_id=''"),
    statement(env, "UPDATE catalog SET parent_id='curriculum-international' WHERE kind='category' AND id LIKE 'cambridge-%' AND parent_id=''"),
    statement(env, "UPDATE catalog SET parent_id='curriculum-other' WHERE kind='category' AND parent_id=''"),
  ]);
}

async function result(env) {
  const groups = await all(env, "SELECT id,name,description,icon,position FROM catalog WHERE kind='group' ORDER BY position,id");
  const rows = await all(env, "SELECT id,parent_id,name,description,icon,levels,subjects,level_subjects FROM catalog WHERE kind='category' ORDER BY position,id");
  return {
    groups,
    categories: rows.map(row => {
      const levels = parseJson(row.levels, []), subjects = parseJson(row.subjects, []);
      const stored = parseJson(row.level_subjects, null);
      return { ...row, parentId: row.parent_id || 'curriculum-other', levels, subjects, levelSubjects: stored || catalogDefinitions.get(row.id)?.levelSubjects || Object.fromEntries(levels.map(level => [level, subjects])) };
    }),
  };
}

export async function catalog(env, user, write, body) {
  await ensureGroups(env);
  if (write) {
    if (user.role !== 'admin') fail(403, 'تعديل التصنيفات متاح للإدارة فقط.');
    const rows = await all(env, "SELECT id FROM catalog WHERE kind='category' ORDER BY position,id");
    if (['install-core-curricula', 'install-jordan-curriculum'].includes(body.action)) {
      const created = Date.now();
      await env.DB.batch([
        statement(env, "DELETE FROM catalog WHERE kind IN ('group','category')"),
        ...educationGroups.map((item, position) => statement(env, "INSERT INTO catalog (name,description,icon,levels,subjects,level_subjects,id,kind,parent_id,position,created) VALUES (?,?,?,?,?,?,?,'group','',?,?)", item.name, item.description, item.icon, '[]', '[]', '{}', item.id, position, created)),
        ...educationCatalog.map((item, position) => statement(env, "INSERT INTO catalog (name,description,icon,levels,subjects,level_subjects,id,kind,parent_id,position,created) VALUES (?,?,?,?,?,?,?,'category',?,?,?)", item.name, item.description, item.icon, JSON.stringify(item.levels), JSON.stringify(item.subjects), JSON.stringify(item.levelSubjects), item.id, item.parentId, position, created)),
        auditEntry(env, user.id, 'catalog:install-core-curricula', 'categories'),
      ]);
    } else if (body.action === 'reorder') {
      const ids = body.ids;
      if (!Array.isArray(ids) || ids.length !== rows.length || new Set(ids).size !== ids.length || ids.some(id => !rows.some(row => row.id === id))) fail(409, 'تغيّرت التصنيفات. حدّث الصفحة وأعد المحاولة.');
      await env.DB.batch([...ids.map((id, index) => statement(env, 'UPDATE catalog SET position=? WHERE id=?', index, id)), auditEntry(env, user.id, 'catalog:reorder', 'categories')]);
    } else if (body.action === 'save-group') {
      const values = [field(body.name, 100), field(body.description || '', 300, 0), field(body.icon || '✨', 500, 0)];
      if (body.id) {
        const existing = await all(env, "SELECT id FROM catalog WHERE id=? AND kind='group'", body.id);
        if (!existing.length) fail(404, 'المنهاج غير موجود.');
        await run(env, "UPDATE catalog SET name=?,description=?,icon=? WHERE id=? AND kind='group'", ...values, body.id);
      } else await run(env, "INSERT INTO catalog (name,description,icon,levels,subjects,level_subjects,id,kind,parent_id,position,created) VALUES (?,?,?,'[]','[]','{}',?,'group','',(SELECT COALESCE(MAX(position),-1)+1 FROM catalog WHERE kind='group'),?)", ...values, crypto.randomUUID(), Date.now());
      await run(env, 'INSERT INTO audit (id,actor,action,target,created) VALUES (?,?,?,?,?)', crypto.randomUUID(), user.id, 'catalog:save-group', body.id || 'new', Date.now());
    } else if (body.action === 'delete-group') {
      const id = field(body.id, 100);
      await env.DB.batch([statement(env, "DELETE FROM catalog WHERE kind='category' AND parent_id=?", id), statement(env, "DELETE FROM catalog WHERE kind='group' AND id=?", id), auditEntry(env, user.id, 'catalog:delete-group', id)]);
    } else if (body.action === 'delete') {
      if (!rows.some(row => row.id === body.id)) fail(404, 'التصنيف غير موجود.');
      await env.DB.batch([statement(env, "DELETE FROM catalog WHERE id=? AND kind='category'", body.id), auditEntry(env, user.id, 'catalog:delete', body.id)]);
    } else if (body.action === 'save') {
      const id = body.id || crypto.randomUUID();
      if (body.id && !rows.some(row => row.id === id)) fail(404, 'التصنيف غير موجود.');
      const groups = await all(env, "SELECT id FROM catalog WHERE kind='group' ORDER BY position,id");
      const parentId = field(body.parentId || groups[0]?.id || 'curriculum-other', 100);
      if (!groups.some(group => group.id === parentId)) fail(400, 'اختر منهاجاً صحيحاً لهذه المرحلة.');
      const levels = list(body.levels), directSubjects = list(body.subjects);
      const source = body.levelSubjects && typeof body.levelSubjects === 'object' && !Array.isArray(body.levelSubjects) ? body.levelSubjects : {};
      const levelSubjects = Object.fromEntries(levels.map(level => [level, list(source[level] || directSubjects)]));
      const subjects = levels.length ? [...new Set(Object.values(levelSubjects).flat())] : directSubjects;
      const values = [parentId, field(body.name, 100), field(body.description || '', 300, 0), field(body.icon || '', 500, 0), JSON.stringify(levels), JSON.stringify(subjects), JSON.stringify(levelSubjects)];
      if (body.id) await run(env, "UPDATE catalog SET parent_id=?,name=?,description=?,icon=?,levels=?,subjects=?,level_subjects=? WHERE id=? AND kind='category'", ...values, id);
      else await run(env, "INSERT INTO catalog (parent_id,name,description,icon,levels,subjects,level_subjects,id,kind,position,created) VALUES (?,?,?,?,?,?,?,?,'category',(SELECT COALESCE(MAX(position),-1)+1 FROM catalog WHERE kind='category'),?)", ...values, id, Date.now());
    } else fail(400, 'عملية غير صحيحة.');
  }
  return result(env);
}
