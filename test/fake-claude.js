// `claude -p --input-format stream-json --output-format stream-json` giả cho test remote.js.
// Lời nhắn chứa PERM -> xin quyền Write; ASK -> AskUserQuestion; LIMIT -> hết hạn mức; SLOW -> chờ tới khi bị ngắt;
// còn lại -> trả lời "echo: <lời nhắn>". Ghi tham số dòng lệnh vào FAKE_ARGS_FILE, lịch sử vào CLAUDE_PROJECTS_DIR.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const sid = flag('--resume') || flag('--session-id');
if (process.env.FAKE_ARGS_FILE) fs.appendFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ args, cwd: process.cwd() }) + '\n');

const dir = path.join(process.env.CLAUDE_PROJECTS_DIR, 'fake');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${sid}.jsonl`);
const log = (o) => fs.appendFileSync(file, JSON.stringify({ ...o, cwd: process.cwd(), sessionId: sid, timestamp: new Date().toISOString() }) + '\n');
const out = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: sid }) + '\n');
const result = (extra = {}) => out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 5, num_turns: 1, terminal_reason: 'completed', ...extra });
const say = (text) => {
  const m = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null };
  out(m); log(m);
};

out({ type: 'system', subtype: 'init', cwd: process.cwd(), permissionMode: flag('--permission-mode') });

const waiting = new Map();   // request_id -> hàm nhận kết quả
let slow = null;
let n = 0;

function onUser(text) {
  log({ type: 'user', message: { role: 'user', content: text } });
  if (text.includes('PERM') || text.includes('ASK')) {
    const ask = text.includes('ASK');
    const tool = ask ? 'AskUserQuestion' : 'Write';
    const input = ask
      ? { questions: [{ question: 'Màu gì?', header: 'Màu', multiSelect: false, options: [{ label: 'Đỏ', description: '' }, { label: 'Xanh', description: '' }] }] }
      : { file_path: 'C:\\x\\a.txt', content: 'hi' };
    const id = `tu-${++n}`;
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: tool, input }] }, parent_tool_use_id: null });
    const rid = `req-${n}`;
    waiting.set(rid, (resp) => {
      const ok = resp.behavior === 'allow';
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: !ok, content: ok ? 'ok' : resp.message }] }, parent_tool_use_id: null });
      say(ok ? `allowed ${JSON.stringify(resp.updatedInput.answers || null)} perms=${(resp.updatedPermissions || []).length}` : 'denied');
      result();
    });
    out({ type: 'control_request', request_id: rid, request: { subtype: 'can_use_tool', tool_name: tool, input, permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] } });
  } else if (text.includes('LIMIT')) {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1900000000, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1900000000 }, seven_day: { utilization: 0.5 } } } });
    result({ is_error: true, subtype: 'error', result: 'Claude AI usage limit reached' });
  } else if (text.includes('SLOW')) {
    say('working...');
    slow = () => { out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null }); result({ is_error: true, subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }); };
  } else {
    say(`echo: ${text}`);
    result();
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.type === 'user') onUser(typeof m.message.content === 'string' ? m.message.content : '');
    else if (m.type === 'control_response') {
      const fn = waiting.get(m.response.request_id);
      waiting.delete(m.response.request_id);
      if (fn) fn(m.response.response);
    } else if (m.type === 'control_request') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
      if (m.request.subtype === 'interrupt' && slow) { slow(); slow = null; }
      if (m.request.subtype === 'set_permission_mode') out({ type: 'system', subtype: 'status', permissionMode: m.request.mode });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
