// Xác thực của hub: băm mật khẩu (scrypt), token ngẫu nhiên (lưu SHA-256), tên đăng nhập, khoá khi sai nhiều lần.
const crypto = require('crypto');

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function scrypt(pw, salt, opts) {
  return new Promise((resolve, reject) => crypto.scrypt(String(pw).normalize('NFC'), salt, KEYLEN, opts,
    (err, key) => (err ? reject(err) : resolve(key))));
}

// "scrypt$N$r$p$saltB64$hashB64"
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(pw, stored) {
  const [kind, N, r, p, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const key = await scrypt(pw, Buffer.from(salt, 'base64'), { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}

// 32 byte ngẫu nhiên; DB chỉ giữ hash.
function newToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: sha(token) };
}

// Tên đăng nhập: chữ thường, số, _ . - (3–32 ký tự); không hợp lệ -> null.
function normUser(name) {
  const u = String(name || '').trim().toLowerCase();
  return /^[a-z0-9_.-]{3,32}$/.test(u) ? u : null;
}

// Sai 5 lần trong 15 phút (theo khoá tên|IP) -> chặn 15 phút kể từ lần sai cuối.
const WINDOW = 15 * 60e3, MAX_FAILS = 5;
class Limiter {
  constructor() { this.m = new Map(); }
  recent(key, now) { return (this.m.get(key) || []).filter((t) => now - t < WINDOW); }
  blocked(key, now = Date.now()) { return this.recent(key, now).length >= MAX_FAILS; }
  fail(key, now = Date.now()) {
    const list = this.recent(key, now);
    list.push(now);
    this.m.set(key, list);
    if (this.m.size > 10000) for (const [k, v] of this.m) if (!v.some((t) => now - t < WINDOW)) this.m.delete(k);
  }
  ok(key) { this.m.delete(key); }
}

module.exports = { sha, hashPassword, verifyPassword, newToken, normUser, Limiter };
