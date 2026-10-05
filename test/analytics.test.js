// Test các hàm thuần liên quan đến nhiều tài khoản trong analytics.js
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../analytics.js');

const { DAY } = A;
const NOW = Date.parse('2026-10-05T10:00:00Z');
const iso = (t) => new Date(t).toISOString();

// dựng usage thô giống cachedUsageUtilization của Claude Code
const usage = (five, seven) => ({
  fetchedAtMs: NOW - 1000,
  accountUuid: 'x',
  utilization: {
    five_hour: five && { utilization: five[0], resets_at: iso(five[1]) },
    seven_day: seven && { utilization: seven[0], resets_at: iso(seven[1]) },
    seven_day_opus: null,
  },
});
const H = 3600e3;

test('accountAt: tìm mục cuối có t <= thời điểm', () => {
  const e = [{ t: 0, id: 'a' }, { t: 100, id: 'b' }];
  assert.equal(A.accountAt(e, 50), 'a');
  assert.equal(A.accountAt(e, 100), 'b');
  assert.equal(A.accountAt(e, 999), 'b');
  assert.equal(A.accountAt([{ t: 10, id: 'a' }], 5), 'a');
  assert.equal(A.accountAt([], 5), null);
  assert.equal(A.accountAt(undefined, 5), null);
});

test('effectiveUsage: trước/sau mốc reset', () => {
  const u = { fetchedAtMs: 123, utilization: { five_hour: { utilization: 18, resets_at: '2026-10-05T12:19:59.991143+00:00' }, seven_day: null } };
  const before = A.effectiveUsage(u, Date.parse('2026-10-05T12:00:00Z'));
  assert.equal(before.fiveHour.pct, 18);
  assert.equal(before.fiveHour.resetsAt, Date.parse('2026-10-05T12:19:59.991143+00:00'));
  assert.equal(before.sevenDay, null);
  assert.equal(before.fetchedAt, 123);
  const after = A.effectiveUsage(u, Date.parse('2026-10-05T12:30:00Z'));
  assert.equal(after.fiveHour.pct, 0);
});

test('effectiveUsage: thiếu dữ liệu', () => {
  assert.deepEqual(A.effectiveUsage(null, NOW), { fiveHour: null, sevenDay: null, fetchedAt: null });
  const r = A.effectiveUsage({ utilization: { five_hour: { utilization: null, resets_at: null }, seven_day: null } }, NOW);
  assert.deepEqual(r, { fiveHour: null, sevenDay: null, fetchedAt: null });
});

test('loginState', () => {
  assert.equal(A.loginState(null, NOW), 'unknown');
  assert.equal(A.loginState(NOW - 1, NOW), 'expired');
  assert.equal(A.loginState(NOW, NOW), 'expired');
  assert.equal(A.loginState(NOW + 2 * DAY, NOW), 'soon');
  assert.equal(A.loginState(NOW + 10 * DAY, NOW), 'ok');
});

test('suggestAccount: chọn tài khoản còn nhiều hạn mức nhất', () => {
  const accounts = [
    { id: 'a', usage: usage([95, NOW + H], [60, NOW + DAY]), loginExpiresAt: NOW + 9 * DAY },
    { id: 'b', usage: usage([20, NOW + H], [50, NOW + DAY]), loginExpiresAt: NOW + 9 * DAY },
    { id: 'c', usage: usage([10, NOW + H], [30, NOW + DAY]), loginExpiresAt: NOW + 9 * DAY },
    { id: 'd', usage: usage([0, NOW + H], [0, NOW + DAY]), loginExpiresAt: NOW - 1 },
  ];
  assert.equal(A.suggestAccount(accounts, 'a', NOW), 'c');
});

test('suggestAccount: hoà điểm thì ưu tiên 5h reset sớm hơn; cửa sổ đã reset tính 0', () => {
  const accounts = [
    { id: 'a', usage: usage([95, NOW + H], [1, NOW + DAY]), loginExpiresAt: null },
    { id: 'b', usage: usage([40, NOW + H], [0, NOW + DAY]), loginExpiresAt: null },
    { id: 'c', usage: usage([40, NOW + 2 * H], [90, NOW - H]), loginExpiresAt: null }, // tuần đã reset -> 0
  ];
  assert.equal(A.suggestAccount(accounts, 'a', NOW), 'b');
});

test('suggestAccount: bỏ tài khoản không có dữ liệu usage; không còn ứng viên -> null', () => {
  const only = [{ id: 'a', usage: usage([1, NOW + H], [1, NOW + DAY]), loginExpiresAt: null }];
  assert.equal(A.suggestAccount(only, 'a', NOW), null);
  const noData = [
    { id: 'a', usage: null, loginExpiresAt: null },
    { id: 'b', usage: null, loginExpiresAt: null },
    { id: 'c', usage: { utilization: { five_hour: null, seven_day: null } }, loginExpiresAt: null },
  ];
  assert.equal(A.suggestAccount(noData, 'a', NOW), null);
});

// một lượt đã enrich tối thiểu cho summary/windows
const turn = (t, cost = 1) => ({ t, tok: 100, ctx: 0, cr: 0, c: { total: cost } });

test('summary: có mốc reset thật -> cửa sổ hiện tại theo Anthropic, không theo giờ tròn', () => {
  const resetsAt = NOW + 2 * H + 20 * 60e3;          // reset 12:20Z -> cửa sổ 07:20Z–12:20Z
  const rows = [turn(NOW - 8 * H, 5), turn(NOW - 3 * H, 2), turn(NOW - 1 * H, 3), turn(NOW - 10 * 60e3, 4)];
  const s = A.summary(rows, NOW, { resetsAt });
  assert.equal(s.window.start, resetsAt - A.WINDOW);
  assert.equal(s.window.end, resetsAt);
  assert.equal(s.window.real, true);
  assert.equal(s.window.n, 2);                          // chỉ 2 lượt từ 07:20Z
  assert.equal(s.window.cost, 7);
  // các cửa sổ cũ (ước lượng) chỉ gồm lượt trước khi cửa sổ thật mở, cửa sổ thật nằm cuối danh sách
  assert.equal(s.windows[s.windows.length - 1], s.window);
  assert.equal(s.windows.slice(0, -1).reduce((a, w) => a + w.n, 0), 2);
});

test('summary: cửa sổ thật chưa có lượt nào vẫn hiện (n = 0)', () => {
  const s = A.summary([turn(NOW - 8 * H)], NOW, { resetsAt: NOW + H });
  assert.equal(s.window.n, 0);
  assert.equal(s.window.cost, 0);
  assert.equal(s.window.real, true);
});

test('summary: mốc reset đã qua hoặc thiếu -> quay về ước lượng giờ tròn', () => {
  const rows = [turn(NOW - 30 * 60e3)];
  for (const opts of [undefined, {}, { resetsAt: NOW - 1 }, { resetsAt: null }]) {
    const s = A.summary(rows, NOW, opts);
    assert.equal(s.window.start, A.floorHour(NOW - 30 * 60e3));
    assert.ok(!s.window.real);
  }
});

test('suggestAccount: chỉ gợi ý khi còn nhiều hạn mức hơn tài khoản đang dùng và chưa chạm 100%', () => {
  const act = { id: 'a', usage: usage([16, NOW + H], [3, NOW + DAY]), loginExpiresAt: null };
  const full = { id: 'b', usage: usage([100, NOW + H], [87, NOW + DAY]), loginExpiresAt: null };
  assert.equal(A.suggestAccount([act, full], 'a', NOW), null);                    // 100% > 16% -> không gợi ý
  const cap = { id: 'c', usage: usage([100, NOW + H], [0, NOW + DAY]), loginExpiresAt: null };
  const hot = { id: 'a', usage: usage([100, NOW + H], [100, NOW + DAY]), loginExpiresAt: null };
  assert.equal(A.suggestAccount([hot, cap], 'a', NOW), null);                     // ứng viên cũng 100% -> không
  const ok = { id: 'd', usage: usage([30, NOW + H], [40, NOW + DAY]), loginExpiresAt: null };
  assert.equal(A.suggestAccount([hot, cap, ok], 'a', NOW), 'd');
  // tài khoản đang dùng không có số liệu -> vẫn gợi ý ứng viên tốt nhất dưới 100%
  assert.equal(A.suggestAccount([{ id: 'a', usage: null }, full, ok], 'a', NOW), 'd');
});
