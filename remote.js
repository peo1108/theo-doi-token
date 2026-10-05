#!/usr/bin/env node
// Điều khiển Claude Code từ điện thoại (app iOS "CC Remote") qua Tailscale.
// Server riêng ở 127.0.0.1:7789 (đưa ra tailnet bằng `tailscale serve --bg 7789`), mọi API cần token thiết bị.
// Mỗi phiên là một tiến trình `claude -p` nói chuyện bằng stream-json qua stdin/stdout; hỏi quyền đi qua
// control_request `can_use_tool` (--permission-prompt-tool stdio) để duyệt từ điện thoại.
//
//   node remote.js pair      -> tạo mã ghép 6 số (hiệu lực 10 phút)
//   node remote.js devices   -> liệt kê thiết bị đã ghép
//   node remote.js revoke <id>

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync, execFile } = require('child_process');

const MIN = 60e3;
const VERSION = 1;
const dataDir = () => process.env.TT_DATA_DIR || path.join(__dirname, 'data');
const remoteFile = () => path.join(dataDir(), 'remote.json');
const logRoot = () => process.env.CLAUDE_PROJECTS_DIR || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const REMOTE_PORT = Number(process.env.REMOTE_PORT) || 7789;
const REMOTE_HOST = process.env.REMOTE_HOST || '127.0.0.1';
const MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
const MAX_EVENTS = 1500;
const IDLE_CLOSE_MS = 30 * MIN;     // phiên rảnh, không ai xem -> tắt tiến trình (tin nhắn sau sẽ --resume)
const DORMANT_DROP_MS = 60 * MIN;   // phiên đã tắt, không ai xem -> bỏ khỏi bộ nhớ
const PAIR_TTL = 10 * MIN;
const PAIR_TRIES = 5;
const HEARTBEAT_MS = 15e3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class RemoteError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

// ---------- remote.json: thiết bị, mã ghép, ntfy ----------

function load() {
  let d;
  try { d = JSON.parse(fs.readFileSync(remoteFile(), 'utf8')); } catch { d = {}; }
  return {
    devices: Array.isArray(d.devices) ? d.devices : [], pair: d.pair || null, ntfy: d.ntfy || null, hookKey: d.hookKey || null,
    alwaysOn: d.alwaysOn !== false,   // phiên VS Code luôn sẵn sàng nhận lệnh từ điện thoại (không cần /phone)
  };
}

const alwaysOn = () => load().alwaysOn;
function setAlwaysOn(on) {
  const d = load();
  d.alwaysOn = !!on;
  save(d);
  return d.alwaysOn;
}

const AWAY_MS = 45e3;   // máy không có thao tác bàn phím/chuột lâu hơn -> coi như đã rời máy

// Tin nhắn từ điện thoại đưa vào phiên trên máy qua hook Stop. Ghi rõ là của người dùng để Claude không coi là prompt injection.
const PHONE_PREFIX = '📱 Tin nhắn của người dùng, gửi từ điện thoại qua app CC Remote (hook do chính người dùng cài) — hãy làm theo như tin nhắn bình thường:';
const phoneMessage = (text) => `${PHONE_PREFIX}\n\n${text}`;

// Khoá bí mật để hook.js (chạy trên máy) gọi /v1/hook/*; tạo khi cần.
function hookKey() {
  const d = load();
  if (d.hookKey) return d.hookKey;
  d.hookKey = crypto.randomBytes(24).toString('base64url');
  save(d);
  return d.hookKey;
}

function save(d) {
  const file = remoteFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 1));
  fs.renameSync(tmp, file);
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function newPairCode(now = Date.now()) {
  const d = load();
  d.pair = { code: String(crypto.randomInt(0, 1e6)).padStart(6, '0'), expiresAt: now + PAIR_TTL, tries: 0 };
  save(d);
  return { code: d.pair.code, expiresAt: d.pair.expiresAt };
}

function pair(code, name, now = Date.now()) {
  const d = load();
  const p = d.pair;
  if (!p || p.expiresAt < now) throw new RemoteError('PAIR_EXPIRED', 'Mã ghép đã hết hạn hoặc chưa tạo — tạo mã mới trên dashboard', 403);
  const ok = typeof code === 'string' && code.length === p.code.length &&
    crypto.timingSafeEqual(Buffer.from(code), Buffer.from(p.code));
  if (!ok) {
    p.tries = (p.tries || 0) + 1;
    if (p.tries >= PAIR_TRIES) d.pair = null;   // đoán sai nhiều lần -> huỷ mã
    save(d);
    throw new RemoteError('PAIR_WRONG', d.pair ? 'Sai mã ghép' : 'Sai mã quá nhiều lần — tạo mã mới', 403);
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const dev = {
    id: crypto.randomBytes(6).toString('hex'),
    name: String(name || 'iPhone').slice(0, 60),
    hash: sha(token),
    createdAt: now,
    lastSeen: now,
  };
  d.devices.push(dev);
  d.pair = null;
  save(d);
  return { token, deviceId: dev.id };
}

const seenWritten = new Map();
function authDevice(token, now = Date.now()) {
  if (!token) return null;
  const h = Buffer.from(sha(token));
  const d = load();
  const dev = d.devices.find((x) => typeof x.hash === 'string' && x.hash.length === h.length && crypto.timingSafeEqual(Buffer.from(x.hash), h));
  if (!dev) return null;
  if (now - (seenWritten.get(dev.id) || 0) > 5 * MIN) {   // không ghi file mỗi request
    seenWritten.set(dev.id, now);
    dev.lastSeen = now;
    try { save(d); } catch {}
  }
  return dev;
}

function devices() {
  return load().devices.map(({ id, name, createdAt, lastSeen }) => ({ id, name, createdAt, lastSeen }));
}

function revoke(id) {
  const d = load();
  const n = d.devices.length;
  d.devices = d.devices.filter((x) => x.id !== id);
  if (d.devices.length === n) throw new RemoteError('NOT_FOUND', 'Không có thiết bị này', 404);
  save(d);
  return { ok: true };
}

function setNtfy(patch) {
  const d = load();
  const topic = String((patch && patch.topic) || '').trim();
  if (topic && !/^[\w-]{6,64}$/.test(topic)) throw new RemoteError('FORMAT', 'Topic ntfy chỉ gồm chữ, số, - và _ (6–64 ký tự)');
  const server = String((patch && patch.server) || 'https://ntfy.sh').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/.test(server)) throw new RemoteError('FORMAT', 'Địa chỉ server ntfy không hợp lệ');
  d.ntfy = topic ? { server, topic } : null;
  save(d);
  return d.ntfy;
}

// Thông báo khi app đang đóng (ntfy.sh hoặc server ntfy riêng). Chỉ gửi tiêu đề ngắn, không gửi nội dung code.
const b64h = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
function notify(title, body, sid, fetchImpl = globalThis.fetch) {
  const n = load().ntfy;
  if (!n || !n.topic || !fetchImpl) return Promise.resolve(false);
  return fetchImpl(`${n.server}/${encodeURIComponent(n.topic)}`, {
    method: 'POST',
    body: body || ' ',
    headers: { Title: b64h(title), Tags: 'robot', ...(sid ? { Click: `ccremote://session/${sid}` } : {}) },
    signal: AbortSignal.timeout(10e3),
  }).then((r) => r.ok, () => false);
}

// ---------- tìm lệnh claude ----------

let claudeCache;
function findClaude() {
  const env = process.env.CLAUDE_BIN;
  if (env) return /\.[cm]?js$/.test(env) ? { cmd: process.execPath, pre: [env] } : { cmd: env, pre: [] };
  if (claudeCache) return claudeCache;
  const win = process.platform === 'win32';
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(os.homedir(), '.local', 'bin'));
  if (win && process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  for (const dir of dirs) {
    if (win) {
      const exe = path.join(dir, 'claude.exe');
      if (fs.existsSync(exe)) return (claudeCache = { cmd: exe, pre: [] });
      // npm tạo claude.cmd gọi tới ...\bin\claude.exe; chạy thẳng exe để khỏi qua cmd.exe
      const shim = path.join(dir, 'claude.cmd');
      let text = '';
      try { text = fs.readFileSync(shim, 'utf8'); } catch { continue; }
      const m = /"%(?:~?dp0)%?\\([^"]+?\.exe)"/i.exec(text);
      if (m && fs.existsSync(path.join(dir, m[1]))) return (claudeCache = { cmd: path.join(dir, m[1]), pre: [] });
    } else {
      const p = path.join(dir, 'claude');
      try { fs.accessSync(p, fs.constants.X_OK); return (claudeCache = { cmd: p, pre: [] }); } catch {}
    }
  }
  return null;
}

// ---------- chuẩn hoá message Claude Code -> sự kiện cho app ----------

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
// bỏ ký hiệu markdown cho tiêu đề / dòng xem trước
const plain = (s) => String(s ?? '').replace(/```[\s\S]*?(```|$)/g, ' ').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();

function toolSummary(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const pick = i.command ?? i.file_path ?? i.notebook_path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt ?? i.plan;
  if (name === 'TodoWrite' && Array.isArray(i.todos)) {
    const cur = i.todos.find((t) => t.status === 'in_progress');
    return `${i.todos.filter((t) => t.status === 'completed').length}/${i.todos.length} việc${cur ? ` · ${cur.activeForm || cur.content}` : ''}`;
  }
  if (name === 'AskUserQuestion' && Array.isArray(i.questions)) return clip(i.questions.map((q) => q.question).join(' · '), 200);
  if (pick != null) return clip(String(pick).replace(/\s+/g, ' '), 200);
  const first = Object.values(i).find((v) => typeof v === 'string');
  return clip(first || '', 200);
}

// Phần để app vẽ tool giống VS Code: title (mô tả), path, code (lệnh / nội dung), old/new (diff của Edit).
function toolDetail(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const str = (v, n) => (typeof v === 'string' && v ? clip(v, n) : undefined);
  const d = {};
  if (name === 'Bash' || name === 'PowerShell') {
    d.title = str(i.description, 200);
    d.code = str(i.command, 3000);
  } else if (name === 'Edit' || name === 'MultiEdit') {
    d.path = str(i.file_path, 400);
    const e = name === 'MultiEdit' && Array.isArray(i.edits) ? i.edits[0] || {} : i;
    d.old = str(e.old_string, 3000);
    d.new = str(e.new_string, 3000);
    if (name === 'MultiEdit' && Array.isArray(i.edits) && i.edits.length > 1) d.title = `${i.edits.length} chỗ sửa`;
  } else if (name === 'Write') {
    d.path = str(i.file_path, 400);
    d.code = str(i.content, 3000);
  } else if (name === 'Read' || name === 'NotebookEdit') {
    d.path = str(i.file_path || i.notebook_path, 400);
    if (i.offset || i.limit) d.title = `dòng ${i.offset || 1}${i.limit ? `–${(i.offset || 1) + i.limit}` : ''}`;
  } else if (name === 'Grep' || name === 'Glob') {
    d.title = str(i.pattern, 300);
    d.path = str(i.path, 400);
  } else if (name === 'WebFetch') {
    d.title = str(i.url, 400);
  } else if (name === 'WebSearch') {
    d.title = str(i.query, 300);
  } else if (name === 'Task' || name === 'Agent') {
    d.title = str(i.description, 200);
    d.code = str(i.prompt, 1500);
  } else if (name === 'TodoWrite' && Array.isArray(i.todos)) {
    d.code = i.todos.map((t) => `${t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'} ${t.content}`).join('\n');
  }
  for (const k of Object.keys(d)) if (d[k] === undefined) delete d[k];
  return d;
}

function resultText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x.type === 'text' ? x.text : x.type === 'image' ? '[ảnh]' : '')).join('\n');
  return '';
}

// Bỏ phần hệ thống chèn vào lời người dùng (system-reminder, ide_selection...), đổi /lệnh về dạng ngắn.
function cleanUserText(t) {
  t = String(t || '');
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(t);
  if (cmd) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(t);
    return `${cmd[1].trim()}${args && args[1].trim() ? ' ' + args[1].trim() : ''}`;
  }
  t = t.replace(/<(system-reminder|ide_selection|ide_opened_file|local-command-caveat|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g, '');
  return t.trim();
}

// Một message (dòng stream-json hoặc dòng .jsonl) -> danh sách sự kiện. Bỏ message của subagent.
function normalize(m) {
  const out = [];
  // tin từ điện thoại chèn giữa chừng qua PostToolUse được ghi thành attachment hook_blocking_error
  const att = m && !m.isSidechain && m.attachment;
  if (att && att.type === 'hook_blocking_error') {
    const t = String((att.blockingError && att.blockingError.blockingError) || '').trim();
    if (t.startsWith(PHONE_PREFIX)) out.push({ kind: 'user', text: t.slice(PHONE_PREFIX.length).trim(), via: 'phone' });
    return out;
  }
  if (!m || m.parent_tool_use_id || m.isSidechain || !m.message) return out;
  const content = m.message.content;
  if (m.type === 'assistant' && Array.isArray(content)) {
    for (const c of content) {
      if (c.type === 'text' && c.text && c.text.trim()) out.push({ kind: 'assistant', text: c.text });
      else if (c.type === 'tool_use') {
        out.push({ kind: 'tool', id: c.id, name: c.name, summary: toolSummary(c.name, c.input), input: clip(JSON.stringify(c.input ?? {}, null, 1), 4000), ...toolDetail(c.name, c.input) });
      }
    }
  } else if (m.type === 'user' && !m.isMeta) {
    const first = typeof content === 'string' ? content : Array.isArray(content) && content[0] && content[0].type === 'text' ? content[0].text : '';
    if (m.isCompactSummary || /^This session is being continued from a previous conversation/.test(first || '')) {
      out.push({ kind: 'note', text: 'Hội thoại đã được compact' });
      return out;
    }
    const userText = (raw) => {
      // kết quả lệnh / (vd. /context, /cost) nằm trong local-command-stdout
      const so = /<local-command-std(out|err)>([\s\S]*?)<\/local-command-std(?:out|err)>/.exec(raw);
      if (so) { if (so[2].trim()) out.push({ kind: 'output', error: so[1] === 'err', text: clip(so[2].trim(), 6000) }); return; }
      const fb = /^Stop hook feedback:\s*\n?([\s\S]*)$/.exec(String(raw || '').trim());
      if (fb) {
        const msg = fb[1].trim().startsWith(PHONE_PREFIX) ? fb[1].trim().slice(PHONE_PREFIX.length).trim() : fb[1].trim();
        if (msg) out.push({ kind: 'user', text: msg, via: 'phone' });
        return;
      }
      const t = cleanUserText(raw);
      if (!t) return;
      if (t.startsWith('[Request interrupted')) out.push({ kind: 'note', text: 'Đã ngắt' });
      else out.push({ kind: 'user', text: t });
    };
    if (typeof content === 'string') userText(content);
    else if (Array.isArray(content)) {
      for (const c of content) {
        if (c.type === 'tool_result') out.push({ kind: 'tool_result', id: c.tool_use_id, error: !!c.is_error, text: clip(resultText(c.content), 3000) });
        else if (c.type === 'text') userText(c.text);
        else if (c.type === 'image') out.push({ kind: 'user', text: '[ảnh]' });
      }
    }
  }
  return out;
}

// ---------- đọc lịch sử phiên từ ~/.claude/projects ----------

function sessionFile(id) {
  if (!UUID.test(id)) return null;
  let dirs;
  try { dirs = fs.readdirSync(logRoot(), { withFileTypes: true }); } catch { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const f = path.join(logRoot(), d.name, `${id}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function readLines(file, maxBytes) {
  let text;
  try {
    if (maxBytes) {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(maxBytes);
        const n = fs.readSync(fd, buf, 0, maxBytes, 0);
        text = buf.subarray(0, n).toString('utf8');
      } finally { fs.closeSync(fd); }
    } else text = fs.readFileSync(file, 'utf8');
  } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function readTranscript(file, limit = 400) {
  const events = [];
  for (const m of readLines(file)) for (const e of normalize(m)) events.push({ ...e, t: Date.parse(m.timestamp) || 0 });
  return events.slice(-limit);
}

// Thông tin ngắn của một file phiên: cwd, tiêu đề (ai-title, nếu không có thì lời nhắn đầu). Có cache theo mtime.
const metaCache = new Map();
function sessionMeta(file, st) {
  const key = `${st.mtimeMs}:${st.size}`;
  const c = metaCache.get(file);
  if (c && c.key === key) return c.meta;
  const head = readLines(file, st.size > 512e3 ? 160e3 : 0);   // đầu file đủ để lấy cwd + lời nhắn đầu
  let cwd = null, first = null, title = null;
  for (const m of head) {
    if (!cwd && m.cwd && !m.isSidechain) cwd = m.cwd;
    if (m.type === 'ai-title' && m.aiTitle) title = m.aiTitle;
    if (m.type === 'custom-title' && m.customTitle) title = m.customTitle;
    if (!first && m.type === 'user' && !m.isMeta && !m.isSidechain) {
      const u = normalize(m).find((e) => e.kind === 'user');
      if (u) first = u.text;
    }
  }
  if (st.size > 512e3) {   // tiêu đề AI thường nằm ở cuối file
    try {
      const fd = fs.openSync(file, 'r');
      const len = Math.min(256e3, st.size);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.includes('"ai-title"') && !line.includes('"custom-title"')) continue;
        try { const m = JSON.parse(line); title = m.customTitle || m.aiTitle || title; } catch {}
      }
    } catch {}
  }
  const meta = { cwd, title: clip(plain(title || first) || '(chưa có lời nhắn)', 100) };
  metaCache.set(file, { key, meta });
  return meta;
}

function recentSessions(limit = 40) {
  const files = [];
  let dirs;
  try { dirs = fs.readdirSync(logRoot(), { withFileTypes: true }); } catch { return []; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(logRoot(), d.name);
    let list;
    try { list = fs.readdirSync(dir); } catch { continue; }
    for (const n of list) {
      if (!n.endsWith('.jsonl') || !UUID.test(n.slice(0, -6))) continue;
      const f = path.join(dir, n);
      try { const st = fs.statSync(f); if (st.size > 0) files.push({ f, st, id: n.slice(0, -6) }); } catch {}
    }
  }
  files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const out = [];
  for (const x of files) {
    if (out.length >= limit) break;
    const meta = sessionMeta(x.f, x.st);
    if (!meta.cwd) continue;
    out.push({ id: x.id, cwd: meta.cwd, project: path.basename(meta.cwd), title: meta.title, updatedAt: Math.round(x.st.mtimeMs) });
  }
  return out;
}

const dirKey = (p) => String(p || '').toLowerCase().replace(/[\\/]+$/, '');
const sameDir = (a, b) => dirKey(a) === dirKey(b);

// Dự án = thư mục đã mở Claude Code, mới dùng trước; kèm số phiên. Thư mục đã xoá thì bỏ.
function projects(limit = 40) {
  const seen = new Map();
  for (const s of recentSessions(400)) {
    const k = dirKey(s.cwd);
    const p = seen.get(k) || { cwd: s.cwd, name: s.project, lastUsed: s.updatedAt, count: 0, lastTitle: s.title };
    p.count++;
    seen.set(k, p);
  }
  const scratch = dirKey(path.join(os.tmpdir(), 'claude'));   // thư mục nháp của Claude Code: không phải dự án
  return [...seen.values()]
    .filter((p) => !dirKey(p.cwd).startsWith(scratch))
    .filter((p) => { try { return fs.statSync(p.cwd).isDirectory(); } catch { return false; } })
    .slice(0, limit);
}

// Các phiên của một dự án (mới trước).
function projectSessions(cwd, limit = 150) {
  return recentSessions(400).filter((s) => sameDir(s.cwd, cwd)).slice(0, limit);
}

// ---------- phiên ----------

// ---------- cài đặt phiên (model, effort, thinking...) ----------

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// tên trong app -> khoá settings của Claude Code (truyền bằng --settings, đổi giữa phiên bằng apply_flag_settings)
const SETTING_KEYS = { effort: 'effortLevel', thinking: 'alwaysThinkingEnabled', flagSwitch: 'switchModelsOnFlag', fast: 'fastMode', outputStyle: 'outputStyle' };

let userSettingsCache = null;
function userSettings() {
  const now = Date.now();
  if (userSettingsCache && now - userSettingsCache.t < 5000) return userSettingsCache.v;
  let v = {};
  try { v = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json'), 'utf8')) || {}; } catch {}
  userSettingsCache = { t: now, v };
  return v;
}

// Kiểm tra và giữ lại các tuỳ chọn hợp lệ.
function checkOpts(o) {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  if (o.effort != null) {
    if (!EFFORTS.includes(o.effort)) throw new RemoteError('FORMAT', 'Mức effort không hợp lệ');
    out.effort = o.effort;
  }
  for (const k of ['thinking', 'flagSwitch', 'fast']) if (o[k] != null) out[k] = !!o[k];
  if (o.outputStyle != null) {
    if (!/^[\w .-]{1,40}$/.test(String(o.outputStyle))) throw new RemoteError('FORMAT', 'Output style không hợp lệ');
    out.outputStyle = String(o.outputStyle);
  }
  return out;
}

const toFlagSettings = (opts) => Object.fromEntries(Object.entries(opts).map(([k, v]) => [SETTING_KEYS[k], v]));

// Phần cần dùng trong phản hồi initialize của Claude Code.
function pickCaps(x) {
  x = x || {};
  return {
    models: (x.models || []).map((m) => ({
      value: String(m.value), label: String(m.displayName || m.value), description: String(m.description || ''),
      resolved: String(m.resolvedModel || m.value), efforts: m.supportsEffort ? (m.supportedEffortLevels || EFFORTS) : [],
      thinking: !!m.supportsAdaptiveThinking, fast: !!m.supportsFastMode,
    })),
    commands: (x.commands || []).filter((c) => c && c.name && !String(c.name).startsWith('__')).map((c) => ({
      name: String(c.name), description: clip(c.description || '', 200), hint: String(c.argumentHint || ''),
    })),
    outputStyles: Array.isArray(x.available_output_styles) ? x.available_output_styles.map(String) : ['default'],
    account: x.account ? { email: x.account.email || '', plan: x.account.subscriptionType || '' } : null,
    fetchedAt: Date.now(),
  };
}

function killTree(proc) {
  if (!proc || proc.exitCode != null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
  else try { proc.kill('SIGTERM'); } catch {}
}

class Session {
  constructor(id, { cwd, mode = 'default', model = '', known = false, hub, opts = {} }) {
    this.id = id;
    this.opts = checkOpts(opts);   // effort, thinking, flagSwitch, fast, outputStyle (thiếu = theo settings của máy)
    this.caps = null;
    this.cwd = cwd;
    this.mode = MODES.includes(mode) ? mode : 'default';
    this.model = model || '';
    this.known = known;          // đã có file .jsonl -> lần chạy sau dùng --resume
    this.hub = hub;
    this.events = [];
    this.seq = 0;
    this.epoch = crypto.randomBytes(4).toString('hex');
    this.clients = new Set();
    this.pending = new Map();
    this.proc = null;
    this.status = 'off';        // off | starting | idle | running | waiting
    this.inflight = 0;
    this.rate = null;
    this.title = '';
    this.lastText = '';
    this.cost = 0;
    this.updatedAt = Date.now();
    this.restartAfterTurn = false;
    this.afterRestart = null;
    this.stderr = '';
    this.fileStamp = null;
  }

  transcriptFile() {
    const f = sessionFile(this.id);
    if (f) return f;
    const t = this.bridge && this.bridge.transcript;
    return t && fs.existsSync(t) ? t : null;
  }

  // nạp lại lịch sử từ file khi phiên đang tắt (có thể vừa được dùng trong terminal)
  loadTranscript(force = false) {
    if (this.proc) return;
    const f = this.transcriptFile();
    if (!f) return;
    let st;
    try { st = fs.statSync(f); } catch { return; }
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (stamp === this.fileStamp && !force) return;
    this.fileStamp = stamp;
    this.fileOffset = st.size;
    this.tailRest = Buffer.alloc(0);
    this.known = true;
    const meta = sessionMeta(f, st);
    this.cwd = this.cwd || meta.cwd;
    this.title = meta.title;
    this.events = [];
    this.seq = 0;
    this.epoch = crypto.randomBytes(4).toString('hex');
    for (const e of readTranscript(f)) this.store(e, false);
    const last = [...this.events].reverse().find((e) => e.kind === 'assistant');
    if (last) this.lastText = clip(plain(last.text), 160);
    this.updatedAt = Math.round(st.mtimeMs);
    for (const c of this.clients) c.reset();
  }

  // Phiên không do mình chạy (VS Code, terminal): đọc phần mới ghi thêm vào file lịch sử.
  tail() {
    if (this.proc) return;
    const f = this.transcriptFile();
    if (!f) return;
    let st;
    try { st = fs.statSync(f); } catch { return; }
    if (this.fileOffset == null || st.size < this.fileOffset) return this.loadTranscript(true);
    if (st.size === this.fileOffset) return;
    let chunk;
    try {
      const fd = fs.openSync(f, 'r');
      try {
        chunk = Buffer.alloc(st.size - this.fileOffset);
        fs.readSync(fd, chunk, 0, chunk.length, this.fileOffset);
      } finally { fs.closeSync(fd); }
    } catch { return; }
    this.fileOffset = st.size;
    this.fileStamp = `${st.mtimeMs}:${st.size}`;
    this.fileChangedAt = Date.now();
    const buf = Buffer.concat([this.tailRest || Buffer.alloc(0), chunk]);
    const cut = buf.lastIndexOf(10);   // chỉ xử lý dòng đã đủ (\n), phần dở để lần sau
    this.tailRest = cut < 0 ? buf : buf.subarray(cut + 1);
    if (cut < 0) return;
    for (const line of buf.subarray(0, cut).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.type === 'ai-title' && m.aiTitle) this.title = clip(plain(m.aiTitle), 100);
      if (m.type === 'queue-operation' && m.operation === 'enqueue' && this.bridge && this.bridge.parked
        && (Date.parse(m.timestamp) || Date.now()) >= this.bridge.parked.since - 1000) {
        this.release({ action: 'continue' });   // nhường cho tin vừa gõ trong VS Code
        this.bridge.busy = true;
        if (this.bridge.attached) this.attach(false, 'Bạn vừa gõ trên máy — duyệt quyền trả về máy tính');
      }
      for (const e of normalize(m)) {
        if (e.kind === 'user' && this.echo && this.echo.has(e.text)) { this.echo.delete(e.text); continue; }
        this.store({ ...e, t: Date.parse(m.timestamp) || Date.now() });
      }
    }
    this.broadcastState();
  }

  store(e, live = true) {
    const ev = { seq: ++this.seq, t: e.t || Date.now(), ...e };
    delete ev.live;
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    if (ev.kind === 'user' && !this.title) this.title = clip(plain(ev.text), 100);
    if (ev.kind === 'assistant') this.lastText = clip(plain(ev.text), 160);
    if (live) {
      this.updatedAt = Date.now();
      for (const c of this.clients) c.send(ev);
    }
    return ev;
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.broadcastState();
  }

  broadcastState() {
    const st = { kind: 'state', ...this.summary() };
    for (const c of this.clients) c.send(st);
  }

  // 'Default (recommended)' -> tên model thật mà nó trỏ tới (vd. Opus 5.5)
  modelName(info, caps) {
    if (info.value !== 'default') return info.label;
    const real = caps.models.find((m) => m.value !== 'default' && m.resolved === info.resolved);
    return real ? real.label : info.label;
  }

  // Giá trị đang có hiệu lực (tuỳ chọn của phiên, nếu không thì settings.json của máy).
  effective() {
    const us = userSettings();
    const caps = this.caps || this.hub.caps;
    const want = this.model || us.model || 'default';
    const info = caps && caps.models.find((m) => m.value === want || m.resolved === want);
    const perModel = (us.modelSettings && info && us.modelSettings[info.resolved]) || {};
    return {
      model: this.model, modelValue: info ? info.value : want, modelLabel: info ? this.modelName(info, caps) : want === 'default' ? 'Mặc định' : want,
      effort: this.opts.effort ?? perModel.effortLevel ?? us.effortLevel ?? null,
      thinking: this.opts.thinking ?? us.alwaysThinkingEnabled ?? true,
      flagSwitch: this.opts.flagSwitch ?? us.switchModelsOnFlag ?? true,
      fast: this.opts.fast ?? us.fastMode ?? false,
      outputStyle: this.opts.outputStyle ?? us.outputStyle ?? 'default',
    };
  }

  // Trạng thái của phiên đang mở trên máy (suy ra từ hook và file lịch sử).
  externalStatus() {
    const b = this.bridge;
    if (this.pending.size) return 'waiting';
    if (b.parked) return 'idle';
    if (b.busy || Date.now() - (this.fileChangedAt || 0) < 15e3) return 'running';
    return 'idle';   // Claude trên máy đã xong lượt, VS Code vẫn mở
  }

  summary() {
    const ext = !!this.bridge && !this.proc;
    const b = this.bridge;
    return {
      settings: this.effective(), account: this.caps && this.caps.account ? this.caps.account.email : null,
      external: ext, source: ext ? (b.entrypoint === 'claude-vscode' ? 'VS Code' : b.entrypoint === 'cli' ? 'Terminal' : 'Máy tính') : null,
      attached: ext ? b.attached : false, ready: ext ? !!b.parked : false, pcAway: ext ? this.hub.pcAway() : false,
      id: this.id, cwd: this.cwd, project: this.cwd ? path.basename(this.cwd) : '', title: this.title,
      status: ext ? this.externalStatus() : this.status, live: !!this.proc || ext, pending: this.pending.size, mode: this.mode, model: this.model,
      rate: this.rate, cost: this.cost, lastText: this.lastText, updatedAt: this.updatedAt, epoch: this.epoch,
      lastSeq: this.seq, watching: this.clients.size,
      thinking: this.thinking ? { tokens: this.thinking.tokens, since: this.thinking.since } : null,
    };
  }

  write(obj) {
    if (!this.proc || !this.proc.stdin.writable) return false;
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }

  start() {
    if (this.proc) return;
    const bin = findClaude();
    if (!bin) throw new RemoteError('NO_CLAUDE', 'Không tìm thấy lệnh claude trên máy (đặt biến CLAUDE_BIN)', 500);
    try { if (!fs.statSync(this.cwd).isDirectory()) throw new Error(); } catch {
      throw new RemoteError('NO_CWD', `Thư mục không tồn tại: ${this.cwd}`);
    }
    if (!this.known && sessionFile(this.id)) this.known = true;
    const args = [...bin.pre, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-prompt-tool', 'stdio', '--permission-mode', this.mode,
      ...(this.model ? ['--model', this.model] : []),
      ...(Object.keys(this.opts).length ? ['--settings', JSON.stringify(toFlagSettings(this.opts))] : []),
      ...(this.known ? ['--resume', this.id] : ['--session-id', this.id])];
    const env = { ...process.env, CC_REMOTE_CHILD: '1' };   // hook.js bỏ qua phiên do mình chạy
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
    const proc = spawn(bin.cmd, args, { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    this.stderr = '';
    this.inflight = 0;
    this.setStatus('starting');
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        try { this.onMessage(m); } catch (err) { console.error('remote:', err.message); }
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    proc.stdin.on('error', () => {});
    proc.on('error', (err) => { this.store({ kind: 'error', text: `Không chạy được claude: ${err.message}` }); this.onExit(null); });
    proc.on('exit', (code) => this.onExit(code));
    // hỏi danh sách model, lệnh /, output style, tài khoản đang dùng
    this.write({ type: 'control_request', request_id: `init-${Date.now()}`, request: { subtype: 'initialize' } });
  }

  onExit(code) {
    if (!this.proc) return;
    const wasBusy = this.inflight > 0 || this.status === 'running' || this.status === 'waiting';
    this.proc = null;
    this.inflight = 0;
    for (const id of this.pending.keys()) this.store({ kind: 'decided', requestId: id, decision: 'cancel' });
    this.pending.clear();
    if (code && !this.stopping) {
      const tail = this.stderr.trim().split('\n').slice(-3).join('\n');
      this.store({ kind: 'error', text: `Claude dừng (mã ${code})${tail ? `: ${clip(tail, 600)}` : ''}` });
    } else if (wasBusy && !this.stopping) this.store({ kind: 'note', text: 'Tiến trình Claude đã dừng' });
    this.stopping = false;
    const f = sessionFile(this.id);
    if (f) {   // file vừa do chính tiến trình này ghi -> không cần nạp lại (giữ sự kiện duyệt quyền, kết quả...)
      this.known = true;
      try { const st = fs.statSync(f); this.fileStamp = `${st.mtimeMs}:${st.size}`; } catch {}
    }
    this.setStatus('off');
    if (this.afterRestart) {
      const fn = this.afterRestart;
      this.afterRestart = null;
      fn();
    }
  }

  // Sự kiện tức thời (không lưu, không phát lại): tiến độ suy nghĩ cho dòng "Thinking… · N tokens".
  sendLive(ev) { for (const c of this.clients) c.send(ev); }

  // Hết đoạn suy nghĩ -> để lại dòng "Thought for Xs" như VS Code.
  endThinking() {
    if (!this.thinking) return;
    const t = this.thinking;
    this.thinking = null;
    this.sendLive({ kind: 'progress', phase: 'working' });
    this.store({ kind: 'thought', seconds: Math.max(1, Math.round((Date.now() - t.since) / 1000)), tokens: t.tokens });
  }

  onMessage(m) {
    if (m.type === 'system' && m.subtype === 'thinking_tokens') {
      if (!this.thinking) this.thinking = { since: Date.now(), tokens: 0 };
      this.thinking.tokens = m.estimated_tokens || this.thinking.tokens;
      this.sendLive({ kind: 'progress', phase: 'thinking', tokens: this.thinking.tokens, since: this.thinking.since });
      if (this.status !== 'waiting') this.setStatus('running');
      return;
    }
    if (m.type === 'system' && m.subtype === 'init') {
      this.known = true;
      if (m.permissionMode && MODES.includes(m.permissionMode)) this.mode = m.permissionMode;
      if (this.status === 'starting') this.setStatus(this.inflight > 0 ? 'running' : 'idle');
      return;
    }
    if (m.type === 'system' && m.subtype === 'status' && m.status === 'compacting') {
      this.store({ kind: 'note', text: 'Đang compact hội thoại…' });
      this.setStatus('running');
      return;
    }
    if (m.type === 'system' && m.subtype === 'status' && m.permissionMode && MODES.includes(m.permissionMode)) {
      this.mode = m.permissionMode;
      this.broadcastState();
      return;
    }
    if (m.type === 'rate_limit_event' && m.rate_limit_info) {
      const r = m.rate_limit_info;
      const w = r.unifiedWindows || {};
      const pct = (x) => (x && x.utilization != null ? Math.round(x.utilization * 1000) / 10 : null);
      this.rate = {
        status: r.status, type: r.rateLimitType || null, resetsAt: r.resetsAt ? r.resetsAt * 1000 : null,
        fiveHour: pct(w.five_hour), sevenDay: pct(w.seven_day),
      };
      this.broadcastState();
      if (r.status === 'rejected') this.onLimit();
      return;
    }
    if (m.type === 'control_request') return this.onControl(m);
    if (m.type === 'control_cancel_request') {
      if (this.pending.delete(m.request_id)) this.store({ kind: 'decided', requestId: m.request_id, decision: 'cancel' });
      this.refreshStatus();
      return;
    }
    if (m.type === 'control_response') {
      const r = m.response || {};
      if (String(r.request_id || '').startsWith('init-')) {
        if (r.subtype === 'success') { this.caps = pickCaps(r.response); this.hub.caps = this.caps; this.broadcastState(); }
        return;
      }
      if (r.subtype === 'error') this.store({ kind: 'error', text: `Lệnh điều khiển lỗi: ${clip(r.error, 300)}` });
      return;
    }
    if (m.type === 'result') {
      this.endThinking();
      this.inflight = Math.max(0, this.inflight - 1);
      if (typeof m.total_cost_usd === 'number') this.cost += m.total_cost_usd;
      const ok = !m.is_error;
      const aborted = m.terminal_reason === 'aborted_streaming' || m.subtype === 'error_during_execution';
      const text = ok ? '' : clip(typeof m.result === 'string' ? m.result : (m.errors || []).join('\n') || m.subtype, 600);
      this.store({ kind: 'result', ok, aborted, cost: m.total_cost_usd || 0, ms: m.duration_ms || 0, turns: m.num_turns || 0, text });
      if (!ok && !aborted && /limit|rate/i.test(text)) this.onLimit(text);
      if (this.inflight === 0 && this.clients.size === 0 && !aborted) {
        this.hub.notify(ok ? `Xong · ${this.label()}` : `Lỗi · ${this.label()}`, clip(ok ? this.lastText : text, 180), this.id);
      }
      this.refreshStatus();
      if (this.inflight === 0 && this.restartAfterTurn) { this.restartAfterTurn = false; this.restart(); }
      return;
    }
    const evs = normalize(m);
    if (evs.length) this.endThinking();
    if (evs.length && this.status !== 'waiting') this.setStatus('running');
    for (const e of evs) this.store(e);
  }

  label() { return this.title ? clip(this.title, 40) : path.basename(this.cwd || '') || this.id.slice(0, 8); }

  onLimit(text) {
    if (this.limitNotified && Date.now() - this.limitNotified < 10 * MIN) return;
    this.limitNotified = Date.now();
    const best = this.hub.suggestAccount();
    this.store({ kind: 'limit', text: text || 'Tài khoản đang dùng đã hết hạn mức', suggest: best });
    this.hub.notify(`Hết hạn mức · ${this.label()}`, best ? `Có thể đổi sang ${best.name}` : 'Không còn tài khoản khác', this.id);
  }

  onControl(m) {
    const r = m.request || {};
    if (r.subtype !== 'can_use_tool') {
      this.write({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: `Không hỗ trợ ${r.subtype}` } });
      return;
    }
    this.askPermission({
      requestId: m.request_id, tool: r.tool_name, input: r.input || {}, suggestions: r.permission_suggestions,
      toolUseId: r.tool_use_id || null, reason: r.decision_reason || r.description || '',
    });
  }

  // p: { requestId, tool, input, suggestions, toolUseId, reason, hook? (kết nối của hook đang chờ) }
  askPermission(p) {
    p.suggestions = Array.isArray(p.suggestions) ? p.suggestions : [];
    this.pending.set(p.requestId, p);
    const ev = {
      kind: 'permission', requestId: p.requestId, tool: p.tool, summary: toolSummary(p.tool, p.input),
      input: clip(JSON.stringify(p.input, null, 1), 6000), canAlways: p.suggestions.length > 0, toolUseId: p.toolUseId || null,
      reason: p.reason || '',
    };
    if (p.tool === 'AskUserQuestion' && Array.isArray(p.input.questions)) {
      ev.questions = p.input.questions.map((q) => ({
        question: String(q.question || ''), header: String(q.header || ''), multiSelect: !!q.multiSelect,
        options: (q.options || []).map((o) => ({ label: String(o.label || ''), description: String(o.description || '') })),
      }));
    }
    if (p.tool === 'ExitPlanMode' && typeof p.input.plan === 'string') ev.plan = clip(p.input.plan, 20000);
    this.store(ev);
    this.setStatus('waiting');
    if (this.clients.size === 0) {
      const what = p.tool === 'AskUserQuestion' ? 'Claude đang hỏi bạn' : p.tool === 'ExitPlanMode' ? 'Kế hoạch chờ duyệt' : `Cần duyệt ${p.tool}`;
      this.hub.notify(`${what} · ${this.label()}`, clip(ev.summary, 140), this.id);
    }
  }

  refreshStatus() {
    if (this.bridge && !this.proc) return this.broadcastState();
    if (!this.proc) return this.setStatus('off');
    if (this.pending.size) return this.setStatus('waiting');
    this.setStatus(this.inflight > 0 ? 'running' : 'idle');
  }

  send(text) {
    text = String(text || '').trim();
    if (!text) throw new RemoteError('EMPTY', 'Tin nhắn trống');
    if (text.length > 100e3) throw new RemoteError('TOO_LONG', 'Tin nhắn quá dài');
    if (this.bridge && !this.proc) return this.sendExternal(text);
    this.start();
    this.store({ kind: 'user', text });
    this.inflight++;
    this.write({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: this.id });
    if (this.status !== 'starting' && this.status !== 'waiting') this.setStatus('running');
  }

  // ---- phiên đang mở trên máy (qua hook.js) ----

  // Gửi tin vào phiên trên máy: hook Stop đang chờ thì đưa ngay, không thì xếp hàng tới lần Claude xong lượt.
  sendExternal(text) {
    const b = this.bridge;
    if (!b.attached) this.attach(true);
    this.store({ kind: 'user', text });
    (this.echo ||= new Set()).add(text);
    if (b.parked) {
      this.release({ action: 'message', text: phoneMessage(text) });
      b.busy = true;
    } else {
      b.queue.push(text);
      this.store({ kind: 'note', text: b.busy
        ? 'Sẽ chèn vào ngay sau bước Claude đang làm'
        : 'Phiên trên máy chưa sẵn sàng (hook đã bị dừng hoặc phiên mở trước khi cài): gõ một tin bất kỳ trong VS Code, xong lượt đó tin này sẽ được gửi' });
    }
    this.broadcastState();
  }

  // Trả lời hook Stop đang chờ (nếu có).
  release(reply) {
    const b = this.bridge;
    if (!b || !b.parked) return false;
    const w = b.parked;
    b.parked = null;
    clearInterval(w.keepAlive);
    try { w.res.end(JSON.stringify(reply)); } catch {}
    return true;
  }

  // Bật/tắt điều khiển phiên trên máy từ điện thoại.
  attach(on, reason) {
    const b = this.bridge;
    if (!b) throw new RemoteError('NOT_EXTERNAL', 'Phiên này không mở trên máy tính');
    on = !!on;
    if (b.attached === on) return;
    b.attached = on;
    if (on) {
      this.store({ kind: 'note', text: 'Đang điều khiển phiên trên máy từ điện thoại' });
    } else {
      if (!alwaysOn()) { this.release({ action: 'continue' }); b.queue = []; }
      // quyền đang chờ: trả về hộp thoại trên máy
      for (const [id, p] of this.pending) {
        if (!p.hook) continue;
        this.pending.delete(id);
        clearInterval(p.hook.keepAlive);
        try { p.hook.res.end(JSON.stringify({ decision: null })); } catch {}
        this.store({ kind: 'decided', requestId: id, decision: 'cancel' });
      }
      this.store({ kind: 'note', text: reason || 'Đã thả phiên về máy tính' });
    }
    this.broadcastState();
  }

  decide(requestId, { decision, answers, message } = {}) {
    const p = this.pending.get(requestId);
    if (!p) throw new RemoteError('NOT_PENDING', 'Yêu cầu này đã được xử lý hoặc đã huỷ', 409);
    let response;
    if (decision === 'deny') {
      response = { behavior: 'deny', message: String(message || 'Người dùng từ chối từ điện thoại').slice(0, 2000) };
    } else if (decision === 'allow' || decision === 'always') {
      const updatedInput = { ...p.input };
      if (answers && typeof answers === 'object') updatedInput.answers = answers;
      response = { behavior: 'allow', updatedInput };
      if (decision === 'always' && p.suggestions.length) response.updatedPermissions = p.suggestions;
    } else throw new RemoteError('FORMAT', 'decision phải là allow, always hoặc deny');
    this.pending.delete(requestId);
    if (p.hook) {   // xin quyền từ phiên trên máy: trả cho hook.js
      clearInterval(p.hook.keepAlive);
      try { p.hook.res.end(JSON.stringify({ decision: response })); } catch {}
      if (this.bridge) this.bridge.busy = true;
    } else this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    this.store({ kind: 'decided', requestId, decision, ...(answers ? { answers } : {}) });
    this.refreshStatus();
  }

  interrupt() {
    if (this.bridge && !this.proc) {   // phiên trên máy: dừng ở lần xin quyền đang chờ, hoặc ngay trước/sau tool kế tiếp
      let stopped = false;
      for (const [id, p] of [...this.pending]) {
        if (!p.hook) continue;
        this.pending.delete(id);
        clearInterval(p.hook.keepAlive);
        try { p.hook.res.end(JSON.stringify({ decision: { behavior: 'deny', message: 'Người dùng đã ngắt từ điện thoại', interrupt: true } })); } catch {}
        this.store({ kind: 'decided', requestId: id, decision: 'deny' });
        stopped = true;
      }
      if (!stopped && !this.bridge.parked) {
        this.bridge.stopReq = true;
        this.store({ kind: 'note', text: 'Đang dừng — Claude sẽ dừng ngay ở bước kế tiếp' });
      }
      return this.broadcastState();
    }
    if (!this.proc) return;
    for (const id of [...this.pending.keys()]) this.decide(id, { decision: 'deny', message: 'Người dùng đã ngắt' });
    this.write({ type: 'control_request', request_id: `int-${Date.now()}`, request: { subtype: 'interrupt' } });
  }

  setMode(mode) {
    if (!MODES.includes(mode)) throw new RemoteError('FORMAT', 'Chế độ quyền không hợp lệ');
    this.mode = mode;
    if (this.proc) this.write({ type: 'control_request', request_id: `mode-${Date.now()}`, request: { subtype: 'set_permission_mode', mode } });
    this.broadcastState();
  }

  setModel(model) {
    model = String(model || '').trim();
    if (model && !/^[\w.[\]-]{1,80}$/.test(model)) throw new RemoteError('FORMAT', 'Tên model không hợp lệ');
    this.model = model;
    if (this.proc) this.write({ type: 'control_request', request_id: `model-${Date.now()}`, request: { subtype: 'set_model', model: model || 'default' } });
    this.broadcastState();
  }

  // Đổi nhiều cài đặt một lần: { model, mode, effort, thinking, flagSwitch, fast, outputStyle }
  applySettings(patch = {}) {
    const opts = checkOpts(patch);
    if (patch.model !== undefined) this.setModel(patch.model);
    if (patch.mode !== undefined) this.setMode(patch.mode);
    if (!Object.keys(opts).length) return;
    Object.assign(this.opts, opts);
    if (this.proc) this.write({ type: 'control_request', request_id: `set-${Date.now()}`, request: { subtype: 'apply_flag_settings', settings: toFlagSettings(opts) } });
    this.broadcastState();
  }

  close() {
    if (this.bridge && !this.proc) return this.attach(false);
    if (!this.proc) return;
    this.stopping = true;
    const proc = this.proc;
    if (this.inflight > 0 || this.pending.size) this.interrupt();
    try { proc.stdin.end(); } catch {}
    setTimeout(() => killTree(proc), 5000).unref();
  }

  // Tắt tiến trình để lần chạy sau đọc lại đăng nhập (sau khi đổi tài khoản). then: chạy sau khi đã tắt.
  restart(then) {
    if (!this.proc) { if (then) then(); return; }
    if (then) this.afterRestart = then;
    this.close();
  }
}

// Mở claude (không gửi tin nhắn nào, không tốn token) chỉ để lấy phản hồi initialize.
function probeCaps(timeout = 25e3) {
  const bin = findClaude();
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
    let proc;
    try {
      proc = spawn(bin.cmd, [...bin.pre, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'],
        { cwd: os.homedir(), env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch { return resolve(null); }
    let buf = '', done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); try { proc.stdin.end(); } catch {} setTimeout(() => killTree(proc), 2000).unref(); resolve(v); };
    const t = setTimeout(() => finish(null), timeout);
    proc.on('error', () => finish(null));
    proc.on('exit', () => finish(null));
    proc.stdin.on('error', () => {});
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.type === 'control_response' && m.response && m.response.request_id === 'caps') {
          finish(m.response.subtype === 'success' ? pickCaps(m.response.response) : null);
        }
      }
    });
    proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'caps', request: { subtype: 'initialize' } }) + '\n');
  });
}

// ---------- hub: giữ các phiên, nối với tracker ----------

function createHub(ctx = {}) {
  const sessions = new Map();
  let accountsCache = null;

  const accountsInfo = () => {
    const now = Date.now();
    if (accountsCache && now - accountsCache.t < 10e3) return accountsCache.v;
    let v = null;
    try { v = ctx.accounts ? ctx.accounts() : null; } catch (err) { v = { error: err.message }; }
    accountsCache = { t: now, v };
    return v;
  };

  let capsPending = null;
  const hub = {
    sessions,
    caps: null,
    // Danh sách model / lệnh / output style: lấy từ phiên gần nhất, nếu chưa có thì mở nhanh một tiến trình claude để hỏi.
    async capabilities() {
      if (hub.caps && Date.now() - hub.caps.fetchedAt < 30 * MIN) return hub.caps;
      if (!capsPending) {
        capsPending = probeCaps().then((c) => { if (c) hub.caps = c; return hub.caps; }).finally(() => { capsPending = null; });
      }
      return capsPending;
    },
    defaults() {
      return new Session('00000000-0000-0000-0000-000000000000', { hub }).effective();
    },
    notify: (title, body, sid) => (ctx.notify || notify)(title, body, sid),
    // Phiên trên máy vừa gọi hook: tạo/cập nhật cầu nối.
    bridgeFor(b) {
      const id = String(b.session_id || '').toLowerCase();
      if (!UUID.test(id)) throw new RemoteError('FORMAT', 'session_id không hợp lệ');
      let s = sessions.get(id);
      if (!s) {
        s = new Session(id, { known: true, hub, cwd: b.cwd || undefined });
        sessions.set(id, s);
      }
      if (!s.bridge) s.bridge = { attached: false, parked: null, queue: [], busy: false, lastSeen: 0, entrypoint: '', transcript: '' };
      Object.assign(s.bridge, { lastSeen: Date.now(), entrypoint: String(b.entrypoint || s.bridge.entrypoint || '') });
      if (b.transcript_path) s.bridge.transcript = String(b.transcript_path);
      if (!s.cwd && b.cwd) s.cwd = String(b.cwd);
      if (s.fileOffset == null) {
        if (!s.events.length) s.loadTranscript(true);
        else {   // đã có sự kiện (vd. tin vừa gửi) -> không nạp lại để khỏi mất, chỉ theo dõi từ cuối file
          const f = s.transcriptFile();
          try { if (f) { s.fileOffset = fs.statSync(f).size; s.tailRest = Buffer.alloc(0); } } catch {}
        }
      }
      return s;
    },
    // Hook Stop: không gắn điện thoại -> cho qua; có tin xếp hàng -> đưa luôn; không thì giữ kết nối tới khi có tin.
    hookStop(b, req, res) {
      const s = hub.bridgeFor(b);
      const br = s.bridge;
      br.busy = false;
      br.stopReq = false;   // lượt đã kết thúc: không còn gì để dừng
      s.tail();
      if (!br.attached && !alwaysOn()) { s.broadcastState(); return res.end(JSON.stringify({ action: 'continue' })); }
      if (br.queue.length) {
        br.busy = true;
        s.broadcastState();
        return res.end(JSON.stringify({ action: 'message', text: phoneMessage(br.queue.shift()) }));
      }
      s.release({ action: 'continue' });   // hook cũ còn treo (hiếm) -> thả
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      const w = { res, since: Date.now(), keepAlive: setInterval(() => { try { res.write(' '); } catch {} }, 20e3) };
      br.parked = w;
      req.on('close', () => {
        if (br.parked === w) { br.parked = null; clearInterval(w.keepAlive); s.broadcastState(); }
      });
      s.broadcastState();
      // báo khi người dùng không ở máy (đang điều khiển từ điện thoại hoặc máy để yên)
      if (s.clients.size === 0 && (br.attached || hub.pcAway())) hub.notify(`Xong · ${s.label()}`, clip(b.last || s.lastText, 180), s.id);
    },
    // Hook PermissionRequest: điện thoại đang điều khiển hoặc người dùng đã rời máy -> hỏi trên điện thoại;
    // đang ngồi ở máy -> để VS Code hỏi như thường.
    hookPermission(b, req, res) {
      const s = hub.bridgeFor(b);
      if (!s.bridge.attached && !hub.pcAway()) return res.end(JSON.stringify({ decision: null }));
      s.tail();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      const hook = { res, keepAlive: setInterval(() => { try { res.write(' '); } catch {} }, 20e3) };
      const requestId = `hook-${crypto.randomBytes(6).toString('hex')}`;
      s.askPermission({ requestId, tool: String(b.tool_name || 'Tool'), input: b.tool_input || {}, suggestions: b.permission_suggestions, hook });
      req.on('close', () => {
        clearInterval(hook.keepAlive);
        if (s.pending.get(requestId) === undefined) return;
        s.pending.delete(requestId);   // trên máy đã trả lời / bấm dừng
        s.store({ kind: 'decided', requestId, decision: 'cancel' });
        s.broadcastState();
      });
    },
    // Hook UserPromptSubmit: /phone -> chuyển sang điện thoại; gõ tin khác ở máy -> thả về máy.
    // Hook PreToolUse / PostToolUse: điện thoại bấm dừng -> dừng; có tin đang chờ -> chèn ngay sau tool vừa chạy.
    hookTool(b, pre) {
      const s = hub.bridgeFor(b);
      const br = s.bridge;
      br.busy = true;
      s.fileChangedAt = Date.now();
      if (br.stopReq) {
        br.stopReq = false;
        s.store({ kind: 'note', text: 'Đã dừng theo yêu cầu từ điện thoại' });
        s.broadcastState();
        return { stop: true, reason: 'Người dùng đã bấm dừng từ điện thoại (CC Remote)' };
      }
      if (!pre && br.queue.length) {
        const text = br.queue.shift();
        if (!br.attached) s.attach(true);
        s.broadcastState();
        return { inject: phoneMessage(text) };
      }
      return {};
    },
    hookPrompt(b) {
      const s = hub.bridgeFor(b);
      const p = String(b.prompt || '');
      s.bridge.busy = true;
      if (/^\s*\/phone\b/i.test(p) || p.includes('[[cc-remote:phone]]')) s.attach(true);
      else if (s.bridge.attached) s.attach(false, 'Bạn vừa gõ trên máy — đã thả phiên về máy tính');
      else s.broadcastState();
      return { ok: true };
    },
    // Thời gian máy không có thao tác (ms), do idleWatcher cập nhật; null = không biết (không phải Windows).
    idleMs: null,
    pcAway() { return hub.idleMs != null && hub.idleMs >= AWAY_MS; },
    setIdle(ms) {
      const wasAway = hub.pcAway();
      hub.idleMs = ms;
      // vừa quay lại máy: quyền đang hỏi trên điện thoại (do rời máy, không phải đang điều khiển) -> trả về VS Code
      if (ms != null && ms < 3000) {
        for (const s of sessions.values()) {
          if (!s.bridge || s.bridge.attached) continue;
          for (const [id, p] of [...s.pending]) {
            if (!p.hook) continue;
            s.pending.delete(id);
            clearInterval(p.hook.keepAlive);
            try { p.hook.res.end(JSON.stringify({ decision: null })); } catch {}
            s.store({ kind: 'decided', requestId: id, decision: 'cancel' });
            s.store({ kind: 'note', text: 'Bạn đã quay lại máy — hỏi quyền trên VS Code' });
            s.broadcastState();
          }
        }
      }
      if (wasAway !== hub.pcAway()) for (const s of sessions.values()) if (s.bridge) s.broadcastState();
    },
    suggestAccount() {
      const info = accountsInfo();
      const a = info && info.accounts && info.accounts.find((x) => x.suggested);
      return a ? { id: a.id, name: a.name } : null;
    },
    get(id, { load = true } = {}) {
      let s = sessions.get(id);
      if (!s) {
        if (!sessionFile(id)) return null;
        s = new Session(id, { known: true, hub });
        sessions.set(id, s);
        load = true;
      }
      if (load) s.loadTranscript();
      return s;
    },
    create({ cwd, text, mode, model, ...opts }) {
      cwd = String(cwd || '').trim();
      if (!cwd || !path.isAbsolute(cwd)) throw new RemoteError('NO_CWD', 'Cần đường dẫn thư mục đầy đủ');
      const id = crypto.randomUUID();
      const s = new Session(id, { cwd: path.resolve(cwd), mode, model, hub, opts });
      if (model) s.setModel(model);
      sessions.set(id, s);
      try { s.send(text); } catch (err) { sessions.delete(id); throw err; }
      return s;
    },
    state() {
      const info = accountsInfo();
      const recentBridge = (s) => s.bridge && (s.bridge.attached || Date.now() - Math.max(s.bridge.lastSeen, s.fileChangedAt || 0) < 30 * 60e3);
      const live = [...sessions.values()].filter((s) => s.proc || s.pending.size || recentBridge(s)).map((s) => s.summary())
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const liveIds = new Set(live.map((s) => s.id));
      return {
        version: VERSION, host: os.hostname(), now: Date.now(),
        live,
        recent: recentSessions(40).filter((s) => !liveIds.has(s.id)),
        projects: projects(40).map((p) => ({ ...p, live: live.filter((l) => sameDir(l.cwd, p.cwd)).length })),
        accounts: info && info.accounts ? {
          active: info.active, conflict: !!info.conflict,
          list: info.accounts.map((a) => ({
            id: a.id, name: a.name, email: a.email, plan: a.plan, active: a.id === info.active,
            suggested: !!a.suggested, loginState: a.loginState, stale: !!a.stale, error: a.error || null,
            fiveHour: a.usage && a.usage.fiveHour, sevenDay: a.usage && a.usage.sevenDay,
            costToday: a.costToday || 0,
          })),
        } : null,
        ntfy: load().ntfy,
        alwaysOn: alwaysOn(), pcAway: hub.pcAway(),
      };
    },
    // Đổi tài khoản rồi khởi động lại các phiên đang chạy (phiên đang làm dở thì đợi xong lượt).
    switchAccount(id, { sessionId, text } = {}) {
      if (!ctx.switchAccount) throw new RemoteError('UNSUPPORTED', 'Không đổi được tài khoản ở chế độ này', 500);
      const r = ctx.switchAccount(id);
      accountsCache = null;
      const restarted = [];
      for (const s of sessions.values()) {
        if (!s.proc) continue;
        if (s.id === sessionId || s.status === 'idle' || s.status === 'starting') {
          s.store({ kind: 'note', text: 'Đã đổi tài khoản — khởi động lại phiên' });
          s.restart();
          restarted.push(s.id);
        } else s.restartAfterTurn = true;
      }
      if (sessionId && text) {
        const s = hub.get(sessionId, { load: false });
        if (s) {
          const go = () => { try { s.send(text); } catch (err) { s.store({ kind: 'error', text: err.message }); } };
          if (s.proc) s.afterRestart = go; else go();
        }
      }
      return { ok: true, to: r && r.to, restarted, running: (r && r.running ? r.running.length : 0) };
    },
    sweep(now = Date.now()) {
      for (const s of sessions.values()) {
        const quiet = s.clients.size === 0 && now - s.updatedAt > IDLE_CLOSE_MS;
        if (s.proc && quiet && s.status === 'idle') s.close();
        else if (!s.proc && !s.pending.size && !s.bridge && s.clients.size === 0 && now - s.updatedAt > DORMANT_DROP_MS) sessions.delete(s.id);
      }
    },
    shutdown() {
      clearInterval(tailTimer);
      for (const s of sessions.values()) {
        if (s.proc) killTree(s.proc);
        if (s.bridge) s.release({ action: 'continue' });
      }
    },
  };
  // phiên không do mình chạy mà có người xem / đang gắn điện thoại: đọc phần mới của file lịch sử
  const tailTimer = setInterval(() => {
    for (const s of sessions.values()) if (!s.proc && (s.clients.size || (s.bridge && (s.bridge.attached || s.bridge.parked)))) s.tail();
  }, 700);
  tailTimer.unref();
  return hub;
}

// ---------- HTTP ----------

function readBody(req, limit = 256e3) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { d += c; if (d.length > limit) { reject(new RemoteError('TOO_LARGE', 'Nội dung quá lớn', 413)); req.destroy(); } });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

async function jsonBody(req) {
  const t = await readBody(req);
  if (!t) return {};
  let b;
  try { b = JSON.parse(t); } catch { throw new RemoteError('FORMAT', 'Nội dung gửi lên không phải JSON hợp lệ'); }
  return b && typeof b === 'object' ? b : {};
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function createRemoteServer(hub) {
  try { hookKey(); } catch {}   // để hook.js đọc được khoá ngay từ lần đầu
  const send = (res, code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };

  function stream(req, res, s, after, epoch) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.socket && res.socket.setNoDelay(true);
    const write = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    const client = {
      send: write,
      reset: () => { write({ kind: 'reset', epoch: s.epoch }); for (const e of s.events) write(e); write({ kind: 'state', ...s.summary() }); },
    };
    if (epoch !== s.epoch) client.reset();
    else {
      for (const e of s.events) if (e.seq > after) write(e);
      write({ kind: 'state', ...s.summary() });
    }
    s.clients.add(client);
    s.broadcastState();
    const hb = setInterval(() => res.write(': hb\n\n'), HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(hb);
      s.clients.delete(client);
      s.updatedAt = Math.max(s.updatedAt, Date.now() - IDLE_CLOSE_MS / 2);   // vừa có người xem -> chưa tắt ngay
      s.broadcastState();
    });
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (p === '/v1/ping') {
        const authed = !!authDevice(bearer(req));
        return send(res, 200, { ok: true, app: 'theo-doi-token', version: VERSION, authed, ...(authed ? { host: os.hostname() } : {}) });
      }
      if (p === '/v1/pair' && req.method === 'POST') {
        const b = await jsonBody(req);
        return send(res, 200, { ...pair(String(b.code || '').trim(), b.name), host: os.hostname() });
      }
      if (!p.startsWith('/v1/')) return send(res, 404, { error: 'NOT_FOUND', message: 'Không có' });
      const hm = /^\/v1\/hook\/(stop|permission|prompt|tool|pretool)$/.exec(p);
      if (hm && req.method === 'POST') {
        const key = String(req.headers['x-hook-key'] || '');
        const want = hookKey();
        const ok = LOOPBACK.has(req.socket.remoteAddress) && key.length === want.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(want));
        if (!ok) return send(res, 403, { error: 'FORBIDDEN', message: 'Sai khoá hook' });
        const b = await jsonBody(req);
        if (hm[1] === 'stop') return hub.hookStop(b, req, res);
        if (hm[1] === 'permission') return hub.hookPermission(b, req, res);
        if (hm[1] === 'tool' || hm[1] === 'pretool') return send(res, 200, hub.hookTool(b, hm[1] === 'pretool'));
        return send(res, 200, hub.hookPrompt(b));
      }
      const dev = authDevice(bearer(req));
      if (!dev) return send(res, 401, { error: 'UNAUTHORIZED', message: 'Thiết bị chưa ghép hoặc đã bị thu hồi' });

      if (p === '/v1/state' && req.method === 'GET') return send(res, 200, hub.state());
      if (p === '/v1/projects' && req.method === 'GET') return send(res, 200, projects());
      if (p === '/v1/projects/sessions' && req.method === 'GET') {
        const cwd = url.searchParams.get('cwd') || '';
        if (!cwd) return send(res, 400, { error: 'FORMAT', message: 'Thiếu cwd' });
        return send(res, 200, projectSessions(cwd));
      }
      if (p === '/v1/capabilities' && req.method === 'GET') {
        const caps = await hub.capabilities();
        return send(res, 200, { ...(caps || { models: [], commands: [], outputStyles: ['default'], account: null }), efforts: EFFORTS, defaults: hub.defaults() });
      }
      if (p === '/v1/sessions' && req.method === 'POST') {
        const b = await jsonBody(req);
        return send(res, 200, hub.create(b).summary());
      }
      if (p === '/v1/accounts/switch' && req.method === 'POST') {
        const b = await jsonBody(req);
        return send(res, 200, hub.switchAccount(String(b.id || ''), { sessionId: b.sessionId, text: b.text }));
      }
      if (p === '/v1/ntfy' && req.method === 'POST') return send(res, 200, { ntfy: setNtfy(await jsonBody(req)) });
      if (p === '/v1/always-on' && req.method === 'POST') return send(res, 200, { alwaysOn: setAlwaysOn((await jsonBody(req)).on !== false) });
      if (p === '/v1/ntfy/test' && req.method === 'POST') {
        return send(res, 200, { ok: await hub.notify('CC Remote', 'Thông báo hoạt động bình thường', null) });
      }

      const m = /^\/v1\/sessions\/([0-9a-f-]{36})(?:\/(events|send|permission|interrupt|mode|model|settings|attach|close))?$/i.exec(p);
      if (!m) return send(res, 404, { error: 'NOT_FOUND', message: 'Không có' });
      const s = hub.get(m[1].toLowerCase(), { load: !m[2] || m[2] === 'events' });
      if (!s) return send(res, 404, { error: 'NOT_FOUND', message: 'Không tìm thấy phiên' });
      const action = m[2];
      if (!action && req.method === 'GET') return send(res, 200, s.summary());
      if (action === 'events' && req.method === 'GET') {
        return stream(req, res, s, Number(url.searchParams.get('after')) || 0, url.searchParams.get('epoch') || '');
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'METHOD', message: 'Sai phương thức' });
      const b = await jsonBody(req);
      if (action === 'send') s.send(b.text);
      else if (action === 'permission') s.decide(String(b.requestId || ''), b);
      else if (action === 'interrupt') s.interrupt();
      else if (action === 'mode') s.setMode(b.mode);
      else if (action === 'model') s.setModel(b.model);
      else if (action === 'settings') s.applySettings(b);
      else if (action === 'attach') s.attach(b.on !== false);
      else if (action === 'close') s.close();
      return send(res, 200, s.summary());
    } catch (err) {
      if (err instanceof RemoteError) return send(res, err.status, { error: err.code, message: err.message });
      console.error('remote:', err);
      send(res, 500, { error: 'INTERNAL', message: String(err.message || err) });
    }
  });
}

// In thời gian máy không có thao tác (GetLastInputInfo) mỗi 2 giây; dùng để biết người dùng còn ngồi ở máy không.
function startIdleWatcher(hub) {
  if (process.platform !== 'win32') return null;
  const script = [
    'Add-Type @"',
    'using System; using System.Runtime.InteropServices;',
    'public static class CCIdle {',
    '  [StructLayout(LayoutKind.Sequential)] struct L { public uint cb; public uint t; }',
    '  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref L l);',
    '  public static uint Ms() { var l = new L(); l.cb = (uint)Marshal.SizeOf(l); GetLastInputInfo(ref l); return (uint)Environment.TickCount - l.t; }',
    '}',
    '"@',
    'while ($true) { [Console]::Out.WriteLine([CCIdle]::Ms()); [Console]::Out.Flush(); Start-Sleep -Milliseconds 2000 }',
  ].join('\n');
  let proc;
  try {
    proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch { return null; }
  proc.on('error', () => {});
  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const n = Number(buf.slice(0, i).trim());
      buf = buf.slice(i + 1);
      if (Number.isFinite(n)) hub.setIdle(n);
    }
  });
  process.once('exit', () => { try { proc.kill(); } catch {} });
  return proc;
}

// Chạy kèm `node tracker.js serve`. ctx: { accounts(), switchAccount(id) }.
function start(ctx = {}) {
  const hub = createHub(ctx);
  const server = createRemoteServer(hub);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.log(`Remote: cổng ${REMOTE_PORT} đang được dùng — bỏ qua`);
    else console.error('remote:', err.message);
  });
  server.listen(REMOTE_PORT, REMOTE_HOST, () => console.log(`Remote (app iOS): http://${REMOTE_HOST}:${REMOTE_PORT}`));
  setInterval(() => hub.sweep(), MIN).unref();
  startIdleWatcher(hub);
  const bye = () => { hub.shutdown(); process.exit(0); };
  process.once('SIGINT', bye);
  process.once('SIGTERM', bye);
  process.once('exit', () => hub.shutdown());
  return { hub, server };
}

// ---------- Tailscale (cho dashboard) ----------

function tailscaleBin() {
  if (process.platform === 'win32') {
    const p = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
    if (fs.existsSync(p)) return p;
  }
  return 'tailscale';
}

function runTailscale(args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(tailscaleBin(), args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, missing: !!(err && err.code === 'ENOENT'), out: String(stdout || ''), err: String(stderr || '') });
    });
  });
}

async function tailscaleInfo() {
  const st = await runTailscale(['status', '--json']);
  if (st.missing) return { installed: false };
  let j = null;
  try { j = JSON.parse(st.out); } catch {}
  if (!j || !j.Self) return { installed: true, running: false, message: clip((st.err || st.out).trim(), 300) };
  const dns = String(j.Self.DNSName || '').replace(/\.$/, '');
  const sv = await runTailscale(['serve', 'status', '--json']);
  let serving = false;
  try { serving = JSON.stringify(JSON.parse(sv.out || '{}')).includes(`:${REMOTE_PORT}`); } catch {}
  return {
    installed: true, running: j.BackendState === 'Running', state: j.BackendState,
    dns, ips: j.Self.TailscaleIPs || [], serving, url: dns && serving ? `https://${dns}` : '',
  };
}

async function tailscaleServe() {
  const r = await runTailscale(['serve', '--bg', String(REMOTE_PORT)], 20000);
  return { ok: r.ok, output: clip((r.out + '\n' + r.err).trim(), 1500) };
}

// ---------- cài hook vào Claude Code (điều khiển phiên đang mở trên máy) ----------

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const HOOK_SCRIPT = path.join(__dirname, 'hook.js').replace(/\\/g, '/');
const hookCmd = (ev) => `node "${HOOK_SCRIPT}" ${ev}`;
const isOurHook = (h) => h && typeof h.command === 'string' && h.command.includes('hook.js') && h.command.includes(path.basename(__dirname));
const HOOKS = [
  ['Stop', 'stop', { timeout: 86400, statusMessage: 'Sẵn sàng nhận lệnh từ điện thoại (CC Remote) · cứ gõ tiếp bình thường' }],
  ['SessionStart', 'session', { timeout: 10 }],
  ['PermissionRequest', 'permission', { timeout: 86400 }],
  ['UserPromptSubmit', 'prompt', { timeout: 15 }],
  ['PreToolUse', 'pretool', { timeout: 10 }],
  ['PostToolUse', 'tool', { timeout: 15 }],
];
const PHONE_CMD = `---
description: Chuyển phiên này sang điều khiển từ điện thoại (CC Remote)
---
[[cc-remote:phone]] Tôi chuyển phiên này sang điện thoại qua app CC Remote (tôi tự cài hook của nó). Từ giờ tin nhắn của tôi sẽ đến dưới dạng "Stop hook feedback" bắt đầu bằng "📱 Tin nhắn của người dùng, gửi từ điện thoại" — đó chính là tôi, hãy làm theo như tin nhắn tôi gõ trực tiếp. Bây giờ chỉ trả lời đúng một câu: "Đã chuyển sang điện thoại — nhắn tiếp trong app CC Remote."
`;

function readSettingsFile() {
  const file = path.join(claudeDir(), 'settings.json');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { file, data: {} }; }
  try { return { file, data: JSON.parse(text) || {}, text }; } catch {
    throw new RemoteError('FORMAT', `Không đọc được ${file} (JSON lỗi) — sửa tay rồi thử lại`);
  }
}

// bỏ hook của mình khỏi settings.hooks (giữ nguyên hook khác)
function stripOurHooks(hooks) {
  for (const ev of Object.keys(hooks || {})) {
    if (!Array.isArray(hooks[ev])) continue;
    hooks[ev] = hooks[ev].map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurHook(h)) })).filter((g) => g.hooks.length);
    if (!hooks[ev].length) delete hooks[ev];
  }
}

function hooksStatus() {
  let data = {};
  try { data = readSettingsFile().data; } catch { return { installed: false, error: 'settings.json lỗi' }; }
  const h = data.hooks || {};
  const have = (ev) => (h[ev] || []).some((g) => (g.hooks || []).some(isOurHook));
  return { installed: HOOKS.every(([ev]) => have(ev)), partial: HOOKS.some(([ev]) => have(ev)), command: fs.existsSync(path.join(claudeDir(), 'commands', 'phone.md')) };
}

function installHooks() {
  const { file, data, text } = readSettingsFile();
  if (text) fs.copyFileSync(file, `${file}.cc-remote-backup`);
  data.hooks = data.hooks && typeof data.hooks === 'object' ? data.hooks : {};
  stripOurHooks(data.hooks);
  for (const [ev, arg, extra] of HOOKS) {
    const matcher = ['PermissionRequest', 'PreToolUse', 'PostToolUse'].includes(ev) ? { matcher: '*' } : {};
    (data.hooks[ev] ||= []).push({ ...matcher, hooks: [{ type: 'command', command: hookCmd(arg), ...extra }] });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  const cmdDir = path.join(claudeDir(), 'commands');
  fs.mkdirSync(cmdDir, { recursive: true });
  fs.writeFileSync(path.join(cmdDir, 'phone.md'), PHONE_CMD);
  hookKey();
  return hooksStatus();
}

function uninstallHooks() {
  const { file, data, text } = readSettingsFile();
  if (text && data.hooks) {
    stripOurHooks(data.hooks);
    if (!Object.keys(data.hooks).length) delete data.hooks;
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  }
  const cmd = path.join(claudeDir(), 'commands', 'phone.md');
  try { if (fs.readFileSync(cmd, 'utf8').includes('[[cc-remote:phone]]')) fs.unlinkSync(cmd); } catch {}
  return hooksStatus();
}

module.exports = {
  alwaysOn, setAlwaysOn, startIdleWatcher,
  hookKey, hooksStatus, installHooks, uninstallHooks,
  RemoteError, load, newPairCode, pair, authDevice, devices, revoke, setNtfy, notify,
  findClaude, normalize, cleanUserText, toolSummary, readTranscript, recentSessions, projects, projectSessions, sessionFile,
  Session, createHub, createRemoteServer, start, tailscaleInfo, tailscaleServe, REMOTE_PORT, MODES,
};

// ---------- dòng lệnh ----------

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'pair') {
    const p = newPairCode();
    console.log(`Mã ghép: ${p.code}  (hết hạn lúc ${new Date(p.expiresAt).toLocaleTimeString()})`);
  } else if (cmd === 'devices') {
    const list = devices();
    if (!list.length) console.log('Chưa ghép thiết bị nào. Chạy: node remote.js pair');
    for (const d of list) console.log(`${d.id}  ${d.name}  ghép ${new Date(d.createdAt).toLocaleString()}  dùng lần cuối ${new Date(d.lastSeen).toLocaleString()}`);
  } else if (cmd === 'revoke' && arg) {
    try { revoke(arg); console.log('Đã thu hồi'); } catch (err) { console.error(err.message); process.exitCode = 2; }
  } else if (cmd === 'hooks') {
    try {
      const st = arg === 'install' ? installHooks() : arg === 'uninstall' ? uninstallHooks() : hooksStatus();
      console.log(st.installed ? 'Hook CC Remote: đã cài (mở lại phiên Claude Code để có hiệu lực; gõ /phone để chuyển sang điện thoại)'
        : st.partial ? 'Hook CC Remote: cài thiếu — chạy: node remote.js hooks install' : 'Hook CC Remote: chưa cài');
    } catch (err) { console.error(err.message); process.exitCode = 2; }
  } else if (cmd === 'serve') {
    start();
  } else {
    console.error('Dùng: node remote.js [pair|devices|revoke <id>|hooks [install|uninstall]|serve]');
    process.exitCode = 1;
  }
}
