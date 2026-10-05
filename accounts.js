// Nhiều tài khoản Claude: lưu đăng nhập của từng tài khoản thành "hồ sơ" và đổi qua lại
// bằng cách thay đúng các trường đăng nhập trong file của chính Claude Code
// (.credentials.json: claudeAiOauth + organizationUuid; .claude.json: oauthAccount).
//
// Module này chỉ chứa phần nền: đường dẫn, đọc/kiểm tra, hồ sơ, ghi atomic, sao lưu, khoá.
// Không bao giờ ghi accessToken/refreshToken ra log hay API (xem publicView).

const fs = require('fs');
const os = require('os');
const path = require('path');

const BACKUP_KEEP = 5;            // số cặp sao lưu giữ lại
const LOCK_TTL_MS = 30e3;         // khoá hết hạn sau 30 giây
const WRITE_RETRIES = 5;          // số lần thử lại khi Windows khoá file
const WRITE_RETRY_MS = 100;
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

class AccountError extends Error {
  // code: FORMAT | NOT_FOUND | AMBIGUOUS | LOCKED | NO_TOKEN | WRITE_FAILED | ACTIVE
  constructor(code, message, options) {
    super(message || code, options);
    this.name = 'AccountError';
    this.code = code;
  }
}

// ---------- đường dẫn (tính lại mỗi lần gọi để test đổi được env) ----------

function paths() {
  const cfgDir = process.env.CLAUDE_CONFIG_DIR;
  const claudeDir = cfgDir || path.join(os.homedir(), '.claude');
  // Không đặt CLAUDE_CONFIG_DIR thì .claude.json nằm ở thư mục home, không phải trong ~/.claude.
  const claudeJson = cfgDir ? path.join(cfgDir, '.claude.json') : path.join(os.homedir(), '.claude.json');
  const profilesDir = path.join(claudeDir, 'account-profiles');
  const dataDir = process.env.TT_DATA_DIR || path.join(__dirname, 'data');
  return {
    claudeDir,
    credFile: path.join(claudeDir, '.credentials.json'),
    claudeJson,
    profilesDir,
    backupDir: path.join(profilesDir, 'backup'),
    lockFile: path.join(profilesDir, '.lock'),
    logFile: path.join(dataDir, 'account-log.json'),
  };
}

// ---------- đọc / ghi file ----------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v !== '';

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Đọc file JSON dạng object. Không có file -> {}; hỏng hoặc không phải object -> FORMAT.
function readObject(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new AccountError('FORMAT', `Không đọc được ${path.basename(file)}: ${e.message}`, { cause: e });
  }
  let obj;
  try { obj = JSON.parse(text.replace(/^﻿/, '')); } catch (e) {
    throw new AccountError('FORMAT', `${path.basename(file)} không phải JSON hợp lệ`, { cause: e });
  }
  if (!isObj(obj)) throw new AccountError('FORMAT', `${path.basename(file)} không phải một object JSON`);
  return obj;
}

// Ghi atomic: file tạm cùng thư mục rồi đổi tên. Windows có thể khoá file tạm thời
// (EPERM/EBUSY/EACCES) nên thử lại vài lần trước khi bỏ cuộc.
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(tmp, file); return; } catch (e) {
        if (!RETRY_CODES.has(e.code) || attempt >= WRITE_RETRIES) throw e;
        sleepSync(WRITE_RETRY_MS);
      }
    }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw new AccountError('WRITE_FAILED', `Không ghi được ${path.basename(file)}: ${e.message}`, { cause: e });
  }
}

// ---------- đọc đăng nhập hiện tại ----------

// -> { cred, cfg, id, org }. id = null khi chưa đăng nhập (không có claudeAiOauth hoặc không có file).
function readLogin() {
  const p = paths();
  const cred = readObject(p.credFile);
  const cfg = readObject(p.claudeJson);
  const oauth = cred.claudeAiOauth;
  if (oauth === undefined || oauth === null) return { cred, cfg, id: null, org: null };

  if (!isObj(oauth) || !isStr(oauth.accessToken) || !isStr(oauth.refreshToken)) {
    throw new AccountError('FORMAT', '.credentials.json: claudeAiOauth thiếu accessToken/refreshToken');
  }
  const acct = cfg.oauthAccount;
  if (!isObj(acct) || !isStr(acct.accountUuid)) {
    throw new AccountError('FORMAT', '.claude.json: thiếu oauthAccount.accountUuid');
  }
  if (isStr(acct.organizationUuid) && isStr(cred.organizationUuid) && acct.organizationUuid !== cred.organizationUuid) {
    throw new AccountError('FORMAT', 'organizationUuid ở .claude.json và .credentials.json không khớp');
  }
  const org = (isStr(cred.organizationUuid) && cred.organizationUuid) || (isStr(acct.organizationUuid) && acct.organizationUuid) || null;
  return { cred, cfg, id: acct.accountUuid, org };
}

// ---------- hồ sơ ----------

// Tên mặc định = phần trước @ của email.
const defaultName = (email) => String(email || '').split('@')[0] || 'account';

// Dựng hồ sơ từ đăng nhập hiện tại; giữ name của hồ sơ cũ.
// usage lấy từ file nếu thuộc đúng tài khoản này, ngược lại giữ usage cũ.
function profileFromLogin(login, existing, now) {
  if (!login || !login.id) throw new AccountError('NO_TOKEN', 'Chưa đăng nhập, không có gì để lưu');
  const oauth = login.cred.claudeAiOauth;
  const oauthAccount = login.cfg.oauthAccount;
  const cached = login.cfg.cachedUsageUtilization;
  const usage = isObj(cached) && cached.accountUuid === login.id ? cached : (existing?.usage ?? null);
  const email = oauthAccount.emailAddress || '';
  return {
    v: 1,
    id: login.id,
    name: existing?.name ?? defaultName(email),
    email,
    plan: oauth.subscriptionType || '',
    oauth,
    organizationUuid: login.org,
    oauthAccount,
    usage,
    savedAt: now,
  };
}

// id dùng làm tên file nên chỉ nhận ký tự an toàn (chặn ../).
const safeId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(id);

function profileFile(id) {
  if (!safeId(id)) throw new AccountError('FORMAT', `id hồ sơ không hợp lệ: ${id}`);
  return path.join(paths().profilesDir, `${id}.json`);
}

function loadProfile(id) {
  if (!safeId(id)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(profileFile(id), 'utf8'));
    return isObj(obj) && obj.id === id ? obj : null;
  } catch { return null; }
}

function saveProfile(p) {
  writeAtomic(profileFile(p.id), JSON.stringify(p, null, 2));
}

function deleteProfile(id) {
  try { fs.unlinkSync(profileFile(id)); } catch (e) {
    if (e instanceof AccountError || e.code !== 'ENOENT') throw e;
  }
}

// Mọi hồ sơ trong thư mục; file hỏng thành { id, error } để không làm hỏng cả danh sách.
function listProfiles() {
  let names;
  try { names = fs.readdirSync(paths().profilesDir); } catch { return []; }
  const ok = [];
  const bad = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const id = n.slice(0, -5);
    const p = loadProfile(id);
    if (p) ok.push(p); else bad.push({ id, error: 'FORMAT' });
  }
  ok.sort((a, b) => String(a.name).localeCompare(String(b.name)) || (a.id < b.id ? -1 : 1));
  return [...ok, ...bad];
}

// base, base2, base3... (không phân biệt hoa thường, vì resolve cũng vậy).
function uniqueName(base, profiles) {
  const used = new Set(profiles.filter((p) => p && typeof p.name === 'string').map((p) => p.name.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}${n}`.toLowerCase())) return `${base}${n}`;
}

// Tìm hồ sơ theo id -> tên -> email (khớp chính xác) -> tiền tố duy nhất của tên/email.
function resolve(query, profiles) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) throw new AccountError('NOT_FOUND', 'Chưa nhập tên tài khoản');
  const list = profiles.filter((p) => p && !p.error);
  const stages = [
    (p) => p.id === query || String(p.id).toLowerCase() === q,
    (p) => String(p.name ?? '').toLowerCase() === q,
    (p) => String(p.email ?? '').toLowerCase() === q,
    (p) => String(p.name ?? '').toLowerCase().startsWith(q) || String(p.email ?? '').toLowerCase().startsWith(q),
  ];
  for (const match of stages) {
    const hits = list.filter(match);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw new AccountError('AMBIGUOUS', `"${query}" khớp nhiều tài khoản: ${hits.map((p) => p.name).join(', ')}`);
    }
  }
  throw new AccountError('NOT_FOUND', `Không tìm thấy tài khoản "${query}"`);
}

// ---------- ghi đăng nhập vào file của Claude Code ----------

// Thay đúng claudeAiOauth + organizationUuid (credentials) và oauthAccount (.claude.json),
// giữ nguyên mọi khoá khác. Đọc lại hai file ngay trước khi ghi để không đè thay đổi mới của Claude Code.
function writeLogin(profile) {
  const o = profile?.oauth;
  if (!isObj(o) || !isStr(o.accessToken) || !isStr(o.refreshToken)) {
    throw new AccountError('NO_TOKEN', 'Hồ sơ không có token đăng nhập');
  }
  if (!isObj(profile.oauthAccount) || !isStr(profile.oauthAccount.accountUuid)) {
    throw new AccountError('FORMAT', 'Hồ sơ thiếu oauthAccount.accountUuid');
  }
  const { cred, cfg } = readLogin();   // ném FORMAT nếu file hiện tại có định dạng lạ
  const p = paths();
  cred.claudeAiOauth = o;
  if (profile.organizationUuid) cred.organizationUuid = profile.organizationUuid; else delete cred.organizationUuid;
  cfg.oauthAccount = profile.oauthAccount;
  writeAtomic(p.credFile, JSON.stringify(cred));             // một dòng như Claude Code
  writeAtomic(p.claudeJson, JSON.stringify(cfg, null, 2));   // thụt 2 dấu cách như Claude Code
}

// ---------- sao lưu ----------

// Chép hai file vào backupDir/<now>-credentials.json / <now>-claude.json, giữ 5 cặp gần nhất.
// Trả về tiền tố (đường dẫn không kèm hậu tố) để restore.
function backup(now) {
  const p = paths();
  fs.mkdirSync(p.backupDir, { recursive: true });
  const prefix = path.join(p.backupDir, String(now));
  for (const [src, suffix] of [[p.credFile, 'credentials'], [p.claudeJson, 'claude']]) {
    try { fs.copyFileSync(src, `${prefix}-${suffix}.json`); } catch (e) {
      if (e.code !== 'ENOENT') throw new AccountError('WRITE_FAILED', `Không sao lưu được ${path.basename(src)}: ${e.message}`, { cause: e });
    }
  }
  const stamps = new Set();
  for (const n of fs.readdirSync(p.backupDir)) {
    const m = /^(\d+)-(credentials|claude)\.json$/.exec(n);
    if (m) stamps.add(m[1]);
  }
  const old = [...stamps].sort((a, b) => Number(b) - Number(a)).slice(BACKUP_KEEP);
  for (const s of old) {
    for (const suffix of ['credentials', 'claude']) {
      try { fs.unlinkSync(path.join(p.backupDir, `${s}-${suffix}.json`)); } catch {}
    }
  }
  return prefix;
}

// Khôi phục hai file từ bản sao lưu (tiền tố do backup trả về).
function restore(prefix) {
  const p = paths();
  let found = 0;
  for (const [dst, suffix] of [[p.credFile, 'credentials'], [p.claudeJson, 'claude']]) {
    let text;
    try { text = fs.readFileSync(`${prefix}-${suffix}.json`, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw new AccountError('WRITE_FAILED', `Không đọc được bản sao lưu: ${e.message}`, { cause: e });
    }
    writeAtomic(dst, text);
    found++;
  }
  if (!found) throw new AccountError('NOT_FOUND', 'Không tìm thấy bản sao lưu');
}

// ---------- khoá ----------

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Khoá còn hiệu lực = đọc được { pid, t }, chưa quá 30 giây và tiến trình giữ khoá còn sống.
function lockActive(now) {
  let l;
  try { l = JSON.parse(fs.readFileSync(paths().lockFile, 'utf8')); } catch { return false; }
  if (!isObj(l) || typeof l.t !== 'number') return false;
  return now - l.t <= LOCK_TTL_MS && pidAlive(l.pid);
}

function isLocked(now = Date.now()) {
  return fs.existsSync(paths().lockFile) && lockActive(now);
}

// Chạy fn khi giữ khoá; khoá đang có hiệu lực -> LOCKED. Luôn thả khoá khi xong.
function withLock(fn, now = Date.now()) {
  const { lockFile, profilesDir } = paths();
  fs.mkdirSync(profilesDir, { recursive: true });
  const mine = { pid: process.pid, t: now };
  let got = false;
  for (let i = 0; i < 2 && !got; i++) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify(mine), { flag: 'wx' });   // 'wx': tạo mới, lỗi nếu đã có
      got = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw new AccountError('WRITE_FAILED', `Không tạo được khoá: ${e.message}`, { cause: e });
      if (lockActive(now)) break;
      try { fs.unlinkSync(lockFile); } catch {}   // khoá cũ/mồ côi -> dọn rồi thử lại
    }
  }
  if (!got) throw new AccountError('LOCKED', 'Đang có thao tác đổi tài khoản khác');
  try {
    return fn();
  } finally {
    // Chỉ xoá khoá của chính mình (nếu fn chạy quá hạn, khoá có thể đã thuộc về tiến trình khác).
    try {
      const l = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (l.pid === mine.pid && l.t === mine.t) fs.unlinkSync(lockFile);
    } catch {}
  }
}

// ---------- dạng công khai (không có token) ----------

function publicView(p) {
  if (p.error) {
    return { id: p.id, name: '', email: '', plan: '', usage: null, loginExpiresAt: null, savedAt: null, error: p.error };
  }
  return {
    id: p.id,
    name: p.name,
    email: p.email,
    plan: p.plan,
    usage: p.usage ?? null,
    loginExpiresAt: p.oauth?.refreshTokenExpiresAt ?? null,
    savedAt: p.savedAt,
  };
}

module.exports = {
  AccountError, paths, readLogin, profileFromLogin,
  listProfiles, loadProfile, saveProfile, deleteProfile,
  uniqueName, resolve, writeLogin, backup, restore,
  withLock, isLocked, publicView,
};

// (Các hàm đổi tài khoản, đồng bộ và khối CLI sẽ được thêm ở các task sau.)
