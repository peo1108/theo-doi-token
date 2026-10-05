// Nhiều tài khoản Claude: lưu đăng nhập của từng tài khoản thành "hồ sơ" và đổi qua lại
// bằng cách thay đúng các trường đăng nhập trong file của chính Claude Code
// (.credentials.json: claudeAiOauth + organizationUuid; .claude.json: oauthAccount).
//
// Gồm: đường dẫn, đọc/kiểm tra, hồ sơ, ghi atomic, sao lưu, khoá, dòng thời gian, tìm tiến trình, switchTo, sync/keep.
// Không bao giờ ghi accessToken/refreshToken ra log hay API (xem publicView).

const fs = require('fs');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const { effectiveUsage, loginState } = require('./analytics.js');

const BACKUP_KEEP = 5;            // số cặp sao lưu giữ lại
const LOCK_TTL_MS = 30e3;         // khoá hết hạn sau 30 giây
const WRITE_RETRIES = 5;          // số lần thử lại khi Windows khoá file
const WRITE_RETRY_MS = 100;
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

class AccountError extends Error {
  // code: FORMAT | NOT_FOUND | AMBIGUOUS | LOCKED | NO_TOKEN | WRITE_FAILED | ACTIVE | NAME_TAKEN
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

const PREV_KEEP = 3;

// Dựng hồ sơ từ đăng nhập hiện tại; giữ name của hồ sơ cũ.
// usage lấy từ file nếu thuộc đúng tài khoản này, ngược lại giữ usage cũ.
function profileFromLogin(login, existing, now) {
  if (!login || !login.id) throw new AccountError('NO_TOKEN', 'Chưa đăng nhập, không có gì để lưu');
  const oauth = login.cred.claudeAiOauth;
  const oauthAccount = login.cfg.oauthAccount;
  const cached = login.cfg.cachedUsageUtilization;
  const usage = isObj(cached) && cached.accountUuid === login.id ? cached : (existing?.usage ?? null);
  const email = oauthAccount.emailAddress || '';
  // Bảo hiểm: quyền sở hữu claudeAiOauth chỉ suy ra từ oauthAccount, Claude Code có thể chỉ ghi lại .credentials.json
  // (vd. phiên cũ làm mới token sau khi đổi) -> mỗi lần refreshToken đổi, giữ bản cũ (mới nhất trước, tối đa 3).
  let prev = Array.isArray(existing?.prev) ? existing.prev : [];
  if (isStr(existing?.oauth?.refreshToken) && existing.oauth.refreshToken !== oauth.refreshToken) {
    prev = [{
      oauth: existing.oauth, organizationUuid: existing.organizationUuid ?? null,
      oauthAccount: existing.oauthAccount, savedAt: existing.savedAt,
    }, ...prev].slice(0, PREV_KEEP);
  }
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
    ...(prev.length ? { prev } : {}),
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

const BACKUP_PARTS = [['credFile', 'credentials'], ['claudeJson', 'claude']];

// Chép hai file vào backupDir/<now>-credentials.json / <now>-claude.json, giữ 5 cặp gần nhất
// (không bao giờ xoá cặp vừa ghi). File không tồn tại lúc sao lưu được ghi nhận bằng
// <now>-<tên>.absent để restore xoá lại file mới sinh ra.
// Trả về tiền tố (đường dẫn không kèm hậu tố) để restore.
function backup(now) {
  const p = paths();
  fs.mkdirSync(p.backupDir, { recursive: true });
  const prefix = path.join(p.backupDir, String(now));
  for (const [key, suffix] of BACKUP_PARTS) {
    const src = p[key];
    const copy = `${prefix}-${suffix}.json`;
    const marker = `${prefix}-${suffix}.absent`;
    try {
      fs.copyFileSync(src, copy);
      try { fs.unlinkSync(marker); } catch {}
    } catch (e) {
      if (e.code !== 'ENOENT') throw new AccountError('WRITE_FAILED', `Không sao lưu được ${path.basename(src)}: ${e.message}`, { cause: e });
      try { fs.unlinkSync(copy); } catch {}
      try { fs.writeFileSync(marker, ''); } catch (e2) {
        throw new AccountError('WRITE_FAILED', `Không ghi được dấu sao lưu: ${e2.message}`, { cause: e2 });
      }
    }
  }
  const stamps = new Set();
  for (const n of fs.readdirSync(p.backupDir)) {
    const m = /^(\d+)-(credentials|claude)\.(json|absent)$/.exec(n);
    if (m) stamps.add(m[1]);
  }
  const old = [...stamps].sort((a, b) => Number(b) - Number(a)).slice(BACKUP_KEEP).filter((s) => s !== String(now));
  for (const s of old) {
    for (const [, suffix] of BACKUP_PARTS) {
      for (const ext of ['json', 'absent']) {
        try { fs.unlinkSync(path.join(p.backupDir, `${s}-${suffix}.${ext}`)); } catch {}
      }
    }
  }
  return prefix;
}

// Khôi phục hai file từ bản sao lưu (tiền tố do backup trả về); file vắng lúc sao lưu thì bị xoá.
function restore(prefix) {
  const p = paths();
  let found = 0;
  for (const [key, suffix] of BACKUP_PARTS) {
    const dst = p[key];
    let text;
    try { text = fs.readFileSync(`${prefix}-${suffix}.json`, 'utf8'); } catch (e) {
      if (e.code !== 'ENOENT') throw new AccountError('WRITE_FAILED', `Không đọc được bản sao lưu: ${e.message}`, { cause: e });
      if (!fs.existsSync(`${prefix}-${suffix}.absent`)) continue;
      try { fs.unlinkSync(dst); } catch (e2) {
        if (e2.code !== 'ENOENT') throw new AccountError('WRITE_FAILED', `Không xoá được ${path.basename(dst)}: ${e2.message}`, { cause: e2 });
      }
      found++;
      continue;
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

// File khoá còn hiệu lực = đọc được { pid, t }, chưa quá 30 giây và tiến trình giữ khoá còn sống.
// File chưa đọc được (đang được tạo dở, hoặc hỏng) coi là còn hiệu lực cho tới khi mtime quá 30 giây,
// để không tranh khoá của tiến trình vừa tạo file nhưng chưa kịp ghi nội dung.
function lockFileActive(file, now) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }   // không có file = không có khoá
  let l = null;
  try { l = JSON.parse(text); } catch {}
  if (!isObj(l) || typeof l.t !== 'number') {
    try { return Date.now() - fs.statSync(file).mtimeMs <= LOCK_TTL_MS; } catch { return false; }
  }
  return now - l.t <= LOCK_TTL_MS && pidAlive(l.pid);
}

const lockActive = (now) => lockFileActive(paths().lockFile, now);

function isLocked(now = Date.now()) {
  return lockActive(now);
}

// Dọn khoá cũ: đổi tên sang file riêng (atomic) rồi mới kiểm tra lại, để không xoá nhầm khoá mới
// của tiến trình khác vừa tạo xen vào giữa. Trả true nếu khoá đã được dọn (hoặc đã biến mất).
function reclaimStale(now) {
  const { lockFile } = paths();
  const aside = `${lockFile}.${process.pid}.${Math.random().toString(36).slice(2)}.stale`;
  try { fs.renameSync(lockFile, aside); } catch { return true; }   // ai đó đã dọn trước
  if (!lockFileActive(aside, now)) {
    try { fs.unlinkSync(aside); } catch {}
    return true;
  }
  // Bắt nhầm khoá còn hiệu lực: trả lại (linkSync không ghi đè nếu đã có khoá khác).
  try { fs.linkSync(aside, lockFile); } catch {}
  try { fs.unlinkSync(aside); } catch {}
  return false;
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
      if (lockActive(now) || !reclaimStale(now)) break;
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

// ---------- dòng thời gian (data/account-log.json) ----------

// { v: 1, entries: [{ t, id, reason, running? }] tăng dần theo t, conflict: null | { fileId, chosenId, since } }
function readLog() {
  const o = readObject(paths().logFile);
  const entries = Array.isArray(o.entries) ? o.entries.filter((e) => isObj(e) && Number.isFinite(e.t) && isStr(e.id)) : [];
  entries.sort((a, b) => a.t - b.t);   // sort ổn định: mục trùng t giữ nguyên thứ tự
  return { v: 1, entries, conflict: isObj(o.conflict) ? o.conflict : null };
}

function writeLog(log) {
  writeAtomic(paths().logFile, JSON.stringify(log, null, 2));
}

// Chèn giữ entries tăng theo t (mục trùng t đứng sau mục cũ). "Giữ F" có thể chèn t nhỏ hơn mục cuối.
function addEntry(log, entry) {
  let i = log.entries.length;
  while (i > 0 && log.entries[i - 1].t > entry.t) i--;
  log.entries.splice(i, 0, entry);
  return log;
}

// id của tài khoản đang được chọn = mục cuối.
const chosenId = (log) => (log.entries.length ? log.entries[log.entries.length - 1].id : null);

// Thời điểm cho mục mới để nó luôn là mục cuối (chosenId trả về nó): không nhỏ hơn t của mục cuối hiện có.
const lastT = (log, t) => (log.entries.length ? Math.max(t, log.entries[log.entries.length - 1].t) : t);

// ---------- tìm tiến trình Claude Code đang chạy ----------

const DESKTOP_APP_RE = /[\\/]windowsapps[\\/]|[\\/]anthropicclaude[\\/]|\.app[\\/]contents[\\/]/i;   // ứng dụng Claude desktop
const NPM_CLI_RE = /@anthropic-ai[\\/]claude-code/i;
const RUNTIMES = new Set(['node', 'node.exe', 'bun', 'bun.exe']);

// Từ đầu của command line (có thể đặt trong dấu nháy kép).
function firstToken(cmd) {
  const c = String(cmd || '').trim();
  const m = /^"([^"]*)"/.exec(c) || /^(\S+)/.exec(c);
  return m ? m[1] : '';
}

// Claude Code = claude(.exe) không phải ứng dụng Claude desktop (cũng tên Claude.exe, nằm trong WindowsApps,
// các tiến trình con Electron có --type=...), hoặc node/bun chạy @anthropic-ai/claude-code.
function isClaudeCodeProcess({ name, path: exePath, cmd } = {}) {
  const n = String(name || '').toLowerCase();
  const command = String(cmd || '');
  if (n === 'claude.exe' || n === 'claude') {
    // ExecutablePath có thể null; command line không đặt trong dấu nháy thì đường dẫn có khoảng trắng bị cắt bởi firstToken,
    // nên thử trên cả chuỗi.
    if (DESKTOP_APP_RE.test(exePath || command)) return false;
    return !/\s--type=/.test(command);
  }
  return RUNTIMES.has(n) && NPM_CLI_RE.test(command);
}

// Get-CimInstance trả một object (không phải mảng) khi chỉ có một kết quả.
function parseWindowsProcesses(text, selfPid) {
  if (!String(text).trim()) return [];
  const data = JSON.parse(text);
  const rows = Array.isArray(data) ? data : [data];
  return rows
    .filter((r) => isObj(r) && r.ProcessId !== selfPid
      && isClaudeCodeProcess({ name: r.Name, path: r.ExecutablePath, cmd: r.CommandLine }))
    .map((r) => ({ pid: r.ProcessId, cmd: r.CommandLine || r.ExecutablePath || '' }));
}

function parsePsProcesses(text, selfPid) {
  const list = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const cmd = m[2];
    const name = firstToken(cmd).split(/[\\/]/).pop();
    if (pid !== selfPid && isClaudeCodeProcess({ name, cmd })) list.push({ pid, cmd });
  }
  return list;
}

// -> { ok, list }. Không bao giờ ném: lỗi -> { ok: false, list: [] } (switchTo chỉ cảnh báo, không chặn).
function findClaudeProcesses() {
  try {
    const opts = { encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        'Get-CimInstance Win32_Process | Select ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress'], opts);
      return { ok: true, list: parseWindowsProcesses(out, process.pid) };
    }
    return { ok: true, list: parsePsProcesses(execFileSync('ps', ['-eo', 'pid,args'], opts), process.pid) };
  } catch {
    return { ok: false, list: [] };
  }
}

// ---------- đổi tài khoản ----------

// Lưu đăng nhập hiện tại vào hồ sơ của login.id (giữ name cũ). Không đăng nhập -> null.
function snapshot(login, now) {
  if (!login || !login.id) return null;
  const p = profileFromLogin(login, loadProfile(login.id), now);
  saveProfile(p);
  return p;
}

const SWITCH_TRIES = 3;
const SWITCH_RETRY_MS = 200;

// Đổi tài khoản theo 10 bước ở mục 5.2 của spec. opts.write chỉ để test (mặc định writeLogin).
function switchTo(query, { now = Date.now(), processes, write = writeLogin } = {}) {
  const findProcs = processes || (process.env.TT_SKIP_PROCESS_CHECK === '1' ? () => ({ ok: true, list: [] }) : findClaudeProcesses);
  return withLock(() => {
    const login = readLogin();                                    // bước 2 (ném FORMAT nếu lạ)
    const target = resolve(query, listProfiles());
    snapshot(login, now);                                         // bước 3
    const asWriteFailed = (e, msg) => (e instanceof AccountError && e.code === 'WRITE_FAILED'
      ? e : new AccountError('WRITE_FAILED', `${msg}: ${e.message}`, { cause: e }));
    const scan = () => {                                          // bước 5 (chỉ cảnh báo, không chặn)
      let procs;
      try { procs = findProcs(); } catch { procs = null; }
      const checked = !!(procs && procs.ok);
      return { checked, running: checked && Array.isArray(procs.list) ? procs.list : [] };
    };
    const logSwitch = (log, running, checked) => {                // bước 9
      addEntry(log, { t: lastT(log, now), id: target.id, reason: 'switch', ...(checked ? { running: running.length } : {}) });
      log.conflict = null;
      writeLog(log);
    };
    if (login.id === target.id) {                                 // bước 4
      const log = readLog();
      if (chosenId(log) === target.id) {
        return { ok: true, from: login.id, to: target.id, already: true, running: [], checked: false };
      }
      // File đã là đích nhưng đang chọn tài khoản khác (vd. đang có conflict): chỉ ghi lại lựa chọn, không đụng file đăng nhập.
      const { checked, running } = scan();
      try { logSwitch(log, running, checked); } catch (e) { throw asWriteFailed(e, 'Không ghi được dòng thời gian'); }
      return { ok: true, from: login.id, to: target.id, already: true, running, checked };
    }
    const o = target.oauth;
    if (!isObj(o) || !isStr(o.accessToken) || !isStr(o.refreshToken)) {
      throw new AccountError('NO_TOKEN', `Hồ sơ "${target.name}" không có token đăng nhập, hãy /login lại rồi lưu`);
    }
    const { checked, running } = scan();

    const prefix = backup(now);                                   // bước 6
    // Trả hai file về bản trước khi đổi rồi ném lỗi gốc (restore lỗi thì ném lỗi của restore).
    const rollback = (cause) => {
      try { restore(prefix); } catch (e) {
        throw new AccountError('WRITE_FAILED', `Đổi tài khoản lỗi và không khôi phục được bản sao lưu ${prefix}: ${e.message}`, { cause: e });
      }
      throw cause;
    };
    let lastErr = null;                                           // bước 7-8
    for (let attempt = 1; attempt <= SWITCH_TRIES; attempt++) {
      try {
        write(target);
        if (readLogin().id === target.id) { lastErr = null; break; }
        lastErr = new AccountError('WRITE_FAILED', 'Ghi xong nhưng đọc lại vẫn không phải tài khoản đích');
      } catch (e) { lastErr = e; }
      if (attempt < SWITCH_TRIES) sleepSync(SWITCH_RETRY_MS);
    }
    if (lastErr) rollback(asWriteFailed(lastErr, 'Không đổi được tài khoản'));

    try {                                                         // bước 9
      logSwitch(readLog(), running, checked);
    } catch (e) {
      rollback(asWriteFailed(e, 'Không ghi được dòng thời gian'));
    }
    return { ok: true, from: login.id, to: target.id, running, checked };   // bước 10 (withLock nhả khoá)
  }, now);
}

// ---------- đồng bộ ----------

// Phần của hồ sơ lấy từ file đăng nhập; dùng để biết có gì thay đổi mà cần ghi lại.
const loginPart = (p) => JSON.stringify({
  oauth: p.oauth, organizationUuid: p.organizationUuid ?? null, oauthAccount: p.oauthAccount, usage: p.usage ?? null,
});

// Đồng bộ file đăng nhập của Claude Code với hồ sơ và dòng thời gian (mục 5.3 của spec). Tracker gọi mỗi lần quét.
// Không lấy khoá (không được chặn đổi tài khoản); đang có khoá thì bỏ qua. Chỉ ghi file hồ sơ và log,
// đọc lại log ngay trước khi ghi và kiểm tra khoá lần nữa để ít đè lên một lần đổi vừa bắt đầu.
// -> { skipped?: 'locked'|'format'|'nologin', added?: id, updated?: id, conflict?: { fileId, chosenId, since } }
function sync(now = Date.now()) {
  if (isLocked(now)) return { skipped: 'locked' };
  let login;
  let log;
  try {
    login = readLogin();
    if (!login.id) return { skipped: 'nologin' };   // chưa đăng nhập hoặc vừa /logout: không có gì để lưu
    log = readLog();
  } catch (e) {
    if (e instanceof AccountError && e.code === 'FORMAT') return { skipped: 'format' };
    throw e;
  }
  const id = login.id;                               // F: tài khoản trong file
  const existing = loadProfile(id);
  const next = profileFromLogin(
    login,
    existing ?? { name: uniqueName(defaultName(login.cfg.oauthAccount.emailAddress), listProfiles()) },
    now,
  );
  const profileChanged = !existing || loginPart(existing) !== loginPart(next);

  // Cập nhật log theo F và tài khoản đang chọn I; trả true nếu log có thay đổi.
  const applyLog = (l) => {
    const cur = chosenId(l);                         // I
    if (cur === null) {                              // lần đầu: chưa chọn tài khoản nào
      addEntry(l, { t: 0, id, reason: 'init' });
      l.conflict = null;
      return true;
    }
    if (cur === id) {                                // F === I: nếu còn conflict cũ thì đã hết
      if (!l.conflict) return false;
      l.conflict = null;
      return true;
    }
    if (!existing) {                                 // F là tài khoản mới đăng nhập: chọn luôn
      addEntry(l, { t: lastT(l, now), id, reason: 'login' });
      l.conflict = null;
      return true;
    }
    const c = l.conflict;                            // F !== I, F đã có hồ sơ: ghi nhận conflict, giữ since cũ
    if (c && c.fileId === id && c.chosenId === cur) return false;
    l.conflict = { fileId: id, chosenId: cur, since: now };
    return true;
  };

  const report = (l, base) => (l.conflict && l.conflict.fileId === id ? { ...base, conflict: l.conflict } : base);
  if (!profileChanged && !applyLog(structuredClone(log))) return report(log, {});   // không có gì để ghi
  if (isLocked(now)) return { skipped: 'locked' };   // có lần đổi vừa bắt đầu: để lần quét sau
  const fresh = readLog();
  if (applyLog(fresh)) writeLog(fresh);              // log trước, hồ sơ sau: hồ sơ thiếu thì lần sau tự tạo lại
  if (profileChanged) saveProfile(next);

  return report(fresh, existing ? (profileChanged ? { updated: id } : {}) : { added: id });
}

// "Giữ F": chấp nhận tài khoản trong file là tài khoản đang chọn, tính từ lúc bắt đầu conflict.
// Mục keep chèn tại conflict.since; nếu sau đó đã có mục muộn hơn của tài khoản khác thì kẹp t lên mục cuối
// để chosenId vẫn là F. -> { ok: true, id }
function keep(now = Date.now()) {
  return withLock(() => {
    const log = readLog();
    const c = log.conflict;
    if (!c || !isStr(c.fileId) || !Number.isFinite(c.since)) throw new AccountError('NOT_FOUND', 'Không có xung đột tài khoản nào cần xử lý');
    const last = log.entries[log.entries.length - 1];
    const t = last && last.t > c.since && last.id !== c.fileId ? last.t : c.since;
    addEntry(log, { t, id: c.fileId, reason: 'keep' });
    log.conflict = null;
    writeLog(log);
    return { ok: true, id: c.fileId };
  }, now);
}

// ---------- đổi tên / xoá hồ sơ ----------

// Đổi tên hồ sơ. Đây là nơi duy nhất giữ luật "tên không trùng hồ sơ khác" (không phân biệt hoa thường).
// -> hồ sơ đã đổi tên.
function rename(query, newName, now = Date.now()) {
  const name = String(newName ?? '').trim();
  if (!name) throw new AccountError('FORMAT', 'Tên mới không được để trống');
  return withLock(() => {
    const profiles = listProfiles();
    const target = resolve(query, profiles);
    const lower = name.toLowerCase();
    if (profiles.some((p) => !p.error && p.id !== target.id && String(p.name ?? '').toLowerCase() === lower)) {
      throw new AccountError('NAME_TAKEN', `Tên "${name}" đã có tài khoản khác dùng`);
    }
    const next = { ...target, name };
    saveProfile(next);
    return next;
  }, now);
}

// Xoá file hồ sơ (không đụng file đăng nhập và dòng thời gian). Không xoá được tài khoản đang được chọn.
// -> { id }
function remove(query) {
  return withLock(() => {
    const target = resolve(query, listProfiles());
    if (target.id === chosenId(readLog())) {
      throw new AccountError('ACTIVE', `"${target.name}" đang là tài khoản được chọn`);
    }
    // đang nằm trong file đăng nhập (vd. conflict): xoá thì lần sync sau tạo lại bằng mục 'login', đổi ngầm tài khoản đã chọn
    let fileId = null;
    try { fileId = readLogin().id; } catch (e) { if (!(e instanceof AccountError && e.code === 'FORMAT')) throw e; }
    if (fileId && target.id === fileId) {
      throw new AccountError('ACTIVE', `"${target.name}" đang là tài khoản trong file đăng nhập`);
    }
    deleteProfile(target.id);
    return { id: target.id };
  });
}

module.exports = {
  AccountError, paths, readLogin, profileFromLogin,
  listProfiles, loadProfile, saveProfile, deleteProfile,
  uniqueName, resolve, writeLogin, backup, restore,
  withLock, isLocked, publicView,
  readLog, writeLog, addEntry, chosenId,
  isClaudeCodeProcess, findClaudeProcesses, parseWindowsProcesses, parsePsProcesses,
  snapshot, switchTo, sync, keep, rename, remove,
};

// ---------- dòng lệnh: cc-switch ----------

const USAGE = [
  'Cách dùng:',
  '  cc-switch                          liệt kê tài khoản (* = đang chọn)',
  '  cc-switch <tên|email|id>           đổi sang tài khoản đó',
  '  cc-switch rename <tài khoản> <tên mới>',
  '  cc-switch remove <tài khoản>       xoá hồ sơ (không xoá được tài khoản đang chọn)',
  '  cc-switch keep                     giữ tài khoản trong file đăng nhập khi có xung đột',
].join('\n');

const pad2 = (n) => String(n).padStart(2, '0');
const fmtDate = (t) => { const d = new Date(t); return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`; };

function loginText(expiresAt, now) {
  switch (loginState(expiresAt, now)) {
    case 'ok': return fmtDate(expiresAt);
    case 'soon': return `còn ${Math.max(1, Math.ceil((expiresAt - now) / 864e5))} ngày`;
    case 'expired': return 'cần /login lại';
    default: return '—';
  }
}

function listing(now) {
  const profiles = listProfiles();
  if (!profiles.length) return 'Chưa có tài khoản nào — /login trong Claude Code rồi chạy lại';
  const chosen = chosenId(readLog());
  const pct = (b) => (b ? `${Math.round(b.pct)}%` : '—');
  const rows = profiles.map((p) => {
    if (p.error) return ['', p.id, '', '', '', '', 'hồ sơ hỏng'];
    const eu = effectiveUsage(p.usage, now);
    return [p.id === chosen ? '*' : '', p.name, p.email, p.plan || '—', `5h ${pct(eu.fiveHour)}`, `tuần ${pct(eu.sevenDay)}`,
      loginText(p.oauth?.refreshTokenExpiresAt ?? null, now)];
  });
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows.map((r) => r.map((cell, c) => cell.padEnd(widths[c])).join('  ').trimEnd()).join('\n');
}

const ERROR_TEXT = {
  FORMAT: (m) => `Lỗi định dạng: ${m}`,
  NOT_FOUND: (m) => m,
  AMBIGUOUS: (m) => `${m}. Hãy gõ rõ hơn`,
  LOCKED: () => 'Đang có thao tác đổi tài khoản khác, thử lại sau vài giây',
  NO_TOKEN: (m) => `Không có token đăng nhập: ${m}`,
  WRITE_FAILED: (m) => `Lỗi ghi file: ${m}`,
  ACTIVE: (m) => `Không xoá được: ${m}, hãy đổi sang tài khoản khác trước`,
  NAME_TAKEN: (m) => `${m}, hãy chọn tên khác`,
};

const describe = (p, id) => (p ? `${p.name} (${p.email})` : id);

function runCli(argv, out, err) {
  const [cmd, ...rest] = argv;
  const word = typeof cmd === 'string' ? cmd.toLowerCase() : '';
  if (word === '-h' || word === '--help') { out(USAGE); return 0; }
  const usageError = (line) => { err(`${line}\n${USAGE}`); return 1; };
  try {
    if (cmd === undefined) {
      sync();
      out(listing(Date.now()));
      return 0;
    }
    if (word === 'rename') {
      if (rest.length < 2) return usageError('Thiếu tên: cc-switch rename <tài khoản> <tên mới>');
      const p = rename(rest[0], rest.slice(1).join(' '));
      out(`Đã đổi tên thành ${p.name} (${p.email})`);
      return 0;
    }
    if (word === 'remove') {
      if (rest.length < 1) return usageError('Thiếu tên: cc-switch remove <tài khoản>');
      const target = resolve(rest[0], listProfiles());
      remove(target.id);
      out(`Đã xoá hồ sơ ${describe(target)}`);
      return 0;
    }
    if (word === 'keep') {
      const r = keep();
      out(`Đã giữ ${describe(loadProfile(r.id), r.id)} là tài khoản đang dùng`);
      return 0;
    }
    const r = switchTo(cmd);
    const p = loadProfile(r.to);
    out(r.already ? `Đang dùng sẵn ${describe(p, r.to)}` : `Đã đổi sang ${describe(p, r.to)}`);
    if (r.running.length > 0) err(`Cảnh báo: ${r.running.length} phiên Claude Code đang chạy vẫn dùng tài khoản cũ cho tới khi khởi động lại`);
    if (!r.checked && !r.already) err('Không kiểm tra được phiên đang chạy');
    return 0;
  } catch (e) {
    if (e instanceof AccountError) {
      err((ERROR_TEXT[e.code] || ((m) => m))(e.message));
      return e.code === 'NOT_FOUND' || e.code === 'AMBIGUOUS' ? 2 : 1;
    }
    err(e && e.message ? e.message : String(e));
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runCli(process.argv.slice(2), (s) => console.log(s), (s) => console.error(s));
}
