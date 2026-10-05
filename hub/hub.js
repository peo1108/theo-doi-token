#!/usr/bin/env node
// CC Remote Hub (chạy trên VPS, sau Caddy): trung chuyển giữa app iOS và PC của từng người dùng.
//
//   node hub/hub.js init <tên> [mật khẩu]   -> tạo tài khoản admin đầu tiên
//   node hub/hub.js invite                  -> in mã mời (dùng một lần, 24 giờ)
//   node hub/hub.js users                   -> liệt kê người dùng
//   node hub/hub.js lock|unlock|delete <tên>
//   node hub/hub.js serve                   -> chạy server (HUB_PORT=7790, HUB_HOST=127.0.0.1, HUB_DATA=hub/data)

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { openDb } = require('./db.js');
const auth = require('./auth.js');
const proto = require('./proto.js');
const { createRouter } = require('./router.js');

const INVITE_TTL = 24 * 3600e3;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

class HubError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const BAD_LOGIN = () => new HubError('BAD_LOGIN', 'Sai tên đăng nhập hoặc mật khẩu', 401);

// IP thật: chỉ tin X-Forwarded-For khi kết nối đến từ Caddy trên cùng máy.
function clientIp(req) {
  const ip = req.socket.remoteAddress || '';
  const xff = req.headers['x-forwarded-for'];
  return LOOPBACK.has(ip) && xff ? String(xff).split(',')[0].trim() : ip;
}

function readJson(req, limit = 64e3) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { d += c; if (d.length > limit) { reject(new HubError('TOO_LARGE', 'Nội dung quá lớn', 413)); req.destroy(); } });
    req.on('end', () => {
      if (!d) return resolve({});
      try { const j = JSON.parse(d); resolve(j && typeof j === 'object' ? j : {}); } catch { reject(new HubError('FORMAT', 'Nội dung không phải JSON hợp lệ')); }
    });
    req.on('error', reject);
  });
}

// Mã mời dễ đọc: 8 ký tự, bỏ chữ dễ nhầm (0/O, 1/I/L).
function inviteCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += A[b[i] % A.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
const normInvite = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function createHubServer({ dataDir = process.env.HUB_DATA || path.join(__dirname, 'data'), rpcTimeoutMs, helloTimeoutMs, notifier, log = console } = {}) {
  const db = openDb(path.join(dataDir, 'hub.db'));
  const limiter = new auth.Limiter();
  const router = createRouter({ db, rpcTimeoutMs, helloTimeoutMs, notifier: notifier && notifier(db), log });

  // tên + mật khẩu -> người dùng (khoá sau 5 lần sai / 15 phút theo tên + IP)
  async function checkLogin(username, password, ip) {
    const name = auth.normUser(username) || String(username || '').slice(0, 40).toLowerCase();
    const key = `${name}|${ip}`;
    if (limiter.blocked(key)) throw new HubError('LOCKED', 'Sai quá nhiều lần — thử lại sau 15 phút', 429);
    const u = db.userByName(name);
    const ok = u ? await auth.verifyPassword(String(password || ''), u.pass_hash) : (await auth.hashPassword('x'), false);   // tốn thời gian như nhau
    if (!ok) { limiter.fail(key); db.audit(u ? u.id : null, ip, 'login_fail', name); throw BAD_LOGIN(); }
    if (u.locked) throw new HubError('ACCOUNT_LOCKED', 'Tài khoản đã bị khoá', 403);
    limiter.ok(key);
    return u;
  }
  const userView = (u) => ({ id: u.id, username: u.username, admin: !!u.admin });

  const routes = {
    async 'POST /v1/auth/register'(b, ip) {
      const codeHash = auth.sha(normInvite(b.invite));
      if (!db.inviteValid(codeHash)) throw new HubError('BAD_INVITE', 'Mã mời sai, đã dùng hoặc đã hết hạn');
      const name = auth.normUser(b.username);
      if (!name) throw new HubError('BAD_USERNAME', 'Tên đăng nhập 3–32 ký tự: chữ không dấu, số, _ . -');
      if (String(b.password || '').length < 8) throw new HubError('WEAK_PASSWORD', 'Mật khẩu tối thiểu 8 ký tự');
      if (db.userByName(name)) throw new HubError('USERNAME_TAKEN', 'Tên đăng nhập đã có người dùng');
      const u = db.createUser({ username: name, passHash: await auth.hashPassword(b.password), admin: false });
      if (!db.useInvite(codeHash, u.id)) { db.deleteUser(u.id); throw new HubError('BAD_INVITE', 'Mã mời sai, đã dùng hoặc đã hết hạn'); }
      const t = auth.newToken();
      db.addDevice(u.id, b.deviceName, t.hash);
      db.audit(u.id, ip, 'register');
      return { token: t.token, user: userView(u) };
    },
    async 'POST /v1/auth/login'(b, ip) {
      const u = await checkLogin(b.username, b.password, ip);
      const t = auth.newToken();
      db.addDevice(u.id, b.deviceName, t.hash);
      db.audit(u.id, ip, 'login', b.deviceName);
      return { token: t.token, user: userView(u) };
    },
    async 'POST /v1/auth/logout'(b, ip, req) {
      const h = String(req.headers.authorization || '');
      const d = h.startsWith('Bearer ') && db.deviceByToken(auth.sha(h.slice(7).trim()));
      if (d) { db.revokeDevice(d.user_id, d.id); router.closeWhere((c) => c.role === 'app' && c.deviceId === d.id); }
      return { ok: true };
    },
    // PC tự ngắt khỏi hub (nút "Ngắt" trên dashboard): thu hồi chính token máy đang gửi
    async 'POST /v1/machines/unpair'(b, ip, req) {
      const h = String(req.headers.authorization || '');
      const m = h.startsWith('Bearer ') && db.machineByToken(auth.sha(h.slice(7).trim()));
      if (m) { db.revokeMachine(m.user_id, m.id); router.closeWhere((c) => c.role === 'agent' && c.machineId === m.id); db.audit(m.user_id, ip, 'unpair', m.name); }
      return { ok: true };
    },
    async 'POST /v1/machines/pair'(b, ip) {
      const u = await checkLogin(b.username, b.password, ip);
      const t = auth.newToken();
      const m = db.addMachine(u.id, b.machineName, t.hash);
      db.audit(u.id, ip, 'pair', b.machineName);
      return { machineToken: t.token, machineId: m.id, name: db.machine(u.id, m.id).name };
    },
  };

  const send = (res, code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && url.pathname === '/v1/health') return send(res, 200, { ok: true, proto: proto.PROTO });
      const fn = routes[`${req.method} ${url.pathname}`];
      if (!fn) return send(res, 404, { error: 'NOT_FOUND', message: 'Không có' });
      return send(res, 200, await fn(await readJson(req), clientIp(req), req));
    } catch (e) {
      if (e instanceof HubError) return send(res, e.status, { error: e.code, message: e.message });
      log.error('hub http:', e);
      send(res, 500, { error: 'INTERNAL', message: 'Lỗi hub' });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: proto.MAX_FRAME + 8192 });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/v1/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => router.attach(ws, clientIp(req)));
  });

  const timers = [
    setInterval(() => router.heartbeat(), router.PING_MS),
    setInterval(() => router.recheck(), 30e3),
  ];
  for (const t of timers) t.unref();

  // Lệnh quản trị (cũng dùng trong test). Trả về chuỗi in ra màn hình; mã mời trả về đúng mã.
  async function cli([cmd, a, b]) {
    const byName = (n) => { const u = db.userByName(auth.normUser(n) || ''); if (!u) throw new HubError('NOT_FOUND', `Không có người dùng ${n}`); return u; };
    if (cmd === 'init') {
      if (db.countUsers() > 0) throw new HubError('EXISTS', 'Đã có tài khoản — dùng "invite" để mời thêm người');
      const name = auth.normUser(a);
      if (!name) throw new HubError('BAD_USERNAME', 'Tên đăng nhập 3–32 ký tự: chữ không dấu, số, _ . -');
      if (String(b || '').length < 8) throw new HubError('WEAK_PASSWORD', 'Mật khẩu tối thiểu 8 ký tự');
      db.createUser({ username: name, passHash: await auth.hashPassword(b), admin: true });
      return `Đã tạo admin ${name}`;
    }
    if (cmd === 'invite') {
      const code = inviteCode();
      const admin = db.users().find((u) => u.admin);
      db.addInvite(auth.sha(normInvite(code)), admin ? admin.id : null, Date.now() + INVITE_TTL);
      return code;
    }
    if (cmd === 'users') return db.users().map((u) => `${u.username}${u.admin ? ' (admin)' : ''}${u.locked ? ' [khoá]' : ''} · ${db.machines(u.id).length} máy · ${db.devices(u.id).length} thiết bị`).join('\n') || '(chưa có ai)';
    if (cmd === 'lock' || cmd === 'unlock') { db.setLocked(byName(a).id, cmd === 'lock'); router.recheck(); return `Đã ${cmd === 'lock' ? 'khoá' : 'mở khoá'} ${a}`; }
    if (cmd === 'delete') { db.deleteUser(byName(a).id); router.recheck(); return `Đã xoá ${a}`; }
    throw new HubError('USAGE', 'Dùng: init <tên> <mật khẩu> | invite | users | lock|unlock|delete <tên> | serve');
  }

  async function close() {
    for (const t of timers) clearInterval(t);
    router.shutdown();
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => server.close(() => r()));
    db.close();
  }

  return { server, db, router, cli, close };
}

module.exports = { createHubServer, HubError, inviteCode };

// ---------- dòng lệnh ----------

function ask(question) {
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (ans) => { rl.close(); res(ans); }));
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'serve';
  if (cmd === 'serve') {
    const port = Number(process.env.HUB_PORT) || 7790;
    const host = process.env.HUB_HOST || '127.0.0.1';
    let notifier;
    try { notifier = require('./notify.js').createNotifier; } catch {}
    const h = createHubServer({ notifier: notifier && ((db) => notifier({ db })) });
    h.server.listen(port, host, () => console.log(`CC Remote Hub: http://${host}:${port}  (proto ${proto.PROTO})`));
    const bye = () => h.close().finally(() => process.exit(0));
    process.once('SIGINT', bye);
    process.once('SIGTERM', bye);
  } else {
    (async () => {
      if (cmd === 'init' && !args[2]) args[2] = await ask('Mật khẩu admin (tối thiểu 8 ký tự): ');
      const h = createHubServer({ log: { error() {} } });
      try { console.log(await h.cli(args)); } catch (e) { console.error(e.message); process.exitCode = 2; }
      await h.close();
    })();
  }
}
