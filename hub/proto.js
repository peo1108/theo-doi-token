// Giao thức CC Remote Hub: hằng số và khung "part" cho tin lớn. Dùng chung cho hub, hub-link.js (PC) và test.
// Khung part (WebSocket nhị phân): [4 byte độ dài phần đầu, big-endian][phần đầu JSON][dữ liệu].
const crypto = require('crypto');

const PROTO = 1;
const CHUNK = 256 * 1024;            // tin JSON lớn hơn mức này thì chia, mỗi mảnh tối đa CHUNK byte dữ liệu
const MAX_FRAME = 1024 * 1024;       // khung WebSocket tối đa
const MAX_MSG = 50 * 1024 * 1024;    // một tin (sau khi ghép) tối đa
const MAX_PENDING = 4;               // số tin lớn đang truyền dở trên một kết nối
const PART_IDLE_MS = 60e3;           // tin dở im lâu hơn thì bỏ

const protoError = (code, message) => Object.assign(new Error(message), { code });

function encodePart(header, payload) {
  const h = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(h.length);
  return Buffer.concat([len, h, payload]);
}

function decodePart(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) throw protoError('BAD_PART', 'Mảnh hỏng');
  const n = buf.readUInt32BE(0);
  if (n > 4096 || 4 + n > buf.length) throw protoError('BAD_PART', 'Mảnh hỏng');
  let header;
  try { header = JSON.parse(buf.subarray(4, 4 + n).toString('utf8')); } catch { throw protoError('BAD_PART', 'Mảnh hỏng'); }
  if (!header || header.type !== 'part' || typeof header.pid !== 'string' || !Number.isInteger(header.idx)) {
    throw protoError('BAD_PART', 'Mảnh hỏng');
  }
  return { header, payload: buf.subarray(4 + n) };
}

// Tin lớn -> danh sách khung part; tin nhỏ -> null (gửi như khung chữ bình thường).
// `extra` (machine / to / conn...) được chép vào phần đầu của mọi mảnh để hub định tuyến không cần ghép.
function splitMessage(obj, extra = {}) {
  const data = Buffer.from(JSON.stringify(obj));
  if (data.length <= CHUNK) return null;
  if (data.length > MAX_MSG) throw protoError('TOO_LARGE', 'Tin nhắn quá lớn (tối đa 50 MB)');
  const pid = crypto.randomBytes(8).toString('hex');
  const out = [];
  for (let i = 0, idx = 0; i < data.length; i += CHUNK, idx++) {
    const last = i + CHUNK >= data.length;
    out.push(encodePart({ type: 'part', pid, idx, last, ...extra }, data.subarray(i, i + CHUNK)));
  }
  return out;
}

// Ghép mảnh theo pid; trả tin đã parse khi nhận mảnh cuối, null khi chưa đủ.
class Assembler {
  constructor() { this.m = new Map(); }

  push(header, payload, now = Date.now()) {
    const { pid, idx, last } = header;
    let p = this.m.get(pid);
    if (!p) {
      if (idx !== 0) throw protoError('BAD_PART', 'Thiếu mảnh đầu');
      if (this.m.size >= MAX_PENDING) throw protoError('TOO_MANY', 'Quá nhiều tin lớn đang gửi cùng lúc');
      p = { next: 0, size: 0, chunks: [], at: now };
      this.m.set(pid, p);
    }
    if (idx !== p.next) { this.m.delete(pid); throw protoError('BAD_PART', 'Thiếu mảnh'); }
    p.size += payload.length;
    if (p.size > MAX_MSG) { this.m.delete(pid); throw protoError('TOO_LARGE', 'Tin nhắn quá lớn (tối đa 50 MB)'); }
    p.chunks.push(Buffer.from(payload));
    p.next++;
    p.at = now;
    if (!last) return null;
    this.m.delete(pid);
    try { return JSON.parse(Buffer.concat(p.chunks).toString('utf8')); } catch { throw protoError('BAD_PART', 'Tin ghép lại bị hỏng'); }
  }

  sweep(now = Date.now()) {
    for (const [pid, p] of this.m) if (now - p.at > PART_IDLE_MS) this.m.delete(pid);
  }
}

module.exports = {
  PROTO, CHUNK, MAX_FRAME, MAX_MSG, MAX_PENDING, PART_IDLE_MS,
  protoError, encodePart, decodePart, splitMessage, Assembler,
};
