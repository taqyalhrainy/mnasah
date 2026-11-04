import { useMemo, useState, type CSSProperties, type FormEvent, type MouseEvent } from 'react';
import { ArrowRight, ArrowUp, ArrowDown, GripVertical, ChevronLeft, GraduationCap, Image, Layers3, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { locale, t, usePreferences } from '../../i18n/preferences';
import { type CatalogData, type CatalogGroup, type Category, request } from '../../services/platformApi';

type Editor =
  | { kind: 'group'; item?: CatalogGroup }
  | { kind: 'stage'; item?: Category }
  | { kind: 'direct'; value?: string }
  | { kind: 'level'; value?: string }
  | { kind: 'subject'; value?: string };

const emptyCatalog: CatalogData = { groups: [], categories: [] };
const isImage = (value: string) => /^(?:https?:\/\/|data:image\/|\/)/i.test(value);

function VisualIcon({ value, fallback = '✨' }: { value?: string; fallback?: string }) {
  const icon = value?.trim() || fallback;
  return isImage(icon) ? <img src={icon} alt="" /> : <span>{icon}</span>;
}

export function CatalogPanel({ data, onChanged }: { data: CatalogData; onChanged: (data: CatalogData) => void }) {
  usePreferences();
  const [groupId, setGroupId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [level, setLevel] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragged, setDragged] = useState('');
  const [dropTarget, setDropTarget] = useState('');
  const [orderNotice, setOrderNotice] = useState('');
  const groups = data.groups || [];
  const categories = data.categories || [];
  const group = groups.find(item => item.id === groupId);
  const stages = categories.filter(item => (item.parentId || 'curriculum-other') === groupId);
  const category = categories.find(item => item.id === categoryId);
  const subjects = category ? (level === '__direct__' ? category.subjects : category.levelSubjects?.[level] || category.subjects) : [];
  const screen = !group ? 'groups' : !category ? 'stages' : !level ? 'levels' : 'subjects';
  const title = screen === 'groups' ? t('المناهج والتصنيفات') : screen === 'stages' ? t(group?.name || '') : screen === 'levels' ? t(category?.name.replace(/^.*?\|\s*/, '') || '') : t(level === '__direct__' ? category?.name || '' : level);
  const description = screen === 'groups' ? t('هذه هي الشاشة نفسها التي تظهر للطالب والأستاذ. عدّلها هنا وشاهد النتيجة مباشرة.') : screen === 'stages' ? t(group?.description || '') : screen === 'levels' ? t(category?.description || '') : t('المواد التي ستظهر في هذه الصفحة.');

  async function mutate(body: unknown) {
    setBusy(true); setError('');
    try {
      const result = await request<CatalogData>('admin/catalog', body);
      onChanged({ groups: result.groups || [], categories: result.categories || [] });
      return result;
    } catch (reason) { setError((reason as Error).message); return null; }
    finally { setBusy(false); }
  }
  const saveCategory = (item: Category, patch: Partial<Category>) => mutate({ action: 'save', ...item, ...patch, parentId: patch.parentId || item.parentId || groupId, levelSubjects: patch.levelSubjects || item.levelSubjects || {} });
  const stop = (event: MouseEvent) => event.stopPropagation();
  const back = () => {
    if (screen === 'subjects') setLevel('');
    else if (screen === 'levels') { setCategoryId(''); setLevel(''); }
    else if (screen === 'stages') setGroupId('');
  };
  const removeGroup = async (item: CatalogGroup) => {
    if (!window.confirm(t('حذف المنهاج {v0} وكل المراحل والصفوف والمواد داخله؟', { v0: item.name }))) return;
    if (await mutate({ action: 'delete-group', id: item.id })) { setGroupId(''); setCategoryId(''); setLevel(''); }
  };
  const removeStage = async (item: Category) => {
    if (!window.confirm(t('حذف المرحلة {v0} وكل الصفوف والمواد داخلها؟', { v0: item.name.replace(/^.*?\|\s*/, '') }))) return;
    if (await mutate({ action: 'delete', id: item.id })) { setCategoryId(''); setLevel(''); }
  };
  const removeLevel = async (value: string) => {
    if (!category || !window.confirm(t('حذف الصفحة {v0} والمواد المرتبطة بها؟', { v0: value }))) return;
    const nextMap = { ...(category.levelSubjects || {}) }; delete nextMap[value];
    await saveCategory(category, { levels: category.levels.filter(item => item !== value), levelSubjects: nextMap });
  };
  const removeSubject = async (value: string) => {
    if (!category || !window.confirm(t('حذف مادة {v0} من هذه الصفحة؟', { v0: value }))) return;
    if (level === '__direct__') await saveCategory(category, { subjects: category.subjects.filter(item => item !== value), levelSubjects: {} });
    else await saveCategory(category, { levelSubjects: { ...(category.levelSubjects || {}), [level]: subjects.filter(item => item !== value) } });
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor) return;
    const values = new FormData(event.currentTarget);
    const name = String(values.get('name') || '').trim();
    if (!name) return;
    if (editor.kind === 'group') {
      const result = await mutate({ action: 'save-group', id: editor.item?.id, name, description: values.get('description'), icon: values.get('icon') });
      if (result && !editor.item) setGroupId(result.groups.at(-1)?.id || '');
    } else if (editor.kind === 'direct') {
      const result = await mutate({ action: 'save', parentId: groupId, name, description: '', icon: group?.icon || '📚', levels: [], subjects: [name], levelSubjects: {} });
      if (!result) return;
    } else if (editor.kind === 'stage') {
      const item = editor.item;
      const result = await mutate({ action: 'save', id: item?.id, parentId: groupId, name, description: values.get('description'), icon: values.get('icon'), levels: item?.levels || [], subjects: item?.subjects || [], levelSubjects: item?.levelSubjects || {} });
      if (result && !item) setCategoryId(result.categories.filter(row => row.parentId === groupId).at(-1)?.id || '');
    } else if (editor.kind === 'level' && category) {
      const old = editor.value;
      const nextLevels = old ? category.levels.map(item => item === old ? name : item) : [...category.levels, name];
      const nextMap = { ...(category.levelSubjects || {}) };
      if (old && old !== name) { nextMap[name] = nextMap[old] || []; delete nextMap[old]; }
      else if (!old) nextMap[name] = [];
      if (await saveCategory(category, { levels: [...new Set(nextLevels)], levelSubjects: nextMap })) setLevel(name);
    } else if (editor.kind === 'subject' && category) {
      const old = editor.value;
      const next = [...new Set(old ? subjects.map(item => item === old ? name : item) : [...subjects, name])];
      if (level === '__direct__') await saveCategory(category, { subjects: next, levelSubjects: {} });
      else await saveCategory(category, { levelSubjects: { ...(category.levelSubjects || {}), [level]: next } });
    }
    setEditor(null);
  };

  const cards = useMemo(() => {
    if (screen === 'groups') return groups.map(item => ({ id: item.id, title: item.name, description: item.description, icon: item.icon, open: () => setGroupId(item.id), edit: () => setEditor({ kind: 'group', item }), remove: () => void removeGroup(item) }));
    if (screen === 'stages') return stages.map(item => ({ id: item.id, title: item.name.replace(/^.*?\|\s*/, ''), description: item.description, icon: item.icon, open: () => setCategoryId(item.id), edit: () => setEditor({ kind: 'stage', item }), remove: () => void removeStage(item) }));
    if (screen === 'levels') return (category?.levels || []).map(item => ({ id: item, title: item, description: t('{v0} مواد', { v0: category?.levelSubjects?.[item]?.length || 0 }), icon: '📖', open: () => setLevel(item), edit: () => setEditor({ kind: 'level', value: item }), remove: () => void removeLevel(item) }));
    return subjects.map(item => ({ id: item, title: item, description: t('مادة تعليمية'), icon: category?.icon || '📚', open: () => undefined, edit: () => setEditor({ kind: 'subject', value: item }), remove: () => void removeSubject(item) }));
  }, [screen, groups, stages, category, subjects]);

  const moveCard = async (id: string, target: number) => {
    if (busy) return;
    const ids = cards.map(card => card.id);
    const source = ids.indexOf(id);
    if (source < 0 || target < 0 || target >= ids.length || source === target) return;
    ids.splice(source, 1); ids.splice(target, 0, id);
    setDragged(''); setDropTarget(''); setOrderNotice('');
    const result = screen === 'groups' ? await mutate({ action: 'reorder-groups', ids })
      : screen === 'stages' ? await mutate({ action: 'reorder', parentId: groupId, ids })
      : category ? await saveCategory(category, screen === 'levels' ? { levels: ids }
        : level === '__direct__' ? { subjects: ids, levelSubjects: {} }
        : { levelSubjects: { ...(category.levelSubjects || {}), [level]: ids } }) : null;
    if (result) setOrderNotice(t('تم حفظ ترتيب البطاقات.'));
  };

  return <section className="catalog-studio">
    <header className="catalog-studio-head">
      <div><span><GraduationCap size={17} />{t('معاينة الأونر المباشرة')}</span><h2>{title}</h2><p>{description}</p></div>
      <div className="catalog-studio-actions">
        {screen !== 'groups' && <button type="button" className="secondary-button" onClick={back}><ArrowRight size={17} />{t('رجوع')}</button>}
        {screen === 'stages' && <button type="button" className="primary-button" disabled={busy} onClick={() => setEditor({ kind: 'direct' })}><Plus size={17} />{t('أضف حصة')}</button>}
        <button type="button" className="primary-button" disabled={busy} onClick={() => setEditor(screen === 'groups' ? { kind: 'group' } : screen === 'stages' ? { kind: 'stage' } : screen === 'levels' ? { kind: 'level' } : { kind: 'subject' })}><Plus size={17} />{t(screen === 'groups' ? 'إضافة منهاج' : screen === 'stages' ? 'إضافة مرحلة' : screen === 'levels' ? 'إضافة صف أو صفحة' : 'إضافة مادة')}</button>
      </div>
    </header>
    <div className="catalog-breadcrumbs"><button type="button" onClick={() => { setGroupId(''); setCategoryId(''); setLevel(''); }}>{t('المناهج')}</button>{group && <><ChevronLeft size={14} /><button type="button" onClick={() => { setCategoryId(''); setLevel(''); }}>{t(group.name)}</button></>}{category && <><ChevronLeft size={14} /><button type="button" onClick={() => setLevel('')}>{t(category.name.replace(/^.*?\|\s*/, ''))}</button></>}{level && <><ChevronLeft size={14} /><strong>{t(level === '__direct__' ? 'المواد' : level)}</strong></>}</div>
    {error && <p className="notice error" role="alert">{t(error)}</p>}
    {cards.length > 1 && <p className="catalog-order-help">{t('اسحب البطاقة من مقبضها، أو استخدم الأسهم ورقم الموضع لتغيير ترتيبها.')}</p>}
    {orderNotice && <p className="catalog-order-notice" role="status">{orderNotice}</p>}
    <div className="catalog-preview-stage">
      <div className="showcase-heading"><div><span>{t('كما ستظهر للمستخدم')}</span><h3>{title}</h3><p>{description}</p></div><small>{cards.length} {t('بطاقات')}</small></div>
      <div className="package-grid student-package-grid catalog-preview-grid">{cards.map((card, index) => <article className={`package-card catalog-preview-card ${dragged === card.id ? 'is-dragging' : ''} ${dropTarget === card.id ? 'is-drop-target' : ''}`} style={{ '--package-delay': `${Math.min(index, 12) * 45}ms` } as CSSProperties} key={card.id} onClick={card.open} onDragOver={event => { if (dragged && !busy) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(card.id); } }} onDrop={event => { event.preventDefault(); event.stopPropagation(); if (dragged) void moveCard(dragged, index); }}>
        <span className="package-icon"><VisualIcon value={card.icon} /></span><strong>{t(card.title)}</strong><small>{t(card.description)}</small>{screen !== 'subjects' && <ChevronLeft size={18} />}
        <span className="catalog-card-actions"><button type="button" title={t('تعديل')} onClick={event => { stop(event); card.edit(); }}><Pencil size={15} /></button><button type="button" title={t('حذف')} onClick={event => { stop(event); card.remove(); }}><Trash2 size={15} /></button></span>
        {cards.length > 1 && <div className="catalog-order-controls" onClick={stop}>
          <button className="catalog-drag-handle" type="button" disabled={busy} draggable={!busy} title={t('اسحب لتغيير الترتيب')} aria-label={t('اسحب بطاقة {v0}', { v0: card.title })} onDragStart={event => { event.stopPropagation(); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', card.id); setDragged(card.id); }} onDragEnd={() => { setDragged(''); setDropTarget(''); }}><GripVertical size={17} /></button>
          <button type="button" aria-label={t('تحريك {v0} للأعلى', { v0: card.title })} title={t('تحريك للأعلى')} disabled={busy || index === 0} onClick={() => void moveCard(card.id, index - 1)}><ArrowUp size={15} /></button>
          <button type="button" aria-label={t('تحريك {v0} للأسفل', { v0: card.title })} title={t('تحريك للأسفل')} disabled={busy || index === cards.length - 1} onClick={() => void moveCard(card.id, index + 1)}><ArrowDown size={15} /></button>
          <select aria-label={t('موضع بطاقة {v0}', { v0: card.title })} disabled={busy} value={index} onChange={event => void moveCard(card.id, Number(event.target.value))}>{cards.map((item, position) => <option value={position} key={item.id}>{(position + 1).toLocaleString(locale())}</option>)}</select>
        </div>}
      </article>)}
      {screen === 'stages' && <button type="button" className="catalog-empty-add" disabled={busy} onClick={() => setEditor({ kind: 'direct' })}><Plus size={26} /><strong>{t('أضف حصة مباشرة هنا')}</strong><small>{t('بدون إضافة مرحلة أو صف')}</small></button>}
      {screen === 'levels' && category && !category.levels.length && <button type="button" className="package-card catalog-direct-subjects" onClick={() => setLevel('__direct__')}><span className="package-icon"><Layers3 size={22} /></span><strong>{t('مواد مباشرة')}</strong><small>{t('استخدمها إذا لم يحتج هذا التصنيف إلى صفوف أو صفحات إضافية.')}</small><ChevronLeft size={18} /></button>}
      {!cards.length && !(screen === 'levels' && category && !category.levels.length) && <button type="button" className="catalog-empty-add" onClick={() => setEditor(screen === 'groups' ? { kind: 'group' } : screen === 'stages' ? { kind: 'stage' } : screen === 'levels' ? { kind: 'level' } : { kind: 'subject' })}><Plus size={26} /><strong>{t('ابدأ بإضافة أول بطاقة هنا')}</strong></button>}
      </div>
    </div>
    {screen === 'groups' && <button className="catalog-reset" type="button" disabled={busy} onClick={() => { if (window.confirm(t('استبدال التصنيفات الحالية بالمناهج الأساسية؟'))) void mutate({ action: 'install-core-curricula' }); }}><GraduationCap size={17} />{t('استعادة المناهج الأساسية')}</button>}
    {editor && <dialog className="detail-dialog catalog-editor-dialog" ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => setEditor(null)}>
      <header><div><span>{t('تعديل مباشر')}</span><h2>{t(editor.kind === 'group' ? (editor.item ? 'تعديل المنهاج' : 'منهاج جديد') : editor.kind === 'stage' ? (editor.item ? 'تعديل المرحلة' : 'مرحلة جديدة') : editor.kind === 'level' ? (editor.value ? 'تعديل الصف أو الصفحة' : 'صف أو صفحة جديدة') : (editor.value ? 'تعديل المادة' : 'مادة جديدة'))}</h2></div><button type="button" className="icon-button" onClick={() => setEditor(null)}><X size={19} /></button></header>
      <form className="work-form" onSubmit={submit}>
        <label>{t('الاسم')}<input name="name" defaultValue={editor.kind === 'group' || editor.kind === 'stage' ? editor.item?.name.replace(/^.*?\|\s*/, '') : editor.value || ''} maxLength={100} autoFocus required /></label>
        {(editor.kind === 'group' || editor.kind === 'stage') && <><label>{t('الوصف')}<textarea name="description" defaultValue={editor.item?.description || ''} maxLength={300} rows={3} /></label><label>{t('الأيقونة أو رابط الصورة')}<span className="catalog-icon-field"><Image size={18} /><input name="icon" defaultValue={editor.item?.icon || ''} maxLength={500} placeholder="📚 أو https://..." /></span><small>{t('يمكنك استخدام رمز تعبيري أو رابط صورة آمن.')}</small></label></>}
        <div className="row-actions"><button className="primary-button" disabled={busy}><Save size={17} />{t('حفظ')}</button><button type="button" className="secondary-button" onClick={() => setEditor(null)}><X size={17} />{t('إلغاء')}</button></div>
      </form>
    </dialog>}
  </section>;
}

export const emptyCatalogData = emptyCatalog;
