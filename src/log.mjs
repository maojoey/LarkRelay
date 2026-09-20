// 单行 JSON 到 stdout，交给 Docker 的 json-file（已封顶 10m×3）。
// 脱敏是硬要求：app_secret / admin_token 一旦进日志就等于进了备份与我的上下文。
const SECRET_RE = /^(app_secret|admin_token|encrypt_key|verification_token|authorization|token|secret|password)$/i;

function scrub(v, key = '') {
  if (typeof v === 'string' && SECRET_RE.test(key)) return `<redacted len=${v.length}>`;
  if (Array.isArray(v)) return v.map((x) => scrub(x));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = scrub(val, k);
    return o;
  }
  return v;
}

function emit(level, msg, fields) {
  const line = { t: new Date().toISOString(), level, msg, ...scrub(fields ?? {}) };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

export const log = {
  info: (msg, f) => emit('info', msg, f),
  warn: (msg, f) => emit('warn', msg, f),
  error: (msg, f) => emit('error', msg, f),
};
