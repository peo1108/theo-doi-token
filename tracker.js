#!/usr/bin/env node
// Theo dõi token Claude Code: đọc log ~/.claude/projects/**/*.jsonl,
// giữ chi tiết 7 ngày + tổng hợp theo ngày 90 ngày trong data/usage.json.
//
//   node tracker.js serve    -> dashboard http://127.0.0.1:7788 (+ cảnh báo Windows)
//   node tracker.js report   -> in bảng ra terminal
//   node tracker.js status   -> 1 dòng cho statusLine của Claude Code

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const A = require('./analytics.js');
const accounts = require('./accounts.js');
const remote = require('./remote.js');

const LOG_ROOT = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const DATA_DIR = process.env.TT_DATA_DIR || path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'usage.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
const MODELS_FILE = path.join(__dirname, 'models.json');
const PORT = Number(process.env.PORT) || 7788;
const HOST = process.env.HOST || '127.0.0.1';   // đặt HOST=0.0.0.0 nếu Prometheus chạy trong Docker
const { MIN, HOUR, DAY } = A;
const KEEP_MS = 7 * DAY;
const HISTORY_DAYS = 90;
const STORE_VERSION = 5;
const ALERT_EVERY_MS = 60e3;

const DEFAULT_CONFIG = {
  budgetDay: 0,          // USD, 0 = tắt
  budgetWeek: 0,         // USD (tuần bắt đầu thứ Hai), 0 = tắt
  notify: true,          // gửi thông báo Windows
  alertCacheHit: 80,     // % cache hit trong 1 giờ qua thấp hơn mức này thì báo
  alertContext: 400000,  // token ngữ cảnh của một phiên đang chạy vượt mức này thì báo
  alertWindowRatio: 2,   // cửa sổ 5h dự kiến vượt N lần trung bình thì báo
  alertLimitPct: 90,     // % hạn mức 5h/tuần của tài khoản đang dùng từ mức này thì báo, 0 = tắt
};

// ---------- file JSON ----------

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows có thể khoá file khi tiến trình khác đang đọc; lần sau sẽ ghi lại.
    try { fs.unlinkSync(tmp); } catch {}
  }
}

const loadConfig = () => ({ ...DEFAULT_CONFIG, ...readJSON(CONFIG_FILE, {}) });
const loadPricing = () => A.pricing(readJSON(MODELS_FILE, { models: [] }));

// initId = tài khoản đầu tiên của dòng thời gian (mục 'init'); dùng khi nâng store v4 -> v5.
function loadStore(initId = '') {
  const s = readJSON(STORE_FILE, null);
  if (s && s.v === STORE_VERSION && s.msgs && s.files && s.daily) return s;
  if (s && s.v === 4 && s.daily && typeof s.daily === 'object') {
    // v4 chưa có tài khoản trong khoá: log của ngày cũ đã bị Claude Code xoá nên không dựng lại được,
    // gán các ngày đã chốt cho tài khoản 'init' (mục 5.4 của spec); chi tiết 7 ngày và backfill được dựng lại.
    const daily = {};
    for (const [day, keys] of Object.entries(s.daily)) {
      daily[day] = {};
      for (const [k, v] of Object.entries(keys || {})) daily[day][`${initId}|${k}`] = v;
    }
    return { v: STORE_VERSION, files: {}, msgs: {}, daily, backfilledAt: 0, lastScan: 0 };
  }
  return { v: STORE_VERSION, files: {}, msgs: {}, daily: {}, backfilledAt: 0, lastScan: 0 };
}

// ---------- đọc log ----------

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// Claude hay `cd` vào thư mục con giữa phiên, nên lấy cwd của lượt đầu tiên trong file
// (thư mục mở Claude Code) làm tên project cho cả file.
function projectName(cwd, file) {
  if (cwd) return path.basename(cwd);
  const rel = path.relative(LOG_ROOT, file).split(path.sep)[0];
  return rel || 'unknown';
}

// Một lượt trả lời có thể được ghi nhiều dòng cùng message.id (streaming),
// dòng đầu output_tokens còn nhỏ -> giữ giá trị lớn nhất của từng trường.
function mergeMsg(prev, next) {
  if (!prev) return next;
  for (const k of ['i', 'o', 'cw', 'w1', 'cr', 'th']) prev[k] = Math.max(prev[k], next[k]);
  prev.t = Math.min(prev.t, next.t);
  return prev;
}

function parseFile(file, onRecord) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  let rootCwd = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const m = e.message;
    const u = m && m.usage;
    if (!u || e.type !== 'assistant') continue;
    if (!m.model || m.model === '<synthetic>') continue;
    const t = Date.parse(e.timestamp);
    if (!(t > 0)) continue;
    rootCwd ||= e.cwd;
    const rec = {
      t,
      m: m.model,
      p: projectName(rootCwd, file),
      sid: e.sessionId || '',
      ag: e.attributionAgent || (e.isSidechain ? 'subagent' : 'main'),
      ch: e.isSidechain ? (e.agentId || 'subagent') : '',
      ef: e.effort || '',
      fs: u.speed === 'fast' ? 1 : 0,
      i: u.input_tokens || 0,
      o: u.output_tokens || 0,
      cw: u.cache_creation_input_tokens || 0,
      w1: (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0,
      cr: u.cache_read_input_tokens || 0,
      th: (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0,
    };
    if (!rec.i && !rec.o && !rec.cw && !rec.cr) continue;
    onRecord(m.id || e.requestId || e.uuid, rec);
  }
}

// ---------- tổng hợp theo ngày (giữ 90 ngày) ----------

function addDaily(daily, rec, entries) {
  const day = (daily[A.dayKey(rec.t)] ||= {});
  const a = (day[`${A.accountAt(entries, rec.t) || ''}|${rec.m}${rec.fs ? '|fast' : ''}`] ||= { i: 0, o: 0, w5: 0, w1: 0, cr: 0, th: 0, n: 0 });
  a.i += rec.i; a.o += rec.o; a.w5 += Math.max(0, rec.cw - rec.w1); a.w1 += rec.w1;
  a.cr += rec.cr; a.th += rec.th; a.n += 1;
}

// Lần đầu (hoặc khi lâu không chạy): đọc toàn bộ log còn trên máy để lấp lịch sử các ngày cũ.
function backfill(store, now, entries) {
  const cutoff = now - KEEP_MS;
  const since = now - HISTORY_DAYS * DAY;
  const seen = {};
  for (const file of walk(LOG_ROOT)) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (st.mtimeMs < since) continue;
    parseFile(file, (id, rec) => { if (rec.t >= since) seen[id] = mergeMsg(seen[id], rec); });
  }
  const tmp = {};
  for (const rec of Object.values(seen)) addDaily(tmp, rec, entries);
  for (const [k, v] of Object.entries(tmp)) {
    if (A.dayStartOfKey(k) < cutoff && !store.daily[k]) store.daily[k] = v;
  }
  store.backfilledAt = now;
}

// ---------- tài khoản ----------

// Đọc dòng thời gian; file hỏng thì coi như chưa có (không làm hỏng việc quét log).
function safeLog() {
  try { return accounts.readLog(); } catch (err) { console.error('account-log:', err.message); return { v: 1, entries: [], conflict: null }; }
}
const accountEntries = () => safeLog().entries;

// Cửa sổ 5h ước lượng chỉ tính các lượt của tài khoản đang chọn; ngân sách vẫn tính trên tổng.
const windowRows = (rows, active) => (active ? rows.filter((r) => r.account === active) : rows);

// Cửa sổ 5h của tài khoản đang chọn: dùng mốc reset thật (Anthropic) nếu hồ sơ có, không thì ước lượng.
function windowSummary(rows, now, active) {
  const p = active && accounts.loadProfile(active);
  const five = p && A.effectiveUsage(p.usage, now).fiveHour;
  return A.summary(windowRows(rows, active), now, { resetsAt: five ? five.resetsAt : null });
}

// ---------- hạn mức trực tiếp từ Anthropic ----------
// Cache cachedUsageUtilization của Claude Code chỉ thỉnh thoảng mới cập nhật, nên tracker tự hỏi
// endpoint mà /usage của Claude Code dùng, bằng access token của từng hồ sơ (chỉ đọc, không làm mới token).
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const USAGE_EVERY_MS = 5 * MIN;   // tài khoản không nằm trong file đăng nhập
const USAGE_ACTIVE_MS = MIN;      // tài khoản đang dùng: gần như theo thời gian thực
const USAGE_TICK_MS = 20e3;
const STALE_MS = 10 * MIN;

async function refreshUsage(now = Date.now(), fetchImpl = globalThis.fetch) {
  const updated = [];
  let fileId = null, fileOauth = null;
  try { const l = accounts.readLogin(); fileId = l.id; fileOauth = l.cred.claudeAiOauth; } catch {}
  for (const p of accounts.listProfiles()) {
    if (p.error) continue;
    // tài khoản đang nằm trong file: Claude Code giữ token mới nhất ở đó
    const oauth = p.id === fileId && fileOauth ? fileOauth : p.oauth;
    if (!oauth || !oauth.accessToken || !(oauth.expiresAt > now + MIN)) continue;
    const every = p.id === fileId ? USAGE_ACTIVE_MS : USAGE_EVERY_MS;
    if (p.usage && p.usage.fetchedAtMs > now - every + 5e3) continue;
    try {
      const res = await fetchImpl(USAGE_URL, {
        headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
        signal: AbortSignal.timeout(10e3),
      });
      if (!res.ok) continue;
      const util = await res.json();
      if (!util || (typeof util.five_hour !== 'object' && typeof util.seven_day !== 'object')) continue;
      accounts.setUsage(p.id, util, now);
      updated.push(p.id);
    } catch (err) { if (err && err.name !== 'TimeoutError') console.error('usage:', p.id.slice(0, 8), err.message); }
  }
  return { updated };
}

// Thông tin công khai (không token) của các hồ sơ + chi phí hôm nay/tuần theo tài khoản.
// `rows` đã qua A.enrich và có cột `account`.
function accountsInfo(rows, now = Date.now()) {
  const log = safeLog();
  const active = accounts.chosenId(log);
  let fileAccount = null;
  try { fileAccount = accounts.readLogin().id || null; } catch {}
  const views = accounts.listProfiles().map(accounts.publicView);
  // số liệu cũ: còn lượt của tài khoản đó sau lần lấy hạn mức hơn STALE_MS -> % không còn đáng tin
  const lastTurn = {};
  for (const r of rows) if (!(lastTurn[r.account] >= r.t)) lastTurn[r.account] = r.t;
  const isStale = (v) => !!(v.usage && v.usage.fetchedAtMs && lastTurn[v.id] > v.usage.fetchedAtMs + STALE_MS);
  const suggestedId = A.suggestAccount(views.filter((v) => !v.error && !isStale(v)), active, now);   // usage thô
  const day = A.startOfDay(now), week = A.startOfWeek(now);
  const today = {}, wk = {};
  for (const r of rows) {
    if (r.t >= week) wk[r.account] = (wk[r.account] || 0) + r.c.total;
    if (r.t >= day) today[r.account] = (today[r.account] || 0) + r.c.total;
  }
  return {
    active, fileAccount, conflict: log.conflict,
    accounts: views.map((v) => ({
      ...v,
      usage: A.effectiveUsage(v.usage, now),
      loginState: A.loginState(v.loginExpiresAt, now),
      costToday: today[v.id] || 0,
      costWeek: wk[v.id] || 0,
      suggested: v.id === suggestedId,
      stale: isStale(v),
    })),
  };
}

// ---------- quét ----------

function scan() {
  const now = Date.now();
  const cutoff = now - KEEP_MS;
  try { accounts.sync(now); } catch (err) { console.error('accounts.sync:', err.message); }   // lỗi tài khoản không chặn quét log
  const entries = accountEntries();
  const store = loadStore(entries[0]?.id || '');
  let changed = false;

  if (!store.backfilledAt || now - store.lastScan > 6 * DAY) {
    backfill(store, now, entries);
    changed = true;
  }
  // dòng thời gian tài khoản đổi (đổi/giữ/đăng nhập mới) -> gán lại tài khoản cho các ngày chi tiết
  const sig = JSON.stringify(entries.map((e) => [e.t, e.id]));
  if (store.acctSig !== sig) { store.acctSig = sig; changed = true; }

  for (const file of walk(LOG_ROOT)) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (st.mtimeMs < cutoff) continue;
    const prev = store.files[file];
    if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) continue;
    parseFile(file, (id, rec) => { if (rec.t >= cutoff) store.msgs[id] = mergeMsg(store.msgs[id], rec); });
    store.files[file] = { mtime: st.mtimeMs, size: st.size };
    changed = true;
  }

  for (const [id, r] of Object.entries(store.msgs)) {
    if (r.t < cutoff) { delete store.msgs[id]; changed = true; }
  }
  for (const [f, info] of Object.entries(store.files)) {
    if (info.mtime < cutoff) { delete store.files[f]; changed = true; }
  }

  if (changed) {
    // ngày nằm trọn trong 7 ngày chi tiết -> tính lại; ngày cũ hơn giữ nguyên bản đã chốt
    for (const k of Object.keys(store.daily)) {
      const start = A.dayStartOfKey(k);
      if (start >= cutoff || start < now - HISTORY_DAYS * DAY) delete store.daily[k];
    }
    for (const rec of Object.values(store.msgs)) {
      if (A.startOfDay(rec.t) >= cutoff) addDaily(store.daily, rec, entries);
    }
    store.lastScan = now;
    writeJSON(STORE_FILE, store);
  }
  return store;
}

const toRow = (r, entries) => ({
  t: r.t, model: r.m, project: r.p, session: r.sid, agent: r.ag, chain: r.ch, effort: r.ef,
  account: A.accountAt(entries, r.t) || '', fast: r.fs,
  i: r.i, o: r.o, w5: Math.max(0, r.cw - r.w1), w1: r.w1, cr: r.cr, th: r.th,
});

function analyze() {
  const store = scan();
  const P = loadPricing();
  const log = safeLog();
  const rows = A.enrich(Object.values(store.msgs).map((r) => toRow(r, log.entries)), P);
  return { store, P, rows, now: Date.now(), log, active: accounts.chosenId(log) };
}

// ---------- API cho dashboard ----------

const ROW_COLS = ['t', 'model', 'project', 'session', 'agent', 'chain', 'effort', 'account', 'fast', 'i', 'o', 'w5', 'w1', 'cr', 'th'];
const INDEXED = ['model', 'project', 'session', 'agent', 'chain', 'effort', 'account'];

// Dữ liệu thô gọn: mỗi lượt là 1 mảng số, các cột chữ được đánh chỉ mục để JSON nhỏ.
function records(store = scan()) {
  const lists = {}, maps = {};
  for (const k of INDEXED) { lists[k] = []; maps[k] = new Map(); }
  const idx = (k, v) => {
    let i = maps[k].get(v);
    if (i === undefined) { i = lists[k].push(v) - 1; maps[k].set(v, i); }
    return i;
  };
  const now = Date.now();
  const log = safeLog();
  const enriched = A.enrich(Object.values(store.msgs).map((rec) => toRow(rec, log.entries)), loadPricing());
  const rows = enriched.map((r) => ROW_COLS.map((c) => (INDEXED.includes(c) ? idx(c, r[c]) : r[c])));
  return {
    now,
    keepDays: KEEP_MS / DAY,
    cols: ROW_COLS,
    lists,
    rows,
    daily: store.daily,
    meta: readJSON(MODELS_FILE, { models: [] }),
    config: loadConfig(),
    alerts: loadAlerts().recent,
    accounts: accountsInfo(enriched, now),
    accountLog: log.entries,
  };
}

// ---------- cảnh báo ----------

function loadAlerts() {
  return { sent: {}, recent: [], ...readJSON(ALERTS_FILE, {}) };
}

function notifyWindows(title, body) {
  if (process.platform !== 'win32') return;
  const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$x = $t.GetElementsByTagName('text')
$x.Item(0).AppendChild($t.CreateTextNode($env:TT_TITLE)) > $null
$x.Item(1).AppendChild($t.CreateTextNode($env:TT_BODY)) > $null
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($t))`;
  try {
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, TT_TITLE: title, TT_BODY: body },
      windowsHide: true, stdio: 'ignore',
    }).on('error', () => {});
  } catch {}
}

const usd = (n) => '$' + n.toFixed(2);
const fmt = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n));
const hhmm = (t) => { const d = new Date(t); return `${A.pad(d.getHours())}:${A.pad(d.getMinutes())}`; };

function checkAlerts() {
  const { rows, now, log, active } = analyze();
  const cfg = loadConfig();
  const s = A.summary(rows, now);
  const w = windowSummary(rows, now, active);
  const st = loadAlerts();
  let dirty = false;

  const push = (key, level, title, body) => {
    if (st.sent[key]) return;
    st.sent[key] = now;
    st.recent.unshift({ id: now + Math.random(), t: now, level, title, body });
    st.recent = st.recent.slice(0, 40);
    dirty = true;
    if (cfg.notify) notifyWindows(title, body);
  };

  const today = A.dayKey(now), week = A.dayKey(A.startOfWeek(now));
  const budget = (label, spent, limit, keyBase) => {
    if (!(limit > 0)) return;
    if (spent >= limit) push(`${keyBase}100`, 'critical', `Vượt ngân sách ${label}`, `Đã dùng ${usd(spent)} / ${usd(limit)}`);
    else if (spent >= 0.8 * limit) push(`${keyBase}80`, 'warning', `Sắp chạm ngân sách ${label}`, `Đã dùng ${usd(spent)} / ${usd(limit)} (${Math.round(spent / limit * 100)}%)`);
  };
  budget('ngày', s.today, cfg.budgetDay, `day:${today}:`);
  budget('tuần', s.week, cfg.budgetWeek, `week:${week}:`);

  if (w.window && w.avgWindowCost > 0 && w.window.n >= 10 && w.projected > cfg.alertWindowRatio * w.avgWindowCost) {
    push(`burn:${w.window.start}`, 'warning', 'Cửa sổ 5 giờ đang dùng nhanh',
      `Dự kiến ${usd(w.projected)} đến ${hhmm(w.window.end)}, gấp ${(w.projected / w.avgWindowCost).toFixed(1)} lần trung bình`);
  }

  // tài khoản: conflict, tài khoản mới, gần hết hạn mức, hạn đăng nhập
  const info = accountsInfo(rows, now);
  const nameOf = (id) => (info.accounts.find((a) => a.id === id) || {}).name || id;
  const cf = log.conflict;
  if (cf) {
    push(`conflict:${cf.since}`, 'warning', `Đăng nhập hiện là ${nameOf(cf.fileId)} nhưng bạn đang chọn ${nameOf(cf.chosenId)}`,
      'Phiên cũ ghi đè hoặc vừa /login — mở dashboard để xử lý');
  }
  for (const e of log.entries) {
    if (e.reason !== 'login' || e.t < now - 10 * MIN) continue;
    const a = info.accounts.find((x) => x.id === e.id);
    push(`newacct:${e.id}:${e.t}`, 'info', `Đã thêm tài khoản ${a ? a.email || a.name : e.id}`,
      'Hồ sơ đã được lưu — dùng cc-switch hoặc dashboard để đổi giữa các tài khoản');
  }
  const cur = info.accounts.find((a) => a.id === info.active);
  if (cfg.alertLimitPct > 0 && cur) {
    const best = info.accounts.find((a) => a.suggested);
    const pctOf = (a) => Math.max(a.usage.fiveHour ? a.usage.fiveHour.pct : 0, a.usage.sevenDay ? a.usage.sevenDay.pct : 0);
    const ago = (ms) => (ms < HOUR ? `${Math.max(1, Math.round(ms / MIN))} phút` : ms < DAY ? `${Math.round(ms / HOUR)} giờ` : `${Math.round(ms / DAY)} ngày`);
    for (const [win, label, u] of [['5h', '5h', cur.usage.fiveHour], ['7d', '7 ngày', cur.usage.sevenDay]]) {
      if (!u || u.pct < cfg.alertLimitPct) continue;
      const hint = best
        ? `Gợi ý: ${best.name} (đang ${Math.round(pctOf(best))}%${best.usage.fetchedAt != null ? `, cập nhật ${ago(Math.max(0, now - best.usage.fetchedAt))} trước` : ''})`
        : 'Không có tài khoản khác còn hạn mức';
      push(`limit:${cur.id}:${win}:${u.resetsAt}`, 'warning', `${cur.name} đã dùng ${Math.round(u.pct)}% cửa sổ ${label}`, hint);
    }
  }
  for (const a of info.accounts) {
    if (a.loginState === 'expired') push(`login:${a.id}:expired:${a.loginExpiresAt}`, 'critical', `${a.name}: cần /login lại`, 'Phiên đăng nhập đã hết hạn — chạy /login trong Claude Code');
    else if (a.loginState === 'soon') push(`login:${a.id}:soon:${a.loginExpiresAt}`, 'warning', `${a.name}: sắp hết hạn đăng nhập`,
      `Còn khoảng ${Math.max(1, Math.ceil((a.loginExpiresAt - now) / DAY))} ngày — nên /login lại sớm`);
  }

  if (s.cacheHit1h != null && s.n1h >= 20 && s.cacheHit1h * 100 < cfg.alertCacheHit) {
    push(`cache:${today}:${new Date(now).getHours()}`, 'warning', 'Cache hit thấp',
      `1 giờ qua chỉ ${(s.cacheHit1h * 100).toFixed(1)}% ngữ cảnh được đọc từ cache`);
  }

  if (cfg.alertContext > 0) {
    for (const c of A.activeContexts(A.chains(rows), now)) {
      if (c.ctx < cfg.alertContext) continue;
      const step = Math.floor(c.ctx / 100000);
      push(`ctx:${c.session}:${step}`, 'info', `Ngữ cảnh dài · ${c.project}`,
        `Phiên ${c.session.slice(0, 8)} đã ${fmt(c.ctx)} token ngữ cảnh — cân nhắc /compact hoặc mở phiên mới`);
    }
  }

  if (dirty) {
    for (const [k, t] of Object.entries(st.sent)) if (t < now - 8 * DAY) delete st.sent[k];
    writeJSON(ALERTS_FILE, st);
  }
}

// ---------- Prometheus ----------

function metrics() {
  const { rows, now } = analyze();
  const s = A.summary(rows, now);
  const lines = [];
  const gauge = (name, help, samples) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [labels, v] of samples) {
      const l = Object.entries(labels).map(([k, x]) => `${k}="${String(x).replace(/["\\\n]/g, '_')}"`).join(',');
      lines.push(`${name}${l ? `{${l}}` : ''} ${Number.isFinite(v) ? v : 0}`);
    }
  };
  const byModel = new Map();
  for (const r of rows) {
    if (r.t < now - DAY) continue;
    const m = byModel.get(r.model) || { i: 0, o: 0, w5: 0, w1: 0, cr: 0, cost: 0, n: 0 };
    for (const k of A.TOKEN_KEYS) m[k] += r[k];
    m.cost += r.c.total; m.n++;
    byModel.set(r.model, m);
  }
  const typeName = { i: 'input', o: 'output', w5: 'cache_write_5m', w1: 'cache_write_1h', cr: 'cache_read' };
  gauge('claude_code_tokens_24h', 'Token trong 24 giờ qua', [...byModel].flatMap(([model, m]) =>
    A.TOKEN_KEYS.map((k) => [{ model, type: typeName[k] }, m[k]])));
  gauge('claude_code_cost_usd_24h', 'Chi phí quy đổi USD trong 24 giờ qua', [...byModel].map(([model, m]) => [{ model }, m.cost]));
  gauge('claude_code_requests_24h', 'Số lượt trả lời trong 24 giờ qua', [...byModel].map(([model, m]) => [{ model }, m.n]));
  gauge('claude_code_cost_usd_today', 'Chi phí hôm nay', [[{}, s.today]]);
  gauge('claude_code_cost_usd_week', 'Chi phí tuần này (từ thứ Hai)', [[{}, s.week]]);
  gauge('claude_code_window_cost_usd', 'Chi phí cửa sổ 5 giờ hiện tại', [[{}, s.window ? s.window.cost : 0]]);
  gauge('claude_code_window_reset_seconds', 'Số giây đến khi cửa sổ 5 giờ reset', [[{}, s.window ? (s.window.end - now) / 1000 : 0]]);
  gauge('claude_code_window_projected_usd', 'Chi phí dự kiến của cửa sổ 5 giờ', [[{}, s.projected]]);
  gauge('claude_code_burn_usd_per_minute', 'Tốc độ tiêu (USD/phút, 30 phút qua)', [[{}, s.burn.costPerMin]]);
  gauge('claude_code_cache_hit_ratio_1h', 'Tỉ lệ ngữ cảnh đọc từ cache trong 1 giờ qua', [[{}, s.cacheHit1h ?? 0]]);
  return lines.join('\n') + '\n';
}

// ---------- terminal ----------

function statusLine() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
  const { rows, now, P, active } = analyze();
  const cfg = loadConfig();
  const s = A.summary(rows, now);
  const w = windowSummary(rows, now, active);
  const parts = [];
  if (w.window) parts.push(`5h ${usd(w.window.cost)} · reset ${hhmm(w.window.end)}`);
  parts.push(`hôm nay ${usd(s.today)}${cfg.budgetDay > 0 ? `/${usd(cfg.budgetDay)}` : ''}`);
  parts.push(`24h ${fmt(s.tok24)} tok`);
  if (input.session_id) {
    const mine = rows.filter((r) => r.session === input.session_id && !r.chain);
    const last = mine[mine.length - 1];
    if (last) parts.push(`ctx ${fmt(last.ctx)} (${Math.round(last.ctx / P.contextWindow * 100)}%)`);
  }
  process.stdout.write(parts.join(' │ '));
}

function report() {
  const { rows, now } = analyze();
  const s = A.summary(rows, now);
  const sum = (list) => list.reduce((a, r) => {
    for (const k of A.TOKEN_KEYS) a[k] += r[k];
    a.th += r.th; a.cost += r.c.total; a.n++;
    return a;
  }, { i: 0, o: 0, w5: 0, w1: 0, cr: 0, th: 0, cost: 0, n: 0 });
  const head = `${''.padEnd(26)}${'input'.padStart(8)}${'output'.padStart(9)}${'ghi cache'.padStart(11)}${'đọc cache'.padStart(11)}${'lượt'.padStart(7)}${'chi phí'.padStart(11)}`;
  const row = (label, v) => `${label.slice(0, 25).padEnd(26)}${fmt(v.i).padStart(8)}${fmt(v.o).padStart(9)}${fmt(v.w5 + v.w1).padStart(11)}${fmt(v.cr).padStart(11)}${String(v.n).padStart(7)}${usd(v.cost).padStart(11)}`;
  const group = (key) => {
    const m = new Map();
    for (const r of rows) { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); }
    return [...m].map(([k, list]) => [k, sum(list)]).sort((a, b) => b[1].cost - a[1].cost);
  };

  console.log('\n== Tổng ==\n' + head);
  console.log(row('24 giờ qua', sum(rows.filter((r) => r.t >= now - DAY))));
  console.log(row('7 ngày qua', sum(rows)));
  if (s.window) {
    console.log(`\nCửa sổ 5h hiện tại: ${usd(s.window.cost)} · reset lúc ${hhmm(s.window.end)} · dự kiến ${usd(s.projected)} (TB ${usd(s.avgWindowCost)})`);
  }
  console.log('\n== Theo ngày ==\n' + head);
  for (let k = 6; k >= 0; k--) {
    const start = A.startOfDay(now) - k * DAY;
    const d = new Date(start);
    console.log(row(`${['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][d.getDay()]} ${A.pad(d.getDate())}/${A.pad(d.getMonth() + 1)}`,
      sum(rows.filter((r) => r.t >= start && r.t < start + DAY))));
  }
  console.log('\n== Theo model (7 ngày) ==\n' + head);
  for (const [k, v] of group('model')) console.log(row(k, v));
  console.log('\n== Theo project (7 ngày) ==\n' + head);
  for (const [k, v] of group('project')) console.log(row(k, v));
  console.log('\n== Theo agent (7 ngày) ==\n' + head);
  for (const [k, v] of group('agent')) console.log(row(k === 'main' ? 'Phiên chính' : k, v));
  console.log();
}

// ---------- server ----------

function readBody(req, limit = 1e5) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > limit) { reject(new Error('quá lớn')); req.destroy(); } });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

function saveConfig(patch) {
  const cfg = loadConfig();
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (!(k in patch)) continue;
    if (typeof DEFAULT_CONFIG[k] === 'boolean') cfg[k] = !!patch[k];
    else {
      const n = Number(patch[k]);
      if (Number.isFinite(n) && n >= 0) cfg[k] = n;
    }
  }
  writeJSON(CONFIG_FILE, cfg);
  return cfg;
}

const STATIC = {
  '/': ['dashboard.html', 'text/html; charset=utf-8'],
  '/analytics.js': ['analytics.js', 'text/javascript; charset=utf-8'],
};

// Chống CSRF cho POST /api/accounts/*: cần header tự đặt (buộc preflight), Origin (nếu có) phải là chính
// dashboard này, và nguồn kết nối phải là loopback (kể cả khi HOST=0.0.0.0).
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function guardPost(req) {
  if (req.headers['x-token-tracker'] !== '1') return false;
  if (!LOOPBACK.has(req.socket.remoteAddress)) return false;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const port = req.socket.localPort || PORT;
    if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return false;
  }
  return true;
}

// Chống DNS rebinding: trang web ngoài trỏ tên miền về 127.0.0.1 thì đọc được API (email, usage); khi đó Host là tên
// miền của trang. Chỉ nhận Host là 127.0.0.1/localhost kèm đúng cổng đang nghe. Chỉ áp cho /api/* (không áp cho
// /metrics: Prometheus trong Docker quét bằng Host khác khi HOST=0.0.0.0).
function hostAllowed(req) {
  const port = req.socket.localPort || PORT;
  const h = req.headers.host;
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

// Xử lý /api/accounts*: true = đã trả lời, false = bị chặn (403), null = không phải đường dẫn tài khoản.
async function accountsApi(req, url, json) {
  if (url.pathname === '/api/accounts' && req.method === 'GET') {
    const { rows, now } = analyze();
    return json(accountsInfo(rows, now)), true;
  }
  const m = /^\/api\/accounts\/(switch|keep|rename)$/.exec(url.pathname);
  if (!m || req.method !== 'POST') return null;
  if (!guardPost(req)) return false;
  let body;
  try { body = JSON.parse(await readBody(req) || '{}'); } catch { throw new accounts.AccountError('FORMAT', 'Nội dung gửi lên không phải JSON hợp lệ'); }
  if (!body || typeof body !== 'object') body = {};
  if (m[1] === 'switch') {
    const r = accounts.switchTo(body.id);
    json({ ...r, running: r.running.map((p) => ({ pid: p.pid })) });   // không trả command line của tiến trình
  } else if (m[1] === 'keep') json(accounts.keep());
  else json(accounts.publicView(accounts.rename(body.id, body.name)));
  return true;
}

// Xử lý /api/remote*: ghép điện thoại, thu hồi, ntfy, Tailscale. Cùng luật như /api/accounts (POST chỉ từ dashboard).
let tsCache = null;
async function remoteApi(req, url, json) {
  if (url.pathname === '/api/remote' && req.method === 'GET') {
    if (!tsCache || Date.now() - tsCache.t > 30e3 || url.searchParams.has('fresh')) {
      tsCache = { t: Date.now(), v: await remote.tailscaleInfo().catch((err) => ({ installed: false, message: err.message })) };
    }
    const d = remote.load();
    const pair = d.pair && d.pair.expiresAt > Date.now() ? { code: d.pair.code, expiresAt: d.pair.expiresAt } : null;
    const live = remoteHub ? [...remoteHub.sessions.values()].filter((x) => x.proc).length : 0;
    return json({ port: remote.REMOTE_PORT, enabled: !!remoteHub, devices: remote.devices(), pair, ntfy: d.ntfy, tailscale: tsCache.v, live, hooks: remote.hooksStatus(), alwaysOn: remote.alwaysOn() }), true;
  }
  const m = /^\/api\/remote\/(pair|revoke|ntfy|ntfy-test|serve|hooks|always-on)$/.exec(url.pathname);
  if (!m || req.method !== 'POST') return null;
  if (!guardPost(req)) return false;
  let body;
  try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
  if (!body || typeof body !== 'object') body = {};
  if (m[1] === 'pair') json(remote.newPairCode());
  else if (m[1] === 'revoke') json(remote.revoke(String(body.id || '')));
  else if (m[1] === 'ntfy') json({ ntfy: remote.setNtfy(body) });
  else if (m[1] === 'always-on') json({ alwaysOn: remote.setAlwaysOn(body.on !== false) });
  else if (m[1] === 'hooks') json(body.on === false ? remote.uninstallHooks() : remote.installHooks());
  else if (m[1] === 'ntfy-test') json({ ok: await remote.notify('CC Remote', 'Thông báo hoạt động bình thường', null) });
  else { const r = await remote.tailscaleServe(); tsCache = null; json(r); }
  return true;
}

function createServer() {
  const send = (res, code, type, body) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  };
  const json = (res, data) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify(data));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/') && !hostAllowed(req)) {
        return send(res, 403, 'application/json; charset=utf-8', JSON.stringify({ error: 'FORBIDDEN', message: 'Yêu cầu bị từ chối' }));
      }
      if (url.pathname.startsWith('/api/accounts')) {
        const r = await accountsApi(req, url, (d) => json(res, d));
        if (r === false) return send(res, 403, 'application/json; charset=utf-8', JSON.stringify({ error: 'FORBIDDEN', message: 'Yêu cầu bị từ chối' }));
        if (r !== null) return;
      }
      if (url.pathname.startsWith('/api/remote')) {
        const r = await remoteApi(req, url, (d) => json(res, d));
        if (r === false) return send(res, 403, 'application/json; charset=utf-8', JSON.stringify({ error: 'FORBIDDEN', message: 'Yêu cầu bị từ chối' }));
        if (r !== null) return;
      }
      if (url.pathname === '/api/records') return json(res, records(scan()));
      // POST đổi cài đặt / gửi thông báo thử: cùng luật chống CSRF như /api/accounts
      const forbidden = () => send(res, 403, 'application/json; charset=utf-8', JSON.stringify({ error: 'FORBIDDEN', message: 'Yêu cầu bị từ chối' }));
      if (url.pathname === '/api/config' && req.method === 'POST') {
        if (!guardPost(req)) return forbidden();
        let patch;
        try { patch = JSON.parse(await readBody(req) || '{}'); } catch { patch = null; }
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'FORMAT', message: 'Nội dung gửi lên không phải JSON hợp lệ' }));
        }
        const cfg = saveConfig(patch);
        checkAlerts();
        return json(res, cfg);
      }
      if (url.pathname === '/api/config') return json(res, loadConfig());
      if (url.pathname === '/api/alerts') {
        const after = Number(url.searchParams.get('after')) || 0;
        return json(res, loadAlerts().recent.filter((a) => a.id > after));
      }
      if (url.pathname === '/api/test-notify' && req.method === 'POST') {
        if (!guardPost(req)) return forbidden();
        notifyWindows('Theo dõi token', 'Thông báo hoạt động bình thường');
        return json(res, { ok: true });
      }
      if (url.pathname === '/api/summary') {
        const { rows, now, active } = analyze();
        const s = A.summary(rows, now);
        const w = windowSummary(rows, now, active);   // cửa sổ 5h của tài khoản đang chọn
        const info = accountsInfo(rows, now);
        const cur = info.accounts.find((a) => a.id === info.active);
        return json(res, {
          today: s.today, week: s.week, d24: s.d24, tok24: s.tok24,
          window: w.window && { cost: w.window.cost, end: w.window.end, real: !!w.window.real }, projected: w.projected,
          avgWindowCost: w.avgWindowCost,
          text: `5h ${w.window ? `${usd(w.window.cost)} (reset ${hhmm(w.window.end)})` : '—'} · hôm nay ${usd(s.today)} · 24h ${fmt(s.tok24)} token`,
          account: cur ? { name: cur.name, fiveHour: cur.usage.fiveHour, sevenDay: cur.usage.sevenDay } : null,
          conflict: !!info.conflict,
          needLogin: info.accounts.filter((a) => a.loginState === 'expired').map((a) => a.name),
        });
      }
      if (url.pathname === '/metrics') return send(res, 200, 'text/plain; version=0.0.4; charset=utf-8', metrics());
      const file = STATIC[url.pathname];
      if (file) {
        res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' });
        fs.createReadStream(path.join(__dirname, file[0])).pipe(res);
        return;
      }
      send(res, 404, 'text/plain', 'not found');
    } catch (err) {
      if (err instanceof accounts.AccountError || err instanceof remote.RemoteError) {
        return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: err.code, message: err.message }));
      }
      send(res, 500, 'text/plain; charset=utf-8', String((err && err.stack) || err));
    }
  });

  return server;
}

let remoteHub = null;

function serve() {
  const server = createServer();
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Cổng ${PORT} đang được dùng — có thể dashboard đã chạy sẵn: http://127.0.0.1:${PORT}`);
      process.exit(0);
    }
    throw err;
  });

  server.listen(PORT, HOST, () => {
    console.log(`Dashboard: http://127.0.0.1:${PORT}  ·  Prometheus: /metrics  (Ctrl+C để dừng)`);
    const tick = () => { try { checkAlerts(); } catch (err) { console.error('checkAlerts:', err.message); } };
    tick();
    setInterval(tick, ALERT_EVERY_MS);
    // hạn mức: tự giới hạn 1 phút (tài khoản đang dùng) / 5 phút (tài khoản khác)
    const usageTick = () => refreshUsage().catch((err) => console.error('usage:', err.message));
    usageTick();
    setInterval(usageTick, USAGE_TICK_MS);
    // điều khiển từ điện thoại (app iOS); REMOTE=0 để tắt
    if (process.env.REMOTE !== '0') {
      remoteHub = remote.start({
        accounts: () => { const { rows, now } = analyze(); return accountsInfo(rows, now); },
        switchAccount: (id) => accounts.switchTo(id),
      }).hub;
    }
  });
}

module.exports = { scan, analyze, records, accountsInfo, checkAlerts, createServer, refreshUsage };

if (require.main === module) {
  const cmd = process.argv[2] || 'report';
  if (cmd === 'serve') serve();
  else if (cmd === 'status') statusLine();
  else if (cmd === 'report') report();
  else if (cmd === 'metrics') process.stdout.write(metrics());
  else if (cmd === 'check') checkAlerts();
  else { console.error('Dùng: node tracker.js [serve|report|status|metrics|check]'); process.exit(1); }
}
