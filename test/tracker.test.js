const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { makeEnv, fakeAccount, writeLoginFiles } = require('./helpers.js');

// Env phải đặt TRƯỚC khi require tracker.js (các hằng đường dẫn đọc env lúc nạp module).
const env = makeEnv();
const PROJECTS = path.join(env.dir, 'projects');
process.env.CLAUDE_PROJECTS_DIR = PROJECTS;
process.env.TT_SKIP_PROCESS_CHECK = '1';
const T = require('../tracker.js');
const A = require('../analytics.js');
const acc = require('../accounts.js');
test.after(() => env.cleanup());

const HOUR = 3600e3;
const alertsFile = path.join(env.dataDir, 'alerts.json');

// Xoá mọi thứ test trước để lại: đăng nhập, hồ sơ, log, store, cảnh báo, log hội thoại.
function reset() {
  for (const f of ['.credentials.json', '.claude.json']) fs.rmSync(path.join(env.dir, f), { force: true });
  fs.rmSync(path.join(env.dir, 'account-profiles'), { recursive: true, force: true });
  fs.rmSync(PROJECTS, { recursive: true, force: true });
  for (const f of fs.readdirSync(env.dataDir)) fs.rmSync(path.join(env.dataDir, f), { recursive: true, force: true });
  fs.mkdirSync(PROJECTS, { recursive: true });
}

// Ba lượt assistant ở t0, t0+1h, t0+3h (t0 = 4h05 trước).
function writeTurns() {
  const t0 = Date.now() - 4 * HOUR - 5 * 60e3;
  const lines = [0, 1, 3].map((h, n) => JSON.stringify({
    type: 'assistant', timestamp: new Date(t0 + h * HOUR).toISOString(), sessionId: 's1', cwd: 'C:\\proj\\demo',
    message: {
      id: `msg-${n}`, model: 'claude-fable-5-1',
      usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 2000, cache_read_input_tokens: 20000 },
    },
  }));
  fs.mkdirSync(path.join(PROJECTS, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(PROJECTS, 'demo', 's1.jsonl'), lines.join('\n') + '\n');
  return t0;
}

const profile = (a, usage = null) => ({
  v: 1, id: a.id, name: a.email.split('@')[0], email: a.email, plan: 'max',
  oauth: a.oauth, organizationUuid: a.org, oauthAccount: a.oauthAccount, usage, savedAt: 1000,
});

// Hai hồ sơ; file đăng nhập là loginAs; log: acc-1 từ đầu, (tuỳ chọn) đổi sang acc-2 lúc switchAt.
function seed({ loginAs = 1, switchAt = null, usage1 = null, usage2 = null, loginExtras = {} } = {}) {
  const a1 = fakeAccount(1), a2 = fakeAccount(2);
  writeLoginFiles(env.dir, loginAs === 1 ? a1 : a2, loginExtras);
  acc.saveProfile(profile(a1, usage1));
  acc.saveProfile(profile(a2, usage2));
  const log = acc.readLog();
  acc.addEntry(log, { t: 0, id: 'acc-1', reason: 'init' });
  if (switchAt != null) acc.addEntry(log, { t: switchAt, id: 'acc-2', reason: 'switch' });
  acc.writeLog(log);
}

const decode = (rec, col) => rec.rows.map((r) => {
  const v = r[rec.cols.indexOf(col)];
  return rec.lists[col] ? rec.lists[col][v] : v;
});
const noTokens = (text) => assert.ok(!/at-\d|rt-\d/.test(text), 'không được có token');

test('records(): cột account theo dòng thời gian, daily khoá theo tài khoản', () => {
  reset();
  const t0 = writeTurns();
  seed({ loginAs: 2, switchAt: t0 + 2 * HOUR });
  const rec = T.records();
  assert.deepEqual(decode(rec, 'account'), ['acc-1', 'acc-1', 'acc-2']);
  const keys = Object.values(rec.daily).flatMap((d) => Object.keys(d));
  assert.ok(keys.some((k) => k.startsWith('acc-1|')), keys.join());
  assert.ok(keys.some((k) => k.startsWith('acc-2|')), keys.join());
  assert.ok(keys.every((k) => k.includes('|claude-fable-5-1')));
  assert.ok(rec.accountLog.length >= 2);
});

test('accountsInfo: chi phí hôm nay/tuần cộng đúng, không lộ token', () => {
  reset();
  const t0 = writeTurns();
  seed({ loginAs: 2, switchAt: t0 + 2 * HOUR });
  const { rows, now } = T.analyze();
  const info = T.accountsInfo(rows, now);
  assert.equal(info.active, 'acc-2');
  assert.equal(info.fileAccount, 'acc-2');
  assert.equal(info.conflict, null);
  const sum = (f) => rows.filter(f).reduce((a, r) => a + r.c.total, 0);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  near(info.accounts.reduce((a, x) => a + x.costToday, 0), sum((r) => r.t >= A.startOfDay(now)));
  near(info.accounts.reduce((a, x) => a + x.costWeek, 0), sum((r) => r.t >= A.startOfWeek(now)));
  const a1 = info.accounts.find((x) => x.id === 'acc-1');
  const a2 = info.accounts.find((x) => x.id === 'acc-2');
  assert.ok(a1.costWeek > 0 && a2.costWeek > 0);
  assert.equal(typeof a1.suggested, 'boolean');
  assert.equal(info.accounts.filter((x) => x.suggested).length <= 1, true);
  noTokens(JSON.stringify(info) + JSON.stringify(T.records()));
});

test('accountsInfo: chỉ gợi ý tài khoản có usage thô (suggestAccount nhận usage thô)', () => {
  reset();
  writeTurns();
  const usage = {
    fetchedAtMs: Date.now(), accountUuid: 'acc-1',
    utilization: { five_hour: { utilization: 20, resets_at: new Date(Date.now() + HOUR).toISOString() }, seven_day: null },
  };
  seed({ usage1: usage });
  // chọn acc-2, file là acc-2 -> acc-1 là ứng viên duy nhất
  const log = acc.readLog(); acc.addEntry(log, { t: 10, id: 'acc-2', reason: 'switch' }); acc.writeLog(log);
  writeLoginFiles(env.dir, fakeAccount(2));
  const { rows, now } = T.analyze();
  const info = T.accountsInfo(rows, now);
  assert.deepEqual(info.accounts.filter((x) => x.suggested).map((x) => x.id), ['acc-1']);
});

test('hồ sơ hỏng vẫn có trong accountsInfo kèm error', () => {
  reset();
  writeTurns();
  seed();
  fs.writeFileSync(path.join(acc.paths().profilesDir, 'broken.json'), '{ not json');
  const { rows, now } = T.analyze();
  const bad = T.accountsInfo(rows, now).accounts.find((x) => x.id === 'broken');
  assert.ok(bad && bad.error);
});

test('không có .credentials.json và không có hồ sơ: vẫn chạy', () => {
  reset();
  writeTurns();
  const rec = T.records();
  assert.equal(rec.rows.length, 3);
  assert.deepEqual(rec.accounts.accounts, []);
  assert.equal(rec.accounts.active, null);
  assert.equal(rec.accounts.fileAccount, null);
});

test('nâng cấp store v4 -> v5: ngày đã chốt cũ hơn mọi log được giữ dưới khoá init|model, ngày gần đây dựng lại từ log', () => {
  reset();
  const t0 = writeTurns();
  seed({ loginAs: 2, switchAt: t0 + 2 * HOUR });
  const DAY = 24 * HOUR;
  const oldKey = A.dayKey(Date.now() - 60 * DAY);       // cũ hơn mọi file log còn lại -> chỉ còn trong store
  const midKey = A.dayKey(Date.now() - 20 * DAY);       // có trong store lẫn log: không được ghi đè
  const staleKey = A.dayKey(Date.now() - 3 * DAY);      // trong 7 ngày chi tiết: bỏ và dựng lại
  const oldVal = { i: 111, o: 222, w5: 333, w1: 4, cr: 5555, th: 6, n: 7 };
  fs.writeFileSync(path.join(env.dataDir, 'usage.json'), JSON.stringify({
    v: 4, files: { x: { mtime: 1, size: 1 } }, msgs: { m: { t: 1 } }, backfilledAt: Date.now(), lastScan: Date.now(),
    daily: {
      [oldKey]: { 'claude-old': oldVal, 'claude-old|fast': { ...oldVal, n: 1 } },
      [midKey]: { 'claude-fable-5-1': { ...oldVal, n: 9 } },
      [staleKey]: { 'claude-fable-5-1': { ...oldVal, n: 99 } },
    },
  }));
  // log 20 ngày trước (cùng ngày midKey) có 1 lượt khác hẳn
  const tMid = Date.now() - 20 * DAY;
  fs.writeFileSync(path.join(PROJECTS, 'demo', 'mid.jsonl'), JSON.stringify({
    type: 'assistant', timestamp: new Date(tMid).toISOString(), sessionId: 's2', cwd: 'C:\\proj\\demo',
    message: { id: 'mid-1', model: 'claude-fable-5-1', usage: { input_tokens: 5, output_tokens: 5 } },
  }) + '\n');

  const rec = T.records();
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.dataDir, 'usage.json'), 'utf8')).v, 5);
  assert.deepEqual(rec.daily[oldKey], { 'acc-1|claude-old': oldVal, 'acc-1|claude-old|fast': { ...oldVal, n: 1 } });
  assert.deepEqual(rec.daily[midKey], { 'acc-1|claude-fable-5-1': { ...oldVal, n: 9 } });
  assert.equal(rec.daily[staleKey], undefined);
  const today = rec.daily[A.dayKey(t0)];
  assert.ok(Object.keys(today).some((k) => k.startsWith('acc-1|')) && Object.keys(today).some((k) => k.startsWith('acc-2|')), Object.keys(today).join());
  assert.ok(Object.keys(rec.daily).every((d) => Object.keys(rec.daily[d]).every((k) => /^acc-\d\|/.test(k))));
});

// ---- server ----

async function withServer(fn) {
  const server = T.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const call = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: d, json: () => JSON.parse(d) }));
    });
    req.on('error', reject);
    req.end(body);
  });
  try { return await fn({ call, port }); } finally { await new Promise((r) => server.close(r)); }
}

const CSRF = { 'X-Token-Tracker': '1' };
const loginId = () => JSON.parse(fs.readFileSync(acc.paths().claudeJson, 'utf8')).oauthAccount.accountUuid;

test('API: GET /api/accounts, chặn CSRF, đổi tài khoản, lỗi 400', async () => {
  reset();
  writeTurns();
  seed();
  await withServer(async ({ call, port }) => {
    const g = await call('GET', '/api/accounts');
    assert.equal(g.status, 200);
    assert.equal(g.json().accounts.length, 2);
    noTokens(g.text);

    const body = JSON.stringify({ id: 'acc-2' });
    const noHeader = await call('POST', '/api/accounts/switch', { body });
    assert.equal(noHeader.status, 403);
    assert.equal(loginId(), 'acc-1');

    const evil = await call('POST', '/api/accounts/switch', { body, headers: { ...CSRF, Origin: 'http://evil.example' } });
    assert.equal(evil.status, 403);
    const wrongPort = await call('POST', '/api/accounts/switch', { body, headers: { ...CSRF, Origin: `http://127.0.0.1:${port + 1}` } });
    assert.equal(wrongPort.status, 403);
    assert.equal(loginId(), 'acc-1');

    const ok = await call('POST', '/api/accounts/switch', { body, headers: CSRF });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(loginId(), 'acc-2');
    const r = ok.json();
    assert.equal(r.to, 'acc-2');
    assert.ok(Array.isArray(r.running));
    noTokens(ok.text);

    const unknown = await call('POST', '/api/accounts/switch', { body: JSON.stringify({ id: 'zzz-unknown' }), headers: CSRF });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json().error, 'NOT_FOUND');

    const badJson = await call('POST', '/api/accounts/switch', { body: '{oops', headers: CSRF });
    assert.equal(badJson.status, 400);

    const none = await call('POST', '/api/accounts/keep', { body: '{}', headers: CSRF });
    assert.equal(none.status, 400);
    assert.equal(none.json().error, 'NOT_FOUND');
    assert.equal((await call('POST', '/api/accounts/keep', { body: '{}' })).status, 403);

    // Origin hợp lệ (cùng cổng) được chấp nhận; rename dùng accounts.rename (luật trùng tên nằm ở đó)
    const own = { ...CSRF, Origin: `http://localhost:${port}` };
    const taken = await call('POST', '/api/accounts/rename', { body: JSON.stringify({ id: 'acc-1', name: 'USER2' }), headers: own });
    assert.equal(taken.status, 400);
    assert.equal(taken.json().error, 'NAME_TAKEN');
    const renamed = await call('POST', '/api/accounts/rename', { body: JSON.stringify({ id: 'acc-1', name: 'cam' }), headers: own });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal(renamed.json().name, 'cam');
    noTokens(renamed.text);
  });
});

test('API: POST keep xử lý conflict; /api/summary báo conflict', async () => {
  reset();
  writeTurns();
  seed({ loginAs: 2 });                       // file = acc-2, đang chọn acc-1 -> conflict
  fs.writeFileSync(path.join(env.dataDir, 'config.json'), JSON.stringify({ notify: false }));
  await withServer(async ({ call }) => {
    const s = (await call('GET', '/api/summary')).json();
    assert.equal(s.conflict, true);
    assert.equal(s.account.name, 'user1');
    assert.deepEqual(s.needLogin, []);
    const k = await call('POST', '/api/accounts/keep', { body: '{}', headers: CSRF });
    assert.equal(k.status, 200, k.text);
    assert.equal(k.json().id, 'acc-2');
    const s2 = (await call('GET', '/api/summary')).json();
    assert.equal(s2.conflict, false);
    assert.equal(s2.account.name, 'user2');
  });
});

test('/api/summary: cửa sổ 5h chỉ tính lượt của tài khoản đang chọn', async () => {
  reset();
  const t0 = writeTurns();
  seed({ loginAs: 2, switchAt: t0 + 2 * HOUR });
  await withServer(async ({ call }) => {
    const s = (await call('GET', '/api/summary')).json();
    const { rows } = T.analyze();
    const mine = rows.filter((r) => r.account === 'acc-2');
    assert.equal(mine.length, 1);
    assert.ok(s.window, 'phải có cửa sổ 5h đang chạy');
    assert.ok(Math.abs(s.window.cost - mine[0].c.total) < 1e-9);
    assert.ok(s.d24 >= 3 * mine[0].c.total - 1e-9);   // ngân sách/tổng vẫn tính mọi tài khoản
  });
});

// ---- cảnh báo ----

const future = (ms) => new Date(Date.now() + ms).toISOString();
const readAlerts = () => JSON.parse(fs.readFileSync(alertsFile, 'utf8')).recent;
const writeConfig = (c) => fs.writeFileSync(path.join(env.dataDir, 'config.json'), JSON.stringify(c));
const initLog = () => { const log = acc.readLog(); acc.addEntry(log, { t: 0, id: 'acc-1', reason: 'init' }); acc.writeLog(log); };

test('checkAlerts: gần hết hạn mức 5h kèm gợi ý, không báo trùng', () => {
  reset();
  writeTurns();
  writeConfig({ notify: false, alertLimitPct: 90 });
  const usage = (n5, n7, fetchedAtMs, id) => ({
    fetchedAtMs, accountUuid: id,
    utilization: { five_hour: { utilization: n5, resets_at: future(2 * HOUR) }, seven_day: { utilization: n7, resets_at: future(48 * HOUR) } },
  });
  seed({
    loginAs: 1,
    loginExtras: { usage: usage(92, 10, Date.now(), 'acc-1') },
    usage2: usage(20, 5, Date.now() - 3 * HOUR, 'acc-2'),
  });
  T.checkAlerts();
  const first = readAlerts();
  const limit = first.filter((a) => /92%/.test(a.title));
  assert.equal(limit.length, 1, JSON.stringify(first));
  assert.match(limit[0].title, /user1 đã dùng 92% cửa sổ 5h/);
  assert.match(limit[0].body, /Gợi ý: user2 \(đang 20%, cập nhật 3 giờ trước\)/);
  T.checkAlerts();
  assert.equal(readAlerts().length, first.length);
});

test('checkAlerts: không có tài khoản khác thì nói rõ', () => {
  reset();
  writeTurns();
  writeConfig({ notify: false });
  const a1 = fakeAccount(1);
  writeLoginFiles(env.dir, a1, { usage: { utilization: { five_hour: { utilization: 95, resets_at: future(HOUR) } } } });
  acc.saveProfile(profile(a1));
  initLog();
  T.checkAlerts();
  const a = readAlerts().find((x) => /95%/.test(x.title));
  assert.ok(a);
  assert.match(a.body, /Không có tài khoản khác còn hạn mức/);
});

test('checkAlerts: alertLimitPct = 0 tắt cảnh báo hạn mức', () => {
  reset();
  writeTurns();
  writeConfig({ notify: false, alertLimitPct: 0 });
  const a1 = fakeAccount(1);
  writeLoginFiles(env.dir, a1, { usage: { utilization: { five_hour: { utilization: 99, resets_at: future(HOUR) } } } });
  acc.saveProfile(profile(a1));
  initLog();
  T.checkAlerts();
  const recent = fs.existsSync(alertsFile) ? readAlerts() : [];
  assert.ok(!recent.some((x) => /99%/.test(x.title)));
});

test('checkAlerts: conflict và đăng nhập hết hạn', () => {
  reset();
  writeTurns();
  writeConfig({ notify: false });
  const a1 = fakeAccount(1);
  const a2 = fakeAccount(2);
  a2.oauth = { ...a2.oauth, refreshTokenExpiresAt: Date.now() - 1000 };
  writeLoginFiles(env.dir, a2);                  // file = acc-2 (đã hết hạn), đang chọn acc-1
  acc.saveProfile(profile(a1));
  acc.saveProfile(profile(a2));
  initLog();
  T.checkAlerts();
  const titles = readAlerts().map((x) => `${x.level}|${x.title}`);
  assert.ok(titles.includes('warning|Đăng nhập hiện là user2 nhưng bạn đang chọn user1'), titles.join('\n'));
  assert.ok(titles.includes('critical|user2: cần /login lại'), titles.join('\n'));
  const n = titles.length;
  T.checkAlerts();
  assert.equal(readAlerts().length, n);
});

test('checkAlerts: tài khoản mới đăng nhập báo info', () => {
  reset();
  writeTurns();
  writeConfig({ notify: false });
  acc.saveProfile(profile(fakeAccount(1)));
  writeLoginFiles(env.dir, fakeAccount(2));      // acc-2 chưa có hồ sơ -> sync tự thêm, reason 'login'
  initLog();
  T.checkAlerts();
  const a = readAlerts().find((x) => x.level === 'info' && /user2@example\.com/.test(x.title));
  assert.ok(a, JSON.stringify(readAlerts()));
});

test('API: POST /api/config và /api/test-notify chặn CSRF, JSON sai trả 400', async () => {
  reset();
  writeTurns();
  seed();
  await withServer(async ({ call }) => {
    const body = JSON.stringify({ budgetDay: 7 });
    // form của trang lạ (text/plain, không có header tự đặt) không đổi được cài đặt
    assert.equal((await call('POST', '/api/config', { body })).status, 403);
    assert.equal((await call('POST', '/api/config', { body, headers: { ...CSRF, Origin: 'http://evil.example' } })).status, 403);
    assert.equal((await call('GET', '/api/config')).json().budgetDay, 0);
    assert.equal((await call('POST', '/api/test-notify')).status, 403);
    const bad = await call('POST', '/api/config', { body: '{oops', headers: CSRF });
    assert.equal(bad.status, 400);
    assert.equal(bad.json().error, 'FORMAT');
    const ok = await call('POST', '/api/config', { body, headers: CSRF });
    assert.equal(ok.status, 200);
    assert.equal(ok.json().budgetDay, 7);
  });
});

test('API: /api/* chỉ nhận Host là loopback đúng cổng (chống DNS rebinding); /metrics và trang tĩnh thì không kiểm tra', async () => {
  reset();
  writeTurns();
  seed();
  await withServer(async ({ call, port }) => {
    for (const p of ['/api/accounts', '/api/records', '/api/summary', '/api/config']) {
      const bad = await call('GET', p, { headers: { Host: `evil.example:${port}` } });
      assert.equal(bad.status, 403, p);
      assert.equal(bad.json().error, 'FORBIDDEN');
      assert.equal((await call('GET', p, { headers: { Host: `127.0.0.1:${port + 1}` } })).status, 403, p);
      assert.equal((await call('GET', p, { headers: { Host: '127.0.0.1' } })).status, 403, p);
    }
    assert.equal((await call('GET', '/api/accounts', { headers: { Host: `127.0.0.1:${port}` } })).status, 200);
    assert.equal((await call('GET', '/api/accounts', { headers: { Host: `localhost:${port}` } })).status, 200);
    assert.equal((await call('GET', '/api/accounts')).status, 200);
    const foreign = { Host: 'tracker.docker.internal:7788' };
    assert.equal((await call('GET', '/metrics', { headers: foreign })).status, 200);
    assert.equal((await call('GET', '/', { headers: foreign })).status, 200);
    assert.equal((await call('GET', '/analytics.js', { headers: foreign })).status, 200);
  });
});

test('API: /api/accounts không lộ prev (lịch sử token của hồ sơ)', async () => {
  reset();
  writeTurns();
  seed();
  const p = acc.loadProfile('acc-1');
  acc.saveProfile({ ...p, prev: [{ oauth: { accessToken: 'at-old', refreshToken: 'rt-old' }, organizationUuid: 'o', oauthAccount: p.oauthAccount, savedAt: 1 }] });
  await withServer(async ({ call }) => {
    const g = await call('GET', '/api/accounts');
    assert.equal(g.status, 200);
    assert.ok(!g.text.includes('prev') && !g.text.includes('rt-old') && !g.text.includes('at-old'), g.text);
    const r = await call('GET', '/api/records');
    assert.ok(!r.text.includes('prev') && !r.text.includes('rt-old'));
  });
});

// ---- hạn mức trực tiếp từ Anthropic ----

const okFetch = (byToken, calls = []) => async (url, opts) => {
  const tok = opts.headers.Authorization.replace('Bearer ', '');
  calls.push(tok);
  if (!(tok in byToken)) return { ok: false, status: 401, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => byToken[tok] };
};
const util = (five, seven) => ({ five_hour: { utilization: five, resets_at: new Date(Date.now() + HOUR).toISOString() },
  seven_day: { utilization: seven, resets_at: new Date(Date.now() + 48 * HOUR).toISOString() } });

test('refreshUsage: hỏi Anthropic cho từng hồ sơ còn token, bỏ token hết hạn / vừa hỏi / lỗi', async () => {
  reset();
  seed({ loginAs: 2 });
  // hồ sơ acc-3 có access token đã hết hạn -> không hỏi
  const a3 = fakeAccount(3);
  acc.saveProfile({ ...profile(a3), oauth: { ...a3.oauth, expiresAt: Date.now() - 1 } });
  const calls = [];
  const r = await T.refreshUsage(Date.now(), okFetch({ 'at-1': util(100, 87), 'at-2': util(15, 2) }, calls));
  assert.deepEqual(calls.sort(), ['at-1', 'at-2']);
  assert.deepEqual(r.updated.sort(), ['acc-1', 'acc-2']);
  assert.equal(acc.loadProfile('acc-1').usage.utilization.five_hour.utilization, 100);
  assert.equal(acc.loadProfile('acc-2').usage.utilization.seven_day.utilization, 2);
  // gọi lại ngay -> không hỏi lại (giới hạn tần suất)
  const calls2 = [];
  await T.refreshUsage(Date.now(), okFetch({ 'at-1': util(1, 1) }, calls2));
  assert.deepEqual(calls2, []);
  // lỗi mạng không ném ra ngoài
  const r3 = await T.refreshUsage(Date.now() + 10 * 60e3, async () => { throw new Error('offline'); });
  assert.deepEqual(r3.updated, []);
});

test('refreshUsage: tài khoản đang trong file dùng token mới nhất từ .credentials.json', async () => {
  reset();
  seed({ loginAs: 2 });
  // Claude Code vừa làm mới token acc-2 trong file, hồ sơ còn token cũ
  const a2 = fakeAccount(2);
  writeLoginFiles(env.dir, { ...a2, oauth: { ...a2.oauth, accessToken: 'at-2-new' } });
  const calls = [];
  await T.refreshUsage(Date.now(), okFetch({ 'at-2-new': util(15, 2), 'at-1': util(5, 5) }, calls));
  assert.ok(calls.includes('at-2-new'));
  assert.ok(!calls.includes('at-2'));
});

test('accountsInfo: số liệu cũ mà sau đó còn dùng -> stale, không được gợi ý', () => {
  reset();
  const t0 = writeTurns();                                   // lượt của acc-1 tới t0+3h
  const old = { fetchedAtMs: t0, accountUuid: 'acc-1', utilization: util(18, 20) };
  const fresh = { fetchedAtMs: Date.now(), accountUuid: 'acc-2', utilization: util(50, 60) };
  seed({ loginAs: 2, switchAt: t0 + 3.5 * HOUR, usage1: old, usage2: fresh });
  const { rows, now } = T.analyze();
  const info = T.accountsInfo(rows, now);
  const a1 = info.accounts.find((a) => a.id === 'acc-1');
  assert.equal(a1.stale, true);
  assert.equal(a1.suggested, false);
  assert.equal(info.accounts.find((a) => a.id === 'acc-2').stale, false);
});

test('/api/summary: cửa sổ 5h theo mốc reset thật của tài khoản đang chọn', async () => {
  reset();
  const t0 = writeTurns();
  const resetsAt = Math.round((Date.now() + 2 * HOUR) / 60e3) * 60e3;   // mốc thật luôn tròn phút
  const u2 = { fetchedAtMs: Date.now(), accountUuid: 'acc-2', utilization: {
    five_hour: { utilization: 15, resets_at: new Date(resetsAt).toISOString() }, seven_day: null } };
  seed({ loginAs: 2, switchAt: t0 + 2 * HOUR, usage2: u2 });
  await withServer(async ({ call }) => {
    const s = (await call('GET', '/api/summary')).json();
    assert.equal(s.window.end, resetsAt);
    assert.equal(s.window.real, true);
  });
});

test('refreshUsage: tài khoản đang trong file hỏi lại sau ~1 phút, tài khoản khác 5 phút', async () => {
  reset();
  seed({ loginAs: 2 });
  const t = Date.now();
  await T.refreshUsage(t, okFetch({ 'at-1': util(10, 10), 'at-2': util(20, 20) }));
  const calls = [];
  await T.refreshUsage(t + 61e3, okFetch({ 'at-1': util(11, 11), 'at-2': util(21, 21) }, calls));
  assert.deepEqual(calls, ['at-2']);
  const calls2 = [];
  await T.refreshUsage(t + 5 * 60e3 + 1e3, okFetch({ 'at-1': util(12, 12), 'at-2': util(22, 22) }, calls2));
  assert.deepEqual(calls2.sort(), ['at-1', 'at-2']);
});

// ---- ghép PC với hub (VPS) ----

test('api/hub: ghép qua hub thật lưu token, không lưu mật khẩu; sai mật khẩu 400; thiếu header 403; ngắt thì xoá file và thu hồi trên hub', async () => {
  reset();
  const { startHub } = require('./hub-helpers.js');
  const H = await startHub();
  const hubFile = path.join(env.dataDir, 'hub.json');
  try {
    await H.h.cli(['init', 'cam', 'mat-khau-cam']);
    await withServer(async ({ call }) => {
      const body = (o) => JSON.stringify(o);
      const pairBody = { hubUrl: H.base, username: 'cam', password: 'mat-khau-cam', name: 'pc-test' };
      assert.equal((await call('POST', '/api/hub/pair', { body: body(pairBody) })).status, 403, 'thiếu X-Token-Tracker');
      const bad = await call('POST', '/api/hub/pair', { headers: CSRF, body: body({ ...pairBody, password: 'sai-mat-khau' }) });
      assert.equal(bad.status, 400);
      assert.equal(bad.json().error, 'BAD_LOGIN');
      assert.equal((await call('POST', '/api/hub/pair', { headers: CSRF, body: body({ ...pairBody, hubUrl: 'ftp://x' }) })).json().error, 'FORMAT');
      const ok = await call('POST', '/api/hub/pair', { headers: CSRF, body: body(pairBody) });
      assert.equal(ok.status, 200, ok.text);
      assert.equal(ok.json().paired, true);
      const saved = JSON.parse(fs.readFileSync(hubFile, 'utf8'));
      assert.equal(saved.hubUrl, H.base);
      assert.ok(saved.machineToken && saved.machineId);
      assert.ok(!fs.readFileSync(hubFile, 'utf8').includes('mat-khau-cam'), 'không lưu mật khẩu');
      const user = H.h.db.userByName('cam');
      assert.deepEqual(H.h.db.machines(user.id).map((m) => m.name), ['pc-test']);
      const st = (await call('GET', '/api/remote')).json().hub;
      assert.equal(st.paired, true);
      assert.equal(st.name, 'pc-test');
      assert.ok(!JSON.stringify(st).includes(saved.machineToken), 'không trả token ra dashboard');
      assert.equal((await call('POST', '/api/hub/unpair', {})).status, 403);
      const un = await call('POST', '/api/hub/unpair', { headers: CSRF });
      assert.equal(un.json().paired, false);
      assert.ok(!fs.existsSync(hubFile));
      assert.deepEqual(H.h.db.machines(user.id), [], 'token máy bị thu hồi trên hub');
    });
  } finally { await H.stop(); try { fs.unlinkSync(hubFile); } catch {} }
});

test('api/remote: chỉ còn hub, hook, luôn sẵn sàng — bỏ Tailscale / mã ghép / ntfy riêng', async () => {
  reset();
  await withServer(async ({ call }) => {
    const r = (await call('GET', '/api/remote')).json();
    assert.deepEqual(Object.keys(r).sort(), ['alwaysOn', 'enabled', 'hooks', 'hub', 'live']);
    for (const p of ['pair', 'revoke', 'ntfy', 'ntfy-test', 'serve']) {
      assert.equal((await call('POST', `/api/remote/${p}`, { headers: CSRF, body: '{}' })).status, 404, p);
    }
  });
});
