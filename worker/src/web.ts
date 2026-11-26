// capdux.org Server-Side Rendered (SSR) Geek Web Portal
// Zero external JS framework dependencies, inline dark-theme CSS, strict HTML escaping (XSS-safe).
import type { Env, PackageRow, VersionRow } from "./types";

interface PackageListRow extends PackageRow {
  archive_format: "cap" | "zst" | "tgz" | null;
  archive_size: number | null;
}

function formatArchiveExt(fmt: string | null | undefined): string {
  if (fmt === "tgz") return ".tgz";
  if (fmt === "zst") return ".tar.zst";
  return ".cap";
}

function shortSignature(sig: string | null | undefined): string {
  if (!sig) return "—";
  return sig.length > 34 ? `${sig.slice(0, 34)}…` : sig;
}

interface PortalStats {
  pkgCount: number;
  verCount: number;
  totalDownloads: number;
  mappingCount: number;
}

function escapeHtml(input: unknown): string {
  const s = input === null || input === undefined ? "" : String(input);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function encodePackagePath(name: string): string {
  return name
    .split("/")
    .map((seg) => (seg.startsWith("@") ? `@${encodeURIComponent(seg.slice(1))}` : encodeURIComponent(seg)))
    .join("/");
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return idx === 0 ? `${Math.round(val)} B` : `${val.toFixed(val >= 100 ? 0 : 1)} ${units[idx]}`;
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.floor(n).toLocaleString("en-US");
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1] : escapeHtml(iso.slice(0, 10));
}

function shortIntegrity(integrity: string): string {
  if (!integrity) return "—";
  const dash = integrity.indexOf("-");
  if (dash > 0 && integrity.length > dash + 17) {
    return `${integrity.slice(0, dash + 1 + 16)}…`;
  }
  return integrity.length > 24 ? `${integrity.slice(0, 24)}…` : integrity;
}

function parseJsonObject<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Lightweight, 100% XSS-safe Markdown renderer.
 * All raw input is HTML-escaped BEFORE any structural formatting is applied.
 */
function renderMarkdown(md: string): string {
  if (!md || !md.trim()) {
    return `<p class="muted">No README provided for this package version.</p>`;
  }

  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inCode = false;
  let codeLang = "";
  let codeLines: string[] = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  const renderInline = (rawLine: string): string => {
    let s = escapeHtml(rawLine);
    // Inline code
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    // Bold
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // Links [text](https://...)
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, href) => {
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    return s;
  };

  for (const line of lines) {
    const fence = /^```([a-zA-Z0-9_+-]*)\s*$/.exec(line);
    if (fence) {
      if (!inCode) {
        closeList();
        inCode = true;
        codeLang = escapeHtml(fence[1] || "text");
        codeLines = [];
      } else {
        out.push(`<pre class="code-block" data-lang="${codeLang}"><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        inCode = false;
        codeLang = "";
        codeLines = [];
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      closeList();
      continue;
    }

    const h3 = /^###\s+(.+)$/.exec(line);
    if (h3) {
      closeList();
      out.push(`<h3>${renderInline(h3[1])}</h3>`);
      continue;
    }
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      closeList();
      out.push(`<h2>${renderInline(h2[1])}</h2>`);
      continue;
    }
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1) {
      closeList();
      out.push(`<h1>${renderInline(h1[1])}</h1>`);
      continue;
    }

    const li = /^\s*[-*]\s+(.+)$/.exec(line);
    if (li) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${renderInline(li[1])}</li>`);
      continue;
    }

    closeList();
    if (/^---+$/.test(line.trim())) {
      out.push("<hr>");
    } else {
      out.push(`<p>${renderInline(line)}</p>`);
    }
  }

  if (inCode) {
    out.push(`<pre class="code-block" data-lang="${codeLang}"><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  }
  closeList();
  return out.join("\n");
}

const BASE_CSS = `
:root {
  --bg: #070b14;
  --bg-elev: #0d1322;
  --bg-card: #111829;
  --bg-code: #090e1a;
  --border: #1e2a44;
  --border-hi: #334a78;
  --text: #e6edf7;
  --muted: #8b9bb8;
  --accent: #38bdf8;
  --accent-2: #818cf8;
  --green: #34d399;
  --amber: #fbbf24;
  --red: #f87171;
  --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, Helvetica, Arial, sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: var(--sans); line-height: 1.55; -webkit-font-smoothing: antialiased; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 0 20px; }

/* Header */
.topbar { position: sticky; top: 0; z-index: 40; backdrop-filter: blur(12px); background: rgba(7, 11, 20, 0.86); border-bottom: 1px solid var(--border); }
.topbar-inner { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; padding: 12px 0; }
.brand { display: inline-flex; align-items: center; gap: 9px; font-weight: 800; font-size: 1.08rem; letter-spacing: -0.02em; color: var(--text); }
.brand:hover { text-decoration: none; }
.brand-dot { width: 10px; height: 10px; border-radius: 3px; background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 0 12px rgba(56, 189, 248, 0.7); }
.brand-tag { font-family: var(--mono); font-size: 0.68rem; padding: 2px 6px; border-radius: 4px; background: rgba(56, 189, 248, 0.12); color: var(--accent); border: 1px solid rgba(56, 189, 248, 0.3); }
.nav { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.nav a { color: var(--muted); font-size: 0.88rem; font-weight: 500; padding: 6px 10px; border-radius: 6px; transition: color .15s, background .15s; }
.nav a:hover, .nav a.active { color: var(--text); background: rgba(255, 255, 255, 0.06); text-decoration: none; }
.search-form { margin-left: auto; display: flex; align-items: center; gap: 8px; flex: 1 1 260px; max-width: 420px; }
.search-input { width: 100%; background: var(--bg-elev); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; font-size: 0.9rem; font-family: var(--mono); outline: none; transition: border-color .15s, box-shadow .15s; }
.search-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.16); }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 14px; border-radius: 8px; font-size: 0.86rem; font-weight: 600; border: 1px solid var(--border-hi); background: linear-gradient(135deg, rgba(56,189,248,0.18), rgba(129,140,248,0.18)); color: var(--text); cursor: pointer; transition: transform .1s, border-color .15s; }
.btn:hover { border-color: var(--accent); text-decoration: none; }
.btn:active { transform: translateY(1px); }

/* Hero */
.hero { position: relative; padding: 44px 0 30px; border-bottom: 1px solid var(--border); background: radial-gradient(60% 80% at 50% 0%, rgba(56, 189, 248, 0.12), transparent 70%); }
.hero h1 { margin: 0 0 12px; font-size: clamp(1.55rem, 3.2vw, 2.35rem); font-weight: 800; letter-spacing: -0.03em; line-height: 1.2; background: linear-gradient(90deg, #fff 0%, #bae6fd 60%, #c7d2fe 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
.hero-sub { margin: 0 0 22px; color: var(--muted); font-size: 0.98rem; max-width: 760px; }
.stats-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 22px; }
.stat-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
.stat-val { font-family: var(--mono); font-size: 1.45rem; font-weight: 700; color: var(--text); }
.stat-lbl { font-size: 0.78rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin-top: 2px; }

/* Filter bar */
.toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin: 24px 0 16px; }
.pills { display: flex; flex-wrap: wrap; gap: 8px; }
.pill { font-family: var(--mono); font-size: 0.8rem; padding: 5px 11px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); background: var(--bg-elev); }
.pill:hover, .pill.active { color: var(--text); border-color: var(--accent); background: rgba(56, 189, 248, 0.12); text-decoration: none; }

/* Package cards */
.pkg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 14px; margin-bottom: 48px; }
.pkg-card { display: flex; flex-direction: column; gap: 10px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; color: var(--text); transition: border-color .15s, transform .15s, box-shadow .15s; }
.pkg-card:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35); text-decoration: none; }
.pkg-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.pkg-name { font-family: var(--mono); font-weight: 700; font-size: 1.02rem; color: #f8fafc; word-break: break-word; }
.pkg-desc { margin: 0; font-size: 0.88rem; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 2.6em; }
.badges { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.badge { font-family: var(--mono); font-size: 0.72rem; font-weight: 600; padding: 2px 7px; border-radius: 5px; border: 1px solid var(--border); background: var(--bg-elev); color: var(--muted); white-space: nowrap; }
.badge-ver { color: var(--accent); border-color: rgba(56, 189, 248, 0.35); background: rgba(56, 189, 248, 0.1); }
.badge-zst { color: var(--green); border-color: rgba(52, 211, 153, 0.35); background: rgba(52, 211, 153, 0.1); }
.badge-lic { color: var(--accent-2); border-color: rgba(129, 140, 248, 0.35); background: rgba(129, 140, 248, 0.1); }
.badge-ai { color: #f472b6; border-color: rgba(244, 114, 182, 0.4); background: rgba(244, 114, 182, 0.12); }
.badge-warn { color: var(--amber); border-color: rgba(251, 191, 36, 0.4); background: rgba(251, 191, 36, 0.1); }
.badge-err { color: var(--red); border-color: rgba(248, 113, 113, 0.45); background: rgba(248, 113, 113, 0.12); }
.badge-verified { color: #34d399; border-color: rgba(52, 211, 153, 0.55); background: rgba(16, 185, 129, 0.14); box-shadow: 0 0 12px rgba(52, 211, 153, 0.14); }
.badge-perm { color: #fbbf24; border-color: rgba(251, 191, 36, 0.4); background: rgba(251, 191, 36, 0.09); }
.topbar-auth { display: flex; align-items: center; gap: 6px; }
.topbar-auth a { font-size: 0.84rem; font-weight: 600; padding: 6px 10px; border-radius: 7px; color: var(--muted); border: 1px solid transparent; transition: color .15s, border-color .15s, background .15s; }
.topbar-auth a:hover, .topbar-auth a.active { color: var(--text); background: rgba(255, 255, 255, 0.06); text-decoration: none; }
.topbar-auth a.auth-cta { color: var(--accent); border-color: rgba(56, 189, 248, 0.35); background: rgba(56, 189, 248, 0.1); }
.topbar-auth a.auth-cta:hover, .topbar-auth a.auth-cta.active { border-color: var(--accent); background: rgba(56, 189, 248, 0.18); }

/* Auth & Dashboard */
.auth-wrap { max-width: 460px; margin: 56px auto 80px; padding: 0 20px; }
.auth-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 14px; padding: 28px 26px; box-shadow: 0 18px 40px rgba(0, 0, 0, 0.35); }
.auth-title { margin: 0 0 6px; font-size: 1.45rem; font-weight: 800; letter-spacing: -0.02em; }
.form-group { margin-bottom: 14px; }
.form-label { display: block; font-size: 0.8rem; font-weight: 600; color: var(--muted); margin-bottom: 6px; font-family: var(--mono); }
.form-input, .form-select { width: 100%; background: var(--bg-elev); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 9px 12px; font-size: 0.9rem; font-family: var(--mono); outline: none; }
.form-input:focus, .form-select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.15); }
.alert-err { display: none; background: rgba(248, 113, 113, 0.12); border: 1px solid rgba(248, 113, 113, 0.45); color: #fecaca; border-radius: 8px; padding: 10px 12px; font-size: 0.85rem; margin-bottom: 14px; }
.alert-ok { display: none; background: rgba(52, 211, 153, 0.12); border: 1px solid rgba(52, 211, 153, 0.45); color: #a7f3d0; border-radius: 8px; padding: 10px 12px; font-size: 0.85rem; margin-bottom: 14px; }
.secret-box { display: none; background: #06131c; border: 1px solid rgba(52, 211, 153, 0.5); border-radius: 10px; padding: 14px; margin: 14px 0; }
.btn-danger { background: rgba(248, 113, 113, 0.14); color: #fca5a5; border: 1px solid rgba(248, 113, 113, 0.4); padding: 4px 9px; border-radius: 6px; font-family: var(--mono); font-size: 0.75rem; font-weight: 600; cursor: pointer; }
.btn-danger:hover { background: rgba(248, 113, 113, 0.25); }
.btn-ghost { background: transparent; color: var(--muted); border: 1px solid var(--border); padding: 6px 12px; border-radius: 7px; font-size: 0.82rem; font-weight: 600; cursor: pointer; }
.btn-ghost:hover { color: var(--text); border-color: var(--border-hi); }
.dash-grid { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 20px; margin: 24px 0 64px; align-items: start; }
@media (max-width: 900px) { .dash-grid { grid-template-columns: 1fr; } }
.pkg-foot { margin-top: auto; display: flex; align-items: center; justify-content: space-between; font-family: var(--mono); font-size: 0.76rem; color: var(--muted); padding-top: 8px; border-top: 1px solid rgba(30, 42, 68, 0.7); }

/* Detail page */
.crumb { display: flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 0.82rem; color: var(--muted); margin: 22px 0 12px; flex-wrap: wrap; }
.pkg-hero { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 18px; padding-bottom: 20px; border-bottom: 1px solid var(--border); }
.pkg-title { margin: 0 0 8px; font-family: var(--mono); font-size: clamp(1.45rem, 3vw, 2rem); font-weight: 800; color: #fff; word-break: break-word; }
.cmd-box { display: flex; align-items: center; gap: 10px; background: var(--bg-code); border: 1px solid var(--border-hi); border-radius: 10px; padding: 10px 12px; font-family: var(--mono); font-size: 0.9rem; max-width: 100%; }
.cmd-box code { color: var(--green); overflow-x: auto; white-space: nowrap; }
.copy-btn { background: rgba(56, 189, 248, 0.12); color: var(--accent); border: 1px solid rgba(56, 189, 248, 0.35); border-radius: 6px; padding: 5px 10px; font-family: var(--mono); font-size: 0.76rem; font-weight: 600; cursor: pointer; white-space: nowrap; }
.copy-btn:hover { background: rgba(56, 189, 248, 0.22); }
.detail-grid { display: grid; grid-template-columns: minmax(0, 1fr) 310px; gap: 22px; margin: 24px 0 56px; align-items: start; }
.panel { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; margin-bottom: 18px; }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0 0 14px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
.panel-title { margin: 0; font-size: 0.96rem; font-weight: 700; letter-spacing: 0.01em; display: flex; align-items: center; gap: 8px; }
.code-block { margin: 0; background: var(--bg-code); border: 1px solid var(--border); border-radius: 8px; padding: 14px; overflow-x: auto; font-family: var(--mono); font-size: 0.83rem; line-height: 1.55; color: #dbeafe; }
.md h1, .md h2, .md h3 { margin: 1.1em 0 0.5em; color: #f8fafc; }
.md h1 { font-size: 1.35rem; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
.md h2 { font-size: 1.12rem; }
.md h3 { font-size: 0.98rem; }
.md p { margin: 0.6em 0; color: #cbd5e1; }
.md ul { margin: 0.5em 0 0.8em 1.2em; padding: 0; color: #cbd5e1; }
.md li { margin: 0.3em 0; }
.md code { font-family: var(--mono); font-size: 0.84em; background: rgba(148, 163, 184, 0.14); padding: 1px 5px; border-radius: 4px; color: #e2e8f0; }
.md pre code { background: transparent; padding: 0; }
.md hr { border: 0; border-top: 1px solid var(--border); margin: 16px 0; }

/* Table */
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 0.84rem; font-family: var(--mono); }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
th { color: var(--muted); font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.05em; }
tr:last-child td { border-bottom: 0; }
.kv { display: flex; justify-content: space-between; gap: 10px; padding: 7px 0; border-bottom: 1px solid rgba(30, 42, 68, 0.65); font-size: 0.85rem; }
.kv:last-child { border-bottom: 0; }
.kv-k { color: var(--muted); }
.kv-v { font-family: var(--mono); color: var(--text); text-align: right; word-break: break-all; }
.banner-warn { background: rgba(251, 191, 36, 0.1); border: 1px solid rgba(251, 191, 36, 0.4); color: #fde68a; border-radius: 10px; padding: 12px 14px; margin: 14px 0; font-size: 0.9rem; }
.muted { color: var(--muted); }
.empty { text-align: center; padding: 56px 20px; background: var(--bg-card); border: 1px dashed var(--border-hi); border-radius: 12px; margin-bottom: 48px; }
.footer { border-top: 1px solid var(--border); padding: 24px 0 36px; color: var(--muted); font-size: 0.82rem; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; }

@media (max-width: 900px) {
  .detail-grid { grid-template-columns: 1fr; }
  .stats-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 600px) {
  .search-form { max-width: none; flex-basis: 100%; }
  .pkg-grid { grid-template-columns: 1fr; }
}
`;

const COPY_SCRIPT = `<script>
document.addEventListener('click',function(e){
  var b=e.target.closest('[data-copy]');
  if(!b)return;
  var t=b.getAttribute('data-copy')||'';
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(t).then(function(){
      var o=b.textContent;b.textContent='Copied!';
      setTimeout(function(){b.textContent=o;},1400);
    });
  }
});
</script>`;

function renderLayout(opts: {
  title: string;
  description: string;
  env: Env;
  activeNav?: "all" | "@cap" | "@web" | "login" | "register" | "dashboard";
  query?: string;
  scope?: string;
  body: string;
}): string {
  const registryOrigin = (opts.env.REGISTRY_ORIGIN || "https://registry.capdux.org").replace(/\/+$/, "");
  const scopeVal = opts.scope || "";
  const queryVal = opts.query || "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(opts.title)}</title>
  <meta name="description" content="${escapeHtml(opts.description)}">
  <meta name="theme-color" content="#070b14">
  <style>${BASE_CSS}</style>
</head>
<body>
  <header class="topbar">
    <div class="wrap topbar-inner">
      <a class="brand" href="/">
        <span class="brand-dot" aria-hidden="true"></span>
        <span>capdux.org</span>
        <span class="brand-tag">CP REGISTRY</span>
      </a>
      <nav class="nav" aria-label="Main navigation">
        <a href="/" class="${opts.activeNav === "all" ? "active" : ""}">Packages</a>
        <a href="/?scope=%40cap" class="${opts.activeNav === "@cap" ? "active" : ""}">@cap</a>
        <a href="/?scope=%40web" class="${opts.activeNav === "@web" ? "active" : ""}">@web</a>
        <a href="${escapeHtml(registryOrigin)}/v1/registry.json" target="_blank" rel="noopener noreferrer">Registry JSON</a>
        <a href="https://github.com/cp-lang/cp" target="_blank" rel="noopener noreferrer">Docs</a>
      </nav>
      <form class="search-form" method="GET" action="/">
        ${scopeVal ? `<input type="hidden" name="scope" value="${escapeHtml(scopeVal)}">` : ""}
        <input class="search-input" type="search" name="q" value="${escapeHtml(queryVal)}" placeholder="Search @cap/lru, @web/jwt, zstd..." aria-label="Search packages">
        <button class="btn" type="submit">Search</button>
      </form>
      <div class="topbar-auth" aria-label="Account navigation">
        <a href="/login" class="${opts.activeNav === "login" ? "active" : ""}">Sign In</a>
        <a href="/register" class="${opts.activeNav === "register" ? "active" : ""}">Register</a>
        <a href="/dashboard" class="auth-cta ${opts.activeNav === "dashboard" ? "active" : ""}">Dashboard</a>
      </div>
    </div>
  </header>
  <main>${opts.body}</main>
  <footer class="wrap footer">
    <div><strong>capdux.org</strong> — Official CP &amp; Cap Package Registry · Zstd (<code>.cap</code>) + Ed25519 Attestation + Sparse Index</div>
    <div>Powered by Cloudflare Workers, D1 &amp; R2 Zero-Egress Edge</div>
  </footer>
  ${COPY_SCRIPT}
</body>
</html>`;
}

function htmlResponse(html: string, status = 200, cacheControl = "public, max-age=30, stale-while-revalidate=120"): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
}

async function fetchPortalStats(env: Env): Promise<PortalStats> {
  const [pkgStats, verStats, mapStats] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS pkg_count, COALESCE(SUM(total_downloads), 0) AS total_dl FROM packages`,
    ).first<{ pkg_count: number; total_dl: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS ver_count FROM package_versions`).first<{ ver_count: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS map_count FROM upstream_mappings`).first<{ map_count: number }>(),
  ]);

  return {
    pkgCount: Number(pkgStats?.pkg_count ?? 0),
    verCount: Number(verStats?.ver_count ?? 0),
    totalDownloads: Number(pkgStats?.total_dl ?? 0),
    mappingCount: Number(mapStats?.map_count ?? 0),
  };
}

export async function renderHomePage(env: Env, url: URL): Promise<Response> {
  const q = (url.searchParams.get("q") || "").trim().slice(0, 128);
  const rawScope = (url.searchParams.get("scope") || "").trim();
  const scope = rawScope === "@cap" || rawScope === "@web" ? rawScope : "";

  const whereClauses: string[] = [];
  const binds: unknown[] = [];

  if (scope) {
    whereClauses.push(`p.scope = ?`);
    binds.push(scope);
  }
  if (q) {
    const pattern = `%${q.toLowerCase()}%`;
    whereClauses.push(
      `(LOWER(p.name) LIKE ? OR LOWER(p.description) LIKE ? OR LOWER(p.keywords_json) LIKE ? OR EXISTS (SELECT 1 FROM upstream_mappings um WHERE um.cp_target = p.name AND (LOWER(um.source_name) LIKE ? OR LOWER(um.aliases_json) LIKE ?)))`,
    );
    binds.push(pattern, pattern, pattern, pattern, pattern);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
  const listSql = `
    SELECT p.*, v.archive_format, v.archive_size
    FROM packages p
    LEFT JOIN package_versions v
      ON v.package_id = p.id AND v.version = p.latest_version
    ${whereSql}
    ORDER BY p.total_downloads DESC, p.updated_at DESC
    LIMIT 120
  `;

  const [stats, listRes] = await Promise.all([
    fetchPortalStats(env),
    env.DB.prepare(listSql).bind(...binds).all<PackageListRow>(),
  ]);

  const packages = listRes.results || [];
  const upstreamByTarget = new Map<string, Array<{ registry: string; name: string }>>();
  if (packages.length > 0) {
    const placeholders = packages.map(() => "?").join(",");
    const upRes = await env.DB.prepare(
      `SELECT cp_target, source_registry, source_name FROM upstream_mappings WHERE cp_target IN (${placeholders}) ORDER BY source_registry ASC, source_name ASC`,
    )
      .bind(...packages.map((p) => p.name))
      .all<{ cp_target: string; source_registry: string; source_name: string }>();
    for (const row of upRes.results || []) {
      const arr = upstreamByTarget.get(row.cp_target) || [];
      arr.push({ registry: row.source_registry, name: row.source_name });
      upstreamByTarget.set(row.cp_target, arr);
    }
  }
  const activeNav: "all" | "@cap" | "@web" = scope === "@cap" ? "@cap" : scope === "@web" ? "@web" : "all";

  const cardsHtml =
    packages.length === 0
      ? `<div class="empty">
          <h3>No matching packages found</h3>
          <p class="muted">No packages matched your current filter${q ? ` for <code>${escapeHtml(q)}</code>` : ""}.</p>
          <p><a class="btn" href="/">Reset Filters</a></p>
        </div>`
      : `<div class="pkg-grid">
          ${packages
            .map((pkg) => {
              const fmt = formatArchiveExt(pkg.archive_format);
              const href = `/packages/${encodePackagePath(pkg.name)}`;
              const verText = pkg.latest_version ? `v${pkg.latest_version}` : "0.0.0";
              const licText = pkg.license || "MIT";
              const descText = pkg.description || "Official CP package";
              const sizeText = pkg.archive_size ? formatBytes(pkg.archive_size) : "";
              const upList = upstreamByTarget.get(pkg.name) || [];
              const upBadgeHtml = upList
                .slice(0, 2)
                .map((u) => `<span class="badge badge-ai" title="Original upstream package: ${escapeHtml(u.registry)}:${escapeHtml(u.name)}">from ${escapeHtml(u.registry)}:${escapeHtml(u.name)}</span>`)
                .join("");
              return `<a class="pkg-card" href="${escapeHtml(href)}">
                <div class="pkg-head">
                  <span class="pkg-name">${escapeHtml(pkg.name)}</span>
                  <span class="badge badge-ver">${escapeHtml(verText)}</span>
                </div>
                <p class="pkg-desc">${escapeHtml(descText)}</p>
                <div class="badges">
                  ${upBadgeHtml}
                  <span class="badge badge-lic">${escapeHtml(licText)}</span>
                  <span class="badge badge-zst">${escapeHtml(fmt)}</span>
                  ${sizeText ? `<span class="badge">${escapeHtml(sizeText)}</span>` : ""}
                  ${pkg.deprecated ? `<span class="badge badge-warn">deprecated</span>` : ""}
                </div>
                <div class="pkg-foot">
                  <span>&#8595; ${escapeHtml(formatNumber(pkg.total_downloads))} downloads</span>
                  <span>${escapeHtml(formatDate(pkg.updated_at))}</span>
                </div>
              </a>`;
            })
            .join("\n")}
        </div>`;

  const makeScopeUrl = (targetScope: string) => {
    const params = new URLSearchParams();
    if (targetScope) params.set("scope", targetScope);
    if (q) params.set("q", q);
    const qs = params.toString();
    return qs ? `/?${qs}` : "/";
  };

  const body = `
    <section class="hero">
      <div class="wrap">
        <h1>The Official Package Registry for CP &amp; Cap — Powered by Zstd (.tar.zst) &amp; Global Edge</h1>
        <p class="hero-sub">
          Zero-egress R2 distribution, static Sparse Index resolution, AI-First <code>.d.cp</code> interface stubs, and deterministic SHA-256 integrity verification.
        </p>
        <div class="cmd-box" style="display:inline-flex;">
          <code>$ cap add @cap/lru</code>
          <button class="copy-btn" type="button" data-copy="cap add @cap/lru">Copy</button>
        </div>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-val">${escapeHtml(formatNumber(stats.pkgCount))}</div>
            <div class="stat-lbl">Packages</div>
          </div>
          <div class="stat-card">
            <div class="stat-val">${escapeHtml(formatNumber(stats.verCount))}</div>
            <div class="stat-lbl">Versions</div>
          </div>
          <div class="stat-card">
            <div class="stat-val">${escapeHtml(formatNumber(stats.totalDownloads))}</div>
            <div class="stat-lbl">Total Downloads</div>
          </div>
          <div class="stat-card">
            <div class="stat-val">${escapeHtml(formatNumber(stats.mappingCount))}</div>
            <div class="stat-lbl">Official Mappings</div>
          </div>
        </div>
      </div>
    </section>
    <section class="wrap">
      <div class="toolbar">
        <div class="pills">
          <a class="pill ${scope === "" ? "active" : ""}" href="${escapeHtml(makeScopeUrl(""))}">All Scopes</a>
          <a class="pill ${scope === "@cap" ? "active" : ""}" href="${escapeHtml(makeScopeUrl("@cap"))}">@cap/*</a>
          <a class="pill ${scope === "@web" ? "active" : ""}" href="${escapeHtml(makeScopeUrl("@web"))}">@web/*</a>
        </div>
        <div class="muted" style="font-family:var(--mono);font-size:0.82rem;">
          Showing ${escapeHtml(String(packages.length))} package${packages.length === 1 ? "" : "s"}${q ? ` matching "${escapeHtml(q)}"` : ""}${scope ? ` in ${escapeHtml(scope)}` : ""}
        </div>
      </div>
      ${cardsHtml}
    </section>
  `;

  const html = renderLayout({
    title: q ? `Search "${q}" — capdux.org` : scope ? `${scope} Packages — capdux.org` : "capdux.org — Official CP & Cap Package Registry",
    description: "The Official Package Registry for CP & Cap — Powered by Zstd (.tar.zst) & Global Edge",
    env,
    activeNav,
    query: q,
    scope,
    body,
  });

  return htmlResponse(html, 200, q ? "no-store" : "public, max-age=30, stale-while-revalidate=120");
}

function renderNotFoundPage(env: Env, pkgName: string): Response {
  const body = `
    <section class="wrap" style="padding: 56px 20px 80px;">
      <div class="empty">
        <div class="badge badge-err" style="display:inline-block;margin-bottom:12px;">HTTP 404</div>
        <h1 style="margin:0 0 10px;font-family:var(--mono);font-size:1.6rem;">Package Not Found</h1>
        <p class="muted" style="max-width:520px;margin:0 auto 22px;">
          The package <code>${escapeHtml(pkgName)}</code> does not exist in the capdux.org registry yet.
        </p>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
          <a class="btn" href="/">Back to Registry</a>
          <a class="pill" href="/?q=${encodeURIComponent(pkgName.replace(/^@[^/]+\//, ""))}">Search similar packages</a>
        </div>
      </div>
    </section>
  `;

  const html = renderLayout({
    title: `404 ${pkgName} — capdux.org`,
    description: `Package ${pkgName} not found on capdux.org`,
    env,
    body,
  });

  return htmlResponse(html, 404, "public, max-age=15");
}

export async function renderPackagePage(env: Env, pkgName: string): Promise<Response> {
  let decodedName = pkgName;
  try {
    decodedName = decodeURIComponent(pkgName).trim();
  } catch {
    decodedName = pkgName.trim();
  }

  if (!decodedName) {
    return renderNotFoundPage(env, pkgName);
  }

  const pkg = await env.DB.prepare(`SELECT * FROM packages WHERE name = ? LIMIT 1`)
    .bind(decodedName)
    .first<PackageRow>();

  if (!pkg) {
    return renderNotFoundPage(env, decodedName);
  }

  const [verRes, upMapRes] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM package_versions WHERE package_id = ? ORDER BY published_at DESC`,
    )
      .bind(pkg.id)
      .all<VersionRow>(),
    env.DB.prepare(
      `SELECT source_registry, source_name, source_repo, license FROM upstream_mappings WHERE cp_target = ? ORDER BY source_registry ASC, source_name ASC`,
    )
      .bind(pkg.name)
      .all<{ source_registry: string; source_name: string; source_repo: string; license: string }>(),
  ]);

  const upstreamSources = upMapRes.results || [];
  const versions = verRes.results || [];
  const latestVer =
    versions.find((v) => v.version === pkg.latest_version) ||
    versions[0] ||
    null;

  const dlOrigin = (env.DOWNLOAD_ORIGIN || "https://dl.capdux.org").replace(/\/+$/, "");
  const indexOrigin = (env.INDEX_ORIGIN || "https://index.capdux.org").replace(/\/+$/, "");
  const repoHref = safeUrl(pkg.repository);
  const homeHref = safeUrl(pkg.homepage);
  const installCmd = `cap add ${pkg.name}`;

  const depsMap = parseJsonObject<Record<string, string>>(latestVer?.deps_json, {});
  const depEntries = Object.entries(depsMap);

  const prebuiltMap = parseJsonObject<Record<string, { r2_key?: string; size?: number; integrity?: string }>>(
    latestVer?.prebuilt_json,
    {},
  );
  const prebuiltEntries = Object.entries(prebuiltMap);

  let keywords: string[] = [];
  try {
    const parsedKw = JSON.parse(pkg.keywords_json || "[]");
    if (Array.isArray(parsedKw)) {
      keywords = parsedKw.filter((k): k is string => typeof k === "string" && k.trim().length > 0).slice(0, 16);
    }
  } catch {}

  const dcpContent = (latestVer?.types_dcp || "").trim();
  const latestFmt = formatArchiveExt(latestVer?.archive_format);
  const activeNav: "all" | "@cap" | "@web" = pkg.scope === "@cap" ? "@cap" : pkg.scope === "@web" ? "@web" : "all";

  const securityStatus = (latestVer?.security_status || "").trim();
  const platformSig = (latestVer?.platform_sig || "").trim();
  const signingKeyId = (latestVer?.signing_key_id || "").trim();
  const isVerified = securityStatus === "verified" || platformSig.length > 0;

  const manifestObj = parseJsonObject<Record<string, unknown>>(latestVer?.manifest_json, {});
  const permsFromCol = parseJsonObject<Record<string, unknown>>(latestVer?.permissions_json, {});
  const permsFromManifest =
    manifestObj.permissions && typeof manifestObj.permissions === "object" && !Array.isArray(manifestObj.permissions)
      ? (manifestObj.permissions as Record<string, unknown>)
      : {};
  const permissionsMap = Object.keys(permsFromCol).length > 0 ? permsFromCol : permsFromManifest;
  const permissionEntries = Object.entries(permissionsMap);

  const permissionsHtml =
    permissionEntries.length === 0
      ? `<div class="badges"><span class="badge badge-verified">Zero Permissions · Sandboxed</span></div>
         <p class="muted" style="font-size:0.82rem;margin:8px 0 0;">This package declares no privileged system capabilities (fs, net, env, ffi, subprocess).</p>`
      : permissionEntries
          .map(([permKey, permVal]) => {
            const valText =
              typeof permVal === "boolean"
                ? permVal
                  ? "allowed"
                  : "denied"
                : Array.isArray(permVal)
                  ? permVal.map(String).join(", ")
                  : typeof permVal === "object" && permVal !== null
                    ? JSON.stringify(permVal)
                    : String(permVal);
            return `<div class="kv"><span class="kv-k" style="font-family:var(--mono);"><span class="badge badge-perm">${escapeHtml(permKey)}</span></span><span class="kv-v">${escapeHtml(valText)}</span></div>`;
          })
          .join("");

  const securityPanelHtml = `
    <div class="badges" style="margin-bottom:10px;">
      ${
        isVerified
          ? `<span class="badge badge-verified">&#10003; Verified by capdux.org</span>`
          : `<span class="badge badge-warn">Unverified / Pending Scan</span>`
      }
      <span class="badge">Ed25519</span>
    </div>
    <div class="kv">
      <span class="kv-k">Status</span>
      <span class="kv-v">${escapeHtml(securityStatus || (isVerified ? "verified" : "pending"))}</span>
    </div>
    <div class="kv">
      <span class="kv-k">Signing Key ID</span>
      <span class="kv-v">${escapeHtml(signingKeyId || "capdux-ed25519-v1")}</span>
    </div>
    <div class="kv">
      <span class="kv-k">Platform Sig</span>
      <span class="kv-v" title="${escapeHtml(platformSig || "Not signed")}">
        ${escapeHtml(shortSignature(platformSig))}
        ${platformSig ? `<button class="copy-btn" type="button" style="margin-left:6px;padding:2px 6px;font-size:0.7rem;" data-copy="${escapeHtml(platformSig)}">Copy</button>` : ""}
      </span>
    </div>
    <div style="margin-top:12px;">
      <a class="pill" href="/.well-known/capdux-keys.json" target="_blank" rel="noopener noreferrer">Verify Keys (/.well-known/capdux-keys.json) &#8599;</a>
    </div>
  `;

  const prebuiltHtml =
    prebuiltEntries.length === 0
      ? `<div class="badges"><span class="badge badge-zst">Pure CP / Source Archive</span></div>
         <p class="muted" style="font-size:0.82rem;margin:8px 0 0;">Compiles natively across all Cap targets via Zig backend.</p>`
      : `<div class="badges">
          ${prebuiltEntries
            .map(([target, info]) => {
              const sz = info?.size ? ` · ${formatBytes(info.size)}` : "";
              const dlUrl = info?.r2_key ? `${dlOrigin}/${info.r2_key}` : "";
              return dlUrl
                ? `<a class="badge badge-zst" href="${escapeHtml(dlUrl)}" title="${escapeHtml(info?.integrity || target)}">${escapeHtml(target)}${escapeHtml(sz)}</a>`
                : `<span class="badge badge-zst">${escapeHtml(target)}${escapeHtml(sz)}</span>`;
            })
            .join("")}
        </div>`;

  const depsHtml =
    depEntries.length === 0
      ? `<p class="muted" style="font-size:0.84rem;margin:0;">Zero runtime dependencies.</p>`
      : depEntries
          .map(([depName, depVer]) => {
            const isStd = depName.startsWith("cap:");
            const label = isStd
              ? `<span>${escapeHtml(depName)}</span>`
              : `<a href="/packages/${escapeHtml(encodePackagePath(depName))}">${escapeHtml(depName)}</a>`;
            return `<div class="kv"><span class="kv-k" style="font-family:var(--mono);">${label}</span><span class="kv-v">${escapeHtml(depVer)}</span></div>`;
          })
          .join("");

  const versionsTableHtml =
    versions.length === 0
      ? `<p class="muted">No published versions recorded.</p>`
      : `<div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>Format / Size</th>
                <th>Integrity (SHA-256)</th>
                <th>Downloads</th>
                <th>Published</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${versions
                .map((v) => {
                  const fmt = formatArchiveExt(v.archive_format);
                  const dlUrl = `${dlOrigin}/${v.r2_key}`;
                  const yankedBadge = v.yanked
                    ? `<span class="badge badge-err" title="${escapeHtml(v.yank_reason || "Yanked")}">YANKED</span>`
                    : v.version === pkg.latest_version
                      ? `<span class="badge badge-zst">latest</span>`
                      : `<span class="badge">${escapeHtml(v.dist_tag || "release")}</span>`;
                  return `<tr>
                    <td><a href="${escapeHtml(dlUrl)}" title="Download ${escapeHtml(fmt)}">v${escapeHtml(v.version)}</a></td>
                    <td>${escapeHtml(fmt)} · ${escapeHtml(formatBytes(v.archive_size))}</td>
                    <td title="${escapeHtml(v.integrity)}">${escapeHtml(shortIntegrity(v.integrity))}</td>
                    <td>${escapeHtml(formatNumber(v.downloads))}</td>
                    <td>${escapeHtml(formatDate(v.published_at))}</td>
                    <td>${yankedBadge}</td>
                  </tr>`;
                })
                .join("\n")}
            </tbody>
          </table>
        </div>`;

  const body = `
    <div class="wrap">
      <nav class="crumb" aria-label="Breadcrumb">
        <a href="/">Packages</a>
        <span>/</span>
        ${pkg.scope ? `<a href="/?scope=${encodeURIComponent(pkg.scope)}">${escapeHtml(pkg.scope)}</a><span>/</span>` : ""}
        <span style="color:var(--text);">${escapeHtml(pkg.name)}</span>
      </nav>

      <section class="pkg-hero">
        <div style="flex:1 1 460px;min-width:0;">
          <h1 class="pkg-title">${escapeHtml(pkg.name)}</h1>
          <div class="badges" style="margin-bottom:10px;">
            <span class="badge badge-ver">v${escapeHtml(pkg.latest_version || latestVer?.version || "0.0.0")}</span>
            <span class="badge badge-lic">${escapeHtml(pkg.license || "MIT")}</span>
            <span class="badge badge-zst">${escapeHtml(latestFmt)}</span>
            ${isVerified ? `<span class="badge badge-verified">&#10003; Verified by capdux.org</span>` : ""}
            ${dcpContent ? `<span class="badge badge-ai">AI-First .d.cp</span>` : ""}
          </div>
          <p class="muted" style="margin:0 0 12px;max-width:700px;">${escapeHtml(pkg.description || "Official CP package.")}</p>
          ${
            upstreamSources.length > 0
              ? `<div style="margin:0 0 12px;padding:8px 12px;border-radius:8px;background:rgba(56,189,248,0.08);border:1px solid rgba(56,189,248,0.22);font-size:0.84rem;">
                  <span class="muted">Absorbed / Referenced From:</span>
                  ${upstreamSources
                    .map((s) => {
                      const safeRepo = safeUrl(s.source_repo);
                      const label = `${s.source_registry}:${s.source_name}`;
                      const shortTarget = pkg.name.replace(/^@[^/]+\//, "");
                      const renamedTag = s.source_name !== shortTarget ? ` <span class="muted">(renamed from <code>${escapeHtml(s.source_name)}</code>)</span>` : "";
                      return safeRepo
                        ? `<a href="${escapeHtml(safeRepo)}" target="_blank" rel="noopener noreferrer" style="margin-left:8px;font-family:var(--mono);font-weight:600;">${escapeHtml(label)} &#8599;</a>${renamedTag}`
                        : `<code style="margin-left:8px;">${escapeHtml(label)}</code>${renamedTag}`;
                    })
                    .join(" · ")}
                </div>`
              : ""
          }
          <div class="badges">
            ${repoHref ? `<a class="pill" href="${escapeHtml(repoHref)}" target="_blank" rel="noopener noreferrer">Repository &#8599;</a>` : ""}
            ${homeHref ? `<a class="pill" href="${escapeHtml(homeHref)}" target="_blank" rel="noopener noreferrer">Homepage &#8599;</a>` : ""}
            <a class="pill" href="${escapeHtml(`${indexOrigin}/index/${encodePackagePath(pkg.name)}.json`)}" target="_blank" rel="noopener noreferrer">Sparse Index JSON &#8599;</a>
          </div>
        </div>
        <div>
          <div style="font-size:0.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">Install with Cap</div>
          <div class="cmd-box">
            <code>$ ${escapeHtml(installCmd)}</code>
            <button class="copy-btn" type="button" data-copy="${escapeHtml(installCmd)}">Copy</button>
          </div>
        </div>
      </section>

      ${pkg.deprecated ? `<div class="banner-warn"><strong>Deprecated:</strong> ${escapeHtml(pkg.deprecated)}</div>` : ""}

      <div class="detail-grid">
        <div>
          <section class="panel">
            <div class="panel-head">
              <h2 class="panel-title">
                <span>AI Interface Stub</span>
                <span class="badge badge-ai">.d.cp</span>
              </h2>
              ${dcpContent ? `<button class="copy-btn" type="button" data-copy="${escapeHtml(dcpContent)}">Copy .d.cp</button>` : ""}
            </div>
            ${
              dcpContent
                ? `<pre class="code-block" data-lang="cp"><code>${escapeHtml(dcpContent)}</code></pre>`
                : `<p class="muted" style="margin:0;font-size:0.86rem;">No <code>.d.cp</code> AI interface stub published for this version.</p>`
            }
          </section>

          <section class="panel">
            <div class="panel-head">
              <h2 class="panel-title">README</h2>
              <span class="badge">Markdown</span>
            </div>
            <div class="md">${renderMarkdown(latestVer?.readme_md || "")}</div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <h2 class="panel-title">Version History</h2>
              <span class="badge">${escapeHtml(String(versions.length))} release${versions.length === 1 ? "" : "s"}</span>
            </div>
            ${versionsTableHtml}
          </section>
        </div>

        <aside>
          <section class="panel">
            <div class="panel-head">
              <h2 class="panel-title">Package Metadata</h2>
            </div>
            <div class="kv"><span class="kv-k">Latest</span><span class="kv-v">v${escapeHtml(pkg.latest_version || latestVer?.version || "0.0.0")}</span></div>
            <div class="kv"><span class="kv-k">License</span><span class="kv-v">${escapeHtml(pkg.license || "MIT")}</span></div>
            <div class="kv"><span class="kv-k">Archive</span><span class="kv-v">${escapeHtml(latestFmt)} (${escapeHtml(formatBytes(latestVer?.archive_size || 0))})</span></div>
            <div class="kv"><span class="kv-k">Unpacked</span><span class="kv-v">${escapeHtml(formatBytes(latestVer?.unpacked_size || 0))}</span></div>
            <div class="kv"><span class="kv-k">Downloads</span><span class="kv-v">${escapeHtml(formatNumber(pkg.total_downloads))}</span></div>
            <div class="kv"><span class="kv-k">Updated</span><span class="kv-v">${escapeHtml(formatDate(pkg.updated_at))}</span></div>
            ${
              keywords.length > 0
                ? `<div style="margin-top:12px;"><div class="kv-k" style="font-size:0.78rem;margin-bottom:6px;">Keywords</div><div class="badges">${keywords
                    .map((k) => `<a class="badge" href="/?q=${encodeURIComponent(k)}">${escapeHtml(k)}</a>`)
                    .join("")}</div></div>`
                : ""
            }
          </section>

          <section class="panel">
            <div class="panel-head">
              <h2 class="panel-title">Security &amp; Attestation</h2>
            </div>
            ${securityPanelHtml}
          </section>

          <section class="panel">
            <div class="panel-head">
              <h2 class="panel-title">Declared Permissions</h2>
              <span class="badge">${escapeHtml(String(permissionEntries.length))}</span>
            </div>
            ${permissionsHtml}
          </section>

          <section class="panel">
            <div class="panel-head">
              <h2 class="panel-title">Prebuilt Matrix</h2>
            </div>
            ${prebuiltHtml}
          </section>

          <section class="panel">
            <div class="panel-head">
              <h2 class="panel-title">Runtime Dependencies</h2>
              <span class="badge">${escapeHtml(String(depEntries.length))}</span>
            </div>
            ${depsHtml}
          </section>
        </aside>
      </div>
    </div>
  `;

  const html = renderLayout({
    title: `${pkg.name} v${pkg.latest_version || latestVer?.version || "0.0.0"} — capdux.org`,
    description: pkg.description || `${pkg.name} on capdux.org`,
    env,
    activeNav,
    scope: pkg.scope,
    body,
  });

  return htmlResponse(html, 200);
}

export async function renderAuthPage(env: Env, mode: "login" | "register"): Promise<Response> {
  const isRegister = mode === "register";
  const titleText = isRegister ? "Create Developer Account" : "Sign In to capdux.org";
  const subText = isRegister
    ? "Register to publish .cap packages, manage Ed25519-signed releases, and mint API tokens."
    : "Authenticate with your capdux.org developer credentials to access your token dashboard.";

  const body = `
    <section class="auth-wrap">
      <div class="auth-card">
        <div class="badges" style="margin-bottom:12px;">
          <span class="badge badge-ver">CAPDUX AUTH</span>
          <span class="badge badge-zst">PBKDF2-SHA256</span>
        </div>
        <h1 class="auth-title">${escapeHtml(titleText)}</h1>
        <p class="muted" style="margin:0 0 20px;font-size:0.88rem;">${escapeHtml(subText)}</p>

        <div id="auth-err" class="alert-err" role="alert"></div>
        <div id="auth-ok" class="alert-ok" role="status"></div>

        <form id="auth-form" autocomplete="on">
          <div class="form-group">
            <label class="form-label" for="username">${isRegister ? "Username" : "Username or Email"}</label>
            <input class="form-input" id="username" name="username" type="text" required autocomplete="username" placeholder="${isRegister ? "alice" : "alice or alice@example.com"}">
          </div>
          ${
            isRegister
              ? `<div class="form-group">
                  <label class="form-label" for="email">Email</label>
                  <input class="form-input" id="email" name="email" type="email" required autocomplete="email" placeholder="alice@example.com">
                </div>`
              : ""
          }
          <div class="form-group">
            <label class="form-label" for="password">Password${isRegister ? " (min 8 chars)" : ""}</label>
            <input class="form-input" id="password" name="password" type="password" required minlength="${isRegister ? "8" : "1"}" autocomplete="${isRegister ? "new-password" : "current-password"}" placeholder="••••••••">
          </div>
          <button id="auth-submit" class="btn" type="submit" style="width:100%;margin-top:6px;padding:10px 14px;">
            ${isRegister ? "Create Account &amp; Mint Token" : "Sign In"}
          </button>
        </form>

        <div style="text-align:center;font-size:0.78rem;color:var(--muted);margin:16px 0 12px;">— or continue with OAuth (Capdux SSO) —</div>
        <div style="display:flex;gap:6px;margin-bottom:10px;">
          <button type="button" class="btn-secondary" data-cap-tab="global" style="flex:1;padding:6px 8px;font-size:0.8rem;cursor:pointer;border:1px solid var(--accent);border-radius:7px;background:var(--panel);color:var(--fg);">Global (国际)</button>
          <button type="button" class="btn-secondary" data-cap-tab="cn" style="flex:1;padding:6px 8px;font-size:0.8rem;cursor:pointer;border:1px solid var(--border);border-radius:7px;background:transparent;color:var(--muted);">中国区 (China)</button>
        </div>
        <div id="cap-oauth-global" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:4px;">
          <a class="btn-secondary" style="display:inline-flex;align-items:center;justify-content:center;padding:8px 10px;text-decoration:none;border:1px solid var(--border);border-radius:8px;font-size:0.83rem;font-weight:600;color:var(--fg);" href="https://id.capdux.com/sso/oauth/github?redirect=https%3A%2F%2Fcapdux.org%2Fdashboard">GitHub</a>
          <a class="btn-secondary" style="display:inline-flex;align-items:center;justify-content:center;padding:8px 10px;text-decoration:none;border:1px solid var(--border);border-radius:8px;font-size:0.83rem;font-weight:600;color:var(--fg);" href="https://id.capdux.com/sso/oauth/google?redirect=https%3A%2F%2Fcapdux.org%2Fdashboard">Google</a>
          <a class="btn-secondary" style="display:inline-flex;align-items:center;justify-content:center;padding:8px 10px;text-decoration:none;border:1px solid var(--border);border-radius:8px;font-size:0.83rem;font-weight:600;color:var(--fg);" href="https://id.capdux.com/sso/oauth/apple?redirect=https%3A%2F%2Fcapdux.org%2Fdashboard">Apple</a>
          <a class="btn-secondary" style="display:inline-flex;align-items:center;justify-content:center;padding:8px 10px;text-decoration:none;border:1px solid var(--border);border-radius:8px;font-size:0.83rem;font-weight:600;color:var(--fg);" href="https://id.capdux.com/sso/oauth/microsoft?redirect=https%3A%2F%2Fcapdux.org%2Fdashboard">Microsoft</a>
          <a class="btn-secondary" style="grid-column:1 / -1;display:inline-flex;align-items:center;justify-content:center;padding:8px 10px;text-decoration:none;border:1px solid var(--border);border-radius:8px;font-size:0.83rem;font-weight:600;color:var(--fg);" href="https://id.capdux.com/sso/oauth/facebook?redirect=https%3A%2F%2Fcapdux.org%2Fdashboard">Facebook</a>
        </div>
        <div id="cap-oauth-cn" style="display:none;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:4px;">
          <a class="btn-secondary" style="display:inline-flex;align-items:center;justify-content:center;padding:8px 10px;text-decoration:none;border:1px solid var(--border);border-radius:8px;font-size:0.83rem;font-weight:600;color:var(--fg);" href="https://id.capdux.com/sso/oauth/wechat?redirect=https%3A%2F%2Fcapdux.org%2Fdashboard">微信扫码</a>
          <a class="btn-secondary" style="display:inline-flex;align-items:center;justify-content:center;padding:8px 10px;text-decoration:none;border:1px solid var(--border);border-radius:8px;font-size:0.83rem;font-weight:600;color:var(--fg);" href="https://id.capdux.com/sso/oauth/qq?redirect=https%3A%2F%2Fcapdux.org%2Fdashboard">QQ 登录</a>
          <a class="btn-secondary" style="display:inline-flex;align-items:center;justify-content:center;padding:8px 10px;text-decoration:none;border:1px solid var(--border);border-radius:8px;font-size:0.83rem;font-weight:600;color:var(--fg);" href="https://id.capdux.com/sso/oauth/apple?redirect=https%3A%2F%2Fcapdux.org%2Fdashboard">Apple 账号</a>
          <a class="btn-secondary" style="display:inline-flex;align-items:center;justify-content:center;padding:8px 10px;text-decoration:none;border:1px solid var(--border);border-radius:8px;font-size:0.83rem;font-weight:600;color:var(--fg);" href="https://id.capdux.com/sso/oauth/huawei?redirect=https%3A%2F%2Fcapdux.org%2Fdashboard">华为账号</a>
          <a class="btn-secondary" style="display:inline-flex;align-items:center;justify-content:center;padding:8px 10px;text-decoration:none;border:1px solid var(--border);border-radius:8px;font-size:0.83rem;font-weight:600;color:var(--fg);" href="https://id.capdux.com/sso/oauth/xiaomi?redirect=https%3A%2F%2Fcapdux.org%2Fdashboard">小米账号</a>
          <a class="btn-secondary" style="display:inline-flex;align-items:center;justify-content:center;padding:8px 10px;text-decoration:none;border:1px solid var(--border);border-radius:8px;font-size:0.83rem;font-weight:600;color:var(--fg);" href="https://id.capdux.com/sso/oauth/weibo?redirect=https%3A%2F%2Fcapdux.org%2Fdashboard">微博登录</a>
          <a class="btn-secondary" style="grid-column:1 / -1;display:inline-flex;align-items:center;justify-content:center;padding:8px 10px;text-decoration:none;border:1px solid var(--border);border-radius:8px;font-size:0.83rem;font-weight:600;color:var(--fg);" href="https://id.capdux.com/sso/oauth/baidu?redirect=https%3A%2F%2Fcapdux.org%2Fdashboard">百度账号登录</a>
        </div>
        <script>
        (function(){
          var btns = document.querySelectorAll('[data-cap-tab]');
          var g = document.getElementById('cap-oauth-global');
          var c = document.getElementById('cap-oauth-cn');
          btns.forEach(function(b){
            b.addEventListener('click', function(){
              var t = b.getAttribute('data-cap-tab');
              g.style.display = t === 'global' ? 'grid' : 'none';
              c.style.display = t === 'cn' ? 'grid' : 'none';
              btns.forEach(function(x){
                var active = x === b;
                x.style.borderColor = active ? 'var(--accent)' : 'var(--border)';
                x.style.color = active ? 'var(--fg)' : 'var(--muted)';
                x.style.background = active ? 'var(--panel)' : 'transparent';
              });
            });
          });
        })();
        </script>

        <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border);font-size:0.84rem;color:var(--muted);display:flex;justify-content:space-between;align-items:center;gap:10px;">
          <span>${isRegister ? "Already have an account?" : "New to capdux.org?"}</span>
          <a href="${isRegister ? "/login" : "/register"}">${isRegister ? "Sign In →" : "Register →"}</a>
        </div>
      </div>
    </section>
    <script>
    (function(){
      var form = document.getElementById('auth-form');
      var errEl = document.getElementById('auth-err');
      var okEl = document.getElementById('auth-ok');
      var btn = document.getElementById('auth-submit');
      var isRegister = ${isRegister ? "true" : "false"};

      function showErr(msg){
        okEl.style.display = 'none';
        errEl.textContent = msg;
        errEl.style.display = 'block';
      }
      function showOk(msg){
        errEl.style.display = 'none';
        okEl.textContent = msg;
        okEl.style.display = 'block';
      }

      form.addEventListener('submit', function(e){
        e.preventDefault();
        errEl.style.display = 'none';
        okEl.style.display = 'none';
        btn.disabled = true;
        var origText = btn.textContent;
        btn.textContent = isRegister ? 'Creating account...' : 'Signing in...';

        var payload = isRegister
          ? {
              username: document.getElementById('username').value.trim(),
              email: document.getElementById('email').value.trim(),
              password: document.getElementById('password').value
            }
          : {
              username: document.getElementById('username').value.trim(),
              password: document.getElementById('password').value,
              token_name: 'web-dashboard'
            };

        fetch(isRegister ? '/v1/auth/register' : '/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
          .then(function(res){
            return res.json().catch(function(){ return {}; }).then(function(data){
              return { ok: res.ok, status: res.status, data: data };
            });
          })
          .then(function(r){
            if (!r.ok || !r.data.token) {
              showErr(r.data.error || ('Authentication failed (HTTP ' + r.status + ')'));
              btn.disabled = false;
              btn.textContent = origText;
              return;
            }
            try {
              localStorage.setItem('capdux_token', r.data.token);
              if (r.data.user) {
                localStorage.setItem('capdux_user', JSON.stringify(r.data.user));
              }
            } catch(_) {}
            showOk('Authenticated! Redirecting to developer dashboard...');
            setTimeout(function(){ window.location.href = '/dashboard'; }, 350);
          })
          .catch(function(err){
            showErr('Network error: ' + (err && err.message ? err.message : String(err)));
            btn.disabled = false;
            btn.textContent = origText;
          });
      });
    })();
    </script>
  `;

  const html = renderLayout({
    title: `${isRegister ? "Register" : "Sign In"} — capdux.org`,
    description: subText,
    env,
    activeNav: mode,
    body,
  });

  return htmlResponse(html, 200, "no-store");
}

export async function renderDashboardPage(env: Env): Promise<Response> {
  const registryOrigin = (env.REGISTRY_ORIGIN || "https://registry.capdux.org").replace(/\/+$/, "");

  const body = `
    <div class="wrap" style="padding-top:24px;">
      <section class="pkg-hero">
        <div>
          <div class="badges" style="margin-bottom:8px;">
            <span class="badge badge-ver">DEVELOPER CONSOLE</span>
            <span class="badge badge-verified">Ed25519 Signed Registry</span>
          </div>
          <h1 class="pkg-title" style="margin-bottom:4px;">Token &amp; Publish Dashboard</h1>
          <p class="muted" style="margin:0;">Manage your <code>capdux_*</code> API tokens, inspect account scopes, and publish <code>.cap</code> archives.</p>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <a class="pill" href="/.well-known/capdux-keys.json" target="_blank" rel="noopener noreferrer">Public Signing Keys &#8599;</a>
          <button id="btn-signout" class="btn-ghost" type="button" style="display:none;">Sign Out</button>
        </div>
      </section>

      <div id="dash-unauth" class="empty" style="display:none;margin-top:24px;">
        <h2 style="margin:0 0 8px;">Sign In Required</h2>
        <p class="muted" style="max-width:480px;margin:0 auto 20px;">
          No active session token found in your browser. Sign in or register to manage your <code>capdux_*</code> API tokens.
        </p>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
          <a class="btn" href="/login">Sign In</a>
          <a class="pill" href="/register">Create Account</a>
        </div>
      </div>

      <div id="dash-loading" class="panel" style="margin-top:24px;text-align:center;color:var(--muted);">
        Loading developer session from <code>/v1/auth/whoami</code>...
      </div>

      <div id="dash-content" class="dash-grid" style="display:none;">
        <div>
          <section class="panel">
            <div class="panel-head">
              <h2 class="panel-title">Create New API Token</h2>
              <span class="badge badge-zst">capdux_*</span>
            </div>
            <div id="tok-err" class="alert-err"></div>
            <div id="tok-secret" class="secret-box">
              <div style="font-size:0.8rem;color:var(--green);font-weight:700;margin-bottom:6px;">
                &#10003; New Token Created — Copy it now (it will not be shown again)
              </div>
              <div class="cmd-box">
                <code id="tok-secret-val"></code>
                <button id="tok-secret-copy" class="copy-btn" type="button" data-copy="">Copy Token</button>
              </div>
            </div>
            <form id="create-token-form" style="display:grid;grid-template-columns:1fr 140px 130px auto;gap:10px;align-items:end;">
              <div>
                <label class="form-label" for="tok-name">Token Name</label>
                <input class="form-input" id="tok-name" type="text" placeholder="ci-release" required>
              </div>
              <div>
                <label class="form-label" for="tok-scope">Scope</label>
                <select class="form-select" id="tok-scope">
                  <option value="publish">publish</option>
                  <option value="read">read</option>
                </select>
              </div>
              <div>
                <label class="form-label" for="tok-days">Expires (days)</label>
                <input class="form-input" id="tok-days" type="number" min="1" max="3650" placeholder="90">
              </div>
              <div>
                <button id="tok-create-btn" class="btn" type="submit" style="height:39px;">Create Token</button>
              </div>
            </form>
          </section>

          <section class="panel">
            <div class="panel-head">
              <h2 class="panel-title">Your API Tokens</h2>
              <span id="tok-count" class="badge">0</span>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Name</th>
                    <th>Scope</th>
                    <th>Created</th>
                    <th>Last Used</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody id="tok-tbody"></tbody>
              </table>
            </div>
          </section>
        </div>

        <aside>
          <section class="panel">
            <div class="panel-head">
              <h2 class="panel-title">Account Profile</h2>
              <span id="user-role-badge" class="badge badge-ver">user</span>
            </div>
            <div class="kv"><span class="kv-k">Username</span><span class="kv-v" id="user-name">—</span></div>
            <div class="kv"><span class="kv-k">Email</span><span class="kv-v" id="user-email">—</span></div>
            <div class="kv"><span class="kv-k">Session Scope</span><span class="kv-v" id="user-scope">—</span></div>
            <div class="kv"><span class="kv-k">Registry</span><span class="kv-v">${escapeHtml(registryOrigin)}</span></div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <h2 class="panel-title">CLI Publish Guide</h2>
              <span class="badge badge-ai">.cap</span>
            </div>
            <p class="muted" style="font-size:0.83rem;margin:0 0 10px;">
              1. Pack your CP package into a Zstd-compressed <code>.cap</code> archive:
            </p>
            <div class="cmd-box" style="margin-bottom:12px;">
              <code>$ cap pack</code>
              <button class="copy-btn" type="button" data-copy="cap pack">Copy</button>
            </div>
            <p class="muted" style="font-size:0.83rem;margin:0 0 10px;">
              2. Export your <code>capdux_*</code> token and publish to capdux.org:
            </p>
            <div class="cmd-box" style="margin-bottom:12px;">
              <code>$ CAPDUX_TOKEN=capdux_xxx cap publish</code>
              <button class="copy-btn" type="button" data-copy="CAPDUX_TOKEN=capdux_xxx cap publish">Copy</button>
            </div>
            <p class="muted" style="font-size:0.83rem;margin:0 0 10px;">
              3. Test installing a local <code>.cap</code> archive offline:
            </p>
            <div class="cmd-box">
              <code>$ cap add ./my-pkg-1.0.0.cap</code>
              <button class="copy-btn" type="button" data-copy="cap add ./my-pkg-1.0.0.cap">Copy</button>
            </div>
          </section>
        </aside>
      </div>
    </div>
    <script>
    (function(){
      var token = '';
      try { token = localStorage.getItem('capdux_token') || ''; } catch(_) {}

      var loadingEl = document.getElementById('dash-loading');
      var unauthEl = document.getElementById('dash-unauth');
      var contentEl = document.getElementById('dash-content');
      var signoutBtn = document.getElementById('btn-signout');
      var tokTbody = document.getElementById('tok-tbody');
      var tokCount = document.getElementById('tok-count');
      var tokErr = document.getElementById('tok-err');
      var tokSecret = document.getElementById('tok-secret');
      var tokSecretVal = document.getElementById('tok-secret-val');
      var tokSecretCopy = document.getElementById('tok-secret-copy');
      var scopeSelect = document.getElementById('tok-scope');

      function showUnauth(){
        loadingEl.style.display = 'none';
        contentEl.style.display = 'none';
        signoutBtn.style.display = 'none';
        unauthEl.style.display = 'block';
      }

      function authHeaders(){
        return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
      }

      signoutBtn.addEventListener('click', function(){
        try {
          localStorage.removeItem('capdux_token');
          localStorage.removeItem('capdux_user');
        } catch(_) {}
        window.location.href = '/login';
      });

      function fmtDate(iso){
        if (!iso) return '—';
        return String(iso).slice(0, 10);
      }

      function renderTokens(tokens){
        tokCount.textContent = String(tokens.length);
        tokTbody.textContent = '';
        if (!tokens.length) {
          var emptyTr = document.createElement('tr');
          var emptyTd = document.createElement('td');
          emptyTd.colSpan = 7;
          emptyTd.className = 'muted';
          emptyTd.textContent = 'No tokens created yet.';
          emptyTr.appendChild(emptyTd);
          tokTbody.appendChild(emptyTr);
          return;
        }
        tokens.forEach(function(t){
          var tr = document.createElement('tr');
          var cells = [
            '#' + t.id,
            t.name || '—',
            t.scope || 'publish',
            fmtDate(t.created_at),
            fmtDate(t.last_used_at)
          ];
          cells.forEach(function(val){
            var td = document.createElement('td');
            td.textContent = val;
            tr.appendChild(td);
          });

          var statusTd = document.createElement('td');
          var badge = document.createElement('span');
          if (t.revoked) {
            badge.className = 'badge badge-err';
            badge.textContent = 'revoked';
          } else {
            badge.className = 'badge badge-zst';
            badge.textContent = 'active';
          }
          statusTd.appendChild(badge);
          tr.appendChild(statusTd);

          var actTd = document.createElement('td');
          if (!t.revoked) {
            var revBtn = document.createElement('button');
            revBtn.type = 'button';
            revBtn.className = 'btn-danger';
            revBtn.textContent = 'Revoke';
            revBtn.addEventListener('click', function(){
              revBtn.disabled = true;
              revBtn.textContent = '...';
              fetch('/v1/auth/tokens/' + encodeURIComponent(String(t.id)), {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer ' + token }
              })
                .then(function(res){
                  if (!res.ok) throw new Error('HTTP ' + res.status);
                  return loadTokens();
                })
                .catch(function(err){
                  tokErr.textContent = 'Failed to revoke token: ' + err.message;
                  tokErr.style.display = 'block';
                  revBtn.disabled = false;
                  revBtn.textContent = 'Revoke';
                });
            });
            actTd.appendChild(revBtn);
          } else {
            actTd.textContent = '—';
          }
          tr.appendChild(actTd);
          tokTbody.appendChild(tr);
        });
      }

      function loadTokens(){
        return fetch('/v1/auth/tokens', { headers: { 'Authorization': 'Bearer ' + token } })
          .then(function(res){
            if (res.status === 401) { showUnauth(); return null; }
            return res.json();
          })
          .then(function(data){
            if (data && Array.isArray(data.tokens)) {
              renderTokens(data.tokens);
            }
          });
      }

      document.getElementById('create-token-form').addEventListener('submit', function(e){
        e.preventDefault();
        tokErr.style.display = 'none';
        var nameInput = document.getElementById('tok-name');
        var daysInput = document.getElementById('tok-days');
        var createBtn = document.getElementById('tok-create-btn');
        var payload = {
          name: nameInput.value.trim(),
          scope: scopeSelect.value
        };
        if (daysInput.value.trim()) {
          payload.expires_in_days = Number(daysInput.value.trim());
        }
        createBtn.disabled = true;
        createBtn.textContent = 'Creating...';

        fetch('/v1/auth/tokens', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify(payload)
        })
          .then(function(res){
            return res.json().catch(function(){ return {}; }).then(function(data){
              return { ok: res.ok, status: res.status, data: data };
            });
          })
          .then(function(r){
            createBtn.disabled = false;
            createBtn.textContent = 'Create Token';
            if (!r.ok || !r.data.token) {
              tokErr.textContent = r.data.error || ('Failed to create token (HTTP ' + r.status + ')');
              tokErr.style.display = 'block';
              return;
            }
            tokSecretVal.textContent = r.data.token;
            tokSecretCopy.setAttribute('data-copy', r.data.token);
            tokSecret.style.display = 'block';
            nameInput.value = '';
            daysInput.value = '';
            loadTokens();
          })
          .catch(function(err){
            createBtn.disabled = false;
            createBtn.textContent = 'Create Token';
            tokErr.textContent = 'Network error: ' + err.message;
            tokErr.style.display = 'block';
          });
      });

      if (!token) {
        showUnauth();
        return;
      }

      fetch('/v1/auth/whoami', { headers: { 'Authorization': 'Bearer ' + token } })
        .then(function(res){
          if (!res.ok) { showUnauth(); return null; }
          return res.json();
        })
        .then(function(user){
          if (!user) return;
          document.getElementById('user-name').textContent = user.username || '—';
          document.getElementById('user-email').textContent = user.email || '—';
          document.getElementById('user-scope').textContent = user.tokenScope || '—';
          document.getElementById('user-role-badge').textContent = user.role || 'user';
          if (user.role === 'admin') {
            var opt = document.createElement('option');
            opt.value = 'admin';
            opt.textContent = 'admin';
            scopeSelect.appendChild(opt);
          }
          loadingEl.style.display = 'none';
          signoutBtn.style.display = 'inline-flex';
          contentEl.style.display = 'grid';
          return loadTokens();
        })
        .catch(function(){
          showUnauth();
        });
    })();
    </script>
  `;

  const html = renderLayout({
    title: "Developer Dashboard — capdux.org",
    description: "Manage your capdux.org API tokens and publish .cap packages",
    env,
    activeNav: "dashboard",
    body,
  });

  return htmlResponse(html, 200, "no-store");
}
