import bcrypt from "bcryptjs";
import type { ControlDb } from "../db.js";
import { newId, newToken } from "../util/ids.js";

export interface AuthedUser {
  id: string;
  username: string | null;
  isGuest: boolean;
  xp: number;
  createdAt: string;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function rowToUser(row: any): AuthedUser {
  return {
    id: row.id,
    username: row.username,
    isGuest: !!row.is_guest,
    xp: row.xp,
    createdAt: row.created_at,
  };
}

export function createGuestUser(db: ControlDb): { user: AuthedUser; sessionToken: string; expiresAt: string } {
  const id = newId();
  const now = new Date().toISOString();
  const guestName = `guest_${id.slice(0, 8)}`;
  db.prepare(
    `INSERT INTO users (id, username, password_hash, is_guest, xp, created_at) VALUES (?, ?, NULL, 1, 0, ?)`,
  ).run(id, guestName, now);
  const session = createSession(db, id);
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  return { user: rowToUser(row), ...session };
}

export function registerUser(
  db: ControlDb,
  username: string,
  password: string,
):
  | { ok: true; user: AuthedUser; sessionToken: string; expiresAt: string }
  | { ok: false; status: 400 | 409; error: string } {
  if (username.length < 3 || username.length > 32) {
    return { ok: false, status: 400, error: "Username must be 3–32 characters." };
  }
  if (password.length < 8) {
    return { ok: false, status: 400, error: "Password must be at least 8 characters." };
  }
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (existing) return { ok: false, status: 409, error: "That username is already taken." };

  const id = newId();
  const now = new Date().toISOString();
  const hash = bcrypt.hashSync(password, 12);
  db.prepare(
    `INSERT INTO users (id, username, password_hash, is_guest, xp, created_at) VALUES (?, ?, ?, 0, 0, ?)`,
  ).run(id, username, hash, now);
  const session = createSession(db, id);
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  return { ok: true, user: rowToUser(row), ...session };
}

export function loginUser(
  db: ControlDb,
  username: string,
  password: string,
): { ok: true; user: AuthedUser; sessionToken: string; expiresAt: string } | { ok: false; error: string } {
  const row: any = db.prepare("SELECT * FROM users WHERE username = ? AND is_guest = 0").get(username);
  if (!row || !row.password_hash || !bcrypt.compareSync(password, row.password_hash)) {
    return { ok: false, error: "Invalid username or password." };
  }
  const session = createSession(db, row.id);
  return { ok: true, user: rowToUser(row), ...session };
}

export function createSession(db: ControlDb, userId: string): { sessionToken: string; expiresAt: string } {
  const token = newToken(32);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  db.prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).run(
    token,
    userId,
    now.toISOString(),
    expires.toISOString(),
  );
  return { sessionToken: token, expiresAt: expires.toISOString() };
}

export function getUserBySession(db: ControlDb, token: string | undefined): AuthedUser | null {
  if (!token) return null;
  const row: any = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`,
    )
    .get(token, new Date().toISOString());
  if (!row) return null;
  return rowToUser(row);
}

export function deleteSession(db: ControlDb, token: string | undefined): void {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}
