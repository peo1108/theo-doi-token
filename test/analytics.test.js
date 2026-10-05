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
    { id: 'a', usage: usage([1, NOW + H], [1, NOW + DAY]), loginExpiresAt: NOW + 9 * DAY },
    { id: 'b', usage: usage([20, NOW + H], [50, NOW + DAY]), loginExpiresAt: NOW + 9 * DAY },
    { id: 'c', usage: usage([10, NOW + H], [30, NOW + DAY]), loginExpiresAt: NOW + 9 * DAY },
    { id: 'd', usage: usage([0, NOW + H], [0, NOW + DAY]), loginExpiresAt: NOW - 1 },
  ];
  assert.equal(A.suggestAccount(accounts, 'a', NOW), 'c');
});

test('suggestAccount: hoà điểm thì ưu tiên 5h reset sớm hơn; cửa sổ đã reset tính 0', () => {
  const accounts = [
    { id: 'a', usage: usage([1, NOW + H], [1, NOW + DAY]), loginExpiresAt: null },
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
