// Tiện ích test cho hub: chạy hub thật trên cổng ngẫu nhiên, kết nối WebSocket thử, tạo người dùng.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHubServer } = require('../hub/hub.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hub-'));

// Hub thật trên cổng ngẫu nhiên + tiện ích HTTP / WebSocket.
async function startHub(opts = {}) {
  const { port: wantPort = 0, ...rest } = opts;
  const dataDir = rest.dataDir || tmp();
  const h = createHubServer({ rpcTimeoutMs: 300, ...rest, dataDir });
  await new Promise((r) => h.server.listen(wantPort, '127.0.0.1', r));
  const port = h.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const post = async (p, body, headers = {}) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });
    return { status: r.status, body: await r.json() };
  };
  const conns = [];
  const ws = (hello) => new Promise((resolve) => {
    const c = wsClient(`ws://127.0.0.1:${port}/v1/ws`, hello, resolve);
    conns.push(c);
  });
  const stop = async () => { for (const c of conns) try { c.s.close(); } catch {} await h.close(); };
  return { h, port, base, post, ws, stop, dataDir };
}

// Kết nối WebSocket thử: gom tin, chờ tin thoả điều kiện, chờ đóng.
function wsClient(url, hello, onOpen) {
  const s = new WebSocket(url);
  s.binaryType = 'arraybuffer';
  const c = { s, msgs: [], waiters: [], closeCode: null };
  c.closed = new Promise((res) => s.addEventListener('close', (e) => { c.closeCode = e.code; res(e.code); }));
  s.addEventListener('message', (e) => {
    const m = typeof e.data === 'string' ? JSON.parse(e.data) : { binary: Buffer.from(e.data) };
    const w = c.waiters.find((x) => x.pred(m));
    if (w) { c.waiters.splice(c.waiters.indexOf(w), 1); w.res(m); } else c.msgs.push(m);
  });
  c.send = (o) => s.send(Buffer.isBuffer(o) ? o : JSON.stringify(o));
  c.next = (pred, ms = 3000) => {
    const hit = c.msgs.find(pred);
    if (hit) { c.msgs.splice(c.msgs.indexOf(hit), 1); return Promise.resolve(hit); }
    return new Promise((res, rej) => {
      const w = { pred, res: (m) => { clearTimeout(t); res(m); } };
      const t = setTimeout(() => { c.waiters.splice(c.waiters.indexOf(w), 1); rej(new Error('hết giờ chờ tin: ' + pred)); }, ms);
      c.waiters.push(w);
    });
  };
  c.close = () => s.close();
  s.addEventListener('open', () => { if (hello) c.send(hello); onOpen(c); });
  return c;
}

// Admin + một người được mời; mỗi người một máy (agent) và một app, đã bắt tay xong.
async function twoUsers(T) {
  const { h } = T;
  await h.cli(['init', 'cam', 'mat-khau-cam']);
  const invite = await h.cli(['invite']);
  const reg = await T.post('/v1/auth/register', { invite, username: 'Bob', password: 'mat-khau-bob', deviceName: 'iPhone Bob' });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  const loginA = await T.post('/v1/auth/login', { username: 'cam', password: 'mat-khau-cam', deviceName: 'iPhone Cam' });
  const pairA = await T.post('/v1/machines/pair', { username: 'cam', password: 'mat-khau-cam', machineName: 'pc-cam' });
  const pairB = await T.post('/v1/machines/pair', { username: 'bob', password: 'mat-khau-bob', machineName: 'pc-bob' });
  const agentA = await T.ws({ type: 'hello', proto: 1, role: 'agent', token: pairA.body.machineToken });
  await agentA.next((m) => m.type === 'welcome');
  const agentB = await T.ws({ type: 'hello', proto: 1, role: 'agent', token: pairB.body.machineToken });
  await agentB.next((m) => m.type === 'welcome');
  const appA = await T.ws({ type: 'hello', proto: 1, role: 'app', token: loginA.body.token });
  const wa = await appA.next((m) => m.type === 'welcome');
  const appB = await T.ws({ type: 'hello', proto: 1, role: 'app', token: reg.body.token });
  const wb = await appB.next((m) => m.type === 'welcome');
  return { agentA, agentB, appA, appB, mA: pairA.body.machineId, mB: pairB.body.machineId, wa, wb, tokA: loginA.body.token, tokB: reg.body.token };
}

module.exports = { tmp, startHub, wsClient, twoUsers };
