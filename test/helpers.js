// Tiện ích cho test: thư mục tạm thay cho ~/.claude và tài khoản giả.
// KHÔNG bao giờ động vào file thật của người dùng.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'TT_DATA_DIR'];

// Tạo thư mục tạm, trỏ CLAUDE_CONFIG_DIR / TT_DATA_DIR vào đó. cleanup() trả env về như cũ.
function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-acc-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.CLAUDE_CONFIG_DIR = dir;
  process.env.TT_DATA_DIR = dataDir;
  const cleanup = () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, dataDir, cleanup };
}

// Tài khoản giả thứ n: id acc-n, org org-n, token at-n / rt-n.
function fakeAccount(n) {
  const id = `acc-${n}`;
  const org = `org-${n}`;
  const email = `user${n}@example.com`;
  return {
    id, org, email,
    oauth: {
      accessToken: `at-${n}`,
      refreshToken: `rt-${n}`,
      expiresAt: 1.9e12 + n,
      refreshTokenExpiresAt: 2e12 + n,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_5x',
    },
    oauthAccount: { accountUuid: id, emailAddress: email, organizationUuid: org, displayName: `User ${n}` },
  };
}

// Ghi .credentials.json (một dòng) và .claude.json (thụt 2 dấu cách) như Claude Code.
// extras.usage: true hoặc object -> thêm cachedUsageUtilization cho tài khoản này.
function writeLoginFiles(dir, acc, extras = {}) {
  const cred = {
    mcpOAuth: { x: { accessToken: 'mcp' } },
    claudeAiOauth: acc.oauth,
    organizationUuid: acc.org,
  };
  const cfg = { projects: { p: 1 }, numStartups: 7, oauthAccount: acc.oauthAccount };
  if (extras.usage) {
    cfg.cachedUsageUtilization = {
      fetchedAtMs: 1.9e12,
      accountUuid: acc.id,
      utilization: {
        five_hour: { utilization: 12, resets_at: '2030-01-01T00:00:00.000Z' },
        seven_day: { utilization: 34, resets_at: '2030-01-05T00:00:00.000Z' },
      },
      ...(typeof extras.usage === 'object' ? extras.usage : {}),
    };
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify(cred));
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify(cfg, null, 2));
}

module.exports = { makeEnv, fakeAccount, writeLoginFiles };
