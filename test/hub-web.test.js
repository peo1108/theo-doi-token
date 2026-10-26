// Trang web của hub: đăng nhập bằng cookie, "Của tôi" (máy, thiết bị, mật khẩu), "Quản trị" (admin tạo / khoá / xoá tài khoản).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startHub } = require('./hub-helpers.js');

const WEB = { 'X-CC-Web': '1' };

// Trình duyệt giả: giữ cookie cc_web, gửi header chống CSRF.
function browser(T) {
  let cookie = '';
  const req = async (method, p, body, { headers = WEB, raw = false } = {}) => {
    const r = await fetch(T.base + p, {
      method, redirect: 'manual',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = r.headers.get('set-cookie');
    if (set) { const m = /cc_web=([^;]*)/.exec(set); cookie = m && m[1] ? `cc_web=${m[1]}` : ''; }
    return { status: r.status, set, body: raw ? await r.text() : await r.json().catch(() => null) };
  };
  return { req, get cookie() { return cookie; } };
}

async function setup() {
  const T = await startHub();
  await T.h.cli(['init', 'cam', 'mat-khau-cam']);
  const admin = browser(T);
  const r = await admin.req('POST', '/v1/web/login', { username: 'cam', password: 'mat-khau-cam' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { T, admin };
}

test('web: trang chủ là trang quản trị, có CSP và chặn nhúng iframe', async () => {
  const T = await startHub();
  try {
    const r = await fetch(T.base + '/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(await r.text(), /CC Remote Hub/);
  } finally { await T.stop(); }
});

test('web: đăng nhập đặt cookie HttpOnly, SameSite=Strict, dùng mãi; Secure khi đi qua HTTPS; sai mật khẩu 401', async () => {
  const T = await startHub();
  try {
    await T.h.cli(['init', 'cam', 'mat-khau-cam']);
    const b = browser(T);
    assert.equal((await b.req('POST', '/v1/web/login', { username: 'cam', password: 'sai-mat-khau' })).status, 401);
    const r = await b.req('POST', '/v1/web/login', { username: 'cam', password: 'mat-khau-cam' }, { headers: { ...WEB, 'X-Forwarded-Proto': 'https' } });
    assert.equal(r.status, 200);
    assert.match(r.set, /HttpOnly/);
    assert.match(r.set, /SameSite=Strict/);
    assert.match(r.set, /Secure/);
    assert.match(r.set, /Max-Age=(\d{8,})/, 'cookie sống nhiều năm');
    const me = await b.req('GET', '/v1/web/me');
    assert.equal(me.body.user.username, 'cam');
    assert.equal(me.body.user.admin, true);
    assert.ok(me.body.devices.some((d) => d.current && /Trình duyệt/.test(d.name)));
    // chưa đăng nhập / cookie bậy
    assert.equal((await browser(T).req('GET', '/v1/web/me')).status, 401);
  } finally { await T.stop(); }
});

test('web: thiếu header X-CC-Web thì POST bị chặn (chống CSRF)', async () => {
  const { T, admin } = await setup();
  try {
    const r = await admin.req('POST', '/v1/admin/users', { username: 'bob', password: 'mat-khau-bob' }, { headers: {} });
    assert.equal(r.status, 403);
    assert.equal(T.h.db.userByName('bob'), undefined);
    assert.equal((await browser(T).req('POST', '/v1/web/login', { username: 'cam', password: 'mat-khau-cam' }, { headers: {} })).status, 403);
  } finally { await T.stop(); }
});

test('quản trị: admin tạo tài khoản; tài khoản đó đăng nhập app và ghép PC được; user thường bị chặn khỏi quản trị', async () => {
  const { T, admin } = await setup();
  try {
    assert.equal((await admin.req('POST', '/v1/admin/users', { username: 'Bob', password: 'ngan' })).body.error, 'WEAK_PASSWORD');
    assert.equal((await admin.req('POST', '/v1/admin/users', { username: 'a', password: 'mat-khau-bob' })).body.error, 'BAD_USERNAME');
    const c = await admin.req('POST', '/v1/admin/users', { username: 'Bob', password: 'mat-khau-bob' });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.username, 'bob');
    assert.equal((await admin.req('POST', '/v1/admin/users', { username: 'bob', password: 'mat-khau-bob' })).body.error, 'USERNAME_TAKEN');
    // bob dùng ở cả điện thoại (app) và PC (ghép máy)
    assert.equal((await T.post('/v1/auth/login', { username: 'bob', password: 'mat-khau-bob', deviceName: 'iPhone Bob' })).status, 200);
    assert.equal((await T.post('/v1/machines/pair', { username: 'bob', password: 'mat-khau-bob', machineName: 'pc-bob' })).status, 200);
    const list = (await admin.req('GET', '/v1/admin/users')).body;
    const bob = list.find((u) => u.username === 'bob');
    assert.equal(bob.machines, 1);
    assert.equal(bob.devices, 1);
    assert.equal(bob.admin, false);
    // bob không vào được quản trị
    const b = browser(T);
    await b.req('POST', '/v1/web/login', { username: 'bob', password: 'mat-khau-bob' });
    assert.equal((await b.req('GET', '/v1/admin/users')).status, 403);
    assert.equal((await b.req('POST', '/v1/admin/users', { username: 'eve', password: 'mat-khau-eve' })).status, 403);
    assert.equal((await b.req('GET', '/v1/web/me')).body.user.admin, false);
  } finally { await T.stop(); }
});

test('quản trị: khoá cắt kết nối ngay, mở khoá đăng nhập lại được; đặt lại mật khẩu không đá máy; xoá; không tự khoá / xoá mình', async () => {
  const { T, admin } = await setup();
  try {
    const { id } = (await admin.req('POST', '/v1/admin/users', { username: 'bob', password: 'mat-khau-bob' })).body;
    const login = (await T.post('/v1/auth/login', { username: 'bob', password: 'mat-khau-bob' })).body;
    const app = await T.ws({ type: 'hello', proto: 1, role: 'app', token: login.token });
    await app.next((m) => m.type === 'welcome');
    // đặt lại mật khẩu: mật khẩu mới dùng được, app đang mở không bị đá
    assert.equal((await admin.req('POST', `/v1/admin/users/${id}/password`, { password: 'mat-khau-moi' })).status, 200);
    assert.equal((await T.post('/v1/auth/login', { username: 'bob', password: 'mat-khau-moi' })).status, 200);
    assert.equal((await T.post('/v1/auth/login', { username: 'bob', password: 'mat-khau-bob' })).status, 401);
    assert.equal(app.closeCode, null);
    // khoá: cắt ngay
    assert.equal((await admin.req('POST', `/v1/admin/users/${id}/lock`)).status, 200);
    assert.equal(await app.closed, 4001);
    assert.equal((await T.post('/v1/auth/login', { username: 'bob', password: 'mat-khau-moi' })).body.error, 'ACCOUNT_LOCKED');
    assert.equal((await admin.req('GET', '/v1/admin/users')).body.find((u) => u.id === id).locked, true);
    assert.equal((await admin.req('POST', `/v1/admin/users/${id}/unlock`)).status, 200);
    assert.equal((await T.post('/v1/auth/login', { username: 'bob', password: 'mat-khau-moi' })).status, 200);
    // không tự khoá / xoá mình
    const me = (await admin.req('GET', '/v1/web/me')).body.user.id;
    assert.equal((await admin.req('POST', `/v1/admin/users/${me}/lock`)).body.error, 'SELF');
    assert.equal((await admin.req('POST', `/v1/admin/users/${me}/delete`)).body.error, 'SELF');
    // xoá
    assert.equal((await admin.req('POST', `/v1/admin/users/${id}/delete`)).status, 200);
    assert.equal(T.h.db.userByName('bob'), undefined);
    assert.equal((await admin.req('POST', '/v1/admin/users/999/lock')).status, 404);
  } finally { await T.stop(); }
});

test('của tôi: đổi tên / ngắt máy trên trang web -> app đang mở thấy ngay (không đợi nối lại)', async () => {
  const { T, admin } = await setup();
  try {
    const pair = (await T.post('/v1/machines/pair', { username: 'cam', password: 'mat-khau-cam', machineName: 'pc' })).body;
    const phone = (await T.post('/v1/auth/login', { username: 'cam', password: 'mat-khau-cam', deviceName: 'iPhone' })).body;
    const app = await T.ws({ type: 'hello', proto: 1, role: 'app', token: phone.token });
    await app.next((m) => m.type === 'welcome');
    await admin.req('POST', '/v1/web/machines/rename', { id: pair.machineId, name: 'PC nhà' });
    assert.equal((await app.next((m) => m.type === 'machine')).name, 'PC nhà');
    await admin.req('POST', '/v1/web/machines/revoke', { id: pair.machineId });
    const gone = await app.next((m) => m.type === 'machine');
    assert.equal(gone.id, pair.machineId);
    assert.equal(gone.removed, true);
  } finally { await T.stop(); }
});

test('của tôi: đổi mật khẩu, đổi tên / ngắt máy, thu hồi thiết bị, đăng xuất, đăng xuất mọi nơi', async () => {
  const { T, admin } = await setup();
  try {
    const pair = (await T.post('/v1/machines/pair', { username: 'cam', password: 'mat-khau-cam', machineName: 'pc' })).body;
    const phone = (await T.post('/v1/auth/login', { username: 'cam', password: 'mat-khau-cam', deviceName: 'iPhone' })).body;
    let me = (await admin.req('GET', '/v1/web/me')).body;
    assert.deepEqual(me.machines.map((m) => [m.name, m.online]), [['pc', false]]);
    assert.equal((await admin.req('POST', '/v1/web/machines/rename', { id: pair.machineId, name: 'PC nhà' })).status, 200);
    me = (await admin.req('GET', '/v1/web/me')).body;
    assert.equal(me.machines[0].name, 'PC nhà');
    assert.match(me.ntfy.subscribe, /^ntfy:\/\/ntfy\.sh\/[0-9a-f]{32}$/);
    // thu hồi điện thoại
    const dev = me.devices.find((d) => d.name === 'iPhone');
    assert.equal((await admin.req('POST', '/v1/web/devices/revoke', { id: dev.id })).status, 200);
    const app = await T.ws({ type: 'hello', proto: 1, role: 'app', token: phone.token });
    assert.equal(await app.closed, 4001);
    // đổi mật khẩu (sai mật khẩu cũ -> lỗi)
    assert.equal((await admin.req('POST', '/v1/web/password', { old: 'sai', new: 'mat-khau-moi' })).body.error, 'BAD_LOGIN');
    assert.equal((await admin.req('POST', '/v1/web/password', { old: 'mat-khau-cam', new: 'mat-khau-moi' })).status, 200);
    assert.equal((await admin.req('GET', '/v1/web/me')).status, 200, 'đổi mật khẩu không đá chính mình');
    // ngắt máy
    assert.equal((await admin.req('POST', '/v1/web/machines/revoke', { id: pair.machineId })).status, 200);
    assert.deepEqual((await admin.req('GET', '/v1/web/me')).body.machines, []);
    // đăng xuất: cookie bị xoá, phiên web hết hiệu lực
    const out = await admin.req('POST', '/v1/web/logout');
    assert.match(out.set, /Max-Age=0/);
    assert.equal((await admin.req('GET', '/v1/web/me')).status, 401);
    // đăng xuất mọi nơi
    const b2 = browser(T);
    await b2.req('POST', '/v1/web/login', { username: 'cam', password: 'mat-khau-moi' });
    const phone2 = (await T.post('/v1/auth/login', { username: 'cam', password: 'mat-khau-moi' })).body;
    assert.equal((await b2.req('POST', '/v1/web/logout-all')).status, 200);
    assert.equal((await b2.req('GET', '/v1/web/me')).status, 401);
    const app2 = await T.ws({ type: 'hello', proto: 1, role: 'app', token: phone2.token });
    assert.equal(await app2.closed, 4001);
  } finally { await T.stop(); }
});
