const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const A = require('../accounts.js');
const { makeEnv, fakeAccount, writeLoginFiles } = require('./helpers.js');

// Hồ sơ dựng từ tài khoản giả (không qua file).
const profileOf = (acc, extra = {}) => ({
  v: 1, id: acc.id, name: acc.email.split('@')[0], email: acc.email, plan: 'max',
  oauth: acc.oauth, organizationUuid: acc.org, oauthAccount: acc.oauthAccount,
  usage: null, savedAt: 1000, ...extra,
});

// Chạy fn trong môi trường tạm, luôn dọn dẹp.
function withEnv(fn) {
  const env = makeEnv();
  try { return fn(env); } finally { env.cleanup(); }
}

const throwsCode = (fn, code) =>
  assert.throws(fn, (e) => e instanceof A.AccountError && e.code === code, `cần AccountError ${code}`);

const readText = (f) => fs.readFileSync(f, 'utf8');
const editJSON = (f, mut) => {
  const o = JSON.parse(readText(f));
  mut(o);
  fs.writeFileSync(f, JSON.stringify(o));
};

test('paths: đọc env mỗi lần gọi, có / không có CLAUDE_CONFIG_DIR', () => {
  withEnv(({ dir, dataDir }) => {
    const p = A.paths();
    assert.equal(p.claudeDir, dir);
    assert.equal(p.credFile, path.join(dir, '.credentials.json'));
    assert.equal(p.claudeJson, path.join(dir, '.claude.json'));
    assert.equal(p.profilesDir, path.join(dir, 'account-profiles'));
    assert.equal(p.backupDir, path.join(dir, 'account-profiles', 'backup'));
    assert.equal(p.lockFile, path.join(dir, 'account-profiles', '.lock'));
    assert.equal(p.logFile, path.join(dataDir, 'account-log.json'));
    const e2 = makeEnv();
    try { assert.equal(A.paths().claudeDir, e2.dir); } finally { e2.cleanup(); }
  });
  const saved = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    const home = require('os').homedir();
    const p = A.paths();
    assert.equal(p.claudeDir, path.join(home, '.claude'));
    assert.equal(p.credFile, path.join(home, '.claude', '.credentials.json'));
    assert.equal(p.claudeJson, path.join(home, '.claude.json'));
    assert.equal(p.profilesDir, path.join(home, '.claude', 'account-profiles'));
  } finally {
    if (saved !== undefined) process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test('readLogin: đọc file mẫu', () => {
  withEnv(({ dir }) => {
    writeLoginFiles(dir, fakeAccount(1));
    const l = A.readLogin();
    assert.equal(l.id, 'acc-1');
    assert.equal(l.org, 'org-1');
    assert.equal(l.cred.claudeAiOauth.accessToken, 'at-1');
    assert.equal(l.cfg.oauthAccount.emailAddress, 'user1@example.com');
  });
});

test('readLogin: không có file -> id null, cred rỗng', () => {
  withEnv(() => {
    const l = A.readLogin();
    assert.equal(l.id, null);
    assert.deepEqual(l.cred, {});
  });
});

test('readLogin: sau /logout (không có claudeAiOauth) -> id null', () => {
  withEnv(({ dir }) => {
    writeLoginFiles(dir, fakeAccount(1));
    editJSON(A.paths().credFile, (o) => { delete o.claudeAiOauth; });
    assert.equal(A.readLogin().id, null);
  });
});

test('readLogin: định dạng lạ -> FORMAT', () => {
  withEnv(({ dir }) => {
    const { credFile, claudeJson } = A.paths();
    // JSON hỏng
    writeLoginFiles(dir, fakeAccount(1));
    fs.writeFileSync(credFile, '{"claudeAiOauth":');
    throwsCode(() => A.readLogin(), 'FORMAT');
    // thiếu refreshToken
    writeLoginFiles(dir, fakeAccount(1));
    editJSON(credFile, (o) => { delete o.claudeAiOauth.refreshToken; });
    throwsCode(() => A.readLogin(), 'FORMAT');
    // accessToken không phải chuỗi
    writeLoginFiles(dir, fakeAccount(1));
    editJSON(credFile, (o) => { o.claudeAiOauth.accessToken = 5; });
    throwsCode(() => A.readLogin(), 'FORMAT');
    // thiếu accountUuid
    writeLoginFiles(dir, fakeAccount(1));
    editJSON(claudeJson, (o) => { delete o.oauthAccount.accountUuid; });
    throwsCode(() => A.readLogin(), 'FORMAT');
    // organizationUuid lệch
    writeLoginFiles(dir, fakeAccount(1));
    editJSON(claudeJson, (o) => { o.oauthAccount.organizationUuid = 'org-khac'; });
    throwsCode(() => A.readLogin(), 'FORMAT');
    // .claude.json hỏng
    writeLoginFiles(dir, fakeAccount(1));
    fs.writeFileSync(claudeJson, 'not json');
    throwsCode(() => A.readLogin(), 'FORMAT');
  });
});

test('profileFromLogin: giữ name, plan, usage đúng tài khoản', () => {
  withEnv(({ dir }) => {
    const acc = fakeAccount(1);
    writeLoginFiles(dir, acc, { usage: true });
    const login = A.readLogin();
    const p = A.profileFromLogin(login, null, 5000);
    assert.equal(p.v, 1);
    assert.equal(p.id, 'acc-1');
    assert.equal(p.name, 'user1');
    assert.equal(p.email, 'user1@example.com');
    assert.equal(p.plan, 'max');
    assert.equal(p.organizationUuid, 'org-1');
    assert.equal(p.savedAt, 5000);
    assert.equal(p.usage.accountUuid, 'acc-1');
    assert.equal(p.oauth.refreshToken, 'rt-1');

    const old = { ...p, name: 'cam', usage: { accountUuid: 'acc-1', old: true } };
    // usage trong file thuộc tài khoản khác -> giữ usage cũ
    writeLoginFiles(dir, acc, { usage: { accountUuid: 'acc-9' } });
    const p2 = A.profileFromLogin(A.readLogin(), old, 6000);
    assert.equal(p2.name, 'cam');
    assert.deepEqual(p2.usage, old.usage);
    // không có usage trong file, không có existing -> null
    writeLoginFiles(dir, acc);
    assert.equal(A.profileFromLogin(A.readLogin(), null, 1).usage, null);
  });
});

test('profileFromLogin: chưa đăng nhập -> NO_TOKEN', () => {
  withEnv(() => throwsCode(() => A.profileFromLogin(A.readLogin(), null, 1), 'NO_TOKEN'));
});

test('hồ sơ: save / load / list / delete', () => {
  withEnv(() => {
    assert.deepEqual(A.listProfiles(), []);
    assert.equal(A.loadProfile('acc-1'), null);
    A.saveProfile(profileOf(fakeAccount(2), { name: 'zeta' }));
    A.saveProfile(profileOf(fakeAccount(1), { name: 'alpha' }));
    assert.equal(A.loadProfile('acc-1').oauth.refreshToken, 'rt-1');
    assert.deepEqual(A.listProfiles().map((p) => p.name), ['alpha', 'zeta']);
    // file hỏng -> mục lỗi, không làm hỏng danh sách
    fs.writeFileSync(path.join(A.paths().profilesDir, 'bad.json'), '{oops');
    const list = A.listProfiles();
    assert.equal(list.length, 3);
    assert.deepEqual(list.find((p) => p.error), { id: 'bad', error: 'FORMAT' });
    A.deleteProfile('acc-1');
    assert.equal(A.loadProfile('acc-1'), null);
    A.deleteProfile('acc-1'); // xoá lần nữa không lỗi
    // id lạ không được thoát khỏi thư mục hồ sơ
    throwsCode(() => A.saveProfile(profileOf(fakeAccount(3), { id: '../evil' })), 'FORMAT');
    assert.equal(A.loadProfile('../evil'), null);
  });
});

test('writeLogin: chỉ thay trường đăng nhập, giữ phần còn lại và định dạng', () => {
  withEnv(({ dir }) => {
    writeLoginFiles(dir, fakeAccount(1), { usage: true });
    const before = A.readLogin();
    A.writeLogin(profileOf(fakeAccount(2)));
    const after = A.readLogin();
    assert.equal(after.id, 'acc-2');
    assert.equal(after.org, 'org-2');
    assert.equal(after.cred.claudeAiOauth.refreshToken, 'rt-2');
    assert.deepEqual(after.cred.mcpOAuth, before.cred.mcpOAuth);
    assert.deepEqual(after.cfg.projects, { p: 1 });
    assert.equal(after.cfg.numStartups, 7);
    assert.deepEqual(after.cfg.cachedUsageUtilization, before.cfg.cachedUsageUtilization);
    const { credFile, claudeJson } = A.paths();
    assert.ok(!readText(credFile).includes('\n'));
    assert.ok(readText(claudeJson).startsWith('{\n  "'));
    // không để lại file tạm
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  });
});

test('writeLogin: đọc lại file ngay trước khi ghi (giữ khoá lạ mới thêm)', () => {
  withEnv(({ dir }) => {
    writeLoginFiles(dir, fakeAccount(1));
    A.readLogin(); // người gọi đã đọc trước đó...
    editJSON(A.paths().credFile, (o) => { o.newKey = 'moi'; }); // ...rồi Claude Code ghi thêm khoá
    A.writeLogin(profileOf(fakeAccount(2)));
    assert.equal(A.readLogin().cred.newKey, 'moi');
  });
});

test('writeLogin: định dạng lạ -> FORMAT và không ghi gì', () => {
  withEnv(({ dir }) => {
    writeLoginFiles(dir, fakeAccount(1));
    fs.writeFileSync(A.paths().claudeJson, 'hỏng');
    const before = readText(A.paths().credFile);
    throwsCode(() => A.writeLogin(profileOf(fakeAccount(2))), 'FORMAT');
    assert.equal(readText(A.paths().credFile), before);
  });
});

test('writeLogin: ghi được khi đang đăng xuất', () => {
  withEnv(({ dir }) => {
    writeLoginFiles(dir, fakeAccount(1));
    editJSON(A.paths().credFile, (o) => { delete o.claudeAiOauth; delete o.organizationUuid; });
    A.writeLogin(profileOf(fakeAccount(2)));
    assert.equal(A.readLogin().id, 'acc-2');
  });
});

test('backup: giữ 5 cặp gần nhất; restore trả lại nội dung cũ', () => {
  withEnv(({ dir }) => {
    writeLoginFiles(dir, fakeAccount(1));
    const { credFile, claudeJson, backupDir } = A.paths();
    const origCred = readText(credFile);
    const origCfg = readText(claudeJson);
    const prefix = A.backup(1000);
    for (let i = 2; i <= 7; i++) A.backup(1000 * i);
    assert.equal(fs.readdirSync(backupDir).length, 10);
    assert.ok(!fs.existsSync(`${prefix}-credentials.json`), 'cặp cũ nhất đã bị xoá');
    // backup 7000 là cặp mới nhất, nội dung = hiện tại
    const p7 = path.join(backupDir, '7000');
    assert.equal(readText(`${p7}-credentials.json`), origCred);
    // đổi sang acc2 rồi khôi phục
    A.writeLogin(profileOf(fakeAccount(2)));
    assert.equal(A.readLogin().id, 'acc-2');
    A.restore(p7);
    assert.equal(readText(credFile), origCred);
    assert.equal(readText(claudeJson), origCfg);
    assert.equal(A.readLogin().id, 'acc-1');
    throwsCode(() => A.restore(path.join(backupDir, 'khong-co')), 'NOT_FOUND');
  });
});

test('backup: sắp xếp theo số, không theo chuỗi (999 < 1000)', () => {
  withEnv(({ dir }) => {
    writeLoginFiles(dir, fakeAccount(1));
    for (const t of [999, 1000, 1001, 1002, 1003, 1004]) A.backup(t);
    const names = fs.readdirSync(A.paths().backupDir);
    assert.ok(!names.some((n) => n.startsWith('999-')));
    assert.equal(names.length, 10);
  });
});

test('withLock: lồng nhau -> LOCKED, luôn thả khoá', () => {
  withEnv(() => {
    const out = A.withLock(() => {
      assert.equal(A.isLocked(), true);
      throwsCode(() => A.withLock(() => 1), 'LOCKED');
      return 'xong';
    });
    assert.equal(out, 'xong');
    assert.equal(A.isLocked(), false);
    assert.ok(!fs.existsSync(A.paths().lockFile));
    // fn ném lỗi vẫn thả khoá
    assert.throws(() => A.withLock(() => { throw new Error('boom'); }), /boom/);
    assert.equal(A.isLocked(), false);
  });
});

test('withLock: khoá hết hạn (quá 30 giây hoặc PID chết) bị bỏ qua', () => {
  withEnv(() => {
    const { lockFile, profilesDir } = A.paths();
    fs.mkdirSync(profilesDir, { recursive: true });
    const now = 1e12;
    // còn hiệu lực
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, t: now - 5000 }));
    assert.equal(A.isLocked(now), true);
    throwsCode(() => A.withLock(() => 1, now), 'LOCKED');
    // quá 30 giây
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, t: now - 31000 }));
    assert.equal(A.isLocked(now), false);
    assert.equal(A.withLock(() => 'a', now), 'a');
    // PID không còn sống
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, t: now }));
    assert.equal(A.isLocked(now), false);
    assert.equal(A.withLock(() => 'b', now), 'b');
    // file khoá hỏng
    fs.writeFileSync(lockFile, 'rác');
    assert.equal(A.isLocked(now), false);
    assert.equal(A.withLock(() => 'c', now), 'c');
  });
});

test('resolve: id > tên > email > tiền tố duy nhất', () => {
  const ps = [{ id: 'i1', name: 'cam', email: 'a@x.com' }, { id: 'i2', name: 'cam2', email: 'b@x.com' },
    { id: 'i3', name: 'work', email: 'w@y.com' }, { id: 'bad', error: 'FORMAT' }];
  assert.equal(A.resolve('cam', ps).id, 'i1');
  assert.equal(A.resolve('CAM2', ps).id, 'i2');
  assert.equal(A.resolve('wo', ps).id, 'i3');
  assert.equal(A.resolve('i2', ps).id, 'i2');
  assert.equal(A.resolve('B@X.com', ps).id, 'i2');
  assert.equal(A.resolve('w@', ps).id, 'i3');
  throwsCode(() => A.resolve('ca', ps), 'AMBIGUOUS');
  throwsCode(() => A.resolve('zzz', ps), 'NOT_FOUND');
  throwsCode(() => A.resolve('', ps), 'NOT_FOUND');
  throwsCode(() => A.resolve('bad', ps), 'NOT_FOUND');
});

test('uniqueName', () => {
  assert.equal(A.uniqueName('cam', []), 'cam');
  assert.equal(A.uniqueName('cam', [{ name: 'cam' }]), 'cam2');
  assert.equal(A.uniqueName('cam', [{ name: 'cam' }, { name: 'cam2' }]), 'cam3');
  assert.equal(A.uniqueName('cam', [{ name: 'CAM' }, { id: 'x', error: 'FORMAT' }]), 'cam2');
});

test('publicView: không lộ token', () => {
  const acc = fakeAccount(1);
  const p = profileOf(acc, { usage: { accountUuid: 'acc-1' } });
  const v = A.publicView(p);
  const s = JSON.stringify(v);
  assert.ok(!s.includes('at-1') && !s.includes('rt-1'));
  assert.deepEqual(v, {
    id: 'acc-1', name: 'user1', email: 'user1@example.com', plan: 'max',
    usage: { accountUuid: 'acc-1' }, loginExpiresAt: acc.oauth.refreshTokenExpiresAt, savedAt: 1000,
  });
  assert.equal(A.publicView({ ...p, oauth: null }).loginExpiresAt, null);
  assert.equal(A.publicView({ id: 'bad', error: 'FORMAT' }).error, 'FORMAT');
});
