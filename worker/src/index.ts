// Unified Cloudflare Worker entry point for capdux.org
// Routes API (registry.capdux.org), Sparse Index (index.capdux.org),
// R2 Archive Downloads (dl.capdux.org), and Web SSR (capdux.org).
import { handleAuthRoutes } from "./routes/auth_routes";
import {
  handleDownload,
  handleGetPackage,
  handleGetPackument,
  handlePublish,
  handleSparseIndex,
  handleYank,
} from "./routes/registry";
import {
  handleGetRegistryJson,
  handleListAbsorptionRequests,
  handleSearch,
  handleStats,
  handleSubmitAbsorptionRequest,
  handleSyncRegistry,
} from "./routes/search";
import { getWellKnownKeysDoc } from "./signing";
import type { Env } from "./types";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Cap-Client",
  "Access-Control-Max-Age": "86400",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function jsonError(error: string, status: number): Response {
  return withCors(
    new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }),
  );
}

/**
 * Parses `/v1/packages/<name>/<version>/yank` or `/v1/packages/<name>/<version>/unyank`
 * supporting both scoped (`@cap/lru`) and unscoped (`my-pkg`) names.
 */
function matchYankRoute(pathname: string): { name: string; version: string; yanked: boolean } | null {
  const prefix = "/v1/packages/";
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);

  let yanked: boolean;
  let withoutAction: string;
  if (rest.endsWith("/yank")) {
    yanked = true;
    withoutAction = rest.slice(0, -"/yank".length);
  } else if (rest.endsWith("/unyank")) {
    yanked = false;
    withoutAction = rest.slice(0, -"/unyank".length);
  } else {
    return null;
  }

  const lastSlash = withoutAction.lastIndexOf("/");
  if (lastSlash <= 0 || lastSlash >= withoutAction.length - 1) return null;
  const name = withoutAction.slice(0, lastSlash);
  const version = withoutAction.slice(lastSlash + 1);
  return { name, version, yanked };
}

type WebModule = {
  renderHomePage: (env: Env, url: URL) => Promise<Response>;
  renderPackagePage: (env: Env, pkgName: string) => Promise<Response>;
  renderAuthPage?: (env: Env, mode: "login" | "register") => Promise<Response>;
  renderDashboardPage?: (env: Env) => Promise<Response>;
};

async function loadWebModule(): Promise<WebModule | null> {
  try {
    return (await import("./web")) as unknown as WebModule;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const { hostname, pathname } = url;

    try {
      // Health check
      if (pathname === "/health" && request.method === "GET") {
        return withCors(
          new Response(
            JSON.stringify({
              status: "ok",
              service: "capdux-registry",
              timestamp: new Date().toISOString(),
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json; charset=utf-8" },
            },
          ),
        );
      }

      // Platform Ed25519 public signing keys discovery
      if (pathname === "/.well-known/capdux-keys.json" && request.method === "GET") {
        const keysDoc = await getWellKnownKeysDoc(env);
        return withCors(
          new Response(JSON.stringify(keysDoc), {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "public, max-age=3600",
            },
          }),
        );
      }

      // 1. Download subdomain or /dl/<r2_key>
      if (
        (hostname === "dl.capdux.org" || pathname.startsWith("/dl/")) &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        const r2Key = pathname.startsWith("/dl/") ? pathname.slice("/dl/".length) : pathname.slice(1);
        return withCors(await handleDownload(env, ctx, r2Key));
      }

      // 2. Sparse Index subdomain or /index/<name>.json
      if (
        (hostname === "index.capdux.org" || pathname.startsWith("/index/")) &&
        request.method === "GET"
      ) {
        if (pathname.endsWith(".json")) {
          const rawName = pathname.startsWith("/index/")
            ? pathname.slice("/index/".length, -".json".length)
            : pathname.slice(1, -".json".length);
          return withCors(await handleSparseIndex(env, rawName));
        }
      }

      // 3. Global deduplication registry.json
      if ((pathname === "/v1/registry.json" || pathname === "/registry.json") && request.method === "GET") {
        return withCors(await handleGetRegistryJson(env));
      }

      if (pathname === "/v1/registry/sync" && request.method === "POST") {
        return withCors(await handleSyncRegistry(request, env));
      }

      // 3b. Anonymous viral ecosystem absorption request queue (`cap from -npm/-crate`)
      if (pathname === "/v1/requests" && request.method === "POST") {
        return withCors(await handleSubmitAbsorptionRequest(request, env));
      }
      if (pathname === "/v1/requests" && request.method === "GET") {
        return withCors(await handleListAbsorptionRequests(env, url));
      }

      // 4. Auth API
      if (pathname.startsWith("/v1/auth/")) {
        const authRes = await handleAuthRoutes(request, env, pathname);
        if (authRes) return withCors(authRes);
        return jsonError("Not Found", 404);
      }

      // 5. Publish API (PUT or POST)
      if (pathname === "/v1/publish" && (request.method === "PUT" || request.method === "POST")) {
        return withCors(await handlePublish(request, env));
      }

      // 6. Yank / Unyank API
      if (request.method === "POST" && pathname.startsWith("/v1/packages/")) {
        const yankMatch = matchYankRoute(pathname);
        if (yankMatch) {
          return withCors(
            await handleYank(request, env, yankMatch.name, yankMatch.version, yankMatch.yanked),
          );
        }
      }

      // 7. Package metadata API
      if (request.method === "GET" && pathname.startsWith("/v1/packages/")) {
        const pkgName = pathname.slice("/v1/packages/".length);
        return withCors(await handleGetPackage(env, pkgName));
      }

      // 7b. Standard cap/npm packument endpoint on registry.capdux.org (GET /<encoded_pkg>)
      if (
        request.method === "GET" &&
        (url.hostname === "registry.capdux.org" || url.hostname.startsWith("registry.")) &&
        pathname.length > 1 &&
        !pathname.startsWith("/v1/") &&
        !pathname.startsWith("/index/") &&
        !pathname.startsWith("/dl/") &&
        !pathname.startsWith("/.well-known/") &&
        pathname !== "/health"
      ) {
        const pkgName = pathname.slice(1);
        return withCors(await handleGetPackument(env, pkgName));
      }

      // 8. Search & Stats API
      if (pathname === "/v1/search" && request.method === "GET") {
        return withCors(await handleSearch(env, url));
      }
      if (pathname === "/v1/stats" && request.method === "GET") {
        return withCors(await handleStats(env));
      }

      // 9. Web SSR (capdux.org / www.capdux.org / default web routes)
      if (request.method === "GET") {
        if (pathname === "/" || pathname === "/search") {
          const web = await loadWebModule();
          if (web) return await web.renderHomePage(env, url);
          return jsonError("Web UI module not available", 503);
        }
        if (pathname === "/login" || pathname === "/register") {
          const web = await loadWebModule();
          if (web && typeof web.renderAuthPage === "function") {
            return await web.renderAuthPage(env, pathname === "/register" ? "register" : "login");
          }
          return jsonError("Web UI module not available", 503);
        }
        if (pathname === "/dashboard") {
          const web = await loadWebModule();
          if (web && typeof web.renderDashboardPage === "function") {
            return await web.renderDashboardPage(env);
          }
          return jsonError("Web UI module not available", 503);
        }
        if (pathname.startsWith("/pkg/") || pathname.startsWith("/packages/")) {
          const rawName = pathname.startsWith("/pkg/")
            ? pathname.slice("/pkg/".length)
            : pathname.slice("/packages/".length);
          const pkgName = decodeURIComponent(rawName).replace(/^\/+|\/+$/g, "");
          const web = await loadWebModule();
          if (web) return await web.renderPackagePage(env, pkgName);
          return jsonError("Web UI module not available", 503);
        }
      }

      return jsonError("Not Found", 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal Server Error";
      return jsonError(message, 500);
    }
  },
};
