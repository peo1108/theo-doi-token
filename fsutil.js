// Ghi file atomic dùng chung (accounts.js, remote.js): file tạm cùng thư mục rồi đổi tên -> tắt máy / lỗi giữa chừng
// không để lại file cụt mang tên thật. Windows hay báo EPERM / EBUSY / EACCES khi Defender / trình lập chỉ mục đang mở
// file vừa ghi -> thử lại vài lần. Hỏng hẳn thì xoá file tạm rồi ném lỗi gốc, không bao giờ ghi thẳng vào tên thật.

const fs = require('fs');
const path = require('path');

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
let tmpSeq = 0;
const tmpName = (file) => `${file}.${process.pid}.${++tmpSeq}.tmp`;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chờ bằng sleepSync (chặn luồng): chỉ dùng cho file nhỏ, ít ghi (hồ sơ tài khoản, lệnh cc-switch).
function writeAtomicSync(file, data, { mode, retries = 5, retryMs = 100 } = {}) {
  const tmp = tmpName(file);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, data, mode == null ? undefined : { mode });
    for (let i = 0; ; i++) {
      try { return fs.renameSync(tmp, file); } catch (e) {
        if (!RETRY_CODES.has(e.code) || i >= retries) throw e;
        sleepSync(retryMs);
      }
    }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// Xoá file tạm; bị khoá thì thử lại bằng setTimeout. Vẫn không được thì bỏ (người gọi tự dọn file .tmp sót sau).
async function removeTmp(tmp, retries, retryMs) {
  for (let i = 0; ; i++) {
    try { return fs.rmSync(tmp, { force: true }); } catch (e) {
      if (!RETRY_CODES.has(e.code) || i >= retries) return;
    }
    await sleep(retryMs * (i + 1));
  }
}

// Không chặn event loop (tracker: hook, hub, tail vẫn chạy): ghi file tạm và đổi tên lần đầu ngay -> thường xong luôn,
// trả null; lỗi ghi thì ném ngay. Đổi tên bị khoá -> trả Promise thử lại bằng setTimeout (reject nếu hỏng hẳn).
function writeAtomic(file, data, { retries = 4, retryMs = 25 } = {}) {
  const tmp = tmpName(file);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, data);
  } catch (e) {
    removeTmp(tmp, retries, retryMs);
    throw e;
  }
  try { fs.renameSync(tmp, file); return null; } catch (e) {
    if (!RETRY_CODES.has(e.code)) { removeTmp(tmp, retries, retryMs); throw e; }
  }
  return (async () => {
    for (let i = 1; ; i++) {
      await sleep(retryMs * i);
      try { return fs.renameSync(tmp, file); } catch (e) {
        if (!RETRY_CODES.has(e.code) || i >= retries) { await removeTmp(tmp, retries, retryMs); throw e; }
      }
    }
  })();
}

module.exports = { sleepSync, writeAtomicSync, writeAtomic };
