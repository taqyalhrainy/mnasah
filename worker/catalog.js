import { all, run, statement, field, fail, auditEntry } from './db.js';

export async function catalog(env, user, write, body) {
  if (write) {
    if (user.role !== 'admin') fail(403, 'تعديل التصنيفات متاح للإدارة فقط.');
    const rows = await all(env, "SELECT id FROM catalog WHERE kind='category' ORDER BY position,id");
    if (body.action === 'reorder') {
      const ids = body.ids;
      if (!Array.isArray(ids) || ids.length !== rows.length || new Set(ids).size !== ids.length || ids.some(id => !rows.some(row => row.id === id))) fail(409, 'تغيّرت التصنيفات. حدّث الصفحة وأعد المحاولة.');
      await env.DB.batch([...ids.map((id, index) => statement(env, 'UPDATE catalog SET position=? WHERE id=?', index, id)), auditEntry(env, user.id, 'catalog:reorder', 'categories')]);
    } else if (body.action === 'delete') {
      if (!rows.some(row => row.id === body.id)) fail(404, 'التصنيف غير موجود.');
      await env.DB.batch([statement(env, "DELETE FROM catalog WHERE id=? AND kind='category'", body.id), auditEntry(env, user.id, 'catalog:delete', body.id)]);
    } else if (body.action === 'save') {
      const id = body.id || crypto.randomUUID();
      if (body.id && !rows.some(row => row.id === id)) fail(404, 'التصنيف غير موجود.');
      const list = value => {
        if (!Array.isArray(value) || value.length > 100) fail(400, 'تحقق من المستويات والمواد.');
        return JSON.stringify([...new Set(value.map(item => field(item, 100)))]);
      };
      const values = [field(body.name, 100), field(body.description, 300, 0), field(body.icon, 20, 0), list(body.levels), list(body.subjects)];
      if (body.id) await run(env, "UPDATE catalog SET name=?,description=?,icon=?,levels=?,subjects=? WHERE id=? AND kind='category'", ...values, id);
      else await run(env, "INSERT INTO catalog (name,description,icon,levels,subjects,id,kind,position,created) VALUES (?,?,?,?,?,?,'category',(SELECT COALESCE(MAX(position),-1)+1 FROM catalog),?)", ...values, id, Date.now());
    } else fail(400, 'عملية غير صحيحة.');
  }
  return { categories: (await all(env, "SELECT id,name,description,icon,levels,subjects FROM catalog WHERE kind='category' ORDER BY position,id")).map(row => ({ ...row, levels: JSON.parse(row.levels), subjects: JSON.parse(row.subjects) })) };
}
