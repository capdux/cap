// Platform Security Scanner & Ed25519 Signing Engine for capdux.org
// Ensures every published `.cap` archive is verified, scanned, and cryptographically attested by capdux.org.

import type { Env, SecurityScanReport } from "./types";
import type { ArchiveFormat } from "./storage";

const DEFAULT_KEY_ID = "capdux-ed25519-v1";

// Cached ephemeral Ed25519 keypair for local dev / unit tests when CAPDUX_SIGNING_PRIVATE_KEY is not set
let cachedDevKeyPair: {
  keyId: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeySpkiB64: string;
} | null = null;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

async function getSigningMaterial(env: Env): Promise<{
  keyId: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeySpkiB64: string;
}> {
  const keyId = env.CAPDUX_SIGNING_KEY_ID || DEFAULT_KEY_ID;
  if (env.CAPDUX_SIGNING_PRIVATE_KEY && env.CAPDUX_SIGNING_PUBLIC_KEY) {
    const privBytes = base64ToBytes(env.CAPDUX_SIGNING_PRIVATE_KEY);
    const pubBytes = base64ToBytes(env.CAPDUX_SIGNING_PUBLIC_KEY);
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      privBytes,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const publicKey = await crypto.subtle.importKey(
      "spki",
      pubBytes,
      { name: "Ed25519" },
      true,
      ["verify"],
    );
    return {
      keyId,
      privateKey,
      publicKey,
      publicKeySpkiB64: env.CAPDUX_SIGNING_PUBLIC_KEY,
    };
  }

  if (!cachedDevKeyPair) {
    const kp = (await crypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
    cachedDevKeyPair = {
      keyId,
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      publicKeySpkiB64: bytesToBase64(spki),
    };
  }
  return cachedDevKeyPair;
}

/**
 * Canonical attestation payload signed by capdux.org:
 * `capdux-v1|<name>|<version>|<integrity>|<security_status>|<published_at>`
 */
export function buildAttestationPayload(params: {
  name: string;
  version: string;
  integrity: string;
  securityStatus: string;
  publishedAt: string;
}): string {
  return `capdux-v1|${params.name}|${params.version}|${params.integrity}|${params.securityStatus}|${params.publishedAt}`;
}

export async function signPackageAttestation(
  env: Env,
  params: {
    name: string;
    version: string;
    integrity: string;
    securityStatus: string;
    publishedAt: string;
  },
): Promise<{ keyId: string; signature: string }> {
  const mat = await getSigningMaterial(env);
  const payload = new TextEncoder().encode(buildAttestationPayload(params));
  const sigBuf = await crypto.subtle.sign({ name: "Ed25519" }, mat.privateKey, payload);
  return {
    keyId: mat.keyId,
    signature: `ed25519:${bytesToBase64(new Uint8Array(sigBuf))}`,
  };
}

export async function verifyPackageAttestation(
  publicKeySpkiB64: string,
  signature: string,
  params: {
    name: string;
    version: string;
    integrity: string;
    securityStatus: string;
    publishedAt: string;
  },
): Promise<boolean> {
  if (!signature.startsWith("ed25519:")) return false;
  const sigBytes = base64ToBytes(signature.slice("ed25519:".length));
  const pubBytes = base64ToBytes(publicKeySpkiB64);
  const publicKey = await crypto.subtle.importKey(
    "spki",
    pubBytes,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const payload = new TextEncoder().encode(buildAttestationPayload(params));
  return crypto.subtle.verify({ name: "Ed25519" }, publicKey, sigBytes, payload);
}

export async function getWellKnownKeysDoc(env: Env): Promise<{
  issuer: string;
  algorithm: string;
  keys: Array<{ key_id: string; algorithm: string; public_key_spki_base64: string; status: string }>;
}> {
  const mat = await getSigningMaterial(env);
  return {
    issuer: env.WEB_ORIGIN || "https://capdux.org",
    algorithm: "Ed25519",
    keys: [
      {
        key_id: mat.keyId,
        algorithm: "Ed25519",
        public_key_spki_base64: mat.publicKeySpkiB64,
        status: "active",
      },
    ],
  };
}

export function isPermissiveLicense(license: string): boolean {
  const up = (license || "").trim().toUpperCase();
  if (!up) return false;
  for (const forbidden of ["AGPL", "GPL", "LGPL", "SSPL", "BSL"]) {
    if (up.includes(forbidden)) {
      if (up.includes(" OR ") && (up.includes("MIT") || up.includes("APACHE-2.0") || up.includes("BSD"))) {
        return true;
      }
      return false;
    }
  }
  for (const ok of [
    "MIT",
    "APACHE-2.0",
    "APACHE 2.0",
    "BSD",
    "ISC",
    "ZLIB",
    "CC0",
    "UNLICENSE",
    "0BSD",
    "MPL-2.0",
    "FTL",
    "CURL",
    "OLDAP-2.8",
    "IJG",
    "LIBPNG",
    "POSTGRESQL",
  ]) {
    if (up.includes(ok)) return true;
  }
  return false;
}

/**
 * Automated pre-publish security scan run by capdux.org before signing and accepting a package.
 */
export function runSecurityScan(input: {
  archiveFormat: ArchiveFormat | null;
  archiveSize: number;
  unpackedSize: number;
  license: string;
  manifest: Record<string, unknown>;
  readmeMd?: string;
}): SecurityScanReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  const archive_magic = input.archiveFormat !== null;
  if (!archive_magic) {
    errors.push("Invalid archive magic bytes (expected Zstd .cap 28 B5 2F FD or Gzip .tgz 1F 8B).");
  }

  // Guard against extreme decompression ratios (resource exhaustion protection)
  let compression_ratio_ok = true;
  if (input.unpackedSize > 0 && input.archiveSize > 0) {
    const ratio = input.unpackedSize / input.archiveSize;
    if (ratio > 200 || input.unpackedSize > 512 * 1024 * 1024) {
      compression_ratio_ok = false;
      errors.push(`Abnormal decompression ratio (${ratio.toFixed(1)}x) or unpacked size exceeds 512 MiB limit.`);
    }
  }

  const license_compliant = isPermissiveLicense(input.license);
  if (!license_compliant) {
    errors.push(`License '${input.license || "UNSPECIFIED"}' failed capdux.org permissive license compliance check.`);
  }

  // Reject arbitrary lifecycle shell execution hooks (common supply-chain vector in npm)
  let no_suspicious_hooks = true;
  const scripts = input.manifest.scripts as Record<string, unknown> | undefined;
  if (scripts && typeof scripts === "object") {
    for (const hook of ["preinstall", "postinstall", "install"]) {
      if (typeof scripts[hook] === "string" && scripts[hook].trim().length > 0) {
        no_suspicious_hooks = false;
        errors.push(`Disallowed lifecycle hook 'scripts.${hook}' detected (capdux.org prohibits arbitrary install-time shell hooks).`);
      }
    }
  }

  if (input.archiveFormat === "tgz") {
    warnings.push("Legacy .tgz format accepted; consider packing with `cap pack` (.cap Zstd) for ~40x smaller archives.");
  }

  const passed = errors.length === 0;
  return {
    passed,
    status: passed ? "verified" : "rejected",
    checks: {
      archive_magic,
      compression_ratio_ok,
      license_compliant,
      no_suspicious_hooks,
    },
    warnings,
    errors,
    scanned_at: new Date().toISOString(),
  };
}
