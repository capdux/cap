#!/usr/bin/env bun
// Batch pack & publish script for official @cap/* and @web/* packages to capdux.org
// Usage:
//   DRY_RUN=1 bun run scripts/seed_official.ts
//   CAPDUX_URL=https://registry.capdux.org CAPDUX_TOKEN=capdux_xxx bun run scripts/seed_official.ts

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface CapManifest {
  name?: string;
  ver?: string;
  version?: string;
  description?: string;
  license?: string;
  repository?: string;
  homepage?: string;
  keywords?: string[];
  dependencies?: Record<string, string>;
  deps?: Record<string, string>;
  [key: string]: unknown;
}

interface DiscoveredPackage {
  dir: string;
  scope: string;
  folderName: string;
  manifest: CapManifest;
  name: string;
  version: string;
}

const CAPDUX_URL = (process.env.CAPDUX_URL || "https://registry.capdux.org").replace(/\/+$/, "");
const CAPDUX_TOKEN = (process.env.CAPDUX_TOKEN || "").trim();
const CP_REPO = resolve(process.env.CP_REPO || "/data/dev/cp");
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;

function isZstdArchive(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === ZSTD_MAGIC[0] &&
    bytes[1] === ZSTD_MAGIC[1] &&
    bytes[2] === ZSTD_MAGIC[2] &&
    bytes[3] === ZSTD_MAGIC[3]
  );
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

async function computeSha256Integrity(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256-${bytesToHex(new Uint8Array(digest))}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function computeDirUnpackedSize(dir: string): number {
  let total = 0;
  const ignore = new Set([".git", ".cap", "bin", "node_modules", "cap_modules", "zig-cache", ".zig-cache"]);
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (ignore.has(entry)) continue;
      const full = join(cur, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          stack.push(full);
        } else if (st.isFile()) {
          total += st.size;
        }
      } catch {}
    }
  }
  return total;
}

function discoverOfficialPackages(cpRepo: string): DiscoveredPackage[] {
  const scopes = ["@cap", "@web"];
  const found: DiscoveredPackage[] = [];

  for (const scope of scopes) {
    const scopeDir = join(cpRepo, "packages", scope);
    if (!existsSync(scopeDir)) continue;

    const entries = readdirSync(scopeDir).sort();
    for (const entry of entries) {
      const pkgDir = join(scopeDir, entry);
      let isDir = false;
      try {
        isDir = statSync(pkgDir).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;

      const manifestPath = join(pkgDir, "cap.json");
      if (!existsSync(manifestPath)) continue;

      try {
        const raw = readFileSync(manifestPath, "utf8");
        const manifest = JSON.parse(raw) as CapManifest;
        const name = (manifest.name || `${scope}/${entry}`).trim();
        const version = (manifest.ver || manifest.version || "1.0.0").trim();
        found.push({ dir: pkgDir, scope, folderName: entry, manifest, name, version });
      } catch (err) {
        console.error(`[WARN] Skipping invalid cap.json in ${pkgDir}:`, err);
      }
    }
  }

  return found;
}

function findZstFileInDir(dir: string): string | null {
  try {
    const files = readdirSync(dir);
    for (const f of files) {
      if (f.endsWith(".tar.zst")) {
        return join(dir, f);
      }
    }
  } catch {}
  return null;
}

async function packPackage(pkg: DiscoveredPackage, workDir: string): Promise<{ archivePath: string; usedFallback: boolean }> {
  const safeBase = pkg.name.replace(/^@/, "").replace(/\//g, "-");
  const outDir = join(workDir, `${safeBase}-${pkg.version}`);
  const fallbackArchive = join(workDir, `${safeBase}-${pkg.version}.tar.zst`);

  // 1. Primary path: `cap pack --out <tmp>`
  try {
    const proc = Bun.spawn(["cap", "pack", "--out", outDir], {
      cwd: pkg.dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      const produced = findZstFileInDir(outDir);
      if (produced && existsSync(produced)) {
        const bytes = new Uint8Array(readFileSync(produced));
        if (isZstdArchive(bytes)) {
          return { archivePath: produced, usedFallback: false };
        }
      }
    }
  } catch {
    // Fall through to tar --zstd fallback
  }

  // 2. Fallback path: `tar --zstd -cf`
  const tarProc = Bun.spawn(
    [
      "tar",
      "--zstd",
      "-cf",
      fallbackArchive,
      "--exclude=.git",
      "--exclude=.cap",
      "--exclude=bin",
      "--exclude=node_modules",
      "--exclude=cap_modules",
      "--exclude=zig-cache",
      "--exclude=.zig-cache",
      "-C",
      pkg.dir,
      ".",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const tarExit = await tarProc.exited;
  if (tarExit !== 0) {
    const stderr = await new Response(tarProc.stderr).text();
    throw new Error(`tar --zstd failed (exit ${tarExit}): ${stderr.trim()}`);
  }

  return { archivePath: fallbackArchive, usedFallback: true };
}

function readOptionalText(paths: string[]): string {
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        return readFileSync(p, "utf8");
      } catch {}
    }
  }
  return "";
}

async function publishPackage(
  pkg: DiscoveredPackage,
  archiveBytes: Uint8Array,
  integrity: string,
  unpackedSize: number,
  readmeMd: string,
  typesDcp: string,
): Promise<"published" | "skipped"> {
  const safeBase = pkg.name.replace(/^@/, "").replace(/\//g, "-");
  const filename = `${safeBase}-${pkg.version}.tar.zst`;

  const metadata = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.manifest.description || "",
    license: pkg.manifest.license || "MIT",
    repository: pkg.manifest.repository || `https://github.com/cp-lang/cp/tree/main/packages/${pkg.scope}/${pkg.folderName}`,
    homepage: pkg.manifest.homepage || "",
    keywords: Array.isArray(pkg.manifest.keywords) ? pkg.manifest.keywords : [],
    manifest: pkg.manifest,
    deps: pkg.manifest.dependencies || pkg.manifest.deps || {},
    readme_md: readmeMd,
    types_dcp: typesDcp,
    integrity,
    unpacked_size: unpackedSize,
    dist_tag: "latest",
  };

  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  form.append("archive", new Blob([archiveBytes], { type: "application/zstd" }), filename);
  if (readmeMd) form.append("readme", readmeMd);
  if (typesDcp) form.append("types_dcp", typesDcp);

  const res = await fetch(`${CAPDUX_URL}/v1/publish`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${CAPDUX_TOKEN}`,
    },
    body: form,
  });

  if (res.status === 409) {
    return "skipped";
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  return "published";
}

async function syncRegistryJson(cpRepo: string): Promise<number> {
  const registryPath = join(cpRepo, "packages", "@cap", "registry.json");
  if (!existsSync(registryPath)) {
    console.warn(`[WARN] registry.json not found at ${registryPath}, skipping sync.`);
    return 0;
  }

  const raw = readFileSync(registryPath, "utf8");
  const parsed = JSON.parse(raw) as { entries?: unknown[] };
  const entryCount = Array.isArray(parsed.entries) ? parsed.entries.length : 0;

  if (DRY_RUN) {
    console.log(`[DRY_RUN] Validated ${registryPath} (${entryCount} upstream mappings) — would POST ${CAPDUX_URL}/v1/registry/sync`);
    return entryCount;
  }

  const res = await fetch(`${CAPDUX_URL}/v1/registry/sync`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CAPDUX_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: raw,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Registry sync failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }

  console.log(`[OK] Synced ${entryCount} upstream mappings to ${CAPDUX_URL}/v1/registry/sync`);
  return entryCount;
}

async function main() {
  if (!DRY_RUN && !CAPDUX_TOKEN) {
    console.error("ERROR: CAPDUX_TOKEN environment variable is required when DRY_RUN is not set.");
    console.error("Hint: run with DRY_RUN=1 to pack and verify locally without uploading.");
    process.exit(1);
  }

  const packages = discoverOfficialPackages(CP_REPO);
  console.log(
    `[capdux-seed] Found ${packages.length} official packages under ${CP_REPO}/packages/{@cap,@web}` +
      (DRY_RUN ? " (DRY_RUN mode)" : ` -> ${CAPDUX_URL}`),
  );

  const workDir = mkdtempSync(join(tmpdir(), "capdux-seed-"));
  let published = 0;
  let skipped = 0;
  let failed = 0;
  let fallbackCount = 0;
  let totalArchiveBytes = 0;
  let totalUnpackedBytes = 0;

  try {
    for (let i = 0; i < packages.length; i++) {
      const pkg = packages[i];
      const prefix = `[${i + 1}/${packages.length}] ${pkg.name}@${pkg.version}`;

      try {
        const { archivePath, usedFallback } = await packPackage(pkg, workDir);
        if (usedFallback) fallbackCount++;

        const archiveBytes = new Uint8Array(readFileSync(archivePath));
        if (!isZstdArchive(archiveBytes)) {
          throw new Error("Generated archive failed Zstd magic (28 B5 2F FD) verification");
        }

        const integrity = await computeSha256Integrity(archiveBytes);
        const unpackedSize = computeDirUnpackedSize(pkg.dir);
        const readmeMd = readOptionalText([join(pkg.dir, "README.md"), join(pkg.dir, "readme.md")]);
        const typesDcp = readOptionalText([join(pkg.dir, "src", "index.d.cp"), join(pkg.dir, "index.d.cp")]);

        totalArchiveBytes += archiveBytes.byteLength;
        totalUnpackedBytes += unpackedSize;

        if (DRY_RUN) {
          console.log(
            `${prefix} — OK (${formatBytes(archiveBytes.byteLength)} zst, ${formatBytes(unpackedSize)} raw, ` +
              `${integrity.slice(0, 23)}…, dcp=${typesDcp.length}B${usedFallback ? ", tar-fallback" : ""})`,
          );
          published++;
        } else {
          const outcome = await publishPackage(pkg, archiveBytes, integrity, unpackedSize, readmeMd, typesDcp);
          if (outcome === "skipped") {
            console.log(`${prefix} — SKIPPED (409 already published)`);
            skipped++;
          } else {
            console.log(`${prefix} — PUBLISHED (${formatBytes(archiveBytes.byteLength)}, ${integrity.slice(0, 23)}…)`);
            published++;
          }
        }
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${prefix} — FAILED: ${msg}`);
      }
    }

    let syncedMappings = 0;
    try {
      syncedMappings = await syncRegistryJson(CP_REPO);
    } catch (err) {
      failed++;
      console.error(`[ERROR] registry.json sync failed:`, err instanceof Error ? err.message : String(err));
    }

    const ratio = totalUnpackedBytes > 0 ? ((totalArchiveBytes / totalUnpackedBytes) * 100).toFixed(1) : "0.0";
    console.log("\n=== capdux-seed summary ===");
    console.log(`Mode:            ${DRY_RUN ? "DRY_RUN" : "LIVE PUBLISH"}`);
    console.log(`Total packages:  ${packages.length}`);
    console.log(`${DRY_RUN ? "Verified" : "Published"}:       ${published}`);
    if (!DRY_RUN) console.log(`Skipped (409):   ${skipped}`);
    console.log(`Failed:          ${failed}`);
    console.log(`Tar fallback:    ${fallbackCount}`);
    console.log(`Archive total:   ${formatBytes(totalArchiveBytes)} / ${formatBytes(totalUnpackedBytes)} (${ratio}%)`);
    console.log(`Registry sync:   ${syncedMappings} mappings`);

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

await main();
