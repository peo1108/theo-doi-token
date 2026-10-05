const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { makeEnv } = require('./helpers.js');

const env = makeEnv();
const PROJECTS = path.join(env.dir, 'projects');
const ARGS_FILE = path.join(env.dir, 'args.jsonl');
const WORK = path.join(env.dir, 'work');
fs.mkdirSync(PROJECTS, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });
process.env.CLAUDE_PROJECTS_DIR = PROJECTS;
process.env.CLAUDE_BIN = path.join(__dirname, 'fake-claude.js');
process.env.FAKE_ARGS_FILE = ARGS_FILE;
const R = require('../remote.js');

const pushes = [];
let switched = [];
const accountsView = {
  active: 'a1', conflict: null,
  accounts: [
    { id: 'a1', name: 'Chính', email: 'a@x', usage: { fiveHour: { pct: 100, resetsAt: 1 }, sevenDay: null }, loginState: 'ok' },
    { id: 'a2', name: 'Phụ', email: 'b@x', usage: { fiveHour: { pct: 10, resetsAt: 1 }, sevenDay: null }, loginState: 'ok', suggested: true },
  ],
};
const hub = R.createHub({
  accounts: () => accountsView,
  switchAccount: (id) => { switched.push(id); return { ok: true, to: id, running: [] }; },
  notify: async (title, body, sid) => { pushes.push({ title, body, sid }); return true; },
});
const server = R.createRemoteServer(hub);
let base;
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => { hub.shutdown(); server.close(); env.cleanup(); });

let token = '';
async function api(method, p, body, tok = token) {
  const r = await fetch(base + p, {
    method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
}

// Đọc SSE cho tới khi cond(events) đúng.
function watch(id, cond, { after = 0, epoch = '' } = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get(`${base}/v1/sessions/${id}/events?after=${after}&epoch=${epoch}`, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (chunk.startsWith('data: ')) events.push(JSON.parse(chunk.slice(6)));
          if (cond(events)) { req.destroy(); clearTimeout(t); return resolve(events); }
        }
      });
    });
    req.on('error', () => {});
    const t = setTimeout(() => { req.destroy(); reject(new Error('timeout: ' + JSON.stringify(events.map((e) => e.kind)))); }, 8000);
  });
}
const has = (kind, f = () => true) => (evs) => evs.some((e) => e.kind === kind && f(e));
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('until timeout'); await new Promise((r) => setTimeout(r, 20)); } };

test('ghép thiết bị: mã đúng cấp token, sai 5 lần thì huỷ mã, không token -> 401', async () => {
  assert.equal((await api('GET', '/v1/state', null, '')).status, 401);
  assert.equal((await api('POST', '/v1/pair', { code: '000000' })).body.error, 'PAIR_EXPIRED');
  const { code } = R.newPairCode();
  const wrong = code === '111111' ? '222222' : '111111';
  for (let i = 0; i < 4; i++) assert.equal((await api('POST', '/v1/pair', { code: wrong })).body.error, 'PAIR_WRONG');
  const ok = await api('POST', '/v1/pair', { code, name: 'iPhone test' });
  assert.equal(ok.status, 200);
  token = ok.body.token;
  assert.ok(token.length > 30);
  assert.equal((await api('POST', '/v1/pair', { code })).body.error, 'PAIR_EXPIRED');   // mã dùng một lần
  const raw = fs.readFileSync(path.join(env.dataDir, 'remote.json'), 'utf8');
  assert.ok(!raw.includes(token), 'không lưu token thô');
  assert.equal((await api('GET', '/v1/ping')).body.authed, true);

  const c2 = R.newPairCode().code;
  const bad = c2 === '111111' ? '222222' : '111111';
  for (let i = 0; i < 5; i++) await api('POST', '/v1/pair', { code: bad });
  assert.equal((await api('POST', '/v1/pair', { code: c2 })).body.error, 'PAIR_EXPIRED');
});

test('phiên mới: gửi, nhận echo, gửi tiếp dùng cùng tiến trình', async () => {
  const r = await api('POST', '/v1/sessions', { cwd: WORK, text: 'xin chào', mode: 'acceptEdits' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.id;
  const evs = await watch(id, has('result'));
  assert.deepEqual(evs.filter((e) => e.kind === 'user' || e.kind === 'assistant').map((e) => e.text), ['xin chào', 'echo: xin chào']);
  const first = JSON.parse(fs.readFileSync(ARGS_FILE, 'utf8').trim().split('\n').pop());
  assert.ok(first.args.includes('--session-id') && first.args.includes(id));
  assert.equal(first.args[first.args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.equal(path.resolve(first.cwd), path.resolve(WORK));

  const last = evs.filter((e) => e.seq).pop().seq;
  await api('POST', `/v1/sessions/${id}/send`, { text: 'lần hai' });
  const evs2 = await watch(id, has('assistant', (e) => e.text === 'echo: lần hai'), { after: last, epoch: evs.find((e) => e.kind === 'state').epoch });
  assert.ok(evs2.every((e) => !e.seq || e.seq > last), 'chỉ phát lại sự kiện mới');
  assert.equal(fs.readFileSync(ARGS_FILE, 'utf8').trim().split('\n').length, 1, 'không mở thêm tiến trình');

  const st = await api('GET', '/v1/state');
  assert.ok(st.body.live.some((s) => s.id === id && s.status === 'idle'));
  assert.equal(st.body.accounts.list.length, 2);
});

test('duyệt quyền: allow / always / deny và AskUserQuestion có answers', async () => {
  const { body } = await api('POST', '/v1/sessions', { cwd: WORK, text: 'PERM 1' });
  const id = body.id;
  let evs = await watch(id, (e) => has('permission')(e) && has('state', (x) => x.status === 'waiting')(e));
  const p = evs.find((e) => e.kind === 'permission');
  assert.equal(p.tool, 'Write');
  assert.equal(p.canAlways, true);
  assert.equal((await api('POST', `/v1/sessions/${id}/permission`, { requestId: p.requestId, decision: 'always' })).status, 200);
  evs = await watch(id, has('result'));
  assert.ok(evs.some((e) => e.kind === 'assistant' && e.text === 'allowed null perms=1'));
  assert.ok(evs.some((e) => e.kind === 'decided' && e.decision === 'always'));
  assert.equal((await api('POST', `/v1/sessions/${id}/permission`, { requestId: p.requestId, decision: 'allow' })).status, 409);

  await api('POST', `/v1/sessions/${id}/send`, { text: 'PERM 2' });
  evs = await watch(id, has('permission', (e) => e.requestId !== p.requestId));
  const p2 = evs.filter((e) => e.kind === 'permission').pop();
  await api('POST', `/v1/sessions/${id}/permission`, { requestId: p2.requestId, decision: 'deny' });
  await watch(id, has('assistant', (e) => e.text === 'denied'));

  await api('POST', `/v1/sessions/${id}/send`, { text: 'ASK' });
  evs = await watch(id, has('permission', (e) => e.tool === 'AskUserQuestion'));
  const q = evs.filter((e) => e.kind === 'permission').pop();
  assert.equal(q.questions[0].options[1].label, 'Xanh');
  await api('POST', `/v1/sessions/${id}/permission`, { requestId: q.requestId, decision: 'allow', answers: { 'Màu gì?': 'Xanh' } });
  await watch(id, has('assistant', (e) => e.text === 'allowed {"Màu gì?":"Xanh"} perms=0'));
});

test('không ai xem: xin quyền và xong lượt thì đẩy thông báo', async () => {
  pushes.length = 0;
  const { body } = await api('POST', '/v1/sessions', { cwd: WORK, text: 'PERM x' });
  await until(() => pushes.length >= 1);
  assert.match(pushes[0].title, /Cần duyệt Write/);
  assert.equal(pushes[0].sid, body.id);
  const s = hub.get(body.id);
  s.decide([...s.pending.keys()][0], { decision: 'allow' });
  await until(() => pushes.length >= 2);
  assert.match(pushes[1].title, /^Xong/);
});

test('ngắt, đổi chế độ, đóng rồi gửi lại thì --resume và giữ lịch sử', async () => {
  const { body } = await api('POST', '/v1/sessions', { cwd: WORK, text: 'SLOW' });
  const id = body.id;
  await watch(id, has('assistant', (e) => e.text === 'working...'));
  await api('POST', `/v1/sessions/${id}/interrupt`);
  let evs = await watch(id, has('result'));
  const { epoch } = (await api('GET', `/v1/sessions/${id}`)).body;
  assert.ok(evs.some((e) => e.kind === 'note' && e.text === 'Đã ngắt'));
  assert.equal(evs.find((e) => e.kind === 'result').aborted, true);

  await api('POST', `/v1/sessions/${id}/mode`, { mode: 'plan' });
  await until(() => hub.get(id).mode === 'plan');
  assert.equal((await api('POST', `/v1/sessions/${id}/mode`, { mode: 'yolo' })).status, 400);

  await api('POST', `/v1/sessions/${id}/close`);
  await until(() => !hub.get(id, { load: false }).proc);
  await api('POST', `/v1/sessions/${id}/send`, { text: 'tiếp' });
  evs = await watch(id, has('assistant', (e) => e.text === 'echo: tiếp'), { epoch });
  assert.ok(!evs.some((e) => e.kind === 'reset'), 'tự tắt rồi mở lại thì không nạp lại lịch sử');
  const last = JSON.parse(fs.readFileSync(ARGS_FILE, 'utf8').trim().split('\n').pop());
  assert.equal(last.args[last.args.indexOf('--resume') + 1], id);
  assert.equal(last.args[last.args.indexOf('--permission-mode') + 1], 'plan');

  await api('POST', `/v1/sessions/${id}/close`);
  await until(() => !hub.get(id, { load: false }).proc);
  hub.sessions.delete(id);   // như sau khi khởi động lại server: chỉ còn file .jsonl
  evs = await watch(id, (e) => e.some((x) => x.kind === 'state'));
  assert.ok(evs.some((e) => e.kind === 'reset'));
  assert.deepEqual(evs.filter((e) => e.kind === 'user').map((e) => e.text), ['SLOW', 'tiếp'], 'nạp lịch sử từ file');
});

test('hết hạn mức: báo limit kèm gợi ý; đổi tài khoản khởi động lại phiên rồi gửi tiếp', async () => {
  const { body } = await api('POST', '/v1/sessions', { cwd: WORK, text: 'LIMIT' });
  const id = body.id;
  const evs = await watch(id, has('limit'));
  const lim = evs.find((e) => e.kind === 'limit');
  assert.deepEqual(lim.suggest, { id: 'a2', name: 'Phụ' });
  assert.equal(hub.get(id).rate.fiveHour, 100);
  const before = fs.readFileSync(ARGS_FILE, 'utf8').trim().split('\n').length;
  switched = [];
  const r = await api('POST', '/v1/accounts/switch', { id: 'a2', sessionId: id, text: 'tiếp tục' });
  assert.equal(r.status, 200);
  assert.deepEqual(switched, ['a2']);
  assert.ok(r.body.restarted.includes(id));
  await watch(id, has('assistant', (e) => e.text === 'echo: tiếp tục'));
  const lines = fs.readFileSync(ARGS_FILE, 'utf8').trim().split('\n');
  assert.equal(lines.length, before + 1, 'mở tiến trình mới');
  assert.ok(JSON.parse(lines.pop()).args.includes('--resume'));
});

test('lỗi đầu vào: thư mục không tồn tại, phiên lạ, tin nhắn trống', async () => {
  assert.equal((await api('POST', '/v1/sessions', { cwd: path.join(WORK, 'khong-co'), text: 'x' })).body.error, 'NO_CWD');
  assert.equal((await api('POST', '/v1/sessions', { cwd: 'relative', text: 'x' })).body.error, 'NO_CWD');
  assert.equal((await api('GET', '/v1/sessions/00000000-0000-0000-0000-000000000000/events')).status, 404);
  const { body } = await api('POST', '/v1/sessions', { cwd: WORK, text: 'a' });
  assert.equal((await api('POST', `/v1/sessions/${body.id}/send`, { text: '  ' })).body.error, 'EMPTY');
});

test('normalize: bỏ subagent, meta, system-reminder; đổi lệnh / và ngắt', () => {
  assert.deepEqual(R.normalize({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [{ type: 'text', text: 'a' }] } }), []);
  assert.deepEqual(R.normalize({ type: 'user', isMeta: true, message: { content: 'x' } }), []);
  assert.deepEqual(R.normalize({ type: 'user', message: { content: '<system-reminder>a</system-reminder>hỏi' } }), [{ kind: 'user', text: 'hỏi' }]);
  assert.deepEqual(R.normalize({ type: 'user', message: { content: '<command-name>/model</command-name><command-args>opus</command-args>' } }), [{ kind: 'user', text: '/model opus' }]);
  assert.deepEqual(R.normalize({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }), [{ kind: 'note', text: 'Đã ngắt' }]);
  const t = R.normalize({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls -la' } }] } })[0];
  assert.equal(t.summary, 'ls -la');
  assert.equal(R.toolSummary('TodoWrite', { todos: [{ status: 'completed' }, { status: 'in_progress', activeForm: 'Đang viết' }] }), '1/2 việc · Đang viết');
});

test('recentSessions: lấy tiêu đề AI, bỏ file không phải uuid', () => {
  const dir = path.join(PROJECTS, 'p2');
  fs.mkdirSync(dir, { recursive: true });
  const id = '11111111-2222-3333-4444-555555555555';
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), [
    { type: 'user', cwd: WORK, message: { content: 'lời đầu' } },
    { type: 'ai-title', aiTitle: 'Tiêu đề hay' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'agent-x.jsonl'), '{}\n');
  const s = R.recentSessions(100).find((x) => x.id === id);
  assert.equal(s.title, 'Tiêu đề hay');
  assert.equal(s.cwd, WORK);
  assert.ok(R.projects().some((p) => p.cwd === WORK));
});
