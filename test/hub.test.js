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
