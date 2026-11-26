// Authentication & crypto helpers (Web Crypto API — zero external dependencies)
import type { AuthUser, Env } from "./types";

const HEX = "0123456789abcdef";

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += HEX[(b >> 4) & 0x0f] + HEX[b & 0x0f];
  }
  return out;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

export async function hashPassword(password: string, saltHex: string): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: enc.encode(saltHex),
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

export function generateRandomHex(numBytes: number): string {
  const buf = new Uint8Array(numBytes);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

export function generateApiToken(): string {
  return `capdux_${generateRandomHex(24)}`;
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function authenticateRequest(req: Request, env: Env): Promise<AuthUser | null> {
  const auth = req.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const rawToken = auth.slice(7).trim();
  if (!rawToken) return null;

  // Optional bootstrap admin key for initial CI/CD official package seeding
  if (env.ADMIN_BOOTSTRAP_KEY && constantTimeEqual(rawToken, env.ADMIN_BOOTSTRAP_KEY)) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, username, email, password_hash, password_salt, role)
       VALUES (1, 'capdux-bot', 'bot@capdux.org', 'bootstrap-disabled', 'bootstrap-salt', 'admin')`,
    )
      .run()
      .catch(() => {});
    return {
      id: 1,
      username: "capdux-bot",
      email: "bot@capdux.org",
      role: "admin",
      tokenScope: "admin",
    };
  }

  const tokenHash = await sha256Hex(rawToken);
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.email, u.role, t.scope AS token_scope, t.id AS token_id, t.expires_at
     FROM api_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ? AND t.revoked = 0
     LIMIT 1`,
  )
    .bind(tokenHash)
    .first<{
      id: number;
      username: string;
      email: string;
      role: "admin" | "maintainer" | "user";
      token_scope: "read" | "publish" | "admin";
      token_id: number;
      expires_at: string | null;
    }>();

  if (!row) return null;
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    return null;
  }

  // Best-effort last_used_at update
  await env.DB.prepare(
    `UPDATE api_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
  )
    .bind(row.token_id)
    .run()
    .catch(() => {});

  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    tokenScope: row.token_scope,
  };
}

export function canPublishPackage(
  user: AuthUser,
  scope: string,
  existingOwnerId: number | null,
): boolean {
  if (user.tokenScope === "read") return false;
  if (user.role === "admin" || user.tokenScope === "admin") return true;
  // Official scopes (@cap, @web) require maintainer or admin
  if ((scope === "@cap" || scope === "@web") && user.role !== "maintainer") {
    return false;
  }
  if (existingOwnerId !== null && existingOwnerId !== user.id) {
    return false;
  }
  return true;
}
