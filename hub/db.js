// Lưu trữ của hub (SQLite qua node:sqlite). Mọi truy vấn chạm dữ liệu của người dùng đều lọc theo user_id.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL,
  admin INTEGER NOT NULL DEFAULT 0, locked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS invites (
  code_hash TEXT PRIMARY KEY, created_by INTEGER, expires_at INTEGER NOT NULL, used_by INTEGER, used_at INTEGER);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ntfy (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, topic TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (t INTEGER NOT NULL, user_id INTEGER, ip TEXT, event TEXT NOT NULL, detail TEXT);
`;

const clipName = (s, d) => String(s || '').trim().slice(0, 60) || d;
const newId = () => crypto.randomBytes(8).toString('hex');

function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const q = (sql) => db.prepare(sql);
  const now = () => Date.now();

  return {
    raw: db,
    close: () => db.close(),

    createUser({ username, passHash, admin = false }) {
      const r = q('INSERT INTO users (username, pass_hash, admin, created_at) VALUES (?, ?, ?, ?)')
        .run(username, passHash, admin ? 1 : 0, now());
      return this.userById(Number(r.lastInsertRowid));
    },
    userByName: (name) => q('SELECT * FROM users WHERE username = ?').get(name),
    userById: (id) => q('SELECT * FROM users WHERE id = ?').get(id),
    users: () => q('SELECT id, username, admin, locked, created_at FROM users ORDER BY id').all(),
    countUsers: () => q('SELECT COUNT(*) AS n FROM users').get().n,
    setLocked: (id, on) => q('UPDATE users SET locked = ? WHERE id = ?').run(on ? 1 : 0, id).changes > 0,
    deleteUser: (id) => q('DELETE FROM users WHERE id = ?').run(id).changes > 0,
    setPassword: (id, hash) => q('UPDATE users SET pass_hash = ? WHERE id = ?').run(hash, id).changes > 0,

    addInvite: (codeHash, createdBy, expiresAt) =>
      q('INSERT INTO invites (code_hash, created_by, expires_at) VALUES (?, ?, ?)').run(codeHash, createdBy, expiresAt),
    inviteValid: (codeHash, t = now()) =>
      !!q('SELECT 1 FROM invites WHERE code_hash = ? AND used_by IS NULL AND expires_at > ?').get(codeHash, t),
    // đánh dấu đã dùng (một lần, còn hạn) -> true
    useInvite: (codeHash, userId, t = now()) =>
      q('UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ? AND used_by IS NULL AND expires_at > ?')
        .run(userId, t, codeHash, t).changes > 0,

    addDevice(userId, name, tokenHash) {
      const id = newId();
      q('INSERT INTO devices (id, user_id, name, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, userId, clipName(name, 'iPhone'), tokenHash, now(), now());
      return { id };
    },
    deviceByToken: (hash) => q('SELECT * FROM devices WHERE token_hash = ?').get(hash),
    devices: (userId) => q('SELECT id, name, created_at, last_seen FROM devices WHERE user_id = ? ORDER BY created_at').all(userId),
    revokeDevice: (userId, id) => q('DELETE FROM devices WHERE id = ? AND user_id = ?').run(id, userId).changes > 0,
    revokeAllDevices: (userId) => q('DELETE FROM devices WHERE user_id = ?').run(userId).changes,

    addMachine(userId, name, tokenHash) {
      const id = newId();
      q('INSERT INTO machines (id, user_id, name, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, userId, clipName(name, 'PC'), tokenHash, now(), now());
      return { id };
    },
    machineByToken: (hash) => q('SELECT * FROM machines WHERE token_hash = ?').get(hash),
    machine: (userId, id) => q('SELECT id, name, last_seen FROM machines WHERE id = ? AND user_id = ?').get(id, userId),
    machines: (userId) => q('SELECT id, name, created_at, last_seen FROM machines WHERE user_id = ? ORDER BY created_at').all(userId),
    renameMachine: (userId, id, name) =>
      q('UPDATE machines SET name = ? WHERE id = ? AND user_id = ?').run(clipName(name, 'PC'), id, userId).changes > 0,
    revokeMachine: (userId, id) => q('DELETE FROM machines WHERE id = ? AND user_id = ?').run(id, userId).changes > 0,

    touch(table, id, t = now()) {
      if (table !== 'devices' && table !== 'machines') throw new Error('bảng không hợp lệ');
      q(`UPDATE ${table} SET last_seen = ? WHERE id = ?`).run(t, id);
    },

    ntfyTopic(userId) {
      const row = q('SELECT topic FROM ntfy WHERE user_id = ?').get(userId);
      if (row) return row.topic;
      const topic = crypto.randomBytes(16).toString('hex');
      q('INSERT INTO ntfy (user_id, topic) VALUES (?, ?)').run(userId, topic);
      return topic;
    },

    audit: (userId, ip, event, detail = '') =>
      q('INSERT INTO audit (t, user_id, ip, event, detail) VALUES (?, ?, ?, ?, ?)').run(now(), userId ?? null, ip || '', event, String(detail).slice(0, 300)),
  };
}

module.exports = { openDb };
