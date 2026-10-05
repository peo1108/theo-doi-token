#!/usr/bin/env node
// Hook của Claude Code để điều khiển phiên đang mở trên máy (VS Code, terminal) từ app CC Remote.
// Cài bằng `node remote.js hooks install`. Không gắn điện thoại / tracker không chạy -> thoát ngay, phiên chạy như thường.
//
//   node hook.js stop        (Stop)              -> nếu đang điều khiển từ điện thoại: chờ tin nhắn rồi cho Claude làm tiếp
//   node hook.js permission  (PermissionRequest) -> nếu đang điều khiển từ điện thoại: hỏi quyền trên điện thoại
//   node hook.js prompt      (UserPromptSubmit)  -> gõ /phone: chuyển sang điện thoại; gõ tin khác ở máy: thả về máy

const fs = require('fs');
const path = require('path');
const http = require('http');

const event = process.argv[2];
if (process.env.CC_REMOTE_CHILD === '1') process.exit(0);   // phiên do chính remote.js mở: đã điều khiển qua stdio

function readKey() {
  const file = path.join(process.env.TT_DATA_DIR || path.join(__dirname, 'data'), 'remote.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).hookKey || ''; } catch { return ''; }
}

// POST tới remote.js. Server có thể giữ kết nối rất lâu (chờ điện thoại) và gửi khoảng trắng để giữ kết nối.
function post(route, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: Number(process.env.REMOTE_PORT) || 7789, path: `/v1/hook/${route}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'X-Hook-Key': readKey() },
    }, (res) => {
      let t = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { t += d; });
      res.on('end', () => { try { resolve(JSON.parse(t)); } catch { resolve(null); } });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));   // tracker không chạy -> bị từ chối ngay, phiên chạy như thường
    req.end(data);
  });
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  let j = {};
  try { j = JSON.parse(input || '{}'); } catch {}
  const base = {
    session_id: j.session_id, transcript_path: j.transcript_path, cwd: j.cwd,
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT || '',
  };
  let r = null;
  if (event === 'stop') {
    r = await post('stop', { ...base, last: String(j.last_assistant_message || '').slice(0, 300) });
    if (r && r.action === 'message' && r.text) process.stdout.write(JSON.stringify({ decision: 'block', reason: r.text }));
  } else if (event === 'permission') {
    r = await post('permission', { ...base, tool_name: j.tool_name, tool_input: j.tool_input, permission_suggestions: j.permission_suggestions });
    if (r && r.decision) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: r.decision } }));
  } else if (event === 'prompt') {
    await post('prompt', { ...base, prompt: String(j.prompt || '').slice(0, 500) });
  }
  process.exit(0);
});
