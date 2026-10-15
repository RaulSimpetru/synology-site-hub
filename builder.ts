// Site builder: GitLab tells it about every push (a system hook, or project/group webhooks), and it builds
// the pushed branch's Dockerfile and runs it as a site container. It is the only part that holds the Docker
// socket, and only our own code runs with it: a repo controls nothing but its Dockerfile, which Docker builds
// without privileges. The hub reaches it over an internal network; nothing else can.
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GITLAB = process.env.GITLAB_URL ?? "";
const TOKEN = process.env.GITLAB_TOKEN ?? ""; // read_api + read_repository, from an account that can read every site repo
const SECRET = process.env.HOOK_SECRET ?? "";
const DOCKER = process.env.DOCKER_CLI ?? "docker";
const BUILD_MS = 20 * 60_000;

type Job = { site: string; project: string; id: string; branch: string; sha: string; title: string; author: string; url: string; at: number };
// ponytail: in memory, so a builder restart forgets queued and failed builds (the next push brings them back).
const wanted = new Map<string, Job>(); // queued, oldest first; a newer push to the same branch replaces its entry
let current: (Job & { started: number }) | undefined;
const failed = new Map<string, Job & { error: string }>();
const logs = new Map<string, string>();

// GitLab's CI_PROJECT_PATH_SLUG / CI_COMMIT_REF_SLUG, so container names match the ones CI used to make.
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 63).replace(/^-+|-+$/g, "");
export const siteName = (project: string, branch: string) => `site-${slug(project)}-${slug(branch)}`;

const gl = (path: string, method = "GET") => fetch(`${GITLAB}/api/v4/${path}`, { method, headers: { "private-token": TOKEN } });

async function run(args: string[], log?: (s: string) => void) {
  const p = Bun.spawn([DOCKER, ...args], { stdout: "pipe", stderr: "pipe", timeout: BUILD_MS });
  let out = "";
  const read = async (s: ReadableStream<Uint8Array>) => { for await (const chunk of s.pipeThrough(new TextDecoderStream())) { out += chunk; log?.(chunk); } };
  await Promise.all([read(p.stdout), read(p.stderr)]);
  const code = await p.exited;
  if (code !== 0) throw new Error(out.trim().split("\n").reverse().find((l) => /error|failed|not found|cannot/i.test(l)) ?? `docker ${args[0]} exited ${code}`);
  return out.trim();
}

export async function removeSite(site: string) {
  wanted.delete(site);
  failed.delete(site);
  logs.delete(site);
  await run(["rm", "-f", site]).catch(() => {});
  await run(["rmi", site]).catch(() => {});
}

// Project CI/CD variables named SITE_ENV_<NAME> reach the site as <NAME>, at run time only, so no secret is in the image.
async function siteEnv(id: string, log: (s: string) => void) {
  const res = await gl(`projects/${id}/variables?per_page=100`);
  if (!res.ok) { log(`(no SITE_ENV_ variables: GitLab answered ${res.status})\n`); return ""; }
  return ((await res.json()) as { key: string; value: string }[])
    .filter((v) => v.key.startsWith("SITE_ENV_") && !/[\r\n]/.test(v.value))
    .map((v) => `${v.key.slice(9)}=${v.value}\n`).join("");
}

async function deploy(j: Job, log: (s: string) => void) {
  const dir = await mkdtemp(join(tmpdir(), "site-"));
  try {
    log(`$ fetch ${j.project} @ ${j.sha.slice(0, 8)}\n`);
    const tar = await gl(`projects/${j.id}/repository/archive.tar.gz?sha=${j.sha}`);
    if (!tar.ok) throw new Error(`GitLab answered ${tar.status} for the source archive`);
    await Bun.write(`${dir}.tgz`, tar);
    const x = Bun.spawn(["tar", "-xzf", `${dir}.tgz`, "-C", dir, "--strip-components=1"], { stderr: "pipe" });
    if ((await x.exited) !== 0) throw new Error(`could not unpack the source: ${await new Response(x.stderr).text()}`);
    // Outside the build context, so a Dockerfile's COPY . can't bake the secrets into the image.
    await writeFile(`${dir}.env`, await siteEnv(j.id, log), { mode: 0o600 });
    const old = await run(["image", "inspect", "-f", "{{.Id}}", j.site]).catch(() => "");
    log(`$ docker build --pull -t ${j.site} .\n`);
    await run(["build", "--pull", "-t", j.site, dir], log);
    await run(["rm", "-f", j.site]).catch(() => {});
    // Sites get no host mounts, no capabilities and capped resources; they only join the hub network.
    log(`$ docker run ${j.site}\n`);
    await run(["run", "-d", "--name", j.site, "--network", "sites", "--restart", "unless-stopped",
      "--memory", "1g", "--cpu-shares", "512", "--pids-limit", "512", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "-e", "PORT=3000", "--env-file", `${dir}.env`,
      "--label", "hub.site=1", "--label", "hub.port=3000", "--label", `hub.project=${j.project}`, "--label", `hub.branch=${j.branch}`,
      "--label", `hub.commit=${j.sha.slice(0, 8)}`, "--label", `hub.title=${j.title}`, "--label", `hub.author=${j.author}`, "--label", `hub.url=${j.url}`,
      j.site], log);
    if (old && old !== (await run(["image", "inspect", "-f", "{{.Id}}", j.site]).catch(() => old))) await run(["rmi", old]).catch(() => {});
    log("live\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(`${dir}.tgz`, { force: true });
    await rm(`${dir}.env`, { force: true });
  }
}

// One build at a time, so a burst of pushes can't starve the NAS.
async function work() {
  if (current) return;
  for (let j = wanted.values().next().value; j; j = wanted.values().next().value) {
    wanted.delete(j.site);
    current = { ...j, started: Date.now() };
    let text = "";
    const log = (s: string) => { text = (text + s).slice(-200_000); logs.set(j.site, text); };
    log("");
    try {
      await deploy(j, log);
      failed.delete(j.site);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      log(`\nbuild failed: ${error}\n`);
      if (!wanted.has(j.site)) failed.set(j.site, { ...j, error });
    }
    current = undefined;
  }
}

const ZERO = /^0+$/;
export async function onHook(body: any) {
  const kind = body.event_name ?? body.object_kind;
  const project = String(body.project?.path_with_namespace ?? body.path_with_namespace ?? "");
  if (kind === "project_destroy" && project) {
    const names = await run(["ps", "-a", "--filter", "label=hub.site", "--filter", `label=hub.project=${project}`, "--format", "{{.Names}}"]).catch(() => "");
    for (const name of names.split("\n").filter(Boolean)) await removeSite(name);
    return "removed";
  }
  if (kind !== "push" || !project || !String(body.ref ?? "").startsWith("refs/heads/")) return "ignored";
  const branch = body.ref.slice("refs/heads/".length);
  const site = siteName(project, branch);
  if (ZERO.test(body.after ?? "")) { await removeSite(site); return "removed"; }
  const id = encodeURIComponent(project);
  const sha = String(body.after ?? body.checkout_sha);
  // Only branches with a Dockerfile at the root are sites; everything else is left alone.
  const file = await gl(`projects/${id}/repository/files/Dockerfile?ref=${sha}`, "HEAD");
  // GitLab also answers 404 for a project the token can't see.
  if (file.status === 404) { console.log(`${project} ${branch}: no Dockerfile at the root (or GITLAB_TOKEN can't read it), skipped`); return "no Dockerfile"; }
  if (!file.ok) throw new Error(`GitLab answered ${file.status} (does GITLAB_TOKEN have read_api on ${project}?)`);
  const c = (await (await gl(`projects/${id}/repository/commits/${sha}`)).json().catch(() => ({}))) as { title?: string; author_name?: string; web_url?: string };
  wanted.delete(site); // re-queue at the back
  wanted.set(site, { site, project, id, branch, sha, title: c.title ?? "", author: c.author_name ?? body.user_name ?? "", url: c.web_url ?? `${body.project?.web_url ?? ""}/-/commit/${sha}`, at: Date.now() });
  failed.delete(site);
  void work();
  return "queued";
}

export function status() {
  const list = [...wanted.values()].map((j) => ({ ...j, state: "queued" }));
  if (current) list.push({ ...current, state: "building" });
  for (const f of failed.values()) list.push({ ...f, state: "failed" });
  return list;
}

const digest = (s: string) => createHash("sha256").update(s).digest();
const allowed = (req: Request) => Boolean(SECRET) && timingSafeEqual(digest(req.headers.get("x-gitlab-token") ?? ""), digest(SECRET));

export async function handle(req: Request) {
  if (!allowed(req)) return new Response("Forbidden", { status: 403 });
  const { pathname } = new URL(req.url);
  if (pathname === "/hook" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    // Answer GitLab at once; the hub shows the outcome.
    onHook(body).catch((e) => console.error(`hook for ${body.project?.path_with_namespace}: ${e}`));
    return new Response("ok");
  }
  if (pathname === "/status") return Response.json(status());
  const log = pathname.match(/^\/log\/([\w.-]+)$/);
  if (log) return new Response(logs.get(log[1]) ?? "No build log yet (the builder keeps the last one per branch until it restarts).\n");
  const rm = pathname.match(/^\/remove\/(site-[\w.-]+)$/);
  if (rm && req.method === "POST") { await removeSite(rm[1]); return new Response("removed"); }
  return new Response("Not found", { status: 404 });
}

if (import.meta.main) {
  if (!GITLAB || !TOKEN || !SECRET) console.warn("The builder needs GITLAB_URL, GITLAB_TOKEN and HOOK_SECRET; until then no site gets built.");
  const server = Bun.serve({ port: Number(process.env.PORT) || 8081, fetch: handle, maxRequestBodySize: 32 * 1024 * 1024 });
  console.log(`site builder on :${server.port}`);
}
