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

const LOG_ROOT = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'usage.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
const MODELS_FILE = path.join(__dirname, 'models.json');
const PORT = Number(process.env.PORT) || 7788;
const HOST = process.env.HOST || '127.0.0.1';   // đặt HOST=0.0.0.0 nếu Prometheus chạy trong Docker
const { MIN, HOUR, DAY } = A;
const KEEP_MS = 7 * DAY;
const HISTORY_DAYS = 90;
const STORE_VERSION = 4;
const ALERT_EVERY_MS = 60e3;

const DEFAULT_CONFIG = {
  budgetDay: 0,          // USD, 0 = tắt
  budgetWeek: 0,         // USD (tuần bắt đầu thứ Hai), 0 = tắt
  notify: true,          // gửi thông báo Windows
  alertCacheHit: 80,     // % cache hit trong 1 giờ qua thấp hơn mức này thì báo
  alertContext: 400000,  // token ngữ cảnh của một phiên đang chạy vượt mức này thì báo
  alertWindowRatio: 2,   // cửa sổ 5h dự kiến vượt N lần trung bình thì báo
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

function loadStore() {
  const s = readJSON(STORE_FILE, null);
  if (s && s.v === STORE_VERSION && s.msgs && s.files && s.daily) return s;
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

function addDaily(daily, rec) {
  const day = (daily[A.dayKey(rec.t)] ||= {});
  const a = (day[rec.m + (rec.fs ? '|fast' : '')] ||= { i: 0, o: 0, w5: 0, w1: 0, cr: 0, th: 0, n: 0 });
  a.i += rec.i; a.o += rec.o; a.w5 += Math.max(0, rec.cw - rec.w1); a.w1 += rec.w1;
  a.cr += rec.cr; a.th += rec.th; a.n += 1;
}

// Lần đầu (hoặc khi lâu không chạy): đọc toàn bộ log còn trên máy để lấp lịch sử các ngày cũ.
function backfill(store, now) {
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
  for (const rec of Object.values(seen)) addDaily(tmp, rec);
  for (const [k, v] of Object.entries(tmp)) {
    if (A.dayStartOfKey(k) < cutoff && !store.daily[k]) store.daily[k] = v;
  }
  store.backfilledAt = now;
}

// ---------- quét ----------

function scan() {
  const now = Date.now();
  const cutoff = now - KEEP_MS;
  const store = loadStore();
  let changed = false;

  if (!store.backfilledAt || now - store.lastScan > 6 * DAY) {
    backfill(store, now);
    changed = true;
  }

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
      if (A.startOfDay(rec.t) >= cutoff) addDaily(store.daily, rec);
    }
    store.lastScan = now;
    writeJSON(STORE_FILE, store);
  }
  return store;
}

const toRow = (r) => ({
  t: r.t, model: r.m, project: r.p, session: r.sid, agent: r.ag, chain: r.ch, effort: r.ef, fast: r.fs,
  i: r.i, o: r.o, w5: Math.max(0, r.cw - r.w1), w1: r.w1, cr: r.cr, th: r.th,
});

function analyze() {
  const store = scan();
  const P = loadPricing();
  const rows = A.enrich(Object.values(store.msgs).map(toRow), P);
  return { store, P, rows, now: Date.now() };
}

// ---------- API cho dashboard ----------

const ROW_COLS = ['t', 'model', 'project', 'session', 'agent', 'chain', 'effort', 'fast', 'i', 'o', 'w5', 'w1', 'cr', 'th'];
const INDEXED = ['model', 'project', 'session', 'agent', 'chain', 'effort'];

// Dữ liệu thô gọn: mỗi lượt là 1 mảng số, các cột chữ được đánh chỉ mục để JSON nhỏ.
function records(store) {
  const lists = {}, maps = {};
  for (const k of INDEXED) { lists[k] = []; maps[k] = new Map(); }
  const idx = (k, v) => {
    let i = maps[k].get(v);
    if (i === undefined) { i = lists[k].push(v) - 1; maps[k].set(v, i); }
    return i;
  };
  const rows = Object.values(store.msgs)
    .sort((a, b) => a.t - b.t)
    .map((rec) => {
      const r = toRow(rec);
      return ROW_COLS.map((c) => (INDEXED.includes(c) ? idx(c, r[c]) : r[c]));
    });
  return {
    now: Date.now(),
    keepDays: KEEP_MS / DAY,
    cols: ROW_COLS,
    lists,
    rows,
    daily: store.daily,
    meta: readJSON(MODELS_FILE, { models: [] }),
    config: loadConfig(),
    alerts: loadAlerts().recent,
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
  const { rows, now } = analyze();
  const cfg = loadConfig();
  const s = A.summary(rows, now);
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

  if (s.window && s.avgWindowCost > 0 && s.window.n >= 10 && s.projected > cfg.alertWindowRatio * s.avgWindowCost) {
    push(`burn:${s.window.start}`, 'warning', 'Cửa sổ 5 giờ đang dùng nhanh',
      `Dự kiến ${usd(s.projected)} đến ${hhmm(s.window.end)}, gấp ${(s.projected / s.avgWindowCost).toFixed(1)} lần trung bình`);
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
  const { rows, now, P } = analyze();
  const cfg = loadConfig();
  const s = A.summary(rows, now);
  const parts = [];
  if (s.window) parts.push(`5h ${usd(s.window.cost)} · reset ${hhmm(s.window.end)}`);
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

function serve() {
  const send = (res, code, type, body) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  };
  const json = (res, data) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify(data));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/records') return json(res, records(scan()));
      if (url.pathname === '/api/config' && req.method === 'POST') {
        const cfg = saveConfig(JSON.parse(await readBody(req) || '{}'));
        checkAlerts();
        return json(res, cfg);
      }
      if (url.pathname === '/api/config') return json(res, loadConfig());
      if (url.pathname === '/api/alerts') {
        const after = Number(url.searchParams.get('after')) || 0;
        return json(res, loadAlerts().recent.filter((a) => a.id > after));
      }
      if (url.pathname === '/api/test-notify' && req.method === 'POST') {
        notifyWindows('Theo dõi token', 'Thông báo hoạt động bình thường');
        return json(res, { ok: true });
      }
      if (url.pathname === '/api/summary') {
        const { rows, now } = analyze();
        const s = A.summary(rows, now);
        return json(res, {
          today: s.today, week: s.week, d24: s.d24, tok24: s.tok24,
          window: s.window && { cost: s.window.cost, end: s.window.end }, projected: s.projected,
          avgWindowCost: s.avgWindowCost,
          text: `5h ${s.window ? `${usd(s.window.cost)} (reset ${hhmm(s.window.end)})` : '—'} · hôm nay ${usd(s.today)} · 24h ${fmt(s.tok24)} token`,
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
      send(res, 500, 'text/plain; charset=utf-8', String((err && err.stack) || err));
    }
  });

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
  });
}

const cmd = process.argv[2] || 'report';
if (cmd === 'serve') serve();
else if (cmd === 'status') statusLine();
else if (cmd === 'report') report();
else if (cmd === 'metrics') process.stdout.write(metrics());
else if (cmd === 'check') checkAlerts();
else { console.error('Dùng: node tracker.js [serve|report|status|metrics|check]'); process.exit(1); }
