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
