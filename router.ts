// Site hub: lists the site containers the builder started (label hub.site) and serves each one
// under its own path, /<repo>/<branch>/, so every page of every site has a link of its own.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const DOCKER = process.env.DOCKER_API ?? "http://docker:2375";
const BUILDER = process.env.BUILDER_API ?? "http://builder:8081";
const HOOK_SECRET = process.env.HOOK_SECRET ?? "";
const PASSWORD = process.env.HUB_PASSWORD ?? "";
const COOKIE = "hub_site";
const ORG = process.env.HUB_ORG ?? ""; // shown top right, e.g. "Example Lab, Berlin"

// Login with the NAS's Synology SSO Server (OIDC) when a client is configured; else HUB_PASSWORD; else open.
const OIDC = {
  issuer: process.env.OIDC_ISSUER ?? "", // e.g. https://your-nas:8843/webman/sso (DSM SSO Server)
  id: process.env.OIDC_CLIENT_ID ?? "",
  secret: process.env.OIDC_CLIENT_SECRET ?? "",
  hub: process.env.HUB_URL ?? "http://localhost:4300",
};
const SSO = Boolean(OIDC.issuer && OIDC.id && OIDC.secret);
const SESSION_KEY = process.env.SESSION_SECRET || randomBytes(32).toString("hex"); // restart = everyone logs in again
const SESSION_MS = 12 * 3600_000;
const SECURE = OIDC.hub.startsWith("https:") ? "; Secure" : "";

type Site = { name: string; state: string; status: string; created: number; labels: Record<string, string>; path: string };

let cache: { at: number; sites: Map<string, Site>; error?: string } = { at: 0, sites: new Map() };

export async function listSites(force = false) {
  if (!force && Date.now() - cache.at < 5000) return cache;
  try {
    const filters = encodeURIComponent(JSON.stringify({ label: ["hub.site"] }));
    const res = await fetch(`${DOCKER}/containers/json?all=1&filters=${filters}`);
    if (!res.ok) throw new Error(`Docker API answered ${res.status}`);
    const sites = new Map<string, Site>();
    for (const c of (await res.json()) as any[]) {
      const name = String(c.Names?.[0] ?? "").replace(/^\//, "");
      sites.set(name, { name, state: c.State, status: c.Status, created: c.Created * 1000, labels: c.Labels ?? {}, path: "" });
    }
    // /<repo>/<branch>, or /<group>/<repo>/<branch> when two groups have a repo of the same name.
    const repo = (s: Site) => (s.labels["hub.project"] ?? s.name).split("/").pop()!;
    for (const s of sites.values()) {
      const clash = [...sites.values()].some((o) => repo(o) === repo(s) && o.labels["hub.project"] !== s.labels["hub.project"]);
      s.path = `/${clash ? s.labels["hub.project"] : repo(s)}/${refSlug(s.labels["hub.branch"] ?? s.name)}`;
    }
    cache = { at: Date.now(), sites };
  } catch (error) {
    cache = { ...cache, at: Date.now(), error: String(error) }; // keep the last good list
  }
  return cache;
}

// GitLab's CI_COMMIT_REF_SLUG, as builder.ts names containers: the branch part of the site's path.
function refSlug(ref: string) {
  return ref.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 63).replace(/^-+|-+$/g, "");
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function ago(ms: number) {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}

// One row per branch: a running site, a build still on its way, or both (a live site being updated).
type Build = { site: string; project: string; branch: string; sha: string; title: string; url: string; state: "queued" | "building" | "failed"; at: number; started?: number; error?: string };
type Row = { project: string; branch: string; site?: Site; pipe?: Build; at: number };

// Queued, building and failed builds, from the builder (builder.ts); an unreachable builder just shows none.
const builder = (path: string, method = "GET") =>
  fetch(`${BUILDER}${path}`, { method, headers: { "x-gitlab-token": HOOK_SECRET }, signal: AbortSignal.timeout(3000) });
async function builds() {
  const res = await builder("/status").catch(() => undefined);
  return (res?.ok ? await res.json() : []) as Build[];
}

const STEPS = ["Pushed", "Queued", "Build", "Live"];
// done / now / fail / todo per step, plus an optional note on the step that is happening.
function track(states: string[], note?: string) {
  return `<div class="track">${states.map((k, i) => `<span class="st ${k}">${STEPS[i]}${k === "now" && note ? ` ${note}` : ""}${k === "done" ? " ✓" : k === "fail" ? " ✕" : ""}</span>`).join("")}</div>`;
}
const since = (ms: number) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

export async function hubPage(current?: string, user?: string, glToken?: string) {
  const { sites, error } = await listSites(true);
  for (const name of removing) if (!sites.has(name)) removing.delete(name);
  const removable = new Set<string>();
  if (glToken) await Promise.all([...sites.values()].map(async (s) => { if (await canRemove(glToken, s)) removable.add(s.name); }));
  const rows = new Map<string, Row>();
  for (const s of sites.values()) {
    const project = s.labels["hub.project"] ?? "other", branch = s.labels["hub.branch"] ?? s.name;
    rows.set(`${project}\n${branch}`, { project, branch, site: s, at: s.created });
  }
  // Builds on their way, so a brand-new branch shows up while its first build runs.
  for (const b of await builds()) {
    const row = rows.get(`${b.project}\n${b.branch}`);
    if (row) row.pipe = b;
    else rows.set(`${b.project}\n${b.branch}`, { project: b.project, branch: b.branch, pipe: b, at: b.at });
  }
  const projects = new Map<string, Row[]>();
  for (const r of [...rows.values()].sort((a, b) => b.at - a.at)) projects.set(r.project, [...(projects.get(r.project) ?? []), r]);
  let n = 0, building = 0, failed = 0;
  const groups = [...projects].map(([project, list]) => `<section>
<h2><small>${esc(project.split("/").slice(0, -1).join("/"))}/</small>${esc(project.split("/").pop())}</h2>
<ol>${list.map(({ site: s, pipe: p, branch, project }) => {
    const l = s?.labels ?? {};
    const up = s?.state === "running";
    const here = s && s.name === current;
    const live = up && !(s && removing.has(s.name));
    let steps = "", meta = "";
    if (p?.state === "queued") { building++; steps = track(["done", "now", "todo", "todo"]); }
    else if (p?.state === "building") { building++; steps = track(["done", "done", "now", "todo"], since(p.started ?? p.at)); }
    else if (p) { failed++; steps = track(["done", "done", "fail", "todo"]); }
    else if (s && !up) steps = track(["done", "done", "done", "fail"]);
    const sha = p?.sha.slice(0, 8);
    if (p && s) meta = `live: <span class="mono">${esc(l["hub.commit"])}</span> · ${p.state === "failed" ? "failed" : p.state}: <a class="mono" href="${esc(p.url)}">${esc(sha)}</a>${p.title ? ` “${esc(p.title)}”` : ""}`;
    else if (p) meta = `<a class="mono" href="${esc(p.url)}">${esc(sha)}</a> · pushed ${ago(p.at)}`;
    else meta = `${esc(l["hub.author"]?.replace(/\s*<.*>$/, ""))} · <a class="mono" href="${esc(l["hub.url"])}">${esc(l["hub.commit"])}</a> · <a href="/_hub/logs/${esc(s!.name)}">logs</a>`;
    if (s && !up) meta += ` · stopped: ${esc(s.status)}`;
    const err = p?.state === "failed" && p.error ? `<pre class="error">${esc(p.error)}</pre>` : "";
    const main = s && removing.has(s.name) ? '<span class="down">Removing…</span>'
      : live ? `<a class="open" href="${esc(s!.path)}/">Open →</a>`
      : s ? `<a class="open quiet" href="/_hub/logs/${esc(s.name)}">Logs</a>`
      : '<span class="notyet">Not live yet</span>';
    const buildLog = p && `/_hub/build/${esc(p.site)}`;
    const second = p?.state === "failed" ? `<a class="side" href="${buildLog}">Build log</a>`
      : p?.state === "building" ? `<a class="side" href="${buildLog}">Watch log</a>`
      : s && removable.has(s.name) && !removing.has(s.name) ? `<button type="button" class="rm" data-site="${esc(s.name)}" data-branch="${esc(branch)}" data-project="${esc(project)}">Remove</button>` : "";
    return `<li${here ? ' class="here"' : ""}${p && p.state !== "failed" ? " data-active" : ""}>
  <span class="no">${String(++n).padStart(2, "0")}</span>
  <div class="what"><code>${esc(branch)}</code>${here ? '<em>Last viewed</em>' : ""}
    <p>${esc(l["hub.title"] ?? p?.title ?? "")}</p>
    <small>${meta}</small>${err}</div>
  <span class="age">${s ? ago(s.created) : ""}</span>
  <span class="acts">${main}${second}</span>
  ${steps}
</li>`;
  }).join("\n")}</ol></section>`).join("\n");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Site hub</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
:root{--ground:#F4F3EF;--ink:#000;--soft:#555;--mark:#FFE14D;--card:#FFF}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--ground);color:var(--ink);font:16px/1.45 "Space Grotesk",system-ui,sans-serif}
a{color:inherit}a:hover{background:var(--mark)}
.mono,code,.meta,.find span,em,.foot{font-family:"Space Mono",ui-monospace,monospace}
main{max-width:1040px;margin:0 auto;padding:48px 16px 48px}
header{display:grid;grid-template-columns:minmax(0,1fr) auto;border:2px solid var(--ink);background:var(--card)}
header>div:first-child{padding:24px 28px;border-right:2px solid var(--ink)}
h1{margin:0;font-weight:700;font-size:clamp(48px,9vw,72px);line-height:.9;letter-spacing:-.035em}
.lede{margin:14px 0 0;font-size:18px;max-width:34em}
.meta{display:flex;flex-direction:column;font-size:13px;min-width:220px}
.meta>*{padding:14px 20px;border-bottom:2px solid var(--ink)}.meta>:last-child{border-bottom:0;font-weight:700;text-decoration:none}
.find{margin-top:24px;display:flex;border:2px solid var(--ink);background:var(--card)}
.find span{padding:14px 18px;background:var(--ink);color:#fff;font-weight:700;font-size:13px}
.find input{flex:1;min-width:0;border:0;outline:none;padding:0 18px;font:18px "Space Grotesk",sans-serif;background:none}
.find:focus-within{box-shadow:4px 4px 0 var(--mark)}
.list{display:flex;flex-direction:column}
section{margin-top:36px;display:grid;grid-template-columns:240px minmax(0,1fr);column-gap:32px;border-top:4px solid var(--ink);padding-top:14px}
h2{margin:0;font-weight:700;font-size:20px;line-height:1.15;overflow-wrap:anywhere}
h2 small{display:block;font:400 13px "Space Mono",monospace;color:var(--soft)}
ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;border:2px solid var(--ink);background:var(--card)}
ol>li{display:grid;grid-template-columns:56px minmax(0,1fr) 100px 120px;gap:16px;align-items:start;padding:16px 18px;border-top:2px solid var(--ink)}
ol>li:first-child{border-top:0}
li.here{background:#FFF6C2}
.no{font-weight:700;font-size:30px;line-height:1}
code{font-weight:700;font-size:14px}
em{font-style:normal;margin-left:10px;background:var(--ink);color:var(--mark);font-weight:700;font-size:11px;padding:2px 6px;text-transform:uppercase}
li p{margin:2px 0 0;font-size:18px}
li small{display:block;margin-top:4px;font-size:13px;color:var(--soft)}
.age{font-size:14px;color:var(--soft);padding-top:4px}
.acts{display:flex;flex-direction:column;gap:8px}
form{margin:0}
.open{display:block;text-align:center;padding:10px 0;background:var(--ink);color:#fff;text-decoration:none;font-weight:700;box-shadow:4px 4px 0 var(--mark)}
.open:hover{background:var(--ink);transform:translate(-1px,-1px);box-shadow:5px 5px 0 var(--mark)}
.track{grid-column:1/-1;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:6px -18px -16px;border-top:2px solid var(--ink)}
.st{padding:8px 14px;font:700 12px "Space Mono",monospace;border-right:2px solid var(--ink);color:#8A8A8A}.st:last-child{border-right:0}
.st.done{background:var(--ink);color:#fff}.st.now{background:repeating-linear-gradient(-45deg,var(--mark) 0 10px,#F5D33A 10px 20px);color:var(--ink)}.st.fail{background:#B3261E;color:#fff}
pre.error{margin:10px 0 0;padding:10px 12px;background:var(--ink);color:var(--ground);font:13px/1.5 "Space Mono",monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.notyet{display:block;text-align:center;padding:10px 0;border:2px dashed var(--ink);color:var(--soft);font-weight:700}
.open.quiet{background:var(--card);color:var(--ink);box-shadow:none;border:2px solid var(--ink)}
.side{display:block;text-align:center;padding:6px 0;border:2px solid var(--ink);font-weight:700;font-size:13px;text-decoration:none}
.rm{all:unset;box-sizing:border-box;display:block;width:100%;text-align:center;padding:6px 0;border:2px solid var(--ink);font:700 13px "Space Grotesk",sans-serif;cursor:pointer}
.rm:hover,.rm:focus-visible{background:var(--mark)}
dialog{max-width:520px;width:calc(100% - 32px);border:2px solid var(--ink);padding:0;box-shadow:8px 8px 0 var(--ink);background:var(--card);color:var(--ink)}
dialog::backdrop{background:rgba(244,243,239,.85)}
dialog form{padding:24px 26px}
dialog h3{margin:0;font-size:24px;line-height:1.15}dialog h3 code{font-size:22px;background:var(--mark);padding:0 6px}
dialog .proj{margin:6px 0 0;font:13px "Space Mono",monospace;color:var(--soft)}
dialog ul{margin:18px 0 0;padding:0 0 0 18px;font-size:15px}dialog li{margin:6px 0}
dialog .who{margin:14px 0 0;font-size:13px;color:var(--soft)}
.btns{display:flex;justify-content:flex-end;gap:12px;margin-top:22px}
.btns button{font:700 15px "Space Grotesk",sans-serif;padding:12px 18px;border:2px solid var(--ink);cursor:pointer}
.cancel{background:var(--card)}.cancel:hover{background:var(--mark)}
.go{background:var(--ink);color:#fff;box-shadow:4px 4px 0 var(--mark)}.go:hover{background:#B3261E;border-color:#B3261E}
.down,.err{font-weight:700;font-size:13px}
.err{border:2px solid var(--ink);background:var(--mark);padding:10px 14px;margin:24px 0 0}
.foot{margin-top:44px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;border-top:2px solid var(--ink);padding-top:16px;font-size:13px}
.sig{font:18px "Space Grotesk",sans-serif}.sig b{background:var(--mark);padding:2px 8px}
@media (max-width:760px){
  header{grid-template-columns:1fr}header>div:first-child{border-right:0;border-bottom:2px solid var(--ink)}
  .meta{flex-direction:row;flex-wrap:wrap;min-width:0}.meta>*{border-bottom:0;border-right:2px solid var(--ink)}.meta>:last-child{border-right:0}
  section{grid-template-columns:1fr;row-gap:12px}
  ol>li{grid-template-columns:40px minmax(0,1fr) 100px}.no{font-size:22px}.what{grid-column:2/4}.age{grid-column:2}.acts{grid-column:3}
}
</style></head><body><main>
<header><div><h1>Site hub</h1>
<p class="lede">Push a branch with a Dockerfile and it shows up here in about two minutes. Delete the branch and it's gone.</p></div>
<div class="meta">${ORG ? `<span style="font-family:'Space Grotesk',sans-serif">${esc(ORG)}</span>` : ""}${user ? `<span>${esc(user)}</span><a href="/_hub/logout">Sign out →</a>` : "<span>branch previews</span>"}</div></header>
<label class="find"><span>SEARCH</span><input type="search" id="find" placeholder="Branch, project or commit (fuzzy)" autocomplete="off" autofocus></label>
${error ? `<p class="err">Can't reach Docker: ${esc(error)}. Showing the last known list.</p>` : ""}
<div class="list">${groups || '<p class="lede">Nothing deployed yet.</p>'}</div>
${GITLAB && !glToken ? '<p class="lede"><a href="/_hub/gitlab/login">Sign in to GitLab</a> to remove previews of branches you can push to.</p>' : ""}
<dialog id="rmdlg" aria-labelledby="rmtitle"><form method="post">
<h3 id="rmtitle">Remove the <code></code> preview?</h3>
<p class="proj"></p>
<ul>
<li>The preview goes offline for everyone, and links to it stop working.</li>
<li>Anything the site saved while running (form messages, sign-ups, uploads) is deleted with it.</li>
<li>The branch and its code in GitLab are not touched.</li>
<li>To bring it back, push to the branch again; it is up again in about two minutes.</li>
</ul>
<div class="btns"><button type="submit" formmethod="dialog" value="cancel" class="cancel" autofocus>Cancel</button><button type="submit" class="go">Remove preview</button></div>
</form></dialog>
<footer class="foot"><span class="sig"><a href="https://github.com/RaulSimpetru/synology-site-hub" style="text-decoration:none">site-hub</a> by <b>Raul C. Sîmpetru</b></span><span>${sites.size} site${sites.size === 1 ? "" : "s"}${building ? ` · ${building} building` : ""}${failed ? ` · ${failed} failed` : ""} · ${esc(new URL(OIDC.hub).host)}</span></footer>
</main><script>
for (const b of document.querySelectorAll(".rm")) b.onclick = () => {
  const form = rmdlg.querySelector("form");
  form.action = "/_hub/remove/" + encodeURIComponent(b.dataset.site);
  rmdlg.querySelector("code").textContent = b.dataset.branch;
  rmdlg.querySelector(".proj").textContent = b.dataset.project;
  rmdlg.showModal();
};
// While something builds, refresh every 10 s, unless the visitor is searching or deciding in the dialog.
if (document.querySelector("li[data-active]")) setInterval(() => {
  if (!document.getElementById("find").value && !rmdlg.open) location.reload();
}, 10000);
// Fuzzy, fzf-style: every word's letters must appear in order; tighter matches rank first.
// Best start wins; letters spread more than ~3 apart on average don't count, so long rows don't match everything.
const score = (hay, word) => {
  let best = -1;
  for (let start = hay.indexOf(word[0]); start >= 0; start = hay.indexOf(word[0], start + 1)) {
    let at = start, gaps = 0;
    for (const ch of word.slice(1)) { const k = hay.indexOf(ch, at + 1); if (k < 0) { gaps = -1; break; } gaps += k - at - 1; at = k; }
    if (gaps >= 0 && gaps <= word.length * 3 && (best < 0 || gaps < best)) best = gaps;
  }
  return best;
};
const rows = [...document.querySelectorAll("section ol>li")].map((li, i) => ({ li, i, hay: (li.closest("section").querySelector("h2").textContent + " " + li.textContent).toLowerCase().replace(/\\s+/g, " ") }));
// Not the global "find": that name is window.find(), a built-in browser function.
const search = document.getElementById("find");
search.oninput = () => {
  const words = search.value.trim().toLowerCase().split(/\\s+/).filter(Boolean);
  for (const r of rows) {
    const s = words.map((w) => score(r.hay, w));
    r.rank = s.some((x) => x < 0) ? -1 : s.reduce((a, b) => a + b, 0);
    r.li.hidden = r.rank < 0;
    r.li.style.order = words.length ? r.rank : r.i;
  }
  for (const sec of document.querySelectorAll("section")) {
    const shown = rows.filter((r) => !r.li.hidden && sec.contains(r.li));
    sec.hidden = !shown.length;
    sec.style.order = words.length && shown.length ? Math.min(...shown.map((r) => r.rank)) : 0;
  }
};
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

// Docker multiplexes stdout/stderr frames with an 8-byte header; strip them.
function demux(buf: Uint8Array) {
  let out = "", i = 0;
  const dec = new TextDecoder();
  while (i + 8 <= buf.length) {
    const size = new DataView(buf.buffer, buf.byteOffset + i + 4, 4).getUint32(0);
    out += dec.decode(buf.subarray(i + 8, i + 8 + size));
    i += 8 + size;
  }
  return out;
}

export function badge(site: Site) {
  const l = site.labels;
  // Inline styles with all:initial so the site's own CSS can't restyle it.
  const box = "all:initial;box-sizing:border-box;font:700 14px/1 system-ui,-apple-system,sans-serif;color:#000";
  return `<div style="${box};position:fixed;z-index:2147483647;left:16px;bottom:16px;display:flex;align-items:stretch;border:2px solid #000;background:#fff;box-shadow:4px 4px 0 #000">`
    + `<a href="/_hub" title="Back to the site hub" style="${box};display:flex;align-items:center;padding:12px 16px;background:#FFE14D;border-right:2px solid #000;cursor:pointer;text-decoration:none">← All sites</a>`
    + `<span style="${box};display:flex;align-items:center;padding:12px 14px;font:13px/1 ui-monospace,Menlo,monospace;white-space:nowrap">${esc(l["hub.project"]?.split("/").pop())} / ${esc(l["hub.branch"])}</span></div>`;
}

async function proxy(req: Request, site: Site, path: string) {
  const url = new URL(req.url);
  const upstream = `http://${site.name}:${site.labels["hub.port"] || "3000"}`;
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("authorization"); // the hub password is not the site's business
  const kept = (headers.get("cookie") ?? "").split(/;\s*/).filter((c) => c && !/^hub_(session|state|gl|glstate)=/.test(c)).join("; ");
  if (kept) headers.set("cookie", kept);
  else headers.delete("cookie"); // nor is the hub session
  headers.delete("accept-encoding"); // ask for plain bodies so we can rewrite HTML
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
  headers.set("x-forwarded-prefix", site.path);
  let res: Response;
  try {
    res = await fetch(upstream + path + url.search, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      redirect: "manual",
    });
  } catch {
    return new Response(`${site.name} is not answering yet (still starting or crashed). Check /_hub/logs/${site.name}`, { status: 502 });
  }
  const out = new Headers(res.headers);
  out.delete("content-encoding");
  out.delete("content-length");
  const location = out.get("location");
  const local = location?.startsWith(upstream) ? location.slice(upstream.length) || "/" : location;
  if (local) out.set("location", prefixed(site, local));
  // Root-relative requests fall back to the hub_site cookie when there is no referer, so keep caches apart per site.
  out.append("vary", "cookie");
  if (req.headers.get("sec-fetch-mode") === "navigate") out.append("set-cookie", `${COOKIE}=${site.name}; Path=/; SameSite=Lax; HttpOnly${SECURE}`);
  const response = new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  if (!out.get("content-type")?.startsWith("text/html")) return response;
  // Sites are written for "/", so point their root-relative links at the site's own path.
  const fix = (attr: string) => ({ element: (el: HTMLRewriterTypes.Element) => {
    const v = el.getAttribute(attr);
    if (v) el.setAttribute(attr, attr === "srcset" ? v.replace(/(^|,\s*)(\/[^\s,]*)/g, (_, sep, u) => sep + prefixed(site, u)) : prefixed(site, v));
  } });
  const rw = new HTMLRewriter().on("body", { element: (el) => { el.append(badge(site), { html: true }); } });
  for (const attr of ["href", "src", "action", "formaction", "poster", "srcset"]) rw.on(`[${attr}]`, fix(attr));
  return rw.transform(response);
}

// "/x" on a site becomes "/<repo>/<branch>/x"; other links (relative, other hosts, "//cdn…") stay as they are.
function prefixed(site: Site, link: string) {
  return link.startsWith("/") && !link.startsWith("//") && !link.startsWith(site.path + "/") && link !== site.path ? site.path + link : link;
}

const readCookie = (req: Request, name: string) =>
  req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1];
const sign = (value: string) => createHmac("sha256", SESSION_KEY).update(value).digest("base64url");

export function sessionUser(req: Request) {
  const [user, exp, mac] = (readCookie(req, "hub_session") ?? "").split("|");
  if (!user || !mac || !(Number(exp) > Date.now())) return undefined;
  const want = Buffer.from(sign(`${user}|${exp}`));
  const got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got) ? decodeURIComponent(user) : undefined;
}

let discovery: Record<string, any> | undefined;
async function oidc() {
  return (discovery ??= await (await fetch(`${OIDC.issuer}/.well-known/openid-configuration`)).json());
}

async function login(req: Request) {
  const url = new URL(req.url);
  const state = randomBytes(16).toString("base64url");
  const auth = new URL((await oidc()).authorization_endpoint);
  auth.search = new URLSearchParams({ response_type: "code", client_id: OIDC.id, redirect_uri: `${OIDC.hub}/_hub/callback`, scope: "openid email groups", state }).toString();
  const back = encodeURIComponent(url.pathname + url.search);
  return new Response(null, { status: 302, headers: { location: auth.href, "set-cookie": `hub_state=${state}.${back}; Path=/_hub/callback; Max-Age=600; HttpOnly; SameSite=Lax${SECURE}` } });
}

async function callback(req: Request) {
  const url = new URL(req.url);
  const saved = readCookie(req, "hub_state") ?? "";
  const dot = saved.indexOf(".");
  const state = saved.slice(0, dot);
  const code = url.searchParams.get("code");
  if (!state || !code || url.searchParams.get("state") !== state) return new Response("Login expired, please try again: /_hub", { status: 400 });
  const d = await oidc();
  const res = await fetch(d.token_endpoint, {
    method: "POST",
    headers: { authorization: `Basic ${btoa(`${OIDC.id}:${OIDC.secret}`)}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: `${OIDC.hub}/_hub/callback` }),
  });
  const token = (await res.json().catch(() => ({}))) as { id_token?: string };
  if (!res.ok || !token.id_token) return new Response("Login failed at the SSO server", { status: 502 });
  // The id_token came straight from the token endpoint over verified TLS, so checking its claims suffices (OIDC Core 3.1.3.7).
  const claims = JSON.parse(Buffer.from(token.id_token.split(".")[1] ?? "", "base64url").toString() || "{}");
  const aud = [claims.aud].flat();
  if (claims.iss !== d.issuer || !aud.includes(OIDC.id) || !(claims.exp * 1000 > Date.now())) return new Response("Invalid login token", { status: 401 });
  const user = encodeURIComponent(String(claims.username || claims.email || claims.sub));
  const exp = Date.now() + SESSION_MS;
  let back = decodeURIComponent(saved.slice(dot + 1));
  if (!back.startsWith("/") || back.startsWith("//") || back.startsWith("/_hub/callback")) back = "/_hub";
  const headers = new Headers({ location: back });
  headers.append("set-cookie", `hub_session=${user}|${exp}|${sign(`${user}|${exp}`)}; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; SameSite=Lax${SECURE}`);
  headers.append("set-cookie", `hub_state=; Path=/_hub/callback; Max-Age=0`);
  return new Response(null, { status: 302, headers });
}

const authorized = (req: Request) => authorizedFor(req, PASSWORD);
export function authorizedFor(req: Request, password: string) {
  if (!password) return true;
  const [, encoded] = (req.headers.get("authorization") ?? "").split(" ");
  let given = "";
  try { given = atob(encoded ?? "").split(":").slice(1).join(":"); } catch {}
  // Compare digests so the check takes the same time whatever was typed.
  const digest = (v: string) => createHmac("sha256", SESSION_KEY).update(v).digest();
  return timingSafeEqual(digest(given), digest(password));
}

// Removing a preview: GitLab decides. The hub signs each person into GitLab (OAuth, same SSO, so usually no prompt):
// Remove shows only where they can push to the branch. Off unless a GitLab OAuth app is configured.
const GL = {
  url: process.env.GITLAB_URL ?? "",
  id: process.env.GITLAB_CLIENT_ID ?? "",
  secret: process.env.GITLAB_CLIENT_SECRET ?? "",
};
const GITLAB = Boolean(GL.url && GL.id && GL.secret);
// Tokens live in memory only: a hub restart costs everyone one more (usually silent) GitLab redirect.
const glTokens = new Map<string, { token: string; exp: number }>();
const glToken = (req: Request) => {
  const t = glTokens.get(readCookie(req, "hub_gl") ?? "");
  return t && t.exp > Date.now() ? t.token : undefined;
};
const gl = (token: string, path: string, method = "GET") =>
  fetch(`${GL.url}/api/v4/${path}`, { method, headers: { authorization: `Bearer ${token}` } });
const glProject = (s: Site) => encodeURIComponent(s.labels["hub.project"] ?? "");

const pushCache = new Map<string, { at: number; ok: boolean }>();
async function canRemove(token: string, s: Site, fresh = false) {
  const key = `${token}|${s.name}`;
  const hit = pushCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.ok;
  if (pushCache.size > 2000) pushCache.clear();
  const res = await gl(token, `projects/${glProject(s)}/repository/branches/${encodeURIComponent(s.labels["hub.branch"] ?? "")}`).catch(() => undefined);
  const ok = Boolean(res?.ok && ((await res.json()) as { can_push?: boolean }).can_push);
  pushCache.set(key, { at: Date.now(), ok });
  return ok;
}

function glLogin() {
  const state = randomBytes(16).toString("base64url");
  const auth = new URL(`${GL.url}/oauth/authorize`);
  auth.search = new URLSearchParams({ client_id: GL.id, redirect_uri: `${OIDC.hub}/_hub/gitlab`, response_type: "code", scope: "api", state }).toString();
  return new Response(null, { status: 302, headers: { location: auth.href, "set-cookie": `hub_glstate=${state}; Path=/_hub/gitlab; Max-Age=600; HttpOnly; SameSite=Lax${SECURE}` } });
}

async function glCallback(req: Request) {
  const url = new URL(req.url);
  const headers = new Headers({ location: "/_hub" });
  headers.append("set-cookie", `hub_glstate=; Path=/_hub/gitlab; Max-Age=0`);
  const state = readCookie(req, "hub_glstate");
  const code = url.searchParams.get("code");
  let token: { access_token?: string; expires_in?: number } = {};
  if (state && code && url.searchParams.get("state") === state) {
    const res = await fetch(`${GL.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: GL.id, client_secret: GL.secret, code, grant_type: "authorization_code", redirect_uri: `${OIDC.hub}/_hub/gitlab` }),
    }).catch(() => undefined);
    if (res?.ok) token = await res.json();
  }
  if (!token.access_token) {
    // Declined or failed: don't bounce again for an hour; the page offers a link instead.
    headers.append("set-cookie", `hub_gl=none; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax${SECURE}`);
    return new Response(null, { status: 302, headers });
  }
  const id = randomBytes(24).toString("base64url");
  const ttl = Math.min(token.expires_in ?? 7200, SESSION_MS / 1000);
  glTokens.set(id, { token: token.access_token, exp: Date.now() + ttl * 1000 - 60_000 });
  for (const [k, v] of glTokens) if (v.exp < Date.now()) glTokens.delete(k);
  headers.append("set-cookie", `hub_gl=${id}; Path=/; Max-Age=${ttl}; HttpOnly; SameSite=Lax${SECURE}`);
  return new Response(null, { status: 302, headers });
}

const removing = new Set<string>();
async function remove(req: Request, name: string) {
  if (req.method !== "POST" || req.headers.get("origin") !== new URL(OIDC.hub).origin) return new Response("Forbidden", { status: 403 });
  const token = glToken(req);
  const s = (await listSites(true)).sites.get(name);
  if (!token || !s || !(await canRemove(token, s, true))) return new Response("Only people who can push to this branch can remove its preview.", { status: 403 });
  const res = await builder(`/remove/${encodeURIComponent(name)}`, "POST").catch(() => undefined);
  if (!res?.ok) return new Response("The builder is not answering, so the preview is still up. Try again in a minute.", { status: 502 });
  removing.add(name);
  return new Response(null, { status: 303, headers: { location: "/_hub" } });
}

// Chat apps fetch a link to show a preview, without signing in. Give them a card built only from the
// address itself (repo and branch are in the URL anyway) instead of the NAS login page.
const PREVIEW_BOTS = /WhatsApp|facebookexternalhit|Facebot|Twitterbot|Slackbot|TelegramBot|Discordbot|LinkedInBot|SkypeUriPreview|Teams|Mattermost|redditbot|Applebot|Iframely|Embedly/i;
function previewCard(url: URL) {
  const [repo, branch] = url.pathname.split("/").filter(Boolean);
  const where = ORG ? `the site hub of ${ORG}` : "a private site hub";
  const title = repo && branch && !repo.startsWith("_") ? `${repo} · ${branch}` : "Site hub";
  const desc = repo && branch && !repo.startsWith("_") ? `A live preview on ${where}. Sign in with your NAS account to open it.` : `Live previews of every git branch, on ${where}.`;
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:site_name" content="${esc(ORG || "Site hub")}"><meta property="og:type" content="website"><meta property="og:url" content="${esc(OIDC.hub + url.pathname)}">
<meta property="og:image" content="${esc(OIDC.hub)}/_hub/og.png?v=2"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Site hub: every git branch, live, on your own NAS"><meta name="twitter:card" content="summary_large_image"><meta name="description" content="${esc(desc)}"></head><body>${esc(title)}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export async function handle(req: Request) {
  const url = new URL(req.url);
  // GitLab's push hooks go straight on to the builder, which checks their secret token. Without a login, because
  // GitLab has none; the only other way to the builder is through the hub's own calls below.
  if (url.pathname === "/_hub/hook" && req.method === "POST") {
    const res = await fetch(`${BUILDER}/hook`, { method: "POST", headers: { "x-gitlab-token": req.headers.get("x-gitlab-token") ?? "", "content-type": "application/json" }, body: req.body }).catch(() => undefined);
    return new Response(res?.ok ? "ok" : "builder unavailable", { status: res?.status ?? 502 });
  }
  // The preview picture is the same for every link and says nothing about any site, so it needs no login.
  if (url.pathname === "/_hub/og.png") return new Response(Bun.file(new URL("./og.png", import.meta.url).pathname), { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
  if (req.method === "GET" && PREVIEW_BOTS.test(req.headers.get("user-agent") ?? "") && !sessionUser(req)) return previewCard(url);
  let user: string | undefined;
  if (SSO) {
    if (url.pathname === "/_hub/callback") return callback(req);
    if (url.pathname === "/_hub/logout") return new Response(null, { status: 302, headers: { location: "/_hub/signed-out", "set-cookie": `hub_session=; Path=/; Max-Age=0${SECURE}` } });
    if (url.pathname === "/_hub/signed-out") return new Response('Signed out of the site hub. <a href="/_hub">Sign in again</a>', { headers: { "content-type": "text/html" } });
    user = sessionUser(req);
    if (!user) return login(req);
  } else if (!authorized(req)) {
    return new Response("Password required", { status: 401, headers: { "www-authenticate": 'Basic realm="site hub"' } });
  }
  const current = req.headers.get("cookie")?.match(/(?:^|;\s*)hub_site=([^;]+)/)?.[1];

  if (url.pathname === "/_hub" || url.pathname === "/_hub/") {
    if (!GITLAB) return hubPage(current, user);
    const token = glToken(req);
    if (!token && readCookie(req, "hub_gl") !== "none") return glLogin();
    return hubPage(current, user, token);
  }
  if (GITLAB && url.pathname === "/_hub/gitlab") return glCallback(req);
  if (GITLAB && url.pathname === "/_hub/gitlab/login") return glLogin();
  const rm = url.pathname.match(/^\/_hub\/remove\/([\w.-]+)$/);
  if (GITLAB && rm) return remove(req, rm[1]);
  // Old-style links still work: they go to the site's own path.
  const open = url.pathname.match(/^\/_hub\/open\/([\w.-]+)$/);
  if (open) {
    const s = (await listSites(true)).sites.get(open[1]);
    return s ? new Response(null, { status: 302, headers: { location: s.path + "/" } }) : new Response("No such site", { status: 404 });
  }
  const build = url.pathname.match(/^\/_hub\/build\/(site-[\w.-]+)$/);
  if (build) {
    const res = await builder(`/log/${build[1]}`).catch(() => undefined);
    return new Response(res?.ok ? await res.text() : "The builder is not answering.", { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  const logs = url.pathname.match(/^\/_hub\/logs\/([\w.-]+)$/);
  if (logs) {
    if (!(await listSites()).sites.has(logs[1])) return new Response("No such site", { status: 404 });
    const res = await fetch(`${DOCKER}/containers/${logs[1]}/logs?stdout=1&stderr=1&tail=300&timestamps=1`);
    return new Response(demux(new Uint8Array(await res.arrayBuffer())), { headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  // Only names the Docker API listed are ever proxied to, so no URL or cookie can point us anywhere else.
  const { sites } = await listSites();
  const under = (p: string) => [...sites.values()].find((s) => p === s.path || p.startsWith(s.path + "/"));
  const site = under(url.pathname);
  if (site) {
    if (url.pathname === site.path) return new Response(null, { status: 301, headers: { location: site.path + "/" + url.search } });
    return proxy(req, site, url.pathname.slice(site.path.length));
  }
  // A root-relative URL the HTML rewrite couldn't reach (built by the site's JavaScript or CSS): the page that
  // asked for it says which site it belongs to; failing that, the site this browser last opened.
  const referer = req.headers.get("referer");
  const from = referer && new URL(referer).host === url.host ? under(new URL(referer).pathname) : undefined;
  if (url.pathname === "/" && !from) return new Response(null, { status: 302, headers: { location: "/_hub" } });
  const target = from ?? (current ? sites.get(current) : undefined);
  if (!target) return new Response(null, { status: 302, headers: { location: "/_hub" } });
  // Pages move to their proper address, so what the address bar shows can be shared.
  if (req.headers.get("sec-fetch-mode") === "navigate") return new Response(null, { status: 302, headers: { location: target.path + url.pathname + url.search } });
  return proxy(req, target, url.pathname);
}

if (import.meta.main) {
  // HTTPS when the NAS certificate is mounted (compose.yaml); plain HTTP otherwise (local testing).
  const CERTS = process.env.CERT_DIR ?? "/certs";
  const certFile = Bun.file(`${CERTS}/fullchain.pem`);
  const tls = (await certFile.exists()) ? { cert: certFile, key: Bun.file(`${CERTS}/privkey.pem`) } : undefined;
  const server = Bun.serve({ port: Number(process.env.PORT) || 8080, fetch: handle, tls, maxRequestBodySize: 64 * 1024 * 1024 });
  if (!process.env.HUB_URL) console.warn("HUB_URL is not set: sign-in redirects and the Remove button will point at http://localhost:4300.");
  console.log(`site hub on ${tls ? "https" : "http"} :${server.port}${SSO ? " (Synology SSO)" : PASSWORD ? " (password protected)" : ""}`);
  // DSM renews the certificate in place; exit so Docker restarts us with the new one.
  if (tls) {
    const loaded = certFile.lastModified;
    setInterval(() => { if (Bun.file(`${CERTS}/fullchain.pem`).lastModified !== loaded) process.exit(0); }, 3600_000);
  }
}
