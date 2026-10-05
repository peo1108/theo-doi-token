// Vẽ icon 1024x1024 cho CC Remote (nền cam đất, dấu ">_" trắng) ra PNG, không cần thư viện ngoài.
//   node ios/tools/make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const N = 1024;
const px = Buffer.alloc(N * N * 4);
const mix = (a, b, t) => a + (b - a) * t;

// khoảng cách từ điểm tới đoạn thẳng
function segDist(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

const W = 56;   // nửa độ dày nét
const shapes = [
  [300, 330, 520, 512],   // nét trên của ">"
  [520, 512, 300, 694],   // nét dưới của ">"
  [590, 700, 760, 700],   // "_"
];

for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const t = (x + y) / (2 * N);
    let r = mix(222, 176, t), g = mix(125, 82, t), b = mix(92, 58, t);   // #DE7D5C -> #B0523A
    let d = Infinity;
    for (const s of shapes) d = Math.min(d, segDist(x, y, ...s));
    const a = Math.max(0, Math.min(1, W - d + 0.5));   // khử răng cưa 1px
    r = mix(r, 255, a); g = mix(g, 250, a); b = mix(b, 245, a);
    const i = (y * N + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // RGB 8-bit (icon iOS không được có alpha)
const raw = Buffer.alloc(N * (N * 3 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 3 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    const s = (y * N + x) * 4, d = y * (N * 3 + 1) + 1 + x * 3;
    raw[d] = px[s]; raw[d + 1] = px[s + 1]; raw[d + 2] = px[s + 2];
  }
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'CCRemote', 'Assets.xcassets', 'AppIcon.appiconset', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
