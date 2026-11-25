// Auth routes: register, login, whoami, and API token management
import {
  authenticateRequest,
  constantTimeEqual,
  generateApiToken,
  generateRandomHex,
  hashPassword,
  sha256Hex,
} from "../auth";
import type { Env } from "../types";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function parseJsonBody(req: Request): Promise<Record<string, any> | null> {
  try {
    const body = await req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, any>;
    }
    return null;
  } catch {
    return null;
  }
}

export async function handleAuthRoutes(req: Request, env: Env, pathname: string): Promise<Response | null> {
  if (pathname === "/v1/auth/register" && req.method === "POST") {
    return handleRegister(req, env);
  }
  if (pathname === "/v1/auth/login" && req.method === "POST") {
    return handleLogin(req, env);
  }
  if (pathname === "/v1/auth/whoami" && req.method === "GET") {
    return handleWhoami(req, env);
  }
  if (pathname === "/v1/auth/tokens" && req.method === "GET") {
    return handleListTokens(req, env);
  }
  if (pathname === "/v1/auth/tokens" && req.method === "POST") {
    return handleCreateToken(req, env);
  }
  if (pathname.startsWith("/v1/auth/tokens/") && req.method === "DELETE") {
    const idStr = pathname.slice("/v1/auth/tokens/".length);
    return handleRevokeToken(req, env, idStr);
  }
  return null;
}

async function handleRegister(req: Request, env: Env): Promise<Response> {
  const body = await parseJsonBody(req);
  if (!body) {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,31}$/.test(username)) {
    return json(
      { error: "Invalid username: must be 2-32 chars, starting with alphanumeric, containing only letters, digits, '_' or '-'" },
      400,
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: "Invalid email address" }, 400);
  }
  if (password.length < 8) {
    return json({ error: "Password must be at least 8 characters" }, 400);
  }

  // Check if username or email is already taken
  const existing = await env.DB.prepare(
    `SELECT id FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?) LIMIT 1`,
  )
    .bind(username, email)
    .first<{ id: number }>();

  if (existing) {
    return json({ error: "Username or email already exists" }, 409);
  }

  // First registered user automatically becomes admin
  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS cnt FROM users`).first<{ cnt: number }>();
  const isFirstUser = !countRow || Number(countRow.cnt) === 0;
  const role: "admin" | "user" = isFirstUser ? "admin" : "user";
  const tokenScope: "admin" | "publish" = isFirstUser ? "admin" : "publish";

  const saltHex = generateRandomHex(16);
  const passwordHash = await hashPassword(password, saltHex);

  try {
    await env.DB.prepare(
      `INSERT INTO users (username, email, password_hash, password_salt, role) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(username, email, passwordHash, saltHex, role)
      .run();
  } catch {
    return json({ error: "Username or email already exists" }, 409);
  }

  const user = await env.DB.prepare(
    `SELECT id, username, email, role, created_at FROM users WHERE username = ? LIMIT 1`,
  )
    .bind(username)
    .first<{
      id: number;
      username: string;
      email: string;
      role: "admin" | "maintainer" | "user";
      created_at: string;
    }>();

  if (!user) {
    return json({ error: "Failed to create user" }, 500);
  }

  const rawToken = generateApiToken();
  const tokenHash = await sha256Hex(rawToken);
  await env.DB.prepare(
    `INSERT INTO api_tokens (user_id, name, token_hash, scope) VALUES (?, ?, ?, ?)`,
  )
    .bind(user.id, "initial", tokenHash, tokenScope)
    .run();

  await env.DB.prepare(
    `INSERT INTO audit_logs (actor_id, action, target, detail) VALUES (?, ?, ?, ?)`,
  )
    .bind(user.id, "auth.register", user.username, JSON.stringify({ role }))
    .run()
    .catch(() => {});

  return json(
    {
      user,
      token: rawToken,
      scope: tokenScope,
    },
    201,
  );
}

async function handleLogin(req: Request, env: Env): Promise<Response> {
  const body = await parseJsonBody(req);
  if (!body) {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const identifier =
    typeof body.username === "string" && body.username.trim()
      ? body.username.trim()
      : typeof body.email === "string" && body.email.trim()
        ? body.email.trim().toLowerCase()
        : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!identifier || !password) {
    return json({ error: "username/email and password are required" }, 400);
  }

  const user = await env.DB.prepare(
    `SELECT id, username, email, password_hash, password_salt, role
     FROM users
     WHERE lower(username) = lower(?) OR lower(email) = lower(?)
     LIMIT 1`,
  )
    .bind(identifier, identifier)
    .first<{
      id: number;
      username: string;
      email: string;
      password_hash: string;
      password_salt: string;
      role: "admin" | "maintainer" | "user";
    }>();

  if (!user) {
    return json({ error: "Invalid credentials" }, 401);
  }

  const computedHash = await hashPassword(password, user.password_salt);
  if (!constantTimeEqual(computedHash, user.password_hash)) {
    return json({ error: "Invalid credentials" }, 401);
  }

  const requestedScope = typeof body.scope === "string" ? body.scope : "";
  let tokenScope: "read" | "publish" | "admin" = user.role === "admin" ? "admin" : "publish";
  if (requestedScope === "read" || requestedScope === "publish" || requestedScope === "admin") {
    if (requestedScope === "admin" && user.role !== "admin") {
      return json({ error: "Insufficient role for admin token scope" }, 403);
    }
    tokenScope = requestedScope;
  }

  const tokenName =
    typeof body.token_name === "string" && body.token_name.trim()
      ? body.token_name.trim().slice(0, 64)
      : "cli-login";

  const rawToken = generateApiToken();
  const tokenHash = await sha256Hex(rawToken);
  await env.DB.prepare(
    `INSERT INTO api_tokens (user_id, name, token_hash, scope) VALUES (?, ?, ?, ?)`,
  )
    .bind(user.id, tokenName, tokenHash, tokenScope)
    .run();

  await env.DB.prepare(
    `INSERT INTO audit_logs (actor_id, action, target, detail) VALUES (?, ?, ?, ?)`,
  )
    .bind(user.id, "auth.login", user.username, JSON.stringify({ scope: tokenScope }))
    .run()
    .catch(() => {});

  return json({
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
    },
    token: rawToken,
    scope: tokenScope,
  });
}

async function handleWhoami(req: Request, env: Env): Promise<Response> {
  const user = await authenticateRequest(req, env);
  if (!user) {
    return json({ error: "Unauthorized" }, 401);
  }
  return json({
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    tokenScope: user.tokenScope,
  });
}

async function handleListTokens(req: Request, env: Env): Promise<Response> {
  const user = await authenticateRequest(req, env);
  if (!user) {
    return json({ error: "Unauthorized" }, 401);
  }

  const { results } = await env.DB.prepare(
    `SELECT id, name, scope, last_used_at, expires_at, revoked, created_at
     FROM api_tokens
     WHERE user_id = ?
     ORDER BY created_at DESC, id DESC`,
  )
    .bind(user.id)
    .all();

  return json({ tokens: results || [] });
}

async function handleCreateToken(req: Request, env: Env): Promise<Response> {
  const user = await authenticateRequest(req, env);
  if (!user) {
    return json({ error: "Unauthorized" }, 401);
  }

  const body = (await parseJsonBody(req)) || {};
  const name =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim().slice(0, 64)
      : `token-${Date.now()}`;

  const requestedScope = typeof body.scope === "string" ? body.scope : "publish";
  if (requestedScope !== "read" && requestedScope !== "publish" && requestedScope !== "admin") {
    return json({ error: "Invalid scope: expected 'read', 'publish', or 'admin'" }, 400);
  }
  if (requestedScope === "admin" && user.role !== "admin") {
    return json({ error: "Only admins can create admin-scoped tokens" }, 403);
  }
  if (user.tokenScope === "read" && requestedScope !== "read") {
    return json({ error: "Read-only token cannot mint elevated tokens" }, 403);
  }

  let expiresAt: string | null = null;
  if (typeof body.expires_in_days === "number" && Number.isFinite(body.expires_in_days) && body.expires_in_days > 0) {
    const ms = Math.min(body.expires_in_days, 3650) * 86_400_000;
    expiresAt = new Date(Date.now() + ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  const rawToken = generateApiToken();
  const tokenHash = await sha256Hex(rawToken);
  await env.DB.prepare(
    `INSERT INTO api_tokens (user_id, name, token_hash, scope, expires_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(user.id, name, tokenHash, requestedScope, expiresAt)
    .run();

  const row = await env.DB.prepare(
    `SELECT id, name, scope, expires_at, created_at FROM api_tokens WHERE token_hash = ? LIMIT 1`,
  )
    .bind(tokenHash)
    .first<{
      id: number;
      name: string;
      scope: string;
      expires_at: string | null;
      created_at: string;
    }>();

  await env.DB.prepare(
    `INSERT INTO audit_logs (actor_id, action, target, detail) VALUES (?, ?, ?, ?)`,
  )
    .bind(user.id, "auth.token.create", String(row?.id ?? ""), JSON.stringify({ name, scope: requestedScope }))
    .run()
    .catch(() => {});

  return json(
    {
      id: row?.id,
      name,
      scope: requestedScope,
      expires_at: expiresAt,
      created_at: row?.created_at,
      token: rawToken,
    },
    201,
  );
}

async function handleRevokeToken(req: Request, env: Env, idStr: string): Promise<Response> {
  const user = await authenticateRequest(req, env);
  if (!user) {
    return json({ error: "Unauthorized" }, 401);
  }

  const tokenId = Number(idStr);
  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    return json({ error: "Invalid token id" }, 400);
  }

  const existing = await env.DB.prepare(`SELECT id, user_id FROM api_tokens WHERE id = ? LIMIT 1`)
    .bind(tokenId)
    .first<{ id: number; user_id: number }>();

  if (!existing) {
    return json({ error: "Token not found" }, 404);
  }
  if (existing.user_id !== user.id && user.role !== "admin") {
    return json({ error: "Forbidden" }, 403);
  }

  await env.DB.prepare(`UPDATE api_tokens SET revoked = 1 WHERE id = ?`).bind(tokenId).run();

  await env.DB.prepare(
    `INSERT INTO audit_logs (actor_id, action, target, detail) VALUES (?, ?, ?, ?)`,
  )
    .bind(user.id, "auth.token.revoke", String(tokenId), "")
    .run()
    .catch(() => {});

  return json({ ok: true, revoked_id: tokenId });
}
