// Định tuyến của hub: mỗi kết nối WebSocket (app hoặc agent trên PC) gắn với đúng một người dùng lúc "hello";
// tin chỉ đi giữa các kết nối CÙNG người dùng. Hub không lưu nội dung phiên — chỉ chuyển rồi bỏ.
const crypto = require('crypto');
const auth = require('./auth.js');
const proto = require('./proto.js');

const CLOSE = { HELLO: 4000, UNAUTHORIZED: 4001, UPGRADE: 4002, REPLACED: 4003 };
const PING_MS = 20e3, DEAD_MS = 60e3;
const err = (code, message) => ({ code, message });
const NOT_FOUND = err('NOT_FOUND', 'Không tìm thấy');
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

function createRouter({ db, rpcTimeoutMs = 30e3, helloTimeoutMs = 10e3, notifier = null, log = console } = {}) {
  const conns = new Map();    // conn id -> kết nối
  const agents = new Map();   // machine id -> kết nối agent đang online
  const pending = new Map();  // `${connId}|${reqId}` -> { timer, machine }

  const send = (c, obj) => { if (c && c.ws.readyState === 1) c.ws.send(JSON.stringify(obj)); };
  const appsOf = (userId) => [...conns.values()].filter((c) => c.role === 'app' && c.userId === userId);
  const ownAgent = (c, machine) => { const a = agents.get(str(machine, 64)); return a && a.userId === c.userId ? a : null; };
  const ownApp = (c, id) => { const a = conns.get(str(id, 64)); return a && a.role === 'app' && a.userId === c.userId ? a : null; };
  const machineView = (m) => ({ id: m.id, name: m.name, online: agents.has(m.id), lastSeen: m.last_seen });
  const announce = (userId, machineId) => {
    const m = db.machine(userId, machineId);
    if (m) for (const a of appsOf(userId)) send(a, { type: 'machine', ...machineView(m) });
  };
  // máy đổi tên / bị thu hồi (từ app hoặc trang web): báo các app của người đó ngay, không đợi app nối lại
  const machineChanged = (userId, machineId) => {
    if (db.machine(userId, machineId)) return announce(userId, machineId);
    for (const a of appsOf(userId)) send(a, { type: 'machine', id: machineId, removed: true, online: false });
  };
  const closeConn = (c, code, reason = '') => { try { c.ws.close(code, reason); } catch {} };
  const closeWhere = (pred, code = CLOSE.UNAUTHORIZED) => { for (const c of conns.values()) if (c.authed && pred(c)) closeConn(c, code, 'revoked'); };

  // ---------- hàm của chính hub (machine: 'hub') ----------
  const hubMethods = {
    devices: (c) => db.devices(c.userId).map((d) => ({ id: d.id, name: d.name, createdAt: d.created_at, lastSeen: d.last_seen, current: d.id === c.deviceId })),
    'devices.revoke': (c, p) => {
      if (!db.revokeDevice(c.userId, str(p.id, 64))) throw NOT_FOUND;
      closeWhere((x) => x.role === 'app' && x.deviceId === p.id);
      return { ok: true };
    },
    logoutAll: (c) => {
      db.revokeAllDevices(c.userId);
      setImmediate(() => closeWhere((x) => x.role === 'app' && x.userId === c.userId));
      return { ok: true };
    },
    machines: (c) => db.machines(c.userId).map(machineView),
    'machines.rename': (c, p) => {
      if (!db.renameMachine(c.userId, str(p.id, 64), str(p.name, 60))) throw NOT_FOUND;
      machineChanged(c.userId, p.id);
      return { ok: true };
    },
    'machines.revoke': (c, p) => {
      if (!db.revokeMachine(c.userId, str(p.id, 64))) throw NOT_FOUND;
      closeWhere((x) => x.role === 'agent' && x.machineId === p.id);
      machineChanged(c.userId, p.id);
      return { ok: true };
    },
    password: async (c, p) => {
      const u = db.userById(c.userId);
      if (!u || !(await auth.verifyPassword(str(p.old, 200), u.pass_hash))) throw err('BAD_LOGIN', 'Mật khẩu cũ không đúng');
      if (str(p.new, 200).length < 8) throw err('WEAK_PASSWORD', 'Mật khẩu tối thiểu 8 ký tự');
      db.setPassword(c.userId, await auth.hashPassword(p.new));   // không đá thiết bị nào ra (đăng nhập dùng mãi)
      db.audit(c.userId, c.ip, 'password');
      return { ok: true };
    },
    ntfy: (c) => {
      const topic = db.ntfyTopic(c.userId);
      return { topic, url: `https://ntfy.sh/${topic}`, subscribe: `ntfy://ntfy.sh/${topic}` };
    },
  };

  // ---------- bắt tay ----------
  function hello(c, m) {
    const role = m.role === 'agent' ? 'agent' : m.role === 'app' ? 'app' : null;
    const hash = auth.sha(str(m.token, 200));
    const rec = role === 'agent' ? db.machineByToken(hash) : role === 'app' ? db.deviceByToken(hash) : null;
    const user = rec && db.userById(rec.user_id);
    if (!rec || !user || user.locked) {
      send(c, { type: 'error', code: 'UNAUTHORIZED', message: 'Đăng nhập không còn hiệu lực — đăng nhập lại' });
      return closeConn(c, CLOSE.UNAUTHORIZED, 'unauthorized');
    }
    if (m.proto !== proto.PROTO) {
      const code = role === 'agent' ? 'UPGRADE_AGENT' : 'UPGRADE_APP';
      send(c, { type: 'error', code, message: role === 'agent' ? 'Cần cập nhật tracker trên máy' : 'Cần cập nhật app' });
      return closeConn(c, CLOSE.UPGRADE, 'upgrade');
    }
    clearTimeout(c.helloTimer);
    Object.assign(c, { authed: true, role, userId: user.id, tokenHash: hash });
    db.touch(role === 'agent' ? 'machines' : 'devices', rec.id);
    if (role === 'agent') {
      c.machineId = rec.id;
      const old = agents.get(rec.id);
      if (old && old !== c) closeConn(old, CLOSE.REPLACED, 'replaced');
      agents.set(rec.id, c);
      send(c, { type: 'welcome', proto: proto.PROTO, machineId: rec.id, name: rec.name });
      announce(user.id, rec.id);
    } else {
      c.deviceId = rec.id;
      const topic = db.ntfyTopic(user.id);
      send(c, {
        type: 'welcome', proto: proto.PROTO,
        user: { id: user.id, username: user.username, admin: !!user.admin },
        machines: db.machines(user.id).map(machineView),
        ntfy: { topic, url: `https://ntfy.sh/${topic}`, subscribe: `ntfy://ntfy.sh/${topic}` },
      });
    }
  }

  // ---------- tin chữ ----------
  async function fromApp(c, m) {
    // foreground: đang mở app; notifies: app chạy nền và tự bắn thông báo trên máy (hub thôi đẩy ntfy sự kiện phiên)
    if (m.type === 'presence') { c.foreground = !!m.foreground; c.notifies = !!m.notifies; return; }
    if (m.type === 'req') {
      const id = str(m.id, 100);
      const reply = (ok, v) => send(c, { type: 'res', id, machine: m.machine, ok, ...(ok ? { result: v } : { error: v }) });
      if (m.machine === 'hub') {
        const fn = hubMethods[m.method];
        if (!fn) return reply(false, NOT_FOUND);
        try { return reply(true, await fn(c, m.params && typeof m.params === 'object' ? m.params : {})); }
        catch (e) { return reply(false, e && e.code ? { code: e.code, message: e.message } : err('INTERNAL', 'Lỗi hub')); }
      }
      const a = ownAgent(c, m.machine);
      if (!a) return reply(false, NOT_FOUND);
      const key = `${c.id}|${id}`;
      clearTimeout(pending.get(key)?.timer);
      pending.set(key, {
        machine: a.machineId,
        timer: setTimeout(() => { pending.delete(key); reply(false, err('TIMEOUT', 'Máy không phản hồi')); }, rpcTimeoutMs),
      });
      return send(a, { type: 'req', id, conn: c.id, method: str(m.method, 64), params: m.params ?? {} });
    }
    if (m.type === 'sub' || m.type === 'unsub') {
      const a = ownAgent(c, m.machine);
      const session = str(m.session, 64);
      if (!a) return send(c, { type: 'error', code: 'NOT_FOUND', machine: m.machine, session, message: 'Máy không online' });
      const k = `${a.machineId}:${session}`;
      if (m.type === 'sub') c.subs.add(k); else c.subs.delete(k);
      return send(a, { type: m.type, conn: c.id, session, after: Number(m.after) || 0, epoch: str(m.epoch, 32) });
    }
  }

  function fromAgent(c, m) {
    if (m.type === 'res') {
      const app = ownApp(c, m.conn);
      const key = `${m.conn}|${str(m.id, 100)}`;
      const p = pending.get(key);
      // chỉ trả cho app cùng tài khoản; câu hỏi gửi dạng mảnh (hub không đọc được id) thì không có trong pending
      if (!app || (p && p.machine !== c.machineId)) return;
      if (p) { clearTimeout(p.timer); pending.delete(key); }
      return send(app, { type: 'res', id: m.id, machine: c.machineId, ok: !!m.ok, ...(m.ok ? { result: m.result } : { error: m.error }) });
    }
    if (m.type === 'event') {
      const ev = { type: 'event', machine: c.machineId, session: str(m.session, 64), data: m.data };
      if (m.to) return send(ownApp(c, m.to), ev);
      const k = `${c.machineId}:${ev.session}`;
      for (const a of appsOf(c.userId)) if (m.scope === 'user' || a.subs.has(k)) send(a, ev);
      return;
    }
    if (m.type === 'notify' && notifier) {
      notifier.send(c.userId, {
        key: str(m.key, 300), level: str(m.level, 20), title: str(m.title, 200), body: str(m.body, 1000),
        machine: c.machineId, session: str(m.session, 64),
      }, appsOf(c.userId));
    }
  }

  // ---------- mảnh tin lớn: chuyển ngay, không ghép ----------
  function fromBinary(c, buf) {
    let part;
    try { part = proto.decodePart(buf); } catch { return; }
    const { header, payload } = part;
    const now = Date.now();
    let r = c.parts.get(header.pid);
    if (!r) {
      if (header.idx !== 0) return;
      const live = [...c.parts.values()].filter((x) => !x.dead).length;
      let target = null;
      if (c.role === 'app') target = ownAgent(c, header.machine);
      else target = ownApp(c, header.conn);
      if (!target) { c.parts.set(header.pid, { dead: true, at: now }); return send(c, { type: 'error', code: 'NOT_FOUND', pid: header.pid, message: 'Không tìm thấy' }); }
      if (live >= proto.MAX_PENDING) { c.parts.set(header.pid, { dead: true, at: now }); return send(c, { type: 'error', code: 'TOO_MANY', pid: header.pid, message: 'Quá nhiều tin lớn đang gửi' }); }
      r = { target, size: 0, at: now };
      c.parts.set(header.pid, r);
    }
    if (r.dead) { if (header.last) c.parts.delete(header.pid); return; }
    r.size += payload.length;
    r.at = now;
    if (r.size > proto.MAX_MSG) {
      r.dead = true;
      return send(c, { type: 'error', code: 'TOO_LARGE', pid: header.pid, message: 'Tin nhắn quá lớn (tối đa 50 MB)' });
    }
    if (header.last) c.parts.delete(header.pid);
    if (r.target.ws.readyState !== 1) return;
    const out = c.role === 'app'
      ? { type: 'part', pid: header.pid, idx: header.idx, last: !!header.last, conn: c.id }
      : { type: 'part', pid: header.pid, idx: header.idx, last: !!header.last, machine: c.machineId };
    r.target.ws.send(proto.encodePart(out, payload));
  }

  // ---------- vòng đời kết nối ----------
  function attach(ws, ip = '') {
    const c = { id: crypto.randomBytes(8).toString('hex'), ws, ip, authed: false, subs: new Set(), parts: new Map(), foreground: false, notifies: false, lastPong: Date.now() };
    conns.set(c.id, c);
    c.helloTimer = setTimeout(() => { if (!c.authed) closeConn(c, CLOSE.HELLO, 'hello'); }, helloTimeoutMs);
    ws.on('pong', () => { c.lastPong = Date.now(); });
    ws.on('message', (data, isBinary) => {
      if (isBinary) { if (c.authed) fromBinary(c, Buffer.isBuffer(data) ? data : Buffer.from(data)); return; }
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (!c.authed) { if (m.type === 'hello') hello(c, m); return; }
      Promise.resolve(c.role === 'app' ? fromApp(c, m) : fromAgent(c, m)).catch((e) => log.error('hub:', e.message));
    });
    ws.on('close', () => {
      clearTimeout(c.helloTimer);
      conns.delete(c.id);
      if (!c.authed || stopped) return;
      if (c.role === 'agent') {
        if (agents.get(c.machineId) === c) {
          agents.delete(c.machineId);
          for (const [key, p] of pending) {
            if (p.machine !== c.machineId) continue;
            clearTimeout(p.timer);
            pending.delete(key);
            const [connId, reqId] = key.split('|');
            send(conns.get(connId), { type: 'res', id: reqId, machine: c.machineId, ok: false, error: err('OFFLINE', 'Máy vừa mất kết nối') });
          }
          announce(c.userId, c.machineId);
        }
      } else {
        for (const k of c.subs) {
          const [machine, session] = k.split(':');
          const a = agents.get(machine);
          if (a && a.userId === c.userId) send(a, { type: 'unsub', conn: c.id, session });
        }
        for (const [key, p] of pending) if (key.startsWith(`${c.id}|`)) { clearTimeout(p.timer); pending.delete(key); }
      }
    });
    ws.on('error', () => {});
    return c;
  }

  // Token bị thu hồi / tài khoản bị khoá từ tiến trình khác (CLI) -> đóng kết nối.
  function recheck() {
    for (const c of conns.values()) {
      if (!c.authed) continue;
      const rec = c.role === 'agent' ? db.machineByToken(c.tokenHash) : db.deviceByToken(c.tokenHash);
      const user = rec && db.userById(rec.user_id);
      if (!rec || !user || user.locked) closeConn(c, CLOSE.UNAUTHORIZED, 'revoked');
    }
  }

  // Ping 20 giây; im quá 60 giây thì cắt. Dọn mảnh dở quá 60 giây.
  function heartbeat(now = Date.now()) {
    for (const c of conns.values()) {
      if (now - c.lastPong > DEAD_MS) { try { c.ws.terminate(); } catch {} continue; }
      try { c.ws.ping(); } catch {}
      for (const [pid, r] of c.parts) if (now - r.at > proto.PART_IDLE_MS) c.parts.delete(pid);
    }
  }

  // Hub đang tắt: kết nối đóng sau đó không chạm DB nữa.
  let stopped = false;
  function shutdown() {
    stopped = true;
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
  }

  return { attach, recheck, heartbeat, closeWhere, machineChanged, shutdown, conns, agents, appsOf, PING_MS };
}

module.exports = { createRouter, CLOSE };
