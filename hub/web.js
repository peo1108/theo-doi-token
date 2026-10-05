// Trang web của hub (https://<tên miền>/): đăng nhập bằng cookie; "Của tôi" (máy, thiết bị, mật khẩu, ntfy);
// "Quản trị" cho admin (tạo / khoá / mở / xoá tài khoản, đặt lại mật khẩu).
// Chống CSRF: cookie SameSite=Strict + mọi POST phải có header X-CC-Web: 1 (trang khác không tự đặt được header này).
const fs = require('fs');
const path = require('path');
const auth = require('./auth.js');

const COOKIE = 'cc_web';
const TEN_YEARS = 10 * 365 * 24 * 3600;   // đăng nhập dùng mãi — chỉ mất khi tự đăng xuất / bị thu hồi
const PAGE = path.join(__dirname, 'web', 'index.html');
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
  + "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function readCookie(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return '';
}

// Tên thiết bị cho trình duyệt: "Trình duyệt · Chrome trên Windows"
function browserName(ua) {
  ua = String(ua || '');
  const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'web';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `Trình duyệt · ${b}${os ? ` trên ${os}` : ''}`;
}

function createWeb({ db, router, checkLogin, HubError, readJson, clientIp }) {
  const send = (res, code, data, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(data));
  };
  const cookie = (req, value, maxAge) => {
    const https = req.headers['x-forwarded-proto'] === 'https';
    return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${https ? '; Secure' : ''}`;
  };
  const machineView = (m) => ({ id: m.id, name: m.name, online: router.agents.has(m.id), lastSeen: m.last_seen });
  const closeUser = (userId) => router.closeWhere((c) => c.userId === userId);

  // Phiên web hiện tại -> { user, device } hoặc null
  function session(req) {
    const t = readCookie(req);
    const d = t && db.deviceByToken(auth.sha(t));
    const u = d && db.userById(d.user_id);
    return u && !u.locked ? { user: u, device: d } : null;
  }

  async function newPassword(pw) {
    if (String(pw || '').length < 8) throw new HubError('WEAK_PASSWORD', 'Mật khẩu tối thiểu 8 ký tự');
    return auth.hashPassword(String(pw));
  }

  // ---------- "Của tôi" ----------
  const mine = {
    'GET /v1/web/me': ({ user, device }) => {
      const topic = db.ntfyTopic(user.id);
      return {
        user: { id: user.id, username: user.username, admin: !!user.admin },
        machines: db.machines(user.id).map(machineView),
        devices: db.devices(user.id).map((d) => ({ id: d.id, name: d.name, createdAt: d.created_at, lastSeen: d.last_seen, current: d.id === device.id })),
        ntfy: { url: `https://ntfy.sh/${topic}`, subscribe: `ntfy://ntfy.sh/${topic}` },
      };
    },
    'POST /v1/web/password': async ({ user }, b, ip) => {
      if (!(await auth.verifyPassword(String(b.old || ''), user.pass_hash))) throw new HubError('BAD_LOGIN', 'Mật khẩu hiện tại không đúng', 400);
      db.setPassword(user.id, await newPassword(b.new));   // không đá thiết bị nào ra (đăng nhập dùng mãi)
      db.audit(user.id, ip, 'password');
      return { ok: true };
    },
    'POST /v1/web/devices/revoke': ({ user }, b, ip) => {
      const id = String(b.id || '');
      if (!db.revokeDevice(user.id, id)) throw new HubError('NOT_FOUND', 'Không có thiết bị này', 404);
      router.closeWhere((c) => c.role === 'app' && c.deviceId === id);
      db.audit(user.id, ip, 'device_revoke', id);
      return { ok: true };
    },
    'POST /v1/web/machines/rename': ({ user }, b) => {
      if (!db.renameMachine(user.id, String(b.id || ''), String(b.name || '').slice(0, 60))) throw new HubError('NOT_FOUND', 'Không có máy này', 404);
      return { ok: true };
    },
    'POST /v1/web/machines/revoke': ({ user }, b, ip) => {
      const id = String(b.id || '');
      if (!db.revokeMachine(user.id, id)) throw new HubError('NOT_FOUND', 'Không có máy này', 404);
      router.closeWhere((c) => c.role === 'agent' && c.machineId === id);
      db.audit(user.id, ip, 'machine_revoke', id);
      return { ok: true };
    },
  };

  // ---------- "Quản trị" (chỉ admin) ----------
  const target = (me, id, { notSelf = false } = {}) => {
    const u = db.userById(Number(id));
    if (!u) throw new HubError('NOT_FOUND', 'Không có tài khoản này', 404);
    if (notSelf && u.id === me.id) throw new HubError('SELF', 'Không làm việc này với chính tài khoản admin đang dùng');
    return u;
  };
  const admin = {
    'GET /v1/admin/users': () => db.adminUsers().map((u) => ({
      id: u.id, username: u.username, admin: !!u.admin, locked: !!u.locked, createdAt: u.created_at,
      machines: u.machines, devices: u.devices, lastSeen: u.last_seen,
      online: db.machines(u.id).some((m) => router.agents.has(m.id)),
    })),
    'POST /v1/admin/users': async ({ user }, b, ip) => {
      const name = auth.normUser(b.username);
      if (!name) throw new HubError('BAD_USERNAME', 'Tên đăng nhập 3–32 ký tự: chữ không dấu, số, _ . -');
      const hash = await newPassword(b.password);
      if (db.userByName(name)) throw new HubError('USERNAME_TAKEN', 'Tên đăng nhập đã có người dùng');
      const u = db.createUser({ username: name, passHash: hash, admin: false });
      db.audit(user.id, ip, 'user_create', name);
      return { id: u.id, username: u.username };
    },
    lock: ({ user }, id, b, ip) => { const u = target(user, id, { notSelf: true }); db.setLocked(u.id, true); closeUser(u.id); db.audit(user.id, ip, 'user_lock', u.username); },
    unlock: ({ user }, id, b, ip) => { const u = target(user, id); db.setLocked(u.id, false); db.audit(user.id, ip, 'user_unlock', u.username); },
    delete: ({ user }, id, b, ip) => { const u = target(user, id, { notSelf: true }); closeUser(u.id); db.deleteUser(u.id); db.audit(user.id, ip, 'user_delete', u.username); },
    password: async ({ user }, id, b, ip) => { const u = target(user, id); db.setPassword(u.id, await newPassword(b.password)); db.audit(user.id, ip, 'user_password', u.username); },
  };

  // Trả true nếu đã xử lý request.
  async function handle(req, res, url) {
    const p = url.pathname;
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP,
        'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      });
      fs.createReadStream(PAGE).pipe(res);
      return true;
    }
    if (!p.startsWith('/v1/web/') && !p.startsWith('/v1/admin/')) return false;
    if (req.method === 'POST' && req.headers['x-cc-web'] !== '1') {
      send(res, 403, { error: 'FORBIDDEN', message: 'Yêu cầu bị từ chối' });
      return true;
    }
    const ip = clientIp(req);
    const body = req.method === 'POST' ? await readJson(req) : {};

    if (req.method === 'POST' && p === '/v1/web/login') {
      const u = await checkLogin(body.username, body.password, ip);
      const t = auth.newToken();
      db.addDevice(u.id, browserName(req.headers['user-agent']), t.hash);
      db.audit(u.id, ip, 'web_login');
      send(res, 200, { user: { id: u.id, username: u.username, admin: !!u.admin } }, { 'Set-Cookie': cookie(req, t.token, TEN_YEARS) });
      return true;
    }

    const s = session(req);
    if (!s) { send(res, 401, { error: 'UNAUTHORIZED', message: 'Chưa đăng nhập' }); return true; }

    if (req.method === 'POST' && (p === '/v1/web/logout' || p === '/v1/web/logout-all')) {
      if (p === '/v1/web/logout') db.revokeDevice(s.user.id, s.device.id);
      else { db.revokeAllDevices(s.user.id); router.closeWhere((c) => c.role === 'app' && c.userId === s.user.id); }
      send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
      return true;
    }
    const key = `${req.method} ${p}`;
    if (mine[key]) { send(res, 200, await mine[key](s, body, ip)); return true; }

    if (!p.startsWith('/v1/admin/')) { send(res, 404, { error: 'NOT_FOUND', message: 'Không có' }); return true; }
    if (!s.user.admin) { send(res, 403, { error: 'FORBIDDEN', message: 'Chỉ admin' }); return true; }
    if (admin[key]) { send(res, 200, await admin[key](s, body, ip)); return true; }
    const m = /^\/v1\/admin\/users\/(\d+)\/(lock|unlock|delete|password)$/.exec(p);
    if (m && req.method === 'POST') { await admin[m[2]](s, m[1], body, ip); send(res, 200, { ok: true }); return true; }
    send(res, 404, { error: 'NOT_FOUND', message: 'Không có' });
    return true;
  }

  return { handle };
}

module.exports = { createWeb, browserName };
