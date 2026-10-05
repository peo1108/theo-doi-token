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
// Chạy hook.js như Claude Code: JSON qua stdin, trả về stdout khi thoát.
function runHook(event, input) {
  return new Promise((resolve) => {
    const p = spawnProc(process.execPath, [path.join(__dirname, '..', 'hook.js'), event], {
      env: { ...process.env, REMOTE_PORT: String(server.address().port), CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', CC_REMOTE_CHILD: '' },
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve({ code, out }));
    p.stdin.end(JSON.stringify(input));
  });
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

  // điện thoại gửi tin -> hook in decision block với đúng lời nhắn
  await api('POST', `/v1/sessions/${id}/send`, { text: 'làm tiếp phần test' });
  r = await parked;
  assert.equal(JSON.parse(r.out).decision, 'block');
  const reason = JSON.parse(r.out).reason;
  assert.match(reason, /^📱 Tin nhắn của người dùng/);
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
  assert.ok(JSON.parse(r.out).reason.endsWith('thêm việc nữa'));

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
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).hooks.Stop.length, 2);
  assert.equal(R.uninstallHooks().installed, false);
  s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.deepEqual(s.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] });
  assert.ok(!fs.existsSync(path.join(env.dir, 'commands', 'phone.md')));
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

  // đang ở máy: xin quyền để VS Code hỏi
  r = await runHook('permission', { ...base, tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(r.out, '');

  // điện thoại nhắn lúc phiên đang chờ -> đưa vào ngay
  parked = runHook('stop', base);
  await until(() => hub.get(id, { load: false })?.bridge?.parked);
  await api('POST', `/v1/sessions/${id}/send`, { text: 'nhắn từ điện thoại' });
  r = await parked;
  assert.ok(JSON.parse(r.out).reason.endsWith('nhắn từ điện thoại'));

  // điện thoại đã nhắn -> đang điều khiển -> xin quyền hỏi trên điện thoại kể cả khi ngồi ở máy
  let perm = runHook('permission', { ...base, tool_name: 'Write', tool_input: { file_path: 'a.txt' } });
  let pe = (await watch(id, has('permission', (e) => e.tool === 'Write'))).filter((e) => e.kind === 'permission').pop();
  await api('POST', `/v1/sessions/${id}/permission`, { requestId: pe.requestId, decision: 'allow' });
  assert.equal(JSON.parse((await perm).out).hookSpecificOutput.decision.behavior, 'allow');

  // thả về máy trên điện thoại: hook Stop vẫn chờ (luôn sẵn sàng)
  parked = runHook('stop', base);
  await until(() => hub.get(id, { load: false })?.bridge?.parked);
  await api('POST', `/v1/sessions/${id}/attach`, { on: false });
  assert.ok(hub.get(id, { load: false })?.bridge?.parked, 'vẫn chờ');

  // rời máy (không thao tác > 45 giây) -> xin quyền hỏi trên điện thoại; quay lại máy -> trả về VS Code
  hub.setIdle(60e3);
  assert.equal((await api('GET', '/v1/state')).body.pcAway, true);
  perm = runHook('permission', { ...base, tool_name: 'Edit', tool_input: { file_path: 'b.txt' } });
  pe = (await watch(id, has('permission', (e) => e.tool === 'Edit'))).filter((e) => e.kind === 'permission').pop();
  assert.ok(pe);
  hub.setIdle(800);
  assert.equal((await perm).out, '', 'quay lại máy -> hook không quyết định, VS Code hỏi');

  // tắt luôn sẵn sàng: hook Stop đang chờ không bị ép thả, lần sau thì cho qua
  hub.get(id, { load: false }).release({ action: 'continue' });
  await parked;
  assert.equal((await api('POST', '/v1/always-on', { on: false })).body.alwaysOn, false);
  r = await runHook('stop', base);
  assert.equal(r.out, '');
  R.setAlwaysOn(true);
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
