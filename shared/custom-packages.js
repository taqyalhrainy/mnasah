const clean = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';

export function parseCustomPackages(value) {
  let source = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch { source = []; }
  }
  if (!Array.isArray(source)) return [];
  return source.slice(0, 24).map((item, index) => ({
    id: clean(item?.id, 80) || `custom-${index}`,
    name: clean(item?.name, 80),
    description: clean(item?.description, 240),
    levels: Array.isArray(item?.levels) ? [...new Set(item.levels.map(level => clean(level, 80)).filter(Boolean))].slice(0, 30) : [],
  })).filter(item => item.name);
}

export const serializeCustomPackages = value => JSON.stringify(parseCustomPackages(value));
