// Server giả cho kiểm tra app trên Simulator (CI): remote.js thật + claude giả (test/fake-claude.js).
// Ghi token và id các phiên mẫu ra smoke.json để workflow nạp vào app.
//   node ios/tools/smoke-server.js <thư mục tạm>
const fs = require('fs');
const path = require('path');

const dir = path.resolve(process.argv[2] || 'smoke-tmp');
const work = path.join(dir, 'du-an-mau');
fs.mkdirSync(work, { recursive: true });
process.env.TT_DATA_DIR = path.join(dir, 'data');
process.env.CLAUDE_PROJECTS_DIR = path.join(dir, 'projects');
process.env.CLAUDE_BIN = path.join(__dirname, '..', '..', 'test', 'fake-claude.js');
const R = require('../../remote.js');

const now = Date.now();
const accounts = {
  active: 'a1', conflict: null,
  accounts: [
    { id: 'a1', name: 'Tài khoản chính', email: 'chinh@example.com', plan: 'max', loginState: 'ok',
      usage: { fiveHour: { pct: 92, resetsAt: now + 3600e3 }, sevenDay: { pct: 41, resetsAt: now + 3 * 86400e3 } } },
    { id: 'a2', name: 'Tài khoản phụ', email: 'phu@example.com', plan: 'pro', loginState: 'ok', suggested: true,
      usage: { fiveHour: { pct: 12, resetsAt: now + 7200e3 }, sevenDay: { pct: 8, resetsAt: now + 5 * 86400e3 } } },
  ],
};
let active = 'a1';
const hub = R.createHub({
  accounts: () => ({ ...accounts, active, accounts: accounts.accounts.map((a) => ({ ...a, suggested: a.id !== active })) }),
  switchAccount: (id) => { active = id; return { ok: true, to: id, running: [] }; },
  notify: async () => true,
});
const server = R.createRemoteServer(hub);
server.listen(7789, '127.0.0.1', async () => {
  const { code } = R.newPairCode();
  const { token } = R.pair(code, 'Simulator');
  const md = 'Đây là **markdown** với `code` và danh sách:\n- một\n- hai\n\n```js\nconsole.log("xin chào")\n```';
  const chat = hub.create({ cwd: work, text: md });
  await new Promise((r) => setTimeout(r, 800));
  chat.send('Liệt kê file trong thư mục');
  const perm = hub.create({ cwd: work, text: 'PERM tạo file ghi chú' });
  const ask = hub.create({ cwd: work, text: 'ASK chọn màu' });
  const limit = hub.create({ cwd: work, text: 'LIMIT' });
  await new Promise((r) => setTimeout(r, 1500));
  const out = { token, chat: chat.id, perm: perm.id, ask: ask.id, limit: limit.id };
  fs.writeFileSync(path.join(dir, 'smoke.json'), JSON.stringify(out));
  console.log('smoke ready', JSON.stringify(out));
});
