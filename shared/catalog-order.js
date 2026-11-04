export function validCatalogOrder(ids, rows) {
  const expected = new Set(rows.map(row => row.id));
  return Array.isArray(ids) && ids.length === rows.length && new Set(ids).size === ids.length && ids.every(id => typeof id === 'string' && expected.has(id));
}
