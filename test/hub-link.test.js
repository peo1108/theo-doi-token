// PC nối hub (hub-link.js): hub thật trong tiến trình + lõi remote.js chạy claude giả.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeEnv } = require('./helpers.js');

const env = makeEnv();
const PROJECTS = path.join(env.dir, 'projects');
const WORK = path.join(env.dir, 'work');
fs.mkdirSync(PROJECTS, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });
process.env.CLAUDE_PROJECTS_DIR = PROJECTS;
process.env.CLAUDE_BIN = path.join(__dirname, 'fake-claude.js');
const R = require('../remote.js');
const { startLink } = require('../hub-link.js');
const { startHub } = require('./hub-helpers.js');

const hub = R.createHub({ notify: async () => true });
test.after(() => { hub.shutdown(); env.cleanup(); });

const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error('until timeout'); await new Promise((r) => setTimeout(r, 20)); } };
const FAST = { min: 30, max: 150 };

// Hub + tài khoản + PC đã ghép và đang nối + một app.
async function setup() {
  const T = await startHub();
  await T.h.cli(['init', 'cam', 'mat-khau-cam']);
  const pair = (await T.post('/v1/machines/pair', { username: 'cam', password: 'mat-khau-cam', machineName: 'pc' })).body;
  const login = (await T.post('/v1/auth/login', { username: 'cam', password: 'mat-khau-cam' })).body;
  const link = startLink({ hubUrl: T.base, machineToken: pair.machineToken, hub, backoff: FAST });
  await until(() => link.status().state === 'online');
  const app = async () => {
    const a = await T.ws({ type: 'hello', proto: 1, role: 'app', token: login.token });
    await a.next((m) => m.type === 'welcome');
    let n = 0;
    a.call = async (method, params = {}, machine = pair.machineId) => {
      const id = `c${++n}`;
      a.send({ type: 'req', id, machine, method, params });
      const r = await a.next((m) => m.type === 'res' && m.id === id, 8000);
      if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.result;
    };
    a.events = (sid, pred, ms = 8000) => a.next((m) => m.type === 'event' && m.session === sid && pred(m.data), ms);
    return a;
  };
  return { T, link, pair, login, app };
}

test('link: app gọi hàm trên PC qua hub', async () => {
  const { T, link, app } = await setup();
  try {
    const a = await app();
    const st = await a.call('state');
    assert.ok(Array.isArray(st.live));
    await assert.rejects(a.call('không có'), (e) => e.code === 'NOT_FOUND');
  } finally { link.stop(); await T.stop(); }
});

test('link: sub nhận phát lại rồi sự kiện sống; PC rớt rồi nối lại, app sub lại không mất / không lặp', async () => {
  const { T, link, pair, app } = await setup();
  try {
    const a = await app();
    const s = await a.call('sessions.create', { cwd: WORK, text: 'chào' });
    await until(() => hub.get(s.id, { load: false }).events.some((e) => e.text === 'echo: chào'));
    a.send({ type: 'sub', machine: pair.machineId, session: s.id, after: 0, epoch: '' });
    const reset = await a.events(s.id, (d) => d.kind === 'reset');
    assert.ok(reset.data.epoch);
    await a.events(s.id, (d) => d.kind === 'assistant' && d.text === 'echo: chào');
    await a.call('sessions.send', { id: s.id, text: 'sống' });
    const live = await a.events(s.id, (d) => d.kind === 'assistant' && d.text === 'echo: sống');
    const lastSeq = live.data.seq;

    // PC rớt khỏi hub; trong lúc đó phiên vẫn chạy trên máy
    T.h.router.agents.get(pair.machineId).ws.terminate();
    await a.next((m) => m.type === 'machine' && m.online === false);
    R.call(hub, 'sessions.send', { id: s.id, text: 'lúc rớt' });
    await until(() => hub.get(s.id, { load: false }).events.some((e) => e.text === 'echo: lúc rớt'));
    await a.next((m) => m.type === 'machine' && m.online === true);
    a.msgs.length = 0;
    a.send({ type: 'sub', machine: pair.machineId, session: s.id, after: lastSeq, epoch: reset.data.epoch });
    await a.events(s.id, (d) => d.kind === 'state');
    const got = a.msgs.filter((m) => m.type === 'event' && m.data.kind !== 'state').map((m) => m.data);
    assert.ok(!got.some((d) => d.kind === 'reset'), 'cùng epoch: không nạp lại từ đầu');
    assert.equal(got.filter((d) => d.text === 'echo: lúc rớt').length, 1);
    assert.ok(!got.some((d) => d.text === 'echo: sống'), 'không lặp phần đã có');
  } finally { link.stop(); await T.stop(); }
});

test('link: hub khởi động lại, PC tự nối lại', async () => {
  const { T, link, pair, login } = await setup();
  const { dataDir, port } = T;
  await T.stop();
  await until(() => link.status().state !== 'online');
  const T2 = await startHub({ dataDir, port });
  try {
    await until(() => link.status().state === 'online', 8000);
    const a = await T2.ws({ type: 'hello', proto: 1, role: 'app', token: login.token });
    const w = await a.next((m) => m.type === 'welcome');
    assert.deepEqual(w.machines.map((m) => [m.id, m.online]), [[pair.machineId, true]]);
  } finally { link.stop(); await T2.stop(); }
});

test('link: hai app cùng xem — duyệt quyền ở app 1, app 2 thấy đã quyết', async () => {
  const { T, link, pair, app } = await setup();
  try {
    const a1 = await app(), a2 = await app();
    const s = await a1.call('sessions.create', { cwd: WORK, text: 'mở' });
    for (const a of [a1, a2]) a.send({ type: 'sub', machine: pair.machineId, session: s.id, after: 0, epoch: '' });
    await a1.events(s.id, (d) => d.kind === 'assistant' && d.text === 'echo: mở');
    await a1.call('sessions.send', { id: s.id, text: 'PERM ghi file' });
    const p1 = await a1.events(s.id, (d) => d.kind === 'permission');
    await a2.events(s.id, (d) => d.kind === 'permission');
    await a1.call('sessions.permission', { id: s.id, requestId: p1.data.requestId, decision: 'allow' });
    const d2 = await a2.events(s.id, (d) => d.kind === 'decided');
    assert.equal(d2.data.requestId, p1.data.requestId);
    // sự kiện chung: danh sách phiên đổi -> mọi app
    await a2.next((m) => m.type === 'event' && m.data.kind === 'sessions');
  } finally { link.stop(); await T.stop(); }
});

test('link: máy bị thu hồi -> trạng thái revoked, không nối lại', async () => {
  const { T, link, pair, app } = await setup();
  try {
    const a = await app();
    await a.call('machines.revoke', { id: pair.machineId }, 'hub');
    await until(() => link.status().state === 'revoked');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(link.status().state, 'revoked');
    assert.equal(T.h.router.agents.size, 0);
  } finally { link.stop(); await T.stop(); }
});

test('link: tin lớn (~1,2 MB) từ app tới PC và trả lời lớn về app', async () => {
  const { T, link, pair, app } = await setup();
  try {
    const a = await app();
    const proto = require('../hub/proto.js');
    const text = 'lớn '.repeat(240000);   // 960 000 ký tự, ~1,2 MB UTF-8
    const parts = proto.splitMessage({ type: 'req', id: 'big1', method: 'sessions.create', params: { cwd: WORK, text } }, { machine: pair.machineId });
    for (const p of parts) a.send(p);
    const r = await a.next((m) => m.type === 'res' && m.id === 'big1', 8000);
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const s = hub.get(r.result.id, { load: false });
    assert.equal(s.events.find((e) => e.kind === 'user').text, text.trim());
    // phát lại lớn (> 256 KB) đi về app dạng mảnh
    a.send({ type: 'sub', machine: pair.machineId, session: s.id, after: 0, epoch: '' });
    const asm = new proto.Assembler();
    let got = null;
    while (!got) {
      const { binary } = await a.next((m) => m.binary, 8000);
      const { header, payload } = proto.decodePart(binary);
      got = asm.push(header, payload);
    }
    assert.equal(got.type, 'event');
    assert.equal(got.data.kind, 'user');
    assert.equal(got.data.text.length, text.trim().length);
  } finally { link.stop(); await T.stop(); }
});

test('link: thông báo của phiên đi qua hub khi đã nối (không dùng ntfy riêng của máy)', async () => {
  const calls = [];
  const { createNotifier } = require('../hub/notify.js');
  const T = await startHub({ notifier: (db) => createNotifier({ db, fetch: async (url, o) => { calls.push({ url, ...o }); return { ok: true }; } }) });
  await T.h.cli(['init', 'cam', 'mat-khau-cam']);
  const pair = (await T.post('/v1/machines/pair', { username: 'cam', password: 'mat-khau-cam', machineName: 'pc' })).body;
  const link = startLink({ hubUrl: T.base, machineToken: pair.machineToken, hub, backoff: FAST });
  try {
    await until(() => link.status().state === 'online');
    assert.equal(await hub.notify('Xong · demo', 'đã sửa', '11111111-2222-3333-4444-555555555555'), true);
    await until(() => calls.length === 1);
    assert.equal(calls[0].headers.Click, `ccremote://session/${pair.machineId}/11111111-2222-3333-4444-555555555555`);
    link.stop();
    assert.equal(hub.notifyVia, null, 'ngắt hub -> quay về cách cũ');
  } finally { link.stop(); await T.stop(); }
});

test('link: báo "danh sách phiên đổi" chỉ khi trạng thái đổi, gộp tối đa mỗi 2 giây (app làm mới state quét đĩa trên PC)', async () => {
  const { T, link, app } = await setup();
  try {
    const a = await app();
    const s = await a.call('sessions.create', { cwd: WORK, text: 'mở' });
    await until(() => hub.get(s.id, { load: false }).events.some((e) => e.text === 'echo: mở'));
    await new Promise((r) => setTimeout(r, 2200));
    a.msgs.length = 0;
    const sess = hub.get(s.id, { load: false });
    const count = () => a.msgs.filter((m) => m.type === 'event' && m.data.kind === 'sessions').length;
    // phiên chỉ có thêm dòng lịch sử, trạng thái không đổi -> không báo (app chạy nền đỡ pin / dữ liệu)
    for (let i = 0; i < 6; i++) { sess.broadcastState(); await new Promise((r) => setTimeout(r, 250)); }
    await new Promise((r) => setTimeout(r, 1000));   // quá 2 giây gộp
    assert.equal(count(), 0);
    // trạng thái đổi liên tục -> gộp thành một lần
    sess.setStatus('running');
    sess.setStatus('idle');
    await new Promise((r) => setTimeout(r, 2300));
    assert.equal(count(), 1);
  } finally { link.stop(); await T.stop(); }
});
