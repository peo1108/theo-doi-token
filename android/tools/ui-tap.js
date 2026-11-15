// Tìm một nút / dòng chữ trong bản dump của uiautomator và in toạ độ tâm: node ui-tap.js <dump.xml> <chữ> [thứ tự]
const fs = require('fs');
const [file, text, nth = '0'] = process.argv.slice(2);
const xml = fs.readFileSync(file, 'utf8');
const found = [];
for (const m of xml.matchAll(/<node [^>]*>/g)) {
  const n = m[0];
  const t = /\btext="([^"]*)"/.exec(n)?.[1] ?? '';
  const d = /\bcontent-desc="([^"]*)"/.exec(n)?.[1] ?? '';
  const b = /\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(n);
  if (!b) continue;
  if (t === text || d === text || (text.endsWith('*') && (t.startsWith(text.slice(0, -1)) || d.startsWith(text.slice(0, -1))))) {
    found.push([(+b[1] + +b[3]) >> 1, (+b[2] + +b[4]) >> 1]);
  }
}
const hit = found[Number(nth)];
if (!hit) { console.error(`không thấy "${text}" (${found.length} kết quả)`); process.exit(1); }
console.log(hit.join(' '));
