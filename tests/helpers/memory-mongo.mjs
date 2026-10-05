// In-memory implementation of the Mongo operations exercised by the service.
// It permits isolated API/socket/browser tests without production accounts.
import assert from 'node:assert/strict';
const get = (item, key) => key.split('.').reduce((value, part) => value?.[part], item);
function matches(item, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some(part => matches(item, part));
    const current = get(item, key);
    if (value && typeof value === 'object' && !Array.isArray(value)) return Object.entries(value).every(([operator, expected]) => {
      if (operator === '$gt') return current > expected;
      if (operator === '$gte') return current >= expected;
      if (operator === '$lt') return current < expected;
      if (operator === '$ne') return current !== expected;
      if (operator === '$in') return expected.includes(current);
      throw new Error(`Unsupported operator ${operator}`);
    });
    return current === value;
  });
}
function projection(item, fields = {}) {
  const copy = structuredClone(item);
  const included = Object.entries(fields).filter(([key, value]) => value === 1 && key !== '_id');
  if (included.length) return Object.fromEntries(included.map(([key]) => [key, get(copy, key)]));
  for (const [key, value] of Object.entries(fields)) if (!value) delete copy[key];
  return copy;
}
export function memoryMongo(seed = {}) {
  const data = new Map(Object.entries(seed).map(([key, value]) => [key, structuredClone(value)]));
  const collection = name => {
    if (!data.has(name)) data.set(name, []);
    const rows = data.get(name);
    return {
      async findOne(filter, options = {}) { const found = rows.find(row => matches(row, filter)); return found ? projection(found, options.projection) : null; },
      find(filter = {}, options = {}) {
        let selected = rows.filter(row => matches(row, filter));
        const cursor = {
          sort(sort) { selected.sort((a, b) => { for (const [key, direction] of Object.entries(sort)) { if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * direction; } return 0; }); return cursor; },
          limit(count) { selected = selected.slice(0, count); return cursor; },
          async toArray() { return selected.map(row => projection(row, options.projection)); },
        }; return cursor;
      },
      async countDocuments(filter = {}) { return rows.filter(row => matches(row, filter)).length; },
      async insertOne(row) { assert.ok(!row.id || !rows.some(existing => existing.id === row.id), 'duplicate id'); rows.push(structuredClone(row)); },
      async insertMany(inserted) { for (const row of inserted) await this.insertOne(row); },
      async updateOne(filter, update, options = {}) {
        let row = rows.find(item => matches(item, filter)); let inserted = false;
        if (!row && options.upsert) { row = { ...filter, ...structuredClone(update.$setOnInsert || {}) }; rows.push(row); inserted = true; }
        if (!row) return { modifiedCount: 0 };
        Object.assign(row, structuredClone(update.$set || {}));
        for (const [key, value] of Object.entries(update.$max || {})) row[key] = Math.max(row[key] || 0, value);
        for (const key of Object.keys(update.$unset || {})) delete row[key];
        return { modifiedCount: 1, upsertedCount: inserted ? 1 : 0 };
      },
      async deleteOne(filter) { const index = rows.findIndex(row => matches(row, filter)); if (index >= 0) rows.splice(index, 1); },
      async deleteMany(filter) { for (let index = rows.length - 1; index >= 0; index--) if (matches(rows[index], filter)) rows.splice(index, 1); },
      async createIndex() {},
      aggregate(stages) {
        let selected = structuredClone(rows);
        for (const stage of stages) {
          if (stage.$match) selected = selected.filter(row => matches(row, stage.$match));
          else if (stage.$lookup) {
            const { from, localField, foreignField, as } = stage.$lookup;
            selected = selected.map(row => ({ ...row, [as]: (data.get(from) || []).filter(foreign => get(foreign, foreignField) === get(row, localField)) }));
          } else if (stage.$unwind) {
            const key = stage.$unwind.slice(1); selected = selected.flatMap(row => row[key].map(value => ({ ...row, [key]: value })));
          } else if (stage.$group) {
            const groups = selected.map(row => ({ _id: Object.fromEntries(Object.entries(stage.$group._id).map(([key, value]) => [key, get(row, value.slice(1))])) }));
            selected = [...new Map(groups.map(row => [JSON.stringify(row._id), row])).values()];
          } else if (stage.$replaceRoot) selected = selected.map(row => get(row, stage.$replaceRoot.newRoot.slice(1)));
          else throw new Error('Unsupported aggregation stage');
        }
        return { async toArray() { return selected; } };
      },
    };
  };
  return { collection };
}
