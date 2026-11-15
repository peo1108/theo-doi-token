// Gọi một hàm của hub như một app (dùng token trong smoke.json): node hub-call.js <smoke.json> <hàm> [params JSON] [machine|hub]
// Dùng trong smoke test để gửi tin vào phiên khi app đang ở nền (không đăng nhập hub thật).
const fs = require('fs');
const [file, method, paramsJson = '{}', target] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
const ws = new WebSocket(cfg.hubURL.replace(/^http/, 'ws') + '/v1/ws');
const done = (code, msg) => { if (msg !== undefined) console.log(typeof msg === 'string' ? msg : JSON.stringify(msg)); try { ws.close(); } catch {} process.exit(code); };
setTimeout(() => done(2, 'quá thời gian'), 15000);
ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', proto: 1, role: 'app', token: cfg.hubToken, client: { name: 'smoke-tool', version: '0' } }));
ws.onmessage = (e) => {
  const m = JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString());
  if (m.type === 'welcome') ws.send(JSON.stringify({ type: 'req', id: 'r1', machine: target || cfg.machineId, method, params: JSON.parse(paramsJson) }));
  else if (m.type === 'res') done(m.ok ? 0 : 1, m.ok ? m.result : m.error);
  else if (m.type === 'error') done(1, m);
};
ws.onerror = () => done(2, 'lỗi kết nối');
