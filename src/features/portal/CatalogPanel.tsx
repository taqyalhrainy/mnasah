import { useState } from 'react';
import { ArrowUp, ArrowDown, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { type Category, request } from '../../services/platformApi';

export function CatalogPanel({ categories, onChanged }: { categories: Category[]; onChanged: (categories: Category[]) => void }) {
  const [editing, setEditing] = useState<Category | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function mutate(body: unknown) {
    setBusy(true); setError('');
    try { const result = await request<{ categories: Category[] }>('admin/catalog', body); onChanged(result.categories); return true; }
    catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  }
  function move(index: number, direction: number) {
    const ids = categories.map(category => category.id);
    [ids[index], ids[index + direction]] = [ids[index + direction], ids[index]];
    void mutate({ action: 'reorder', ids });
  }
  return <section>
    <div className="section-heading"><h2>بطاقات التصنيفات</h2><button className="primary-button" disabled={busy} onClick={() => setEditing({ id: '', name: '', description: '', icon: '', levels: [], subjects: [] })}><Plus size={18} />إضافة بطاقة</button></div>
    {error && <p className="notice error" role="alert">{error}</p>}
    {editing && <form className="work-form" key={editing.id} onSubmit={async event => {
      event.preventDefault(); const data = new FormData(event.currentTarget);
      const lines = (key: string) => String(data.get(key) || '').split('\n').map(value => value.trim()).filter(Boolean);
      if (await mutate({ action: 'save', id: editing.id, name: data.get('name'), description: data.get('description'), icon: data.get('icon'), levels: lines('levels'), subjects: lines('subjects') })) setEditing(null);
    }}>
      <h3>{editing.id ? 'تعديل البطاقة' : 'بطاقة جديدة'}</h3>
      <label>الاسم<input name="name" defaultValue={editing.name} maxLength={100} required /></label>
      <label>الوصف<input name="description" defaultValue={editing.description} maxLength={300} /></label>
      <label>الرمز<input name="icon" defaultValue={editing.icon} maxLength={20} /></label>
      <label>المستويات (كل مستوى بسطر)<textarea name="levels" defaultValue={editing.levels.join('\n')} rows={4} /></label>
      <label>المواد (كل مادة بسطر)<textarea name="subjects" defaultValue={editing.subjects.join('\n')} rows={4} /></label>
      <div className="row-actions"><button className="primary-button" disabled={busy}><Save size={18} />حفظ</button><button type="button" className="secondary-button" disabled={busy} onClick={() => setEditing(null)}><X size={18} />إلغاء</button></div>
    </form>}
    {!categories.length && <p>لا توجد تصنيفات. أضف بطاقة للبدء.</p>}
    <div className="booking-list">{categories.map((category, index) => <article className="booking-row" key={category.id}>
      <div><h3>{category.icon} {category.name}</h3><p>{category.description}</p></div>
      <div className="row-actions">
        <button className="icon-button" title="تحريك لأعلى" disabled={busy || index === 0} onClick={() => move(index, -1)}><ArrowUp size={18} /></button>
        <button className="icon-button" title="تحريك لأسفل" disabled={busy || index === categories.length - 1} onClick={() => move(index, 1)}><ArrowDown size={18} /></button>
        <button className="icon-button" title="تعديل البطاقة" disabled={busy} onClick={() => setEditing(category)}><Pencil size={18} /></button>
        <button className="icon-button" title="حذف البطاقة" disabled={busy} onClick={async () => { if (window.confirm(`حذف بطاقة ${category.name}؟ لن تتأثر الحجوزات السابقة.`) && await mutate({ action: 'delete', id: category.id })) setEditing(null); }}><Trash2 size={18} /></button>
      </div>
    </article>)}</div>
  </section>;
}
