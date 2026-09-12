export const statement = (env, sql, ...values) => env.DB.prepare(sql).bind(...values);
export const one = (env, sql, ...values) => statement(env, sql, ...values).first();
export const all = async (env, sql, ...values) => (await statement(env, sql, ...values).all()).results;
export const run = (env, sql, ...values) => statement(env, sql, ...values).run();
export function fail(status, message) { throw Object.assign(new Error(message), { status }); }
export function field(value, max = 200, min = 1) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) fail(400, 'تحقق من الحقول المطلوبة وطول النص.');
  return value.trim();
}
export const auditEntry = (env, actor, action, target) => statement(env, 'INSERT INTO audit VALUES (?,?,?,?,?)', crypto.randomUUID(), actor, action, target, Date.now());
