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

// Gọi lõi như app gửi qua hub. Đường dẫn kiểu REST chỉ để test dễ đọc; trả {status, body} (lỗi -> status của RemoteError).
async function api(method, p, body) {
  const fixed = { 'GET /v1/state': 'state', 'GET /v1/capabilities': 'capabilities', 'POST /v1/sessions': 'sessions.create',
    'POST /v1/accounts/switch': 'accounts.switch', 'POST /v1/always-on': 'alwaysOn' };
  let fn = fixed[`${method} ${p}`], params = { ...(body || {}) };
  const m = /^\/v1\/sessions\/([0-9a-f-]{36})(?:\/(\w+))?$/i.exec(p);
  if (!fn && m) { fn = m[2] ? `sessions.${m[2]}` : 'sessions.get'; params.id = m[1]; }
  try { return { status: 200, body: await R.call(hub, fn, params) }; }
  catch (e) { if (!(e instanceof R.RemoteError)) throw e; return { status: e.status, body: { error: e.code, message: e.message } }; }
}

// Theo dõi phiên như app (qua subscribe) cho tới khi cond(events) đúng.
function watch(id, cond, { after = 0, epoch = '' } = {}) {
  return new Promise((resolve, reject) => {
    const s = hub.get(id);
    if (!s) return reject(new Error('không có phiên ' + id));
    const events = [];
    let done = false, off = null;
    const t = setTimeout(() => { done = true; if (off) off(); reject(new Error('timeout: ' + JSON.stringify(events.map((e) => e.kind)))); }, 8000);
    off = R.subscribe(s, { after, epoch }, (ev) => {
      if (done) return;
      events.push(JSON.parse(JSON.stringify(ev)));
      if (cond(events)) { done = true; clearTimeout(t); if (off) off(); resolve(events); }
    });
    if (done) off();
  });
}
const has = (kind, f = () => true) => (evs) => evs.some((e) => e.kind === kind && f(e));
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('until timeout'); await new Promise((r) => setTimeout(r, 20)); } };

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
  const evs2 = await watch(id, (e) => has('assistant', (x) => x.text === 'echo: lần hai')(e) && has('result')(e), { after: last, epoch: evs.find((e) => e.kind === 'state').epoch });
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
  // từ chối kèm lời nhắn (như "No, and tell Claude what to do differently"): Claude đọc được, app thấy lại lời mình gõ
  await api('POST', `/v1/sessions/${id}/permission`, { requestId: p2.requestId, decision: 'deny', feedback: '  ghi vào b.txt thay vì a.txt ' });
  evs = await watch(id, has('assistant', (e) => e.text === 'denied'));
  assert.match(evs.find((e) => e.kind === 'tool_result' && e.error).text, /từ chối từ điện thoại và nhắn: ghi vào b\.txt thay vì a\.txt$/);
  assert.equal(evs.find((e) => e.kind === 'decided' && e.requestId === p2.requestId).text, 'ghi vào b.txt thay vì a.txt');

  await api('POST', `/v1/sessions/${id}/send`, { text: 'ASK' });
  evs = await watch(id, has('permission', (e) => e.tool === 'AskUserQuestion'));
  const q = evs.filter((e) => e.kind === 'permission').pop();
  assert.equal(q.questions[0].options[1].label, 'Xanh');
  await api('POST', `/v1/sessions/${id}/permission`, { requestId: q.requestId, decision: 'allow', answers: { 'Màu gì?': 'Xanh' } });
  // chờ hết lượt khi vẫn đang xem (không thì 'Xong' đẩy thông báo lọt sang test sau)
  await watch(id, (e) => { const i = e.findIndex((x) => x.kind === 'assistant' && x.text === 'allowed {"Màu gì?":"Xanh"} perms=0'); return i >= 0 && e.slice(i).some((x) => x.kind === 'result'); });
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

test('mở lại phiên cũ, gửi tiếp rồi đóng: tail không đọc lại phần claude -p vừa ghi (không lặp sự kiện)', async () => {
  const { body } = await api('POST', '/v1/sessions', { cwd: WORK, text: 'một' });
  const s = hub.get(body.id, { load: false });
  await watch(s.id, has('result'));
  s.close();
  await until(() => !s.proc);
  s.loadTranscript(true);   // app mở phiên cũ
  s.send('hai');
  await until(() => { const i = s.events.findIndex((e) => e.text === 'hai'); return i >= 0 && s.events.slice(i).some((e) => e.kind === 'result'); });
  s.close();
  await until(() => !s.proc);
  s.tail();
  assert.deepEqual(s.events.filter((e) => e.kind === 'user' || e.kind === 'assistant').map((e) => e.text), ['một', 'echo: một', 'hai', 'echo: hai']);
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
  assert.equal((await api('GET', '/v1/sessions/00000000-0000-0000-0000-000000000000')).status, 404);
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

test('cài đặt phiên: --settings khi mở, apply_flag_settings giữa phiên, capabilities từ initialize', async () => {
  const CTRL = ARGS_FILE.replace(/\.jsonl$/, '.ctrl.jsonl');
  const { body } = await api('POST', '/v1/sessions', { cwd: WORK, text: 'xin chào', effort: 'low', thinking: false });
  const id = body.id;
  await watch(id, has('result'));
  const first = JSON.parse(fs.readFileSync(ARGS_FILE, 'utf8').trim().split('\n').pop());
  assert.deepEqual(JSON.parse(first.args[first.args.indexOf('--settings') + 1]), { effortLevel: 'low', alwaysThinkingEnabled: false });
  await until(() => hub.get(id, { load: false }).caps);
  let st = (await api('GET', `/v1/sessions/${id}`)).body;
  assert.equal(st.account, 'fake@example.com');
  assert.equal(st.settings.effort, 'low');
  assert.equal(st.settings.thinking, false);

  const r = await api('POST', `/v1/sessions/${id}/settings`, { effort: 'max', flagSwitch: true, fast: true, model: 'haiku' });
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.effort, 'max');
  assert.equal(r.body.settings.modelLabel, 'Haiku 4.5');
  await until(() => fs.existsSync(CTRL) && fs.readFileSync(CTRL, 'utf8').includes('apply_flag_settings'));
  const ctrl = fs.readFileSync(CTRL, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(ctrl.find((c) => c.subtype === 'apply_flag_settings').settings, { effortLevel: 'max', switchModelsOnFlag: true, fastMode: true });
  assert.ok(ctrl.some((c) => c.subtype === 'set_model' && c.model === 'haiku'));
  assert.equal((await api('POST', `/v1/sessions/${id}/settings`, { effort: 'siêu' })).body.error, 'FORMAT');

  const caps = (await api('GET', '/v1/capabilities')).body;
  assert.deepEqual(caps.models.map((m) => m.value), ['default', 'haiku']);
  assert.deepEqual(caps.models[0].efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(caps.commands.map((c) => c.name), ['compact'], 'ẩn lệnh nội bộ __');
  assert.deepEqual(caps.outputStyles, ['default', 'Concise']);
  assert.ok(caps.defaults && 'effort' in caps.defaults);

  // mở lại (resume) vẫn giữ cài đặt của phiên
  await api('POST', `/v1/sessions/${id}/close`);
  await until(() => !hub.get(id, { load: false }).proc);
  await api('POST', `/v1/sessions/${id}/send`, { text: '/context' });
  const evs = await watch(id, has('output'));
  assert.equal(evs.find((e) => e.kind === 'output').text, 'Context: 12K / 200K');
  const again = JSON.parse(fs.readFileSync(ARGS_FILE, 'utf8').trim().split('\n').pop());
  assert.deepEqual(JSON.parse(again.args[again.args.indexOf('--settings') + 1]), { effortLevel: 'max', alwaysThinkingEnabled: false, switchModelsOnFlag: true, fastMode: true });
  assert.equal(again.args[again.args.indexOf('--model') + 1], 'haiku');
});

test('capabilities khi chưa có phiên nào: mở claude chỉ để hỏi initialize', async () => {
  const hub2 = R.createHub({});
  const caps = await hub2.capabilities();
  assert.equal(caps.account.email, 'fake@example.com');
  assert.equal(caps.models.length, 2);
});

// ---------- phiên đang mở trên máy (VS Code) điều khiển qua hook.js ----------

const { spawn: spawnProc } = require('child_process');
// Chạy hook.js như Claude Code: JSON qua stdin, trả về mã thoát, stdout, stderr.
function runHook(event, input, port = server.address().port) {
  let p;
  const done = new Promise((resolve) => {
    p = spawnProc(process.execPath, [path.join(__dirname, '..', 'hook.js'), event], {
      env: { ...process.env, REMOTE_PORT: String(port), CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', CC_REMOTE_CHILD: '' },
    });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(JSON.stringify(input));
  });
  return Object.assign(done, { kill: () => p.kill() });
}

test('điều khiển phiên VS Code: /phone, chờ lệnh, gửi tin, xin quyền, gõ ở máy thì thả', async () => {
  R.setAlwaysOn(false);   // chế độ cũ: phải gõ /phone
  const id = '22222222-3333-4444-5555-666666666666';
  const dir = path.join(PROJECTS, 'vscode');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const line = (o) => fs.appendFileSync(file, JSON.stringify({ cwd: WORK, sessionId: id, timestamp: new Date().toISOString(), ...o }) + '\n');
  line({ type: 'user', message: { role: 'user', content: 'việc đang làm trên máy' } });
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'đang làm' }] } });
  const base = { session_id: id, transcript_path: file, cwd: WORK };

  // chưa gắn điện thoại: hook cho qua ngay, không in gì
  let r = await runHook('stop', base);
  assert.equal(r.out, '');
  let st = (await api('GET', `/v1/sessions/${id}`)).body;
  assert.equal(st.external, true);
  assert.equal(st.source, 'VS Code');
  assert.equal(st.attached, false);
  assert.ok((await api('GET', '/v1/state')).body.live.some((x) => x.id === id && x.external));

  // gõ /phone trong VS Code -> gắn; Claude trả lời xong -> hook Stop đứng chờ
  await runHook('prompt', { ...base, prompt: '/phone' });
  const parked = runHook('stop', { ...base, last_assistant_message: 'Đã chuyển sang điện thoại' });
  await until(() => hub.get(id, { load: false })?.bridge?.parked);
  st = (await api('GET', `/v1/sessions/${id}`)).body;
  assert.equal(st.attached, true);
  assert.equal(st.ready, true);
  assert.equal(st.status, 'idle');

  // điện thoại gửi tin -> hook thoát mã 2, lời nhắn (kèm mã riêng của máy) ở stderr
  await api('POST', `/v1/sessions/${id}/send`, { text: 'làm tiếp phần test' });
  r = await parked;
  assert.equal(r.code, 2);
  assert.equal(r.out, '');
  const reason = r.err;
  assert.match(reason, /^📱 \[CC Remote #[0-9a-f]{8}\] Tin nhắn của người dùng/);
  assert.ok(reason.endsWith('\n\nlàm tiếp phần test'));

  // Claude Code ghi "Stop hook feedback" vào lịch sử -> app thấy một lần (không kèm câu dẫn), không lặp
  line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `Stop hook feedback:\n${reason}` }] } });
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'xong phần test' }] } });
  const evs = await watch(id, has('assistant', (e) => e.text === 'xong phần test'));
  assert.equal(evs.filter((e) => e.kind === 'user' && e.text === 'làm tiếp phần test').length, 1);

  // xin quyền trong VS Code -> hỏi trên điện thoại
  const perm = runHook('permission', { ...base, tool_name: 'Bash', tool_input: { command: 'npm test' }, permission_suggestions: [{ type: 'addRules' }] });
  const pe = (await watch(id, has('permission', (e) => e.tool === 'Bash'))).find((e) => e.kind === 'permission' && e.tool === 'Bash');
  assert.equal(pe.summary, 'npm test');
  await api('POST', `/v1/sessions/${id}/permission`, { requestId: pe.requestId, decision: 'always' });
  r = await perm;
  const out = JSON.parse(r.out).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PermissionRequest');
  assert.equal(out.decision.behavior, 'allow');
  assert.deepEqual(out.decision.updatedPermissions, [{ type: 'addRules' }]);

  // tin gửi lúc Claude đang làm -> xếp hàng, đưa vào ở lần Stop kế tiếp (không phải chờ)
  await api('POST', `/v1/sessions/${id}/send`, { text: 'thêm việc nữa' });
  r = await runHook('stop', base);
  assert.equal(r.code, 2);
  assert.ok(r.err.endsWith('thêm việc nữa'));

  // gõ ở máy -> thả: hook Stop đang chờ thì cho qua, xin quyền thì để VS Code hỏi
  const parked2 = runHook('stop', base);
  await until(() => hub.get(id, { load: false })?.bridge?.parked);
  await runHook('prompt', { ...base, prompt: 'tôi về máy rồi' });
  r = await parked2;
  assert.equal(r.out, '');
  assert.equal((await api('GET', `/v1/sessions/${id}`)).body.attached, false);
  r = await runHook('permission', { ...base, tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(r.out, '', 'không gắn điện thoại thì không quyết định thay');

  // gắn từ điện thoại, rồi thả bằng nút trên điện thoại
  await api('POST', `/v1/sessions/${id}/attach`, { on: true });
  const parked3 = runHook('stop', base);
  await until(() => hub.get(id, { load: false })?.bridge?.parked);
  await api('POST', `/v1/sessions/${id}/attach`, { on: false });
  assert.equal((await parked3).out, '');
});

test('hook: sai khoá thì bị chặn; tracker không chạy thì hook thoát ngay', async () => {
  const r = await fetch(`${base}/v1/hook/stop`, { method: 'POST', headers: { 'X-Hook-Key': 'sai' }, body: '{}' });
  assert.equal(r.status, 403);
  const p = spawnProc(process.execPath, [path.join(__dirname, '..', 'hook.js'), 'stop'], { env: { ...process.env, REMOTE_PORT: '1' } });
  const t0 = Date.now();
  const code = await new Promise((res) => { p.on('exit', res); p.stdin.end('{"session_id":"x"}'); });
  assert.equal(code, 0);
  assert.ok(Date.now() - t0 < 3000);
});

test('cài / gỡ hook: giữ hook khác của người dùng, có lệnh /phone', () => {
  const settings = path.join(env.dir, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  const st = R.installHooks();
  assert.equal(st.installed, true);
  let s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(s.model, 'opus');
  assert.equal(s.hooks.Stop.length, 2);
  assert.ok(s.hooks.PermissionRequest[0].hooks[0].command.includes('hook.js'));
  assert.ok(fs.existsSync(path.join(env.dir, 'commands', 'phone.md')));
  assert.ok(fs.existsSync(settings + '.cc-remote-backup'));
  R.installHooks();   // cài lại không nhân đôi
  s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(s.hooks.Stop.length, 2);
  assert.equal(s.hooks.Stop[1].hooks[0].asyncRewake, true, 'Stop chạy nền: VS Code không hiện đang chạy');
  assert.equal(R.hooksStatus().outdated, false);
  // cài từ bản cũ (Stop chạy kiểu chặn) -> báo cần cài lại; cài lại thì hết
  delete s.hooks.Stop[1].hooks[0].asyncRewake;
  fs.writeFileSync(settings, JSON.stringify(s));
  assert.equal(R.hooksStatus().outdated, true);
  R.installHooks();
  assert.equal(R.hooksStatus().outdated, false);
  assert.match(fs.readFileSync(path.join(env.dir, 'commands', 'phone.md'), 'utf8'), /#[0-9a-f]{8}/);
  assert.equal(R.uninstallHooks().installed, false);
  s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.deepEqual(s.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] });
  assert.ok(!fs.existsSync(path.join(env.dir, 'commands', 'phone.md')));
});

test('cài hook: dọn hook hỏng khi đã chuyển thư mục tool, giữ hook.js của người khác; settings.json có BOM vẫn đọc được', () => {
  const settings = path.join(env.dir, 'settings.json');
  const ours = (s) => Object.values(s.hooks).flat().flatMap((g) => g.hooks).map((h) => h.command);
  // thư mục tool cũ đã bị chuyển đi (hook.js không còn) + một hook.js khác của người dùng
  const gone = path.join(env.dir, 'thu-muc-cu').replace(/\\/g, '/');
  const other = path.join(env.dir, 'khac');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'hook.js'), '// hook riêng của người dùng\n');
  const otherCmd = `node "${other.replace(/\\/g, '/')}/hook.js" stop`;
  fs.writeFileSync(settings, '\uFEFF' + JSON.stringify({ hooks: {
    Stop: [{ hooks: [{ type: 'command', command: `node "${gone}/hook.js" stop`, timeout: 86400, asyncRewake: true }] },
      { hooks: [{ type: 'command', command: otherCmd }] }],
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node "${gone}/hook.js" pretool`, timeout: 10 }] }],
  } }));
  const before = R.hooksStatus();
  assert.equal(before.outdated, true, 'hook trỏ tới thư mục cũ -> cần cài lại (tracker tự cài lúc khởi động)');
  R.installHooks();
  const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.ok(!ours(s).some((c) => c.includes(gone)), 'hook hỏng đã được dọn');
  assert.ok(ours(s).includes(otherCmd), 'giữ hook.js của người khác');
  assert.equal(ours(s).filter((c) => / stop$/.test(c)).length, 2);
  assert.equal(R.hooksStatus().outdated, false);
  assert.equal(R.uninstallHooks().installed, false);
  assert.deepEqual(ours(JSON.parse(fs.readFileSync(settings, 'utf8'))), [otherCmd]);
});

test('state: kèm cảnh báo gần đây của máy cho trang chủ app; đọc lỗi thì rỗng, không làm hỏng state', () => {
  const al = [{ id: 1.5, t: Date.now(), level: 'warning', title: 'Chính đã dùng 92% cửa sổ 5h', body: 'Gợi ý: Phụ' }];
  const h1 = R.createHub({ alerts: () => al });
  assert.deepEqual(h1.state().alerts, al);
  const h2 = R.createHub({ alerts: () => { throw new Error('alerts.json hỏng'); } });
  assert.deepEqual(h2.state().alerts, []);
  assert.deepEqual(R.createHub({}).state().alerts, []);
  for (const h of [h1, h2]) h.shutdown();
});

test('tiêu đề phiên: tên đặt bằng /rename thắng ai-title ghi sau nó (cả lúc nạp lẫn lúc đang theo dõi)', async () => {
  const id = 'abababab-1111-2222-3333-444444444444';
  const dir = path.join(PROJECTS, 'title');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const line = (o) => fs.appendFileSync(file, JSON.stringify({ sessionId: id, timestamp: new Date().toISOString(), ...o }) + '\n');
  line({ type: 'user', cwd: WORK, message: { role: 'user', content: 'lời nhắn đầu' } });
  line({ type: 'custom-title', customTitle: 'Tên tôi đặt' });
  line({ type: 'ai-title', aiTitle: 'Tên AI đặt' });
  assert.equal(R.recentSessions(400).find((s) => s.id === id).title, 'Tên tôi đặt');
  const s = hub.get(id);
  assert.equal(s.title, 'Tên tôi đặt');
  s.followEnd(file, fs.statSync(file));
  line({ type: 'ai-title', aiTitle: 'Tên AI mới' });
  s.tail();
  assert.equal(s.title, 'Tên tôi đặt', 'ai-title mới không đè tên người dùng đặt');
  line({ type: 'custom-title', customTitle: 'Đổi tên lần hai' });
  s.tail();
  assert.equal(s.title, 'Đổi tên lần hai');
});

test('luôn sẵn sàng: không cần /phone, gõ ở máy thì nhả hook, rời máy thì hỏi quyền trên điện thoại', async () => {
  R.setAlwaysOn(true);
  hub.setIdle(500);   // đang ngồi ở máy
  const id = '55555555-6666-7777-8888-999999999999';
  const dir = path.join(PROJECTS, 'vscode2');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const line = (o) => fs.appendFileSync(file, JSON.stringify({ cwd: WORK, sessionId: id, timestamp: new Date().toISOString(), ...o }) + '\n');
  line({ type: 'user', message: { role: 'user', content: 'đang làm trên máy' } });
  const base = { session_id: id, transcript_path: file, cwd: WORK };

  // xong lượt -> hook Stop đứng chờ dù chưa ai gõ /phone
  let parked = runHook('stop', base);
  await until(() => hub.get(id, { load: false })?.bridge?.parked);
  let st = (await api('GET', `/v1/sessions/${id}`)).body;
  assert.equal(st.ready, true);
  assert.equal(st.attached, false);

  // người dùng gõ tiếp trong VS Code -> Claude Code ghi enqueue -> hook nhả, không gửi gì
  line({ type: 'queue-operation', operation: 'enqueue' });
  let r = await parked;
  assert.equal(r.out, '');
  assert.equal(hub.get(id, { load: false })?.bridge?.parked, null);

  // đang ở máy: VS Code hỏi, điện thoại cũng hiện (song song, không đẩy thông báo); bấm cho phép trên máy -> tool chạy
  // -> PostToolUse của đúng tool đó gỡ câu hỏi khỏi điện thoại, hook thôi chờ mà không quyết định
  const notes = [];
  const realNotify = hub.notify;
  hub.notify = async (title) => { notes.push(title); return true; };
  let perm = runHook('permission', { ...base, tool_name: 'Bash', tool_input: { command: 'ls' } });
  let pe = (await watch(id, has('permission', (e) => e.tool === 'Bash'))).filter((e) => e.kind === 'permission').pop();
  assert.ok(pe, 'điện thoại thấy câu hỏi dù đang ngồi máy');
  assert.equal(notes.length, 0, 'ngồi máy: không đẩy thông báo');
  await runHook('tool', { ...base, tool_name: 'Read', tool_input: { file_path: 'x' } });
  assert.equal(hub.get(id, { load: false }).pending.size, 1, 'tool khác chạy xong không gỡ');
  await runHook('tool', { ...base, tool_name: 'Bash', tool_input: { command: 'ls' } });
  r = await perm;
  assert.equal(r.out, '');
  assert.equal(hub.get(id, { load: false }).pending.size, 0);

  // ngồi máy lúc hỏi rồi bỏ đi -> lúc đó mới đẩy thông báo; điện thoại trả lời được
  perm = runHook('permission', { ...base, tool_name: 'Bash', tool_input: { command: 'rm x' } });
  pe = (await watch(id, has('permission', (e) => e.tool === 'Bash' && e.summary.includes('rm')))).filter((e) => e.kind === 'permission').pop();
  hub.setIdle(60e3);
  assert.equal(notes.length, 1);
  await api('POST', `/v1/sessions/${id}/permission`, { requestId: pe.requestId, decision: 'deny' });
  assert.equal(JSON.parse((await perm).out).hookSpecificOutput.decision.behavior, 'deny');
  hub.setIdle(500);
  hub.notify = realNotify;

  // điện thoại nhắn lúc phiên đang chờ -> đưa vào ngay
  parked = runHook('stop', base);
  await until(() => hub.get(id, { load: false })?.bridge?.parked);
  await api('POST', `/v1/sessions/${id}/send`, { text: 'nhắn từ điện thoại' });
  r = await parked;
  assert.equal(r.code, 2);
  assert.ok(r.err.endsWith('nhắn từ điện thoại'));

  // điện thoại đã nhắn -> đang điều khiển -> xin quyền hỏi trên điện thoại kể cả khi ngồi ở máy
  perm = runHook('permission', { ...base, tool_name: 'Write', tool_input: { file_path: 'a.txt' } });
  pe = (await watch(id, has('permission', (e) => e.tool === 'Write'))).filter((e) => e.kind === 'permission').pop();
  await api('POST', `/v1/sessions/${id}/permission`, { requestId: pe.requestId, decision: 'allow' });
  assert.equal(JSON.parse((await perm).out).hookSpecificOutput.decision.behavior, 'allow');

  // thả về máy trên điện thoại: hook Stop vẫn chờ (luôn sẵn sàng)
  parked = runHook('stop', base);
  await until(() => hub.get(id, { load: false })?.bridge?.parked);
  await api('POST', `/v1/sessions/${id}/attach`, { on: false });
  assert.ok(hub.get(id, { load: false })?.bridge?.parked, 'vẫn chờ');

  // rời máy (không thao tác > 45 giây) -> xin quyền hỏi trên điện thoại; quay lại máy vẫn hiện cả hai nơi;
  // lượt kết thúc (đã trả lời trên máy) -> gỡ khỏi điện thoại
  hub.setIdle(60e3);
  assert.equal((await api('GET', '/v1/state')).body.pcAway, true);
  perm = runHook('permission', { ...base, tool_name: 'Edit', tool_input: { file_path: 'b.txt' } });
  pe = (await watch(id, has('permission', (e) => e.tool === 'Edit'))).filter((e) => e.kind === 'permission').pop();
  assert.ok(pe);
  hub.setIdle(800);
  assert.equal(hub.get(id, { load: false }).pending.size, 1, 'quay lại máy: điện thoại vẫn hiện');
  hub.get(id, { load: false }).release({ action: 'continue' });
  await parked;
  parked = runHook('stop', base);
  assert.equal((await perm).out, '', 'Stop -> hook không quyết định');
  assert.equal(hub.get(id, { load: false }).pending.size, 0);

  // tắt luôn sẵn sàng: hook Stop đang chờ không bị ép thả, lần sau thì cho qua
  hub.get(id, { load: false }).release({ action: 'continue' });
  await parked;
  assert.equal((await api('POST', '/v1/always-on', { on: false })).body.alwaysOn, false);
  r = await runHook('stop', base);
  assert.equal(r.out, '');
  R.setAlwaysOn(true);
});

test('hook Stop chạy nền: gõ ở máy (UserPromptSubmit) thì nhả hook đang chờ; chính tin điện thoại thì không', async () => {
  R.setAlwaysOn(true);
  hub.setIdle(500);
  const id = '99999999-aaaa-bbbb-cccc-dddddddddddd';
  const dir = path.join(PROJECTS, 'vscode4');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: WORK, sessionId: id, timestamp: new Date().toISOString(), message: { content: 'việc' } }) + '\n');
  const base = { session_id: id, transcript_path: file, cwd: WORK };

  let parked = runHook('stop', base);
  await until(() => hub.get(id, { load: false })?.bridge?.parked);
  await runHook('prompt', { ...base, prompt: `📱 [CC Remote #${'0'.repeat(8)}] Tin nhắn của người dùng, gửi từ điện thoại …\n\nabc` });
  assert.ok(hub.get(id, { load: false }).bridge.parked, 'tin điện thoại không phải gõ ở máy');
  await runHook('prompt', { ...base, prompt: 'gõ trên máy' });
  const r = await parked;
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.equal(hub.get(id, { load: false }).bridge.parked, null);
});

test('hook Stop: tracker khởi động lại khi hook đang chờ -> chờ tracker lên lại rồi đứng chờ tiếp; đã gõ lượt mới trên máy thì thôi', async () => {
  R.setAlwaysOn(true);
  const id = 'cdcdcdcd-1111-2222-3333-444444444444';
  const dir = path.join(PROJECTS, 'restart');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const line = (o) => fs.appendFileSync(file, JSON.stringify({ cwd: WORK, sessionId: id, timestamp: new Date().toISOString(), ...o }) + '\n');
  line({ type: 'user', message: { role: 'user', content: 'việc trên máy' } });
  const base = { session_id: id, transcript_path: file, cwd: WORK };
  // tracker riêng (cùng cổng mỗi lần mở lại); "tắt" = cắt mọi kết nối như tiến trình bị kill, không trả lời hook
  let port = 0;
  const downs = [];
  const notes = [];
  const up = async () => {
    const h = R.createHub({ notify: async (title) => { notes.push(title); return true; } });
    h.setIdle(60e3);   // máy để yên: xong lượt thì báo điện thoại
    const srv = R.createRemoteServer(h);
    await new Promise((r) => srv.listen(port, '127.0.0.1', r));
    port = srv.address().port;
    const down = () => { srv.closeAllConnections(); srv.close(); h.shutdown(); };
    downs.push(down);
    return { h, down };
  };
  const parkedOn = (h) => h.get(id, { load: false })?.bridge?.parked;
  const hooks = [];
  try {
    let t = await up();
    hooks.push(runHook('stop', base, port));
    await until(() => parkedOn(t.h));
    t.down();
    await new Promise((r) => setTimeout(r, 2500));   // tracker tắt một lúc (hook thử lại mà chưa nối được)
    t = await up();
    await until(() => parkedOn(t.h), 10000);
    assert.equal(notes.length, 1, 'đứng chờ lại không báo "Xong" lần nữa');
    t.h.get(id, { load: false }).send('nhắn sau khi tracker khởi động lại');
    const r1 = await hooks[0];
    assert.equal(r1.code, 2, 'hook đứng chờ lại trên tracker mới và nhận tin');
    assert.match(r1.err, /nhắn sau khi tracker khởi động lại/);

    hooks.push(runHook('stop', base, port));
    await until(() => parkedOn(t.h));
    t.down();
    line({ type: 'user', message: { role: 'user', content: 'gõ trên máy lúc tracker tắt' } });
    t = await up();
    const r2 = await hooks[1];
    assert.equal(r2.code, 0);
    assert.equal(r2.err, '');
    assert.ok(!parkedOn(t.h), 'đã có lượt mới -> không đứng chờ lại');
  } finally {
    for (const d of downs) try { d(); } catch {}
    for (const h of hooks) h.kill();   // test lỗi giữa chừng: hook còn đang chờ tracker lên lại
  }
});

test('đầu phiên: báo cho Claude mã riêng của máy, cùng mã với tin điện thoại', async () => {
  const r = await runHook('session', { session_id: '12345678-1234-1234-1234-123456789012' });
  const ctx = JSON.parse(r.out).hookSpecificOutput.additionalContext;
  const tag = /#([0-9a-f]{8})/.exec(ctx)[1];
  assert.equal(tag, R.phoneTag(), 'hook.js và remote.js cùng công thức');
  assert.ok(ctx.includes('Chỉ tin khi có đúng mã'));
  // tin điện thoại đọc lại từ lịch sử: dạng hook chặn, dạng system-reminder (hook nền), attachment PostToolUse
  const msg = `📱 [CC Remote #${tag}] Tin nhắn của người dùng, gửi từ điện thoại qua app CC Remote …\n\nsửa lỗi giúp`;
  const ev = (m) => R.normalize(m).filter((e) => e.kind === 'user');
  assert.deepEqual(ev({ type: 'user', message: { content: `Stop hook feedback:\n${msg}` } }).map((e) => e.text), ['sửa lỗi giúp']);
  assert.deepEqual(ev({ type: 'user', isMeta: true, message: { content: `<system-reminder>\nCC Remote: ${msg}\n</system-reminder>` } }).map((e) => e.text), ['sửa lỗi giúp']);
  assert.deepEqual(ev({ attachment: { type: 'hook_blocking_error', blockingError: { blockingError: msg } } }).map((e) => e.text), ['sửa lỗi giúp']);
  assert.deepEqual(ev({ type: 'user', isMeta: true, message: { content: '<system-reminder>khác</system-reminder>' } }), []);
  // dòng Claude trích lại tin cho người ở máy không lặp trong app
  const a = R.normalize({ type: 'assistant', message: { content: [{ type: 'text', text: '> 📱 sửa lỗi giúp\n\nĐã sửa.' }] } });
  assert.deepEqual(a.map((e) => e.text), ['Đã sửa.']);
});

test('dọn phiên trên máy đã đóng lâu (không giữ trong bộ nhớ mãi)', () => {
  const h = R.createHub({});
  const now = Date.now();
  const mk = (id, bridge) => {
    const s = new R.Session(id, { hub: h });
    s.updatedAt = now - 2 * 3600e3;
    s.bridge = { attached: false, parked: null, queue: [], busy: false, lastSeen: now - 2 * 3600e3, ...bridge };
    h.sessions.set(id, s);
  };
  mk('a0000000-0000-0000-0000-000000000000', {});
  mk('b0000000-0000-0000-0000-000000000000', { parked: {} });            // hook còn chờ: phiên còn mở
  mk('c0000000-0000-0000-0000-000000000000', { queue: ['tin chưa gửi'] });
  mk('d0000000-0000-0000-0000-000000000000', { lastSeen: now - 60e3 });  // vừa thấy hook
  h.sweep(now);
  assert.deepEqual([...h.sessions.keys()].sort(), ['b0000000-0000-0000-0000-000000000000', 'c0000000-0000-0000-0000-000000000000', 'd0000000-0000-0000-0000-000000000000']);
  h.shutdown();
});

test('suy nghĩ: phát Thinking… · N tokens tức thời, xong thì để lại Thought for Xs', async () => {
  const { body } = await api('POST', '/v1/sessions', { cwd: WORK, text: 'mở phiên' });
  await watch(body.id, has('result'));
  const epoch = (await api('GET', `/v1/sessions/${body.id}`)).body.epoch;
  const seen = watch(body.id, (e) => e.some((x) => x.kind === 'thought'), { after: 1e9, epoch });
  await new Promise((r) => setTimeout(r, 100));
  await api('POST', `/v1/sessions/${body.id}/send`, { text: 'THINK đi' });
  const evs = await seen;
  const prog = evs.filter((e) => e.kind === 'progress' && e.phase === 'thinking');
  assert.deepEqual(prog.map((e) => e.tokens), [50, 120]);
  assert.ok(prog.every((e) => e.seq === undefined), 'không lưu, không phát lại');
  const th = evs.find((e) => e.kind === 'thought');
  assert.equal(th.tokens, 120);
  assert.ok(th.seconds >= 1);
  assert.ok(evs.some((e) => e.kind === 'progress' && e.phase === 'working'));
});

test('như điều khiển từ xa: bấm dừng lúc đang chạy -> dừng ở tool kế tiếp; gửi lúc đang chạy -> chèn sau tool', async () => {
  R.setAlwaysOn(true);
  hub.setIdle(500);
  const id = '66666666-7777-8888-9999-aaaaaaaaaaaa';
  const dir = path.join(PROJECTS, 'vscode3');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: WORK, sessionId: id, timestamp: new Date().toISOString(), message: { content: 'việc dài' } }) + '\n');
  const base = { session_id: id, transcript_path: file, cwd: WORK };

  // Claude đang chạy tool -> chưa có gì thì hook cho qua
  let r = await runHook('tool', { ...base, tool_name: 'Bash' });
  assert.equal(r.out, '');

  // điện thoại gửi lúc đang chạy -> tool kế tiếp xong thì chèn (decision block, có câu dẫn)
  await api('POST', `/v1/sessions/${id}/send`, { text: 'nhân tiện sửa luôn README' });
  r = await runHook('pretool', { ...base, tool_name: 'Read' });
  assert.equal(r.out, '', 'PreToolUse không chèn tin (chỉ dừng)');
  r = await runHook('tool', { ...base, tool_name: 'Read' });
  const o = JSON.parse(r.out);
  assert.equal(o.decision, 'block');
  assert.ok(o.reason.endsWith('nhân tiện sửa luôn README'));
  assert.equal(o.systemMessage, '📱 Từ điện thoại: nhân tiện sửa luôn README', 'hiện cho người ở máy thấy');

  // bấm dừng lúc đang chạy -> tool kế tiếp (trước hoặc sau) trả continue:false
  await api('POST', `/v1/sessions/${id}/interrupt`);
  r = await runHook('pretool', { ...base, tool_name: 'Bash' });
  assert.equal(JSON.parse(r.out).continue, false);
  r = await runHook('tool', { ...base, tool_name: 'Bash' });
  assert.equal(r.out, '', 'chỉ dừng một lần');
});

test('hook bỏ qua claude -p / SDK (không được đứng chờ)', async () => {
  const p = spawnProc(process.execPath, [path.join(__dirname, '..', 'hook.js'), 'stop'], {
    env: { ...process.env, REMOTE_PORT: String(server.address().port), CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', CC_REMOTE_CHILD: '' },
  });
  const t0 = Date.now();
  const code = await new Promise((res) => { p.on('exit', res); p.stdin.end(JSON.stringify({ session_id: '77777777-8888-9999-aaaa-bbbbbbbbbbbb' })); });
  assert.equal(code, 0);
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(!hub.sessions.has('77777777-8888-9999-aaaa-bbbbbbbbbbbb'), 'không gọi server');
});

test('hook không bao giờ chặn nhầm khi server trả lỗi (vd. tracker bản cũ chưa có route)', async () => {
  const bad = http.createServer((req, res) => {
    req.resume();
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'UNAUTHORIZED', message: 'Thiết bị chưa ghép hoặc đã bị thu hồi' }));
  });
  await new Promise((r) => bad.listen(0, '127.0.0.1', r));
  const port = String(bad.address().port);
  for (const ev of ['pretool', 'tool', 'stop', 'permission', 'prompt']) {
    const p = spawnProc(process.execPath, [path.join(__dirname, '..', 'hook.js'), ev], {
      env: { ...process.env, REMOTE_PORT: port, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', CC_REMOTE_CHILD: '' },
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    const code = await new Promise((res) => { p.on('exit', res); p.stdin.end(JSON.stringify({ session_id: '88888888-9999-aaaa-bbbb-cccccccccccc', tool_name: 'Bash' })); });
    assert.equal(code, 0, ev);
    assert.equal(out, '', `${ev} không được in gì`);
  }
  bad.close();
});

// ---------- call(): lõi dùng chung cho HTTP cũ và hub ----------

test('call: state, tạo / gửi / duyệt quyền / ngắt / đóng phiên qua call như qua HTTP; hàm lạ -> NOT_FOUND', async () => {
  const st = await R.call(hub, 'state', {});
  assert.ok(Array.isArray(st.live) && Array.isArray(st.projects));
  const s = await R.call(hub, 'sessions.create', { cwd: WORK, text: 'mở qua call' });
  assert.match(s.id, /^[0-9a-f-]{36}$/);
  await watch(s.id, has('assistant', (e) => e.text === 'echo: mở qua call'));
  const viaHttp = (await api('GET', `/v1/sessions/${s.id}`)).body;
  const viaCall = await R.call(hub, 'sessions.get', { id: s.id.toUpperCase() });
  assert.equal(viaCall.id, viaHttp.id);
  assert.equal(viaCall.status, viaHttp.status);
  // xin quyền -> duyệt qua call
  await R.call(hub, 'sessions.send', { id: s.id, text: 'PERM qua call' });
  const pe = (await watch(s.id, has('permission'), { after: viaCall.lastSeq })).find((e) => e.kind === 'permission');
  await R.call(hub, 'sessions.permission', { id: s.id, requestId: pe.requestId, decision: 'allow' });
  await watch(s.id, has('assistant', (e) => e.text.startsWith('allowed')), { after: viaCall.lastSeq });
  // ngắt lúc đang chạy
  await R.call(hub, 'sessions.send', { id: s.id, text: 'SLOW qua call' });
  await watch(s.id, has('assistant', (e) => e.text === 'working...'), { after: viaCall.lastSeq });
  await R.call(hub, 'sessions.interrupt', { id: s.id });
  await watch(s.id, has('note', (e) => e.text === 'Đã ngắt'), { after: viaCall.lastSeq });
  assert.equal((await R.call(hub, 'sessions.mode', { id: s.id, mode: 'plan' })).mode, 'plan');
  await R.call(hub, 'sessions.close', { id: s.id });
  await until(() => !hub.get(s.id, { load: false }).proc);
  await assert.rejects(R.call(hub, 'sessions.get', { id: 'không-phải-id' }), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(R.call(hub, 'sessions.get', { id: '00000000-0000-0000-0000-00000000dead' }), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(R.call(hub, 'không có hàm này', {}), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(R.call(hub, 'projects.sessions', {}), (e) => e.code === 'FORMAT');
  assert.equal((await R.call(hub, 'alwaysOn', { on: true })).alwaysOn, true);
});

// ---------- ảnh và tin lớn ----------

// ảnh nhỏ hợp lệ (chỉ cần đúng chữ ký đầu file)
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]).toString('base64');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 3)]).toString('base64');
const img = (data = PNG, mime = 'image/png', name = 'a.png') => ({ mime, data, name, thumb: JPG });
const inputLog = () => (fs.existsSync(ARGS_FILE.replace(/\.jsonl$/, '.input.jsonl'))
  ? fs.readFileSync(ARGS_FILE.replace(/\.jsonl$/, '.input.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

test('ảnh vào phiên claude -p thành khối image; xem lại ảnh đầy đủ bằng sessions.image', async () => {
  const s = await R.call(hub, 'sessions.create', { cwd: WORK, text: 'xem ảnh này', images: [img(), img(JPG, 'image/jpeg', 'b.jpg')] });
  const evs = await watch(s.id, has('assistant', (e) => e.text === 'echo: xem ảnh này'));
  const blocks = inputLog().pop().content;
  assert.deepEqual(blocks.map((b) => b.type), ['text', 'image', 'image']);
  assert.deepEqual(blocks[1].source, { type: 'base64', media_type: 'image/png', data: PNG });
  const u = evs.find((e) => e.kind === 'user');
  assert.equal(u.images.length, 2);
  assert.equal(u.images[0].thumb, JPG);
  const full = await R.call(hub, 'sessions.image', { id: s.id, name: u.images[1].name });
  assert.deepEqual(full, { mime: 'image/jpeg', data: JPG });
  await assert.rejects(R.call(hub, 'sessions.image', { id: s.id, name: '../../remote.json' }), (e) => e.code === 'NOT_FOUND');
  // chỉ ảnh, không chữ
  await R.call(hub, 'sessions.send', { id: s.id, text: '', images: [img()] });
  await until(() => inputLog().pop().content.length === 1);
  assert.equal(inputLog().pop().content[0].type, 'image');
  // ảnh nhỏ thiếu / quá cỡ -> sự kiện không mang thumb (không cắt cụt thành ảnh hỏng), app tự tải ảnh thật
  await R.call(hub, 'sessions.send', { id: s.id, text: 'không thumb', images: [{ ...img(), thumb: undefined }, { ...img(), thumb: 'A'.repeat(400001) }] });
  const u2 = (await watch(s.id, has('user', (e) => e.text === 'không thumb'))).find((e) => e.text === 'không thumb');
  assert.deepEqual(u2.images.map((x) => 'thumb' in x), [false, false]);
});

test('ảnh: sai chữ ký file -> BAD_IMAGE; quá 10 ảnh -> TOO_MANY_IMAGES; tin 900 000 ký tự qua được', async () => {
  const s = await R.call(hub, 'sessions.create', { cwd: WORK, text: 'mở' });
  await watch(s.id, has('result'));
  const fake = Buffer.from('<html>không phải ảnh</html>').toString('base64');
  await assert.rejects(R.call(hub, 'sessions.send', { id: s.id, text: 'x', images: [img(fake, 'image/png')] }), (e) => e.code === 'BAD_IMAGE');
  await assert.rejects(R.call(hub, 'sessions.send', { id: s.id, text: 'x', images: [img(PNG, 'image/svg+xml', 'a.svg')] }), (e) => e.code === 'BAD_IMAGE');
  await assert.rejects(R.call(hub, 'sessions.send', { id: s.id, text: 'x', images: Array.from({ length: 11 }, () => img()) }), (e) => e.code === 'TOO_MANY_IMAGES');
  const long = 'dài '.repeat(225000);
  await R.call(hub, 'sessions.send', { id: s.id, text: long });
  await until(() => { const l = inputLog().pop(); return l && l.content === long.trim(); });
  await assert.rejects(R.call(hub, 'sessions.send', { id: s.id, text: 'x'.repeat(1e6 + 1) }), (e) => e.code === 'TOO_LONG');
});

test('ảnh vào phiên VS Code (hook): lưu file, tin chèn vào có đường dẫn để Claude dùng Read', async () => {
  R.setAlwaysOn(true);
  hub.setIdle(500);
  const id = 'abcdef00-1111-2222-3333-444444444444';
  const dir = path.join(PROJECTS, 'vscode-img');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: WORK, sessionId: id, timestamp: new Date().toISOString(), message: { content: 'việc' } }) + '\n');
  const base = { session_id: id, transcript_path: file, cwd: WORK };
  const parked = runHook('stop', base);
  await until(() => hub.get(id, { load: false })?.bridge?.parked);
  await R.call(hub, 'sessions.send', { id, text: 'lỗi trong ảnh này', images: [img()] });
  const r = await parked;
  assert.equal(r.code, 2);
  const paths = r.err.split('\n').filter((l) => l.endsWith('.png'));
  assert.equal(paths.length, 1);
  assert.ok(r.err.includes('lỗi trong ảnh này'));
  assert.ok(r.err.includes('tool Read'));
  assert.ok(paths[0].startsWith(path.join(env.dataDir, 'uploads', id)));
  assert.deepEqual(fs.readFileSync(paths[0]), Buffer.from(PNG, 'base64'));
});

test('ảnh Claude xem trong lịch sử (Read, ảnh dán VS Code): chỉ giữ chỗ, app hỏi mới đọc lại đúng dòng trong file', async () => {
  const id = 'abcdef00-5555-6666-7777-888888888888';
  const dir = path.join(PROJECTS, 'pc-img');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const block = (data, mime = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type: mime, data } });
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
  const t = new Date().toISOString();
  const lines = (xs) => xs.map((x) => JSON.stringify({ ...x, sessionId: id, timestamp: t })).join('\n') + '\n';
  fs.writeFileSync(file, lines([
    { type: 'user', cwd: WORK, message: { content: [{ type: 'text', text: '<ide_opened_file>a</ide_opened_file>' }, block(JPG, 'image/jpeg'), { type: 'text', text: 'lỗi ở đây' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'C:/a.png' } }] } },
    // ảnh hỏng bị bỏ nhưng vẫn giữ thứ tự; JPEG khai nhầm là PNG -> nhận theo chữ ký
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: [block(svg), block(JPG, 'image/png'), { type: 'text', text: 'kèm chữ' }] }] } },
    { type: 'user', message: { content: [block(svg)] } },
    { type: 'user', message: { content: [{ type: 'image', source: { type: 'url', url: 'https://x/a.png' } }] } },
  ]));

  await R.call(hub, 'sessions.get', { id });
  const evs = await watch(id, (e) => e.filter((x) => x.kind === 'user').length === 3);
  assert.ok(!JSON.stringify(evs).includes(JPG), 'sự kiện chỉ mang tên ảnh, không mang dữ liệu');
  const [u, bad, url] = evs.filter((e) => e.kind === 'user');
  assert.equal(u.text, 'lỗi ở đây');
  assert.match(u.images[0].name, /^l-[0-9a-f]{8}-\d+-\d+-0\.jpg$/);
  assert.deepEqual([bad.text, bad.images, url.text, url.images], ['[ảnh]', undefined, '[ảnh]', undefined]);
  const r1 = evs.find((e) => e.kind === 'tool_result');
  assert.equal(r1.images.length, 1);
  assert.match(r1.images[0].name, /^l-[0-9a-f]{8}-\d+-\d+-1\.jpg$/);
  assert.ok(!fs.existsSync(path.join(env.dataDir, 'uploads', id)), 'nạp lịch sử không ghi file ảnh');
  assert.deepEqual(await R.call(hub, 'sessions.image', { id, name: u.images[0].name }), { mime: 'image/jpeg', data: JPG });
  assert.deepEqual(await R.call(hub, 'sessions.image', { id, name: r1.images[0].name }), { mime: 'image/jpeg', data: JPG });
  const ep = /^l-([0-9a-f]{8})-/.exec(u.images[0].name)[1];
  for (const name of [`l-${ep}-0-10-0.png`, `l-${ep}-999999-5-0.png`, `l-${ep}-0-255999999-0.png`, 'l-0-10-0.png',
    r1.images[0].name.replace(/-1\.jpg$/, '-0.jpg'), r1.images[0].name.replace(ep, ep === '00000000' ? '11111111' : '00000000'), 'c-../x.png']) {
    await assert.rejects(R.call(hub, 'sessions.image', { id, name }), (e) => e.code === 'NOT_FOUND', name);
  }

  // dòng ghi thêm khi phiên VS Code đang chạy -> tail cũng giữ chỗ đúng vị trí trong file
  fs.appendFileSync(file, lines([{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r2', content: [block(PNG)] }] } }]));
  const s = hub.get(id, { load: false });
  s.tail();
  const r2 = s.events.find((e) => e.kind === 'tool_result' && e.id === 'r2');
  assert.deepEqual(await R.call(hub, 'sessions.image', { id, name: r2.images[0].name }), { mime: 'image/png', data: PNG });

  // nạp lại lúc dòng ảnh đang ghi dở: dòng đó không mất, không lặp — tail đọc tiếp khi ghi xong.
  // File chỉ được ghi thêm -> tên ảnh cũ giữ nguyên (app khỏi tải lại ảnh đang cache)
  const half = lines([{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r3', content: [block(JPG, 'image/jpeg')] }] } }]);
  fs.appendFileSync(file, half.slice(0, 60));
  const streamEpoch = s.epoch;
  s.loadTranscript(true);
  assert.notEqual(s.epoch, streamEpoch, 'dãy sự kiện đánh số lại -> app nạp lại từ đầu');
  assert.equal(s.events.find((e) => e.id === 'r2').images[0].name, r2.images[0].name);
  assert.deepEqual(await R.call(hub, 'sessions.image', { id, name: r2.images[0].name }), { mime: 'image/png', data: PNG });
  assert.ok(!s.events.some((e) => e.id === 'r3'));
  fs.appendFileSync(file, half.slice(60));
  s.tail();
  const r3 = s.events.filter((e) => e.kind === 'tool_result' && e.id === 'r3');
  assert.equal(r3.length, 1);
  assert.deepEqual(await R.call(hub, 'sessions.image', { id, name: r3[0].images[0].name }), { mime: 'image/jpeg', data: JPG });
  s.tail();
  assert.equal(s.events.filter((e) => e.id === 'r3').length, 1);

  // đọc file lỗi (Windows đang khoá) -> giữ nguyên lịch sử và vị trí, không đọc lại cả file thành sự kiện mới
  const count = s.events.length, offset = s.fileOffset;
  fs.appendFileSync(file, lines([{ type: 'assistant', message: { content: [{ type: 'text', text: 'sau khoá' }] } }]));
  const realRead = fs.readFileSync;
  fs.readFileSync = (p, ...a) => { if (p === file) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return realRead(p, ...a); };
  try { s.loadTranscript(true); } finally { fs.readFileSync = realRead; }
  assert.deepEqual([s.events.length, s.fileOffset], [count, offset]);
  s.tail();
  assert.equal(s.events.length, count + 1);
  assert.equal(s.events.filter((e) => e.text === 'sau khoá').length, 1);

  // file bị ghi lại ngắn hơn -> đặt tên lại, tên cũ hết hiệu lực
  fs.writeFileSync(file, lines([{ type: 'user', cwd: WORK, message: { content: [block(PNG)] } }]));
  s.tail();
  await assert.rejects(R.call(hub, 'sessions.image', { id, name: r3[0].images[0].name }), (e) => e.code === 'NOT_FOUND');
  const fresh = s.events.find((e) => e.kind === 'user').images[0].name;
  assert.notEqual(/^l-([0-9a-f]{8})-/.exec(fresh)[1], ep);
  assert.deepEqual(await R.call(hub, 'sessions.image', { id, name: fresh }), { mime: 'image/png', data: PNG });
});

test('bắt đầu theo dõi file lúc dòng cuối đang ghi dở (dài hơn một khúc đọc): không mất dòng đó', () => {
  const id = 'abcdef00-9999-6666-7777-888888888888';
  const dir = path.join(PROJECTS, 'follow');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const line = (text) => JSON.stringify({ type: 'assistant', sessionId: id, timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text }] } }) + '\n';
  const big = line('x'.repeat(200e3));
  fs.writeFileSync(file, line('cũ') + big.slice(0, 150e3));
  const s = new R.Session(id, { hub, known: true });
  s.followEnd(file, fs.statSync(file));
  fs.appendFileSync(file, big.slice(150e3));
  s.tail();
  assert.deepEqual(s.events.map((e) => e.text.length), [200e3]);
});

test('ảnh Claude xem trong phiên claude -p: một file theo nội dung, không để file tạm; dọn ảnh chừa phiên còn trong bộ nhớ', async () => {
  const s = await R.call(hub, 'sessions.create', { cwd: WORK, text: 'SEEIMG' });
  const evs = await watch(s.id, has('result'));
  const rs = evs.filter((e) => e.kind === 'tool_result');
  assert.equal(rs.length, 2);
  assert.match(rs[0].images[0].name, /^c-[0-9a-f]{16}\.png$/);
  assert.equal(rs[1].images[0].name, rs[0].images[0].name);
  const up = path.join(env.dataDir, 'uploads', s.id);
  assert.deepEqual(fs.readdirSync(up), [rs[0].images[0].name]);
  assert.equal((await R.call(hub, 'sessions.image', { id: s.id, name: rs[0].images[0].name })).mime, 'image/png');

  // tool chụp màn hình phải duyệt quyền: app ẩn dòng tool, ảnh hiện theo toolUseId của thẻ quyền
  await R.call(hub, 'sessions.send', { id: s.id, text: 'PERM SHOT' });
  const pe = (await watch(s.id, has('permission'))).find((e) => e.kind === 'permission');
  await R.call(hub, 'sessions.permission', { id: s.id, requestId: pe.requestId, decision: 'allow' });
  const shot = (await watch(s.id, has('tool_result', (e) => e.id === pe.toolUseId))).find((e) => e.kind === 'tool_result' && e.id === pe.toolUseId);
  assert.match(shot.images[0].name, /^c-[0-9a-f]{16}\.png$/);

  const old = (Date.now() - 8 * 24 * 3600e3) / 1000;
  fs.utimesSync(up, old, old);
  hub.sweep();
  assert.ok(fs.existsSync(up), 'phiên còn trong bộ nhớ -> không dọn');
});

test('ghi ảnh: Windows báo EPERM khi đổi tên -> thử lại ở nền; vẫn lỗi thì báo lỗi, không ghi thẳng, không để file tạm', async () => {
  const s = await R.call(hub, 'sessions.create', { cwd: WORK, text: 'mở' });
  await watch(s.id, has('result'));
  const up = path.join(env.dataDir, 'uploads', s.id);
  const files = () => (fs.existsSync(up) ? fs.readdirSync(up) : []);
  const real = fs.renameSync;
  let fails = 2;
  fs.renameSync = (a, b) => { if (fails-- > 0) throw Object.assign(new Error('busy'), { code: 'EPERM' }); return real(a, b); };
  try {
    await R.call(hub, 'sessions.send', { id: s.id, text: 'a', images: [img()] });
    // không chờ đồng bộ: send đã trả về khi chưa đổi tên được, trong lúc đó app vẫn xem được ảnh
    assert.ok(!files().some((f) => f.endsWith('.png')));
    const name = hub.get(s.id, { load: false }).events.filter((e) => e.kind === 'user').pop().images[0].name;
    assert.deepEqual(await R.call(hub, 'sessions.image', { id: s.id, name }), { mime: 'image/png', data: PNG });
    await until(() => files().includes(name));
    assert.deepEqual(fs.readFileSync(path.join(up, name)), Buffer.from(PNG, 'base64'));

    fails = 99;
    await R.call(hub, 'sessions.send', { id: s.id, text: 'b', images: [img(JPG, 'image/jpeg', 'b.jpg')] });
    await watch(s.id, has('error', (e) => e.text.startsWith('Không lưu được ảnh trên máy')));
  } finally { fs.renameSync = real; }
  assert.deepEqual(files().map((f) => path.extname(f)), ['.png'], 'không có ảnh ghi dở mang tên thật, không còn file tạm');
});

test('dọn ảnh cũ hơn 7 ngày trong data/uploads', () => {
  const up = path.join(env.dataDir, 'uploads');
  const old = path.join(up, 'cu'), fresh = path.join(up, 'moi');
  fs.mkdirSync(old, { recursive: true });
  fs.mkdirSync(fresh, { recursive: true });
  fs.writeFileSync(path.join(old, 'a.png'), 'x');
  const t = (Date.now() - 8 * 24 * 3600e3) / 1000;
  fs.utimesSync(old, t, t);
  // file tạm sót lại (xoá cũng bị khoá) cũ hơn 1 giờ thì dọn, file tạm đang ghi thì không
  const stale = path.join(fresh, '1-1.png.9.1.tmp'), writingNow = path.join(fresh, '1-2.png.9.2.tmp');
  fs.writeFileSync(stale, 'x');
  fs.writeFileSync(writingNow, 'x');
  const h = (Date.now() - 2 * 3600e3) / 1000;
  fs.utimesSync(stale, h, h);
  R.sweepUploads(Date.now());
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(fresh));
  assert.deepEqual([fs.existsSync(stale), fs.existsSync(writingNow)], [false, true]);
});

test('server trên máy chỉ còn cho hook: không còn API điện thoại kiểu cũ (Tailscale, mã ghép)', async () => {
  for (const [m, p] of [['GET', '/v1/state'], ['GET', '/v1/ping'], ['POST', '/v1/pair'], ['GET', '/v1/projects'], ['POST', '/v1/sessions']]) {
    const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: m === 'POST' ? '{}' : undefined });
    assert.equal(r.status, 404, `${m} ${p}`);
  }
  for (const k of ['newPairCode', 'pair', 'authDevice', 'devices', 'setNtfy', 'tailscaleInfo', 'tailscaleServe']) assert.equal(R[k], undefined, k);
});
