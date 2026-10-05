// PC nối ra CC Remote Hub (VPS): giữ một WebSocket tới hub, nhận lệnh từ app (req / sub / unsub) và gọi lõi remote.js.
// PC chỉ kết nối ra ngoài: không mở cổng, không cần Tailscale. Không thêm thư viện (WebSocket có sẵn trong Node ≥ 22).
const proto = require('./hub/proto.js');
const remote = require('./remote.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toWsUrl = (u) => String(u).replace(/\/+$/, '').replace(/^http/i, 'ws') + '/v1/ws';

// opts: { hubUrl, machineToken, hub (remote.createHub), onStatus?, backoff?: {min, max}, WebSocketImpl? }
function startLink({ hubUrl, machineToken, hub, onStatus = () => {}, backoff = { min: 1e3, max: 30e3 }, WebSocketImpl = globalThis.WebSocket, version = '' }) {
  let ws = null, stopped = false, attempt = 0, retryTimer = null;
  let st = { state: 'off', since: Date.now(), error: null };
  const subs = new Map();   // `${conn}:${session}` -> { s, client }
  const asm = new proto.Assembler();

  const setState = (state, error = null) => {
    if (st.state === state && st.error === error) return;
    st = { state, since: Date.now(), error };
    try { onStatus(st); } catch {}
  };
  const raw = (obj) => {
    if (!ws || ws.readyState !== 1) return false;
    const parts = proto.splitMessage(obj, obj.to ? { conn: obj.to } : obj.conn ? { conn: obj.conn } : {});
    if (parts) for (const p of parts) ws.send(p); else ws.send(JSON.stringify(obj));
    return true;
  };

  // ---------- người xem phiên qua hub (giống một kết nối SSE của đường cũ) ----------
  function unsubscribe(key) {
    const x = subs.get(key);
    if (!x) return;
    subs.delete(key);
    x.s.clients.delete(x.client);
    x.s.updatedAt = Math.max(x.s.updatedAt, Date.now() - 15 * 60e3);   // vừa có người xem -> chưa tắt ngay
    x.s.broadcastState();
  }
  function subscribe(conn, session, after, epoch) {
    const key = `${conn}:${session}`;
    unsubscribe(key);
    const s = UUID.test(session) && hub.get(session.toLowerCase());
    const ev = (data) => raw({ type: 'event', to: conn, session, data });
    if (!s) return ev({ kind: 'error', text: 'Không tìm thấy phiên' });
    const client = {
      send: ev,
      reset: () => { ev({ kind: 'reset', epoch: s.epoch }); for (const e of s.events) ev(e); ev({ kind: 'state', ...s.summary() }); },
    };
    if (epoch !== s.epoch) client.reset();
    else {
      for (const e of s.events) if (e.seq > after) ev(e);
      ev({ kind: 'state', ...s.summary() });
    }
    s.clients.add(client);
    subs.set(key, { s, client });
    s.broadcastState();
  }
  const dropSubs = () => { for (const k of [...subs.keys()]) unsubscribe(k); };

  // danh sách phiên / trạng thái đổi -> báo mọi app, gộp 2 giây (app sẽ gọi lại state, mà state quét thư mục lịch sử)
  let stateTimer = null;
  hub.onSessionState = () => {
    if (stateTimer) return;
    stateTimer = setTimeout(() => { stateTimer = null; raw({ type: 'event', scope: 'user', data: { kind: 'sessions' } }); }, 2000);
    stateTimer.unref?.();
  };

  async function onMessage(m) {
    if (m.type === 'welcome') { attempt = 0; return setState('online'); }
    if (m.type === 'error') return setState(st.state, m.message || m.code);
    if (m.type === 'req') {
      try { raw({ type: 'res', id: m.id, conn: m.conn, ok: true, result: await remote.call(hub, m.method, m.params) }); }
      catch (e) {
        const known = e instanceof remote.RemoteError;
        if (!known) console.error('hub-link:', e);
        raw({ type: 'res', id: m.id, conn: m.conn, ok: false, error: { code: known ? e.code : 'INTERNAL', message: known ? e.message : 'Lỗi trên máy' } });
      }
      return;
    }
    if (m.type === 'sub') return subscribe(String(m.conn || ''), String(m.session || ''), Number(m.after) || 0, String(m.epoch || ''));
    if (m.type === 'unsub') return unsubscribe(`${m.conn}:${m.session}`);
  }

  function connect() {
    if (stopped) return;
    setState('connecting', st.error);
    let s;
    try { s = new WebSocketImpl(toWsUrl(hubUrl)); } catch (e) { return retry(e.message); }
    ws = s;
    s.binaryType = 'arraybuffer';
    s.addEventListener('open', () => s.send(JSON.stringify({ type: 'hello', proto: proto.PROTO, role: 'agent', token: machineToken, client: { name: 'tracker', version } })));
    s.addEventListener('message', (e) => {
      let m;
      if (typeof e.data === 'string') { try { m = JSON.parse(e.data); } catch { return; } }
      else {
        try {
          const { header, payload } = proto.decodePart(Buffer.from(e.data));
          m = asm.push(header, payload);
          if (m && header.conn && !m.conn) m.conn = header.conn;   // hub gắn conn của app vào phần đầu mảnh
        } catch { return; }
        if (!m) return;
      }
      onMessage(m).catch((err) => console.error('hub-link:', err.message));
    });
    s.addEventListener('close', (e) => {
      if (ws === s) ws = null;
      dropSubs();
      if (stopped) return setState('off');
      if (e.code === 4001) return setState('revoked', 'Máy đã bị ngắt khỏi hub — ghép lại trên dashboard');
      if (e.code === 4002) return setState('upgrade', 'Hub yêu cầu cập nhật tracker');
      retry(e.code === 4003 ? 'Một tracker khác đang dùng cùng máy này' : null, e.code === 4003);
    });
    s.addEventListener('error', () => {});
  }

  function retry(error, slow = false) {
    if (stopped) return;
    setState('connecting', error || st.error);
    const base = slow ? backoff.max : Math.min(backoff.max, backoff.min * 2 ** attempt++);
    retryTimer = setTimeout(connect, base * (0.8 + Math.random() * 0.4));
    retryTimer.unref?.();
  }

  // thông báo của phiên (xin quyền, xong lượt...) đi qua hub khi đã nối; mỗi sự kiện là một thông báo riêng
  hub.notifyVia = (title, body, sid) => st.state === 'online'
    && raw({ type: 'notify', key: `s:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, level: 'info', title, body: body || '', session: sid || '' });

  const sweepTimer = setInterval(() => asm.sweep(), 30e3);
  sweepTimer.unref?.();
  connect();

  return {
    status: () => ({ ...st }),
    // thông báo do hub gửi (ntfy); trả false nếu chưa nối
    notify: (n) => raw({ type: 'notify', ...n }),
    online: () => st.state === 'online',
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(sweepTimer);
      clearTimeout(stateTimer);
      if (hub.onSessionState) hub.onSessionState = null;
      hub.notifyVia = null;
      dropSubs();
      try { ws && ws.close(); } catch {}
      setState('off');
    },
  };
}

module.exports = { startLink, toWsUrl };
