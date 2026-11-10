export function paymentDb() {
  const data = new Map(), indexes = new Map();
  let fault;
  const get = (row, key) => key.split('.').reduce((v, k) => v?.[k], row);
  const set = (row, key, value) => { const keys = key.split('.'); const last = keys.pop(); for (const part of keys) row = row[part] ||= {}; row[last] = structuredClone(value); };
  const match = (row, query) => Object.entries(query).every(([key, value]) => {
    if (key === '$or') return value.some(q => match(row, q));
    const current = get(row, key);
    if (value && typeof value === 'object') return Object.entries(value).every(([op, v]) => op === '$ne' ? current !== v : op === '$exists' ? (current !== undefined) === v : op === '$in' ? v.includes(current) : op === '$gte' ? current >= v : op === '$gt' ? current > v : op === '$lt' ? current < v : op === '$lte' ? current <= v : (() => { throw new Error(op); })());
    return current === value;
  });
  const collection = name => {
    if (!data.has(name)) data.set(name, []);
    const rows = data.get(name);
    const validate = (candidate, old) => { for (const index of indexes.get(name) || []) { const keys = Object.keys(index.keys); if (index.sparse && keys.every(k => get(candidate, k) === undefined)) continue; if (rows.some(row => row !== old && keys.every(k => get(row, k) === get(candidate, k)))) throw Object.assign(new Error('duplicate'), { code: 11000 }); } };
    return {
      async createIndex(keys, options = {}) { if (options.unique) { const list = indexes.get(name) || []; list.push({ keys, ...options }); indexes.set(name, list); } },
      async findOne(query = {}) { return structuredClone(rows.find(row => match(row, query)) || null); },
      find(query = {}) { let selected = rows.filter(row => match(row, query)); const cursor = { sort(order) { selected.sort((a, b) => { for (const [key, direction] of Object.entries(order)) if (get(a, key) !== get(b, key)) return (get(a, key) > get(b, key) ? 1 : -1) * direction; return 0; }); return cursor; }, limit(n) { selected = selected.slice(0, n); return cursor; }, async toArray() { return structuredClone(selected); } }; return cursor; },
      async insertOne(row) { validate(row); rows.push(structuredClone(row)); },
      async updateOne(query, update, options = {}) {
        if (fault?.(name, query, update)) { fault = undefined; throw new Error('simulated storage failure'); }
        const old = rows.find(row => match(row, query));
        if (!old && !options.upsert) return { modifiedCount: 0 };
        const row = old ? structuredClone(old) : { ...structuredClone(query), ...structuredClone(update.$setOnInsert || {}) };
        for (const [key, value] of Object.entries(update.$set || {})) set(row, key, value);
        for (const [key, value] of Object.entries(update.$inc || {})) set(row, key, Number(get(row, key) || 0) + value);
        validate(row, old);
        if (old) Object.assign(old, row); else rows.push(row);
        return { modifiedCount: 1, upsertedCount: old ? 0 : 1 };
      },
      async deleteOne(query) { const i = rows.findIndex(row => match(row, query)); if (i >= 0) rows.splice(i, 1); },
    };
  };
  return { collection, failOnce(predicate) { fault = predicate; } };
}

const user = { id: 'paypal-student', role: 'students', status: 'active', name: 'Student' };