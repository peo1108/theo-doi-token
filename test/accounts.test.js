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

test('backup: ghi nhận file vắng, restore xoá lại file mới sinh ra', () => {
  withEnv(({ dir }) => {
    const { credFile, claudeJson } = A.paths();
    // chỉ có .claude.json, chưa có .credentials.json
    writeLoginFiles(dir, fakeAccount(1));
    fs.unlinkSync(credFile);
    const origCfg = readText(claudeJson);
    const prefix = A.backup(1000);
    A.writeLogin(profileOf(fakeAccount(2)));
    assert.ok(fs.existsSync(credFile));
    A.restore(prefix);
    assert.ok(!fs.existsSync(credFile), 'credentials phải vắng lại');
    assert.equal(readText(claudeJson), origCfg);
    // cả hai vắng
    fs.unlinkSync(claudeJson);
    const p2 = A.backup(2000);
    writeLoginFiles(dir, fakeAccount(2));
    A.restore(p2);
    assert.ok(!fs.existsSync(credFile) && !fs.existsSync(claudeJson));
    // cùng mốc thời gian, lần sau file đã có -> dấu vắng cũ không được làm restore xoá file
    writeLoginFiles(dir, fakeAccount(1));
    const keep = readText(credFile);
    const p3 = A.backup(2000);
    fs.writeFileSync(credFile, '{}');
    A.restore(p3);
    assert.equal(readText(credFile), keep);
  });
});

test('backup: không bao giờ xoá cặp vừa ghi dù mốc cũ hơn 5 cặp mới nhất', () => {
  withEnv(({ dir }) => {
    writeLoginFiles(dir, fakeAccount(1));
    for (const t of [4000, 5000, 6000, 7000, 8000, 9000]) A.backup(t);
    const prefix = A.backup(10);
    assert.ok(fs.existsSync(`${prefix}-credentials.json`));
    assert.ok(fs.existsSync(`${prefix}-claude.json`));
    A.restore(prefix); // dùng được
    // cặp cũ hơn khác vẫn bị dọn
    const names = fs.readdirSync(A.paths().backupDir);
    assert.ok(!names.some((n) => n.startsWith('4000-')));
    assert.ok(names.some((n) => n.startsWith('5000-')));
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
  });
});

test('withLock: file khoá chưa đọc được (rỗng/hỏng) còn hiệu lực cho tới khi mtime quá 30 giây', () => {
  withEnv(() => {
    const { lockFile, profilesDir } = A.paths();
    fs.mkdirSync(profilesDir, { recursive: true });
    for (const content of ['', 'rác']) {
      // mtime mới: tiến trình khác vừa tạo file, chưa kịp ghi nội dung -> không được tranh khoá
      fs.writeFileSync(lockFile, content);
      assert.equal(A.isLocked(), true);
      throwsCode(() => A.withLock(() => 1), 'LOCKED');
      assert.ok(fs.existsSync(lockFile), 'không được xoá khoá đang hiệu lực');
      assert.equal(fs.readFileSync(lockFile, 'utf8'), content);
      // mtime cũ hơn 30 giây -> mồ côi
      const old = new Date(Date.now() - 31000);
      fs.utimesSync(lockFile, old, old);
      assert.equal(A.isLocked(), false);
      assert.equal(A.withLock(() => 'c'), 'c');
    }
  });
});

test('withLock: dọn khoá cũ không để lại file .stale và không xoá nhầm khoá mới', () => {
  withEnv(() => {
    const { lockFile, profilesDir } = A.paths();
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, t: Date.now() }));
    assert.equal(A.withLock(() => 'x'), 'x');
    assert.deepEqual(fs.readdirSync(profilesDir).filter((f) => f.includes('.stale')), []);
    // khoá còn hiệu lực bị "bắt nhầm" bên trong lúc dọn phải được trả lại nguyên vẹn
    const live = JSON.stringify({ pid: process.pid, t: Date.now() });
    fs.writeFileSync(lockFile, live);
    throwsCode(() => A.withLock(() => 1), 'LOCKED');
    assert.equal(fs.readFileSync(lockFile, 'utf8'), live);
    assert.deepEqual(fs.readdirSync(profilesDir).filter((f) => f.includes('.stale')), []);
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

// ---------- dòng thời gian ----------

test('readLog: không có file -> rỗng; writeLog rồi readLog khứ hồi', () => {
  withEnv(() => {
    assert.deepEqual(A.readLog(), { v: 1, entries: [], conflict: null });
    const log = A.readLog();
    A.addEntry(log, { t: 1, id: 'acc-1', reason: 'init' });
    log.conflict = { fileId: 'acc-2', chosenId: 'acc-1', since: 5 };
    A.writeLog(log);
    assert.deepEqual(A.readLog(), log);
  });
});

test('addEntry: chèn giữ thứ tự tăng theo t; chosenId là mục cuối', () => {
  const log = { v: 1, entries: [{ t: 0, id: 'a' }, { t: 10, id: 'c' }], conflict: null };
  A.addEntry(log, { t: 5, id: 'b' });
  assert.deepEqual(log.entries.map((e) => e.t), [0, 5, 10]);
  assert.equal(A.chosenId(log), 'c');
  A.addEntry(log, { t: 10, id: 'd' });   // trùng t: mục mới đứng sau
  assert.deepEqual(log.entries.map((e) => e.id), ['a', 'b', 'c', 'd']);
  assert.equal(A.chosenId({ v: 1, entries: [], conflict: null }), null);
});

// ---------- nhận diện tiến trình Claude Code ----------

const VSCODE_EXE = 'c:\\Users\\cam\\.vscode\\extensions\\anthropic.claude-code-2.1.289-win32-x64\\resources\\native-binary\\claude.exe';
const DESKTOP_EXE = 'C:\\Program Files\\WindowsApps\\Claude_2.19675.0.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe';

test('isClaudeCodeProcess: Claude Code có, ứng dụng Claude desktop và tiến trình khác không', () => {
  assert.equal(A.isClaudeCodeProcess({ name: 'claude.exe', path: VSCODE_EXE }), true);
  assert.equal(A.isClaudeCodeProcess({ name: 'claude.exe', path: VSCODE_EXE, cmd: `${VSCODE_EXE} --output-format stream-json --verbose` }), true);
  assert.equal(A.isClaudeCodeProcess({ name: 'node.exe', cmd: 'node C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js' }), true);
  assert.equal(A.isClaudeCodeProcess({ name: 'claude.exe', path: 'C:\\Users\\cam\\.local\\bin\\claude.exe' }), true);
  // không phân biệt hoa thường; ExecutablePath rỗng thì dựa vào CommandLine
  assert.equal(A.isClaudeCodeProcess({ name: 'CLAUDE.EXE', path: null, cmd: `"${VSCODE_EXE}" --resume` }), true);
  assert.equal(A.isClaudeCodeProcess({ name: 'claude', cmd: 'claude --continue' }), true);
  // ứng dụng desktop: tiến trình chính và các tiến trình con Electron
  assert.equal(A.isClaudeCodeProcess({ name: 'Claude.exe', path: DESKTOP_EXE }), false);
  assert.equal(A.isClaudeCodeProcess({ name: 'Claude.exe', path: DESKTOP_EXE, cmd: `"${DESKTOP_EXE}"` }), false);
  assert.equal(A.isClaudeCodeProcess({ name: 'Claude.exe', path: DESKTOP_EXE, cmd: `"${DESKTOP_EXE}" --type=renderer --lang=en-US` }), false);
  assert.equal(A.isClaudeCodeProcess({ name: 'Claude.exe', path: null, cmd: `"${DESKTOP_EXE}" --type=gpu-process` }), false);
  assert.equal(A.isClaudeCodeProcess({ name: 'Claude.exe', path: null, cmd: `"${DESKTOP_EXE}"` }), false);
  // tiến trình khác
  assert.equal(A.isClaudeCodeProcess({ name: 'node.exe', cmd: 'node tracker.js serve' }), false);
  assert.equal(A.isClaudeCodeProcess({ name: 'powershell.exe', cmd: 'powershell -Command echo @anthropic-ai/claude-code' }), false);
  assert.equal(A.isClaudeCodeProcess({ name: 'chrome.exe', path: 'C:\\x\\chrome.exe' }), false);
  assert.equal(A.isClaudeCodeProcess({}), false);
});

test('parseWindowsProcesses: một object (không phải mảng), mảng, loại PID của chính mình và tiến trình khác', () => {
  const one = { ProcessId: 10, Name: 'claude.exe', ExecutablePath: VSCODE_EXE, CommandLine: `${VSCODE_EXE} --output-format stream-json` };
  // Get-CimInstance trả một object khi chỉ có một kết quả
  assert.deepEqual(A.parseWindowsProcesses(JSON.stringify(one), 1), [{ pid: 10, cmd: one.CommandLine }]);
  const many = [
    one,
    { ProcessId: 11, Name: 'Claude.exe', ExecutablePath: DESKTOP_EXE, CommandLine: null },
    { ProcessId: 12, Name: 'claude.exe', ExecutablePath: null, CommandLine: `"${VSCODE_EXE}" -p x` },   // ExecutablePath null
    { ProcessId: 13, Name: 'claude.exe', ExecutablePath: VSCODE_EXE, CommandLine: null },
    { ProcessId: 14, Name: 'node.exe', ExecutablePath: 'C:\\node.exe', CommandLine: 'node tracker.js serve' },
  ];
  assert.deepEqual(A.parseWindowsProcesses(JSON.stringify(many), 13).map((p) => p.pid), [10, 12]);
  assert.deepEqual(A.parseWindowsProcesses('', 1), []);
  assert.throws(() => A.parseWindowsProcesses('không phải json', 1));
});

test('parsePsProcesses: lọc dòng ps -eo pid,args', () => {
  const text = [
    '  PID COMMAND',
    '  101 /home/u/.local/bin/claude --continue',
    '  102 node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    '  103 /Applications/Claude.app/Contents/MacOS/Claude',
    '  104 node tracker.js serve',
    '  105 claude',
  ].join('\n');
  assert.deepEqual(A.parsePsProcesses(text, 105).map((p) => p.pid), [101, 102]);
});

test('findClaudeProcesses: trả { ok, list } và không bao giờ ném', () => {
  const r = A.findClaudeProcesses();
  assert.equal(typeof r.ok, 'boolean');
  assert.ok(Array.isArray(r.list));
  assert.ok(r.list.every((p) => typeof p.pid === 'number' && p.pid !== process.pid));
});

// ---------- snapshot ----------

test('snapshot: lưu hồ sơ của tài khoản trong file; không đăng nhập -> null', () => {
  withEnv(({ dir }) => {
    assert.equal(A.snapshot(A.readLogin(), 5), null);
    writeLoginFiles(dir, fakeAccount(1), { usage: true });
    const p = A.snapshot(A.readLogin(), 7);
    assert.equal(p.id, 'acc-1');
    assert.equal(p.savedAt, 7);
    assert.deepEqual(A.loadProfile('acc-1'), p);
    assert.equal(p.usage.accountUuid, 'acc-1');
    assert.deepEqual(A.listProfiles().map((x) => x.id), ['acc-1']);
  });
});

// ---------- switchTo ----------

const noProcs = () => ({ ok: true, list: [] });
const filesText = () => [readText(A.paths().credFile), readText(A.paths().claudeJson)];
const backupCount = () => {
  try { return fs.readdirSync(A.paths().backupDir).filter((n) => n.endsWith('.json')).length; } catch { return 0; }
};

// acc1 đang đăng nhập (token mới rt-1), hồ sơ acc1 cũ (rt-old) và hồ sơ acc2.
function setupTwo(dir) {
  const a1 = fakeAccount(1);
  const a2 = fakeAccount(2);
  writeLoginFiles(dir, a1);
  A.saveProfile(profileOf(a1, { oauth: { ...a1.oauth, refreshToken: 'rt-old' } }));
  A.saveProfile(profileOf(a2));
  const log = A.readLog();
  A.addEntry(log, { t: 100, id: 'acc-1', reason: 'init' });
  A.writeLog(log);
  return { a1, a2 };
}

test('switchTo: lưu token mới của tài khoản cũ, ghi tài khoản đích, thêm log, một cặp sao lưu', () => {
  withEnv(({ dir }) => {
    setupTwo(dir);
    const r = A.switchTo('user2', { now: 5000, processes: () => ({ ok: true, list: [{ pid: 1 }] }) });
    assert.equal(r.ok, true);
    assert.equal(r.from, 'acc-1');
    assert.equal(r.to, 'acc-2');
    assert.equal(r.already, undefined);
    assert.equal(r.running.length, 1);
    assert.equal(r.checked, true);
    assert.equal(A.loadProfile('acc-1').oauth.refreshToken, 'rt-1');
    const l = A.readLogin();
    assert.equal(l.id, 'acc-2');
    assert.equal(l.cred.claudeAiOauth.refreshToken, 'rt-2');
    assert.equal(l.cred.organizationUuid, 'org-2');
    assert.equal(l.cred.mcpOAuth.x.accessToken, 'mcp');   // khoá khác giữ nguyên
    assert.equal(l.cfg.numStartups, 7);
    assert.deepEqual(A.readLog().entries.at(-1), { t: 5000, id: 'acc-2', reason: 'switch', running: 1 });
    assert.equal(backupCount(), 2);
    assert.equal(A.isLocked(), false);
  });
});

test('switchTo: không kiểm tra được tiến trình -> checked false, log không có running', () => {
  withEnv(({ dir }) => {
    setupTwo(dir);
    const r = A.switchTo('user2', { now: 5000, processes: () => ({ ok: false, list: [] }) });
    assert.equal(r.checked, false);
    assert.deepEqual(r.running, []);
    assert.deepEqual(A.readLog().entries.at(-1), { t: 5000, id: 'acc-2', reason: 'switch' });
  });
});

test('switchTo: TT_SKIP_PROCESS_CHECK=1 -> mặc định coi như không có tiến trình', () => {
  withEnv(({ dir }) => {
    setupTwo(dir);
    const saved = process.env.TT_SKIP_PROCESS_CHECK;
    process.env.TT_SKIP_PROCESS_CHECK = '1';
    try {
      const r = A.switchTo('user2', { now: 5000 });
      assert.equal(r.checked, true);
      assert.deepEqual(r.running, []);
      assert.equal(A.readLog().entries.at(-1).running, 0);
    } finally {
      if (saved === undefined) delete process.env.TT_SKIP_PROCESS_CHECK; else process.env.TT_SKIP_PROCESS_CHECK = saved;
    }
  });
});

test('switchTo: sang chính tài khoản đang ở -> already, log và file không đổi', () => {
  withEnv(({ dir }) => {
    setupTwo(dir);
    const log0 = A.readLog();
    const files0 = filesText();
    const r = A.switchTo('user1', { now: 5000, processes: noProcs });
    assert.equal(r.already, true);
    assert.equal(r.from, 'acc-1');
    assert.equal(r.to, 'acc-1');
    assert.deepEqual(A.readLog(), log0);
    assert.deepEqual(filesText(), files0);
    assert.equal(backupCount(), 0);
    assert.equal(A.isLocked(), false);
  });
});

test('switchTo: hồ sơ đích không có oauth -> NO_TOKEN, file không đổi', () => {
  withEnv(({ dir }) => {
    const { a2 } = setupTwo(dir);
    A.saveProfile(profileOf(a2, { oauth: undefined }));
    const files0 = filesText();
    throwsCode(() => A.switchTo('user2', { now: 5000, processes: noProcs }), 'NO_TOKEN');
    assert.deepEqual(filesText(), files0);
    assert.equal(A.readLog().entries.length, 1);
    assert.equal(backupCount(), 0);
    assert.equal(A.isLocked(), false);
  });
});

test('switchTo: không có hồ sơ khớp -> NOT_FOUND, nhả khoá', () => {
  withEnv(({ dir }) => {
    setupTwo(dir);
    throwsCode(() => A.switchTo('nobody', { now: 5000, processes: noProcs }), 'NOT_FOUND');
    assert.equal(A.isLocked(), false);
  });
});

test('switchTo: đang bị khoá -> LOCKED, file không đổi', () => {
  withEnv(({ dir }) => {
    setupTwo(dir);
    const files0 = filesText();
    fs.writeFileSync(A.paths().lockFile, JSON.stringify({ pid: process.pid, t: Date.now() }));
    throwsCode(() => A.switchTo('user2', { processes: noProcs }), 'LOCKED');
    assert.deepEqual(filesText(), files0);
  });
});

test('switchTo: sau /logout vẫn đổi được sang hồ sơ đã lưu, không tạo hồ sơ rỗng', () => {
  withEnv(({ dir }) => {
    setupTwo(dir);
    editJSON(A.paths().credFile, (o) => { delete o.claudeAiOauth; });
    editJSON(A.paths().claudeJson, (o) => { delete o.oauthAccount; });
    assert.equal(A.readLogin().id, null);
    const r = A.switchTo('user2', { now: 5000, processes: noProcs });
    assert.equal(r.from, null);
    assert.equal(r.to, 'acc-2');
    assert.equal(A.readLogin().id, 'acc-2');
    assert.deepEqual(A.listProfiles().map((p) => p.id).sort(), ['acc-1', 'acc-2']);
  });
});

test('switchTo: lỗi ghi -> WRITE_FAILED, hai file trùng bản trước khi đổi, nhả khoá, thử 3 lần', () => {
  withEnv(({ dir }) => {
    setupTwo(dir);
    const files0 = filesText();
    let calls = 0;
    // ghi dở file thứ nhất rồi ném EPERM: restore phải đưa mọi thứ về như cũ
    const write = () => {
      calls++;
      fs.writeFileSync(A.paths().credFile, '{"dở dang":');
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    };
    throwsCode(() => A.switchTo('user2', { now: 5000, processes: noProcs, write }), 'WRITE_FAILED');
    assert.equal(calls, 3);
    assert.deepEqual(filesText(), files0);
    assert.equal(A.readLog().entries.length, 1);
    assert.equal(A.isLocked(), false);
    assert.equal(A.withLock(() => 'ok'), 'ok');
  });
});

test('switchTo: ghi xong nhưng đọc lại sai tài khoản -> thử lại rồi khôi phục', () => {
  withEnv(({ dir }) => {
    setupTwo(dir);
    const files0 = filesText();
    let calls = 0;
    throwsCode(() => A.switchTo('user2', { now: 5000, processes: noProcs, write: () => { calls++; } }), 'WRITE_FAILED');
    assert.equal(calls, 3);
    assert.deepEqual(filesText(), files0);
    assert.equal(A.isLocked(), false);
  });
});

test('switchTo: lần ghi đầu lỗi, lần sau được -> thành công', () => {
  withEnv(({ dir }) => {
    setupTwo(dir);
    let calls = 0;
    const write = (p) => {
      if (++calls === 1) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      A.writeLogin(p);
    };
    const r = A.switchTo('user2', { now: 5000, processes: noProcs, write });
    assert.equal(r.to, 'acc-2');
    assert.equal(calls, 2);
    assert.equal(A.readLogin().id, 'acc-2');
  });
});

test('switchTo: không ghi được log -> khôi phục file, WRITE_FAILED', () => {
  withEnv(({ dir }) => {
    setupTwo(dir);
    const files0 = filesText();
    fs.rmSync(A.paths().logFile);
    fs.mkdirSync(A.paths().logFile);   // log là thư mục -> không ghi được
    throwsCode(() => A.switchTo('user2', { now: 5000, processes: noProcs }), 'WRITE_FAILED');
    assert.deepEqual(filesText(), files0);
    assert.equal(A.isLocked(), false);
  });
});

test('switchTo: xoá conflict', () => {
  withEnv(({ dir }) => {
    setupTwo(dir);
    const log = A.readLog();
    log.conflict = { fileId: 'acc-1', chosenId: 'acc-2', since: 200 };
    A.writeLog(log);
    A.switchTo('user2', { now: 5000, processes: noProcs });
    assert.equal(A.readLog().conflict, null);
  });
});
