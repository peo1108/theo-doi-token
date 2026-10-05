// Thông báo của hub qua ntfy.sh: mỗi người dùng một topic ngẫu nhiên (128 bit, hub tự tạo).
// Chỉ đẩy khi người đó không có app nào đang mở; bỏ trùng theo key trong 24 giờ; tối đa 30 / giờ / người.
const DEDUPE_MS = 24 * 3600e3;
const RATE_MS = 3600e3, RATE_MAX = 30;

// Header HTTP chỉ nhận ASCII: tiêu đề có dấu mã hoá kiểu RFC 2047 (ntfy hiểu).
const b64h = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);

function createNotifier({ db, fetch = globalThis.fetch, now = Date.now, server = 'https://ntfy.sh' }) {
  const seen = new Map();   // `${userId}|${key}` -> lần gửi
  const sent = new Map();   // userId -> [thời điểm gửi trong 1 giờ qua]

  // n = {key, level, title, body, machine, session}; apps = kết nối app của người đó. Trả true nếu đã gửi.
  async function send(userId, n, apps = []) {
    const t = now();
    if (apps.some((a) => a.foreground)) return false;
    const k = `${userId}|${n.key || ''}`;
    if (n.key && seen.has(k) && t - seen.get(k) < DEDUPE_MS) return false;
    const recent = (sent.get(userId) || []).filter((x) => t - x < RATE_MS);
    if (recent.length >= RATE_MAX) return false;
    recent.push(t);
    sent.set(userId, recent);
    if (n.key) seen.set(k, t);
    if (seen.size > 5000) for (const [kk, v] of seen) if (t - v >= DEDUPE_MS) seen.delete(kk);
    const headers = { Title: b64h(String(n.title || 'CC Remote')), Tags: n.level === 'critical' ? 'warning' : 'robot' };
    if (n.machine && n.session) headers.Click = `ccremote://session/${n.machine}/${n.session}`;
    if (n.level === 'critical') headers.Priority = 'high';
    try {
      const r = await fetch(`${server}/${db.ntfyTopic(userId)}`, { method: 'POST', headers, body: String(n.body || ' '), signal: AbortSignal.timeout(10e3) });
      return !!(r && r.ok);
    } catch { return false; }
  }

  return { send };
}

module.exports = { createNotifier };
