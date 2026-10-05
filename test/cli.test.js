const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const A = require('../accounts.js');
const { makeEnv, fakeAccount, writeLoginFiles } = require('./helpers.js');

const ROOT = path.join(__dirname, '..');

// Hai hồ sơ user1/user2; file đăng nhập là acc-1 và acc-1 đang được chọn.
function setup(dir) {
  const a1 = fakeAccount(1);
  const a2 = fakeAccount(2);
  writeLoginFiles(dir, a1, { usage: true });
  for (const a of [a1, a2]) {
    A.saveProfile({
      v: 1, id: a.id, name: a.email.split('@')[0], email: a.email, plan: 'max',
      oauth: a.oauth, organizationUuid: a.org, oauthAccount: a.oauthAccount, usage: null, savedAt: 1000,
    });
  }
  const log = A.readLog();
  A.addEntry(log, { t: 100, id: 'acc-1', reason: 'init' });
  A.writeLog(log);
}

function withCli(fn) {
  const env = makeEnv();
  const run = (...args) => {
    const r = spawnSync(process.execPath, ['accounts.js', ...args], {
      cwd: ROOT, encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: env.dir, TT_DATA_DIR: env.dataDir, TT_SKIP_PROCESS_CHECK: '1' },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  try { return fn({ ...env, run }); } finally { env.cleanup(); }
}

const fileId = () => JSON.parse(fs.readFileSync(A.paths().claudeJson, 'utf8')).oauthAccount.accountUuid;

test('không tham số: bảng có user1, user2 và đúng một dòng bắt đầu bằng *', () => {
  withCli(({ dir, run }) => {
    setup(dir);
    const r = run();
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /user1/);
    assert.match(r.out, /user2/);
    const stars = r.out.split(/\r?\n/).filter((l) => l.startsWith('*'));
    assert.equal(stars.length, 1);
    assert.match(stars[0], /user1/);
    assert.match(stars[0], /5h 12%/);
    assert.match(stars[0], /tuần 34%/);
  });
});

test('không tham số, chưa có hồ sơ: in hướng dẫn /login', () => {
  withCli(({ run }) => {
    const r = run();
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Chưa có tài khoản nào/);
  });
});

test('cc-switch <query>: đổi tài khoản, exit 0, in tên và email', () => {
  withCli(({ dir, run }) => {
    setup(dir);
    const r = run('user2');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Đã đổi sang user2 \(user2@example\.com\)/);
    assert.equal(fileId(), 'acc-2');
    assert.equal(A.chosenId(A.readLog()), 'acc-2');
  });
});

test('query mơ hồ hoặc không có -> exit 2, lỗi tiếng Việt trên stderr', () => {
  withCli(({ dir, run }) => {
    setup(dir);
    const amb = run('user');
    assert.equal(amb.code, 2);
    assert.match(amb.err, /\S/);
    const nf = run('zzz');
    assert.equal(nf.code, 2);
    assert.match(nf.err, /Không tìm thấy/);
    assert.equal(fileId(), 'acc-1');
  });
});

test('rename rồi dùng tên mới; tên trùng -> exit 1', () => {
  withCli(({ dir, run }) => {
    setup(dir);
    const r = run('rename', 'user2', 'work');
    assert.equal(r.code, 0, r.err);
    assert.equal(A.resolve('work', A.listProfiles()).id, 'acc-2');
    const dup = run('rename', 'work', 'user1');
    assert.equal(dup.code, 1);
    assert.match(dup.err, /\S/);
    assert.equal(run('rename', 'work').code, 1);   // thiếu tên mới
    assert.equal(run('rename', 'zzz', 'x').code, 2);
  });
});

test('remove: đang chọn -> exit 1 và còn hồ sơ; hồ sơ khác -> xoá', () => {
  withCli(({ dir, run }) => {
    setup(dir);
    const act = run('remove', 'user1');
    assert.equal(act.code, 1);
    assert.match(act.err, /\S/);
    assert.notEqual(A.loadProfile('acc-1'), null);
    const r = run('remove', 'user2');
    assert.equal(r.code, 0, r.err);
    assert.equal(A.loadProfile('acc-2'), null);
    assert.equal(run('remove').code, 1);   // thiếu tham số
  });
});

test('keep: không có conflict -> exit 2; có conflict -> exit 0', () => {
  withCli(({ dir, run }) => {
    setup(dir);
    assert.equal(run('keep').code, 2);
    const log = A.readLog();
    A.addEntry(log, { t: 200, id: 'acc-2', reason: 'switch' });
    log.conflict = { fileId: 'acc-1', chosenId: 'acc-2', since: 150 };
    A.writeLog(log);
    const r = run('keep');
    assert.equal(r.code, 0, r.err);
    assert.equal(A.chosenId(A.readLog()), 'acc-1');
  });
});

test('-h / --help: in cách dùng, exit 0', () => {
  withCli(({ run }) => {
    for (const f of ['-h', '--help']) {
      const r = run(f);
      assert.equal(r.code, 0);
      assert.match(r.out, /cc-switch/);
    }
  });
});

test('cc-switch.cmd đúng nội dung', () => {
  const t = fs.readFileSync(path.join(ROOT, 'cc-switch.cmd'), 'utf8');
  assert.equal(t.replace(/\r?\n$/, ''), '@node "%~dp0accounts.js" %*');
});
