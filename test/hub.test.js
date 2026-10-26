// Hub trên VPS: DB, xác thực, chia mảnh, định tuyến + cách ly người dùng, thông báo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hub-'));
const HOUR = 3600e3, MIN = 60e3, DAY = 24 * HOUR;

// ---------- Task 1: DB + xác thực ----------

const { openDb } = require('../hub/db.js');
const auth = require('../hub/auth.js');

test('hub: tài khoản, mã mời, token, khoá sai mật khẩu', async () => {
  const db = openDb(path.join(tmp(), 'hub.db'));
  // mật khẩu
  const h = await auth.hashPassword('mat-khau-dai');
  assert.match(h, /^scrypt\$/);
  assert.equal(await auth.verifyPassword('mat-khau-dai', h), true);
  assert.equal(await auth.verifyPassword('sai', h), false);
  // tên đăng nhập
  assert.equal(auth.normUser('Cam'), 'cam');
  assert.equal(auth.normUser('a'), null);
  assert.equal(auth.normUser('có dấu'), null);
  // người dùng + mã mời dùng một lần, hết hạn 24 giờ
  const admin = db.createUser({ username: 'cam', passHash: h, admin: true });
  assert.equal(db.userByName('cam').id, admin.id);
  const t0 = Date.now();
  db.addInvite(auth.sha('MOI1'), admin.id, t0 + DAY);
  const bob = db.createUser({ username: 'bob', passHash: h, admin: false });
  assert.equal(db.useInvite(auth.sha('MOI1'), bob.id, t0 + HOUR), true);
  assert.equal(db.useInvite(auth.sha('MOI1'), bob.id, t0 + HOUR), false, 'chỉ dùng một lần');
  db.addInvite(auth.sha('MOI2'), admin.id, t0 + DAY);
  assert.equal(db.useInvite(auth.sha('MOI2'), bob.id, t0 + DAY + 1), false, 'hết hạn');
  // token chỉ lưu dạng băm
  const { token, hash } = auth.newToken();
  assert.equal(hash, auth.sha(token));
  assert.ok(Buffer.from(token, 'base64url').length === 32);
  const dev = db.addDevice(admin.id, 'iPhone', hash);
  assert.equal(db.deviceByToken(auth.sha(token)).id, dev.id);
  assert.equal(db.deviceByToken(token), undefined, 'không lưu token gốc');
  // máy của người khác: không thu hồi / đổi tên được
  const m = db.addMachine(admin.id, 'admin-pc', auth.newToken().hash);
  assert.equal(db.revokeMachine(bob.id, m.id), false);
  assert.equal(db.renameMachine(bob.id, m.id, 'của tao'), false);
  assert.deepEqual(db.machines(bob.id), []);
  assert.equal(db.machines(admin.id)[0].name, 'admin-pc');
  // topic ntfy mỗi người khác nhau, ổn định
  const ta = db.ntfyTopic(admin.id);
  assert.match(ta, /^[0-9a-f]{32}$/);
  assert.equal(db.ntfyTopic(admin.id), ta);
  assert.notEqual(db.ntfyTopic(bob.id), ta);
  // sai mật khẩu 5 lần trong 15 phút -> khoá 15 phút
  const lim = new auth.Limiter();
  const k = 'cam|1.2.3.4';
  for (let i = 0; i < 5; i++) { assert.equal(lim.blocked(k, t0), false); lim.fail(k, t0 + i); }
  assert.equal(lim.blocked(k, t0 + 10), true);
  assert.equal(lim.blocked(k, t0 + 15 * MIN + 10), false);
  db.close();
});

// ---------- Task 2: chia mảnh ----------

const proto = require('../hub/proto.js');

test('proto: chia và ghép tin 5 MB; header mang đích ở mọi mảnh', () => {
  const big = { type: 'req', id: 'r1', method: 'sessions.send', params: { text: 'x'.repeat(5 * 1024 * 1024) } };
  const parts = proto.splitMessage(big, { machine: 'm1' });
  assert.ok(parts.length >= 20);
  const asm = new proto.Assembler();
  let out = null;
  for (const buf of parts) {
    const { header, payload } = proto.decodePart(buf);
    assert.equal(header.type, 'part');
    assert.equal(header.machine, 'm1');
    assert.ok(buf.length <= 1024 * 1024);
    out = asm.push(header, payload, Date.now());
  }
  assert.deepEqual(out, big);
  assert.equal(proto.splitMessage({ type: 'req', params: { text: 'nhỏ' } }), null, 'tin nhỏ không chia');
});

test('proto: tin vượt 50 MB bị huỷ; quá 4 tin dở bị từ chối; mảnh im 60 giây bị bỏ', () => {
  const asm = new proto.Assembler();
  const mb = Buffer.alloc(1024 * 1024);
  assert.throws(() => { for (let i = 0; i < 51; i++) asm.push({ pid: 'p', idx: i, last: false }, mb, 0); }, (e) => e.code === 'TOO_LARGE');
  const a2 = new proto.Assembler();
  for (const p of ['a', 'b', 'c', 'd']) a2.push({ pid: p, idx: 0, last: false }, mb, 0);
  assert.throws(() => a2.push({ pid: 'e', idx: 0, last: false }, mb, 0), (e) => e.code === 'TOO_MANY');
  a2.sweep(61e3);
  assert.doesNotThrow(() => a2.push({ pid: 'e', idx: 0, last: false }, mb, 61e3));
  assert.throws(() => a2.push({ pid: 'e', idx: 2, last: true }, mb, 61e3), (e) => e.code === 'BAD_PART', 'thiếu mảnh');
});

// ---------- Task 3: server, định tuyến, cách ly ----------

const { startHub, twoUsers } = require('./hub-helpers.js');


test('hub HTTP: đăng ký bằng mã mời, đăng nhập, đăng xuất, ghép máy, health; sai tên / sai mật khẩu cùng lỗi; khoá sau 5 lần sai', async () => {
  const T = await startHub();
  try {
    assert.deepEqual((await (await fetch(T.base + '/v1/health')).json()), { ok: true, proto: 1 });
    await T.h.cli(['init', 'cam', 'mat-khau-cam']);
    assert.equal((await T.post('/v1/auth/register', { invite: 'BAY', username: 'bob', password: 'mat-khau-bob' })).body.error, 'BAD_INVITE');
    const invite = await T.h.cli(['invite']);
    assert.equal((await T.post('/v1/auth/register', { invite, username: 'bob', password: 'ngan' })).body.error, 'WEAK_PASSWORD');
    assert.equal((await T.post('/v1/auth/register', { invite, username: 'cam', password: 'mat-khau-bob' })).body.error, 'USERNAME_TAKEN');
    const reg = await T.post('/v1/auth/register', { invite, username: 'bob', password: 'mat-khau-bob', deviceName: 'iPhone' });
    assert.equal(reg.status, 200);
    assert.equal(reg.body.user.username, 'bob');
    assert.equal(reg.body.user.admin, false);
    assert.equal((await T.post('/v1/auth/register', { invite, username: 'eve', password: 'mat-khau-eve' })).body.error, 'BAD_INVITE', 'mã mời chỉ dùng một lần');

    const noUser = await T.post('/v1/auth/login', { username: 'khongco', password: 'mat-khau-bob' });
    const badPw = await T.post('/v1/auth/login', { username: 'bob', password: 'sai-mat-khau' });
    assert.equal(noUser.status, 401);
    assert.deepEqual(noUser.body, badPw.body, 'không lộ tên đăng nhập có tồn tại');
    for (let i = 0; i < 4; i++) await T.post('/v1/auth/login', { username: 'bob', password: 'sai-mat-khau' });
    const locked = await T.post('/v1/auth/login', { username: 'bob', password: 'mat-khau-bob' });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error, 'LOCKED');

    const login = await T.post('/v1/auth/login', { username: 'CAM', password: 'mat-khau-cam', deviceName: 'iPad' });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.admin, true);
    const pair = await T.post('/v1/machines/pair', { username: 'cam', password: 'mat-khau-cam', machineName: 'admin-pc' });
    assert.match(pair.body.machineId, /^[0-9a-f]{16}$/);
    assert.ok(pair.body.machineToken.length >= 40);
    const out = await T.post('/v1/auth/logout', {}, { Authorization: `Bearer ${login.body.token}` });
    assert.equal(out.body.ok, true);
    const app = await T.ws({ type: 'hello', proto: 1, role: 'app', token: login.body.token });
    assert.equal(await app.closed, 4001, 'token đã đăng xuất không dùng được');
  } finally { await T.stop(); }
});

test('hub WS: sai token đóng 4001; lệch proto báo cần cập nhật; im không hello thì đóng', async () => {
  const T = await startHub({ helloTimeoutMs: 200 });
  try {
    const bad = await T.ws({ type: 'hello', proto: 1, role: 'app', token: 'sai' });
    assert.equal(await bad.closed, 4001);
    await T.h.cli(['init', 'cam', 'mat-khau-cam']);
    const login = await T.post('/v1/auth/login', { username: 'cam', password: 'mat-khau-cam' });
    const old = await T.ws({ type: 'hello', proto: 99, role: 'app', token: login.body.token });
    assert.equal((await old.next((m) => m.type === 'error')).code, 'UPGRADE_APP');
    assert.equal(await old.closed, 4002);
    const quiet = await T.ws(null);
    assert.equal(await quiet.closed, 4000);
  } finally { await T.stop(); }
});

test('hub định tuyến: req/res, hết giờ, sub chỉ tới app đã sub, scope user tới mọi app, máy vào / ra mạng', async () => {
  const T = await startHub();
  try {
    const U = await twoUsers(T);
    assert.deepEqual(U.wa.machines.map((m) => [m.id, m.online]), [[U.mA, true]]);
    U.appA.send({ type: 'req', id: 'q1', machine: U.mA, method: 'state', params: {} });
    const r = await U.agentA.next((m) => m.type === 'req');
    assert.equal(r.method, 'state');
    assert.ok(r.conn);
    U.agentA.send({ type: 'res', id: 'q1', conn: r.conn, ok: true, result: { live: [] } });
    assert.deepEqual((await U.appA.next((m) => m.type === 'res')).result, { live: [] });
    U.appA.send({ type: 'req', id: 'q2', machine: U.mA, method: 'state' });
    const to = await U.appA.next((m) => m.type === 'res' && m.id === 'q2');
    assert.equal(to.ok, false);
    assert.equal(to.error.code, 'TIMEOUT');
    const appA2 = await T.ws({ type: 'hello', proto: 1, role: 'app', token: U.tokA });
    await appA2.next((m) => m.type === 'welcome');
    U.appA.send({ type: 'sub', machine: U.mA, session: 's1', after: 0, epoch: '' });
    const sub = await U.agentA.next((m) => m.type === 'sub');
    assert.equal(sub.session, 's1');
    U.agentA.send({ type: 'event', session: 's1', data: { kind: 'assistant', text: 'chào' } });
    assert.equal((await U.appA.next((m) => m.type === 'event')).data.text, 'chào');
    U.agentA.send({ type: 'event', scope: 'user', data: { kind: 'sessions' } });
    const ev = await appA2.next((m) => m.type === 'event');
    assert.equal(ev.data.kind, 'sessions', 'app không sub phiên vẫn nhận sự kiện chung');
    assert.equal(ev.machine, U.mA);
    assert.ok(!appA2.msgs.some((m) => m.type === 'event' && m.data.text === 'chào'));
    U.appA.close();
    assert.equal((await U.agentA.next((m) => m.type === 'unsub')).session, 's1');
    U.agentA.close();
    const off = await appA2.next((m) => m.type === 'machine');
    assert.deepEqual([off.id, off.online], [U.mA, false]);
    appA2.send({ type: 'req', id: 'q3', machine: U.mA, method: 'state' });
    assert.equal((await appA2.next((m) => m.type === 'res')).error.code, 'NOT_FOUND');
  } finally { await T.stop(); }
});

test('hub cách ly: người này không chạm được máy / kết nối / mảnh của người kia', async () => {
  const T = await startHub();
  try {
    const U = await twoUsers(T);
    U.appB.send({ type: 'req', id: 'x1', machine: U.mA, method: 'state' });
    const e1 = await U.appB.next((m) => m.type === 'res');
    U.appB.send({ type: 'req', id: 'x2', machine: 'ffffffffffffffff', method: 'state' });
    const e2 = await U.appB.next((m) => m.type === 'res');
    assert.deepEqual(e1.error, e2.error);
    assert.equal(e1.error.code, 'NOT_FOUND');
    U.appB.send({ type: 'sub', machine: U.mA, session: 's1' });
    assert.equal((await U.appB.next((m) => m.type === 'error')).code, 'NOT_FOUND');
    U.appA.send({ type: 'req', id: 'a1', machine: U.mA, method: 'state' });
    const ra = await U.agentA.next((m) => m.type === 'req');
    U.agentB.send({ type: 'res', id: 'a1', conn: ra.conn, ok: true, result: { hack: 1 } });
    U.agentB.send({ type: 'event', to: ra.conn, session: 's1', data: { kind: 'assistant', text: 'hack' } });
    U.agentB.send({ type: 'event', scope: 'user', data: { kind: 'sessions' } });
    const parts = proto.splitMessage({ type: 'req', id: 'x3', method: 'state', params: { t: 'y'.repeat(600e3) } }, { machine: U.mA });
    for (const p of parts) U.appB.send(p);
    assert.equal((await U.appB.next((m) => m.type === 'error' && m.pid)).code, 'NOT_FOUND');
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(!U.appA.msgs.some((m) => (m.type === 'res' && m.result && m.result.hack) || m.type === 'event'), 'A không nhận gì từ B');
    assert.ok(!U.agentA.msgs.some((m) => m.binary), 'agent A không nhận mảnh của B');
    assert.deepEqual(U.wb.machines.map((m) => m.id), [U.mB]);
  } finally { await T.stop(); }
});

test('hub chuyển mảnh tin lớn tới đúng máy, gắn conn để máy trả lời được', async () => {
  const T = await startHub();
  try {
    const U = await twoUsers(T);
    const msg = { type: 'req', id: 'big', method: 'sessions.send', params: { text: 'z'.repeat(3e6) } };
    for (const p of proto.splitMessage(msg, { machine: U.mA })) U.appA.send(p);
    const asm = new proto.Assembler();
    let got = null, conn = null;
    while (!got) {
      const { binary } = await U.agentA.next((m) => m.binary);
      const { header, payload } = proto.decodePart(binary);
      conn = header.conn;
      got = asm.push(header, payload);
    }
    assert.equal(got.params.text.length, 3e6);
    assert.ok(conn);
    U.agentA.send({ type: 'res', id: 'big', conn, ok: true, result: { ok: 1 } });
    assert.equal((await U.appA.next((m) => m.type === 'res')).result.ok, 1);
  } finally { await T.stop(); }
});

test('hub hàm riêng + thu hồi: thiết bị, máy, đổi mật khẩu, đăng xuất mọi nơi, khoá tài khoản', async () => {
  const T = await startHub();
  try {
    const U = await twoUsers(T);
    const call = async (c, method, params) => {
      const id = Math.random().toString(36).slice(2);
      c.send({ type: 'req', id, machine: 'hub', method, params });
      return c.next((m) => m.type === 'res' && m.id === id);
    };
    const devs = (await call(U.appA, 'devices')).result;
    assert.deepEqual(devs.map((d) => d.name), ['iPhone Cam']);
    assert.equal((await call(U.appB, 'devices.revoke', { id: devs[0].id })).error.code, 'NOT_FOUND', 'B không thu hồi được thiết bị của A');
    assert.equal((await call(U.appA, 'machines.rename', { id: U.mA, name: 'PC nhà' })).ok, true);
    assert.equal((await U.appA.next((m) => m.type === 'machine')).name, 'PC nhà');
    assert.equal((await call(U.appB, 'machines.rename', { id: U.mA, name: 'x' })).error.code, 'NOT_FOUND');
    const nt = (await call(U.appA, 'ntfy')).result;
    assert.match(nt.topic, /^[0-9a-f]{32}$/);
    assert.equal(nt.subscribe, `ntfy://ntfy.sh/${nt.topic}`);
    assert.equal((await call(U.appA, 'password', { old: 'sai', new: 'mat-khau-moi' })).error.code, 'BAD_LOGIN');
    assert.equal((await call(U.appA, 'password', { old: 'mat-khau-cam', new: 'mat-khau-moi' })).ok, true);
    assert.equal((await call(U.appA, 'state')).error.code, 'NOT_FOUND', 'hàm lạ của hub');
    assert.equal(U.appA.closeCode, null, 'đổi mật khẩu không đá ai ra');
    assert.equal((await call(U.appA, 'machines.revoke', { id: U.mA })).ok, true);
    assert.equal(await U.agentA.closed, 4001);
    await T.h.cli(['lock', 'bob']);
    T.h.router.recheck();
    assert.equal(await U.appB.closed, 4001);
    assert.equal(await U.agentB.closed, 4001);
    assert.equal((await call(U.appA, 'logoutAll')).ok, true);
    assert.equal(await U.appA.closed, 4001);
  } finally { await T.stop(); }
});

// ---------- Task 8: thông báo ----------

const { createNotifier } = require('../hub/notify.js');

function fakeFetch() {
  const calls = [];
  const f = async (url, opts) => { calls.push({ url, ...opts }); return { ok: true }; };
  f.calls = calls;
  return f;
}

test('notify: app đang mở thì không đẩy; trùng key trong 24 giờ chỉ một lần; tối đa 30 / giờ; topic riêng mỗi người', async () => {
  const db = openDb(path.join(tmp(), 'hub.db'));
  const a = db.createUser({ username: 'cam', passHash: 'x' });
  const b = db.createUser({ username: 'bob', passHash: 'x' });
  let t = Date.now();
  const f = fakeFetch();
  const N = createNotifier({ db, fetch: f, now: () => t });
  const n = (key) => ({ key, level: 'warning', title: 'Cần duyệt Bash · dự án', body: 'npm test', machine: 'm1', session: 's1' });
  assert.equal(await N.send(a.id, n('k1'), [{ foreground: true }]), false, 'app đang mở');
  assert.equal(await N.send(a.id, n('k1'), [{ foreground: false }]), true);
  assert.equal(await N.send(a.id, n('k1'), []), false, 'trùng key');
  t += 25 * HOUR;
  assert.equal(await N.send(a.id, n('k1'), []), true, 'sau 24 giờ báo lại');
  const c = f.calls[0];
  assert.equal(c.url, `https://ntfy.sh/${db.ntfyTopic(a.id)}`);
  assert.equal(c.method, 'POST');
  assert.equal(c.body, 'npm test');
  assert.match(c.headers.Title, /^=\?UTF-8\?B\?/, 'tiêu đề có dấu được mã hoá');
  assert.equal(Buffer.from(c.headers.Title.slice(10, -2), 'base64').toString(), 'Cần duyệt Bash · dự án');
  assert.equal(c.headers.Click, 'ccremote://session/m1/s1');
  // trần 30 / giờ / người
  t += 2 * HOUR;
  let sent = 0;
  for (let i = 0; i < 31; i++) if (await N.send(a.id, n(`r${i}`), [])) sent++;
  assert.equal(sent, 30);
  assert.equal(await N.send(b.id, n('r0'), []), true, 'người khác không bị tính chung');
  assert.notEqual(f.calls.at(-1).url, c.url);
  db.close();
});

test('notify: app chạy nền tự báo (notifies) -> hub bỏ sự kiện của phiên để không báo trùng, cảnh báo của PC vẫn đẩy', async () => {
  const db = openDb(path.join(tmp(), 'hub.db'));
  const a = db.createUser({ username: 'cam', passHash: 'x' });
  const f = fakeFetch();
  const N = createNotifier({ db, fetch: f });
  const bg = [{ foreground: false, notifies: true }];
  assert.equal(await N.send(a.id, { key: 's:1', title: 'Cần duyệt Bash', body: 'ls', machine: 'm1', session: 's1' }, bg), false);
  assert.equal(await N.send(a.id, { key: 'day:80', level: 'warning', title: 'Sắp chạm ngân sách ngày', body: '$8 / $10', machine: 'm1', session: '' }, bg), true);
  assert.equal(await N.send(a.id, { key: 's:2', title: 'Xong · demo', body: 'x', machine: 'm1', session: 's1' }, [{ foreground: false, notifies: false }]), true,
    'app không tự báo được (tắt thông báo / không giữ chạy nền) -> vẫn đẩy');
  assert.equal(f.calls.length, 2);
  db.close();
});

test('notify qua hub: agent gửi notify -> hub đẩy ntfy kèm đúng máy', async () => {
  const f = fakeFetch();
  const T = await startHub({ notifier: (db) => createNotifier({ db, fetch: f }) });
  try {
    const U = await twoUsers(T);
    U.agentA.send({ type: 'notify', key: 'xong-1', level: 'info', title: 'Xong · demo', body: 'đã sửa xong', session: 's9' });
    const t0 = Date.now();
    while (!f.calls.length && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 20));
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].headers.Click, `ccremote://session/${U.mA}/s9`);
    // app chạy nền nhưng tự báo -> sự kiện phiên không đẩy nữa
    U.appA.send({ type: 'presence', foreground: false, notifies: true });
    await new Promise((r) => setTimeout(r, 50));
    U.agentA.send({ type: 'notify', key: 'xong-3', title: 'Xong', body: 'x', session: 's9' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(f.calls.length, 1);
    // app báo đang mở -> không đẩy
    U.appA.send({ type: 'presence', foreground: true });
    await new Promise((r) => setTimeout(r, 50));
    U.agentA.send({ type: 'notify', key: 'xong-2', title: 'Xong', body: 'x' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(f.calls.length, 1);
  } finally { await T.stop(); }
});
