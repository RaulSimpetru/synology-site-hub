import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fake `docker` that records each call (and the env file it was given), and a fake GitLab with two repos:
// g/site has a Dockerfile, g/tool doesn't.
const dir = mkdtempSync(join(tmpdir(), "builder-test-"));
const calls = join(dir, "calls");
writeFileSync(join(dir, "docker"), `#!/bin/sh
echo "$*" >> ${calls}
for a in "$@"; do case "$prev" in --env-file) cat "$a" >> ${calls};; esac; prev=$a; done
case "$1" in
  image) exit 1;;
  build) ls -A "$5" >> ${calls}; [ -f "$5/FAIL" ] && { echo "error: Could not resolve \\"three\\"" >&2; exit 1; }; echo "built";;
  ps) echo site-g-site-main; echo site-g-site-dev;;
esac
`);
chmodSync(join(dir, "docker"), 0o755);

const tarball = async (files: Record<string, string>) => {
  const src = mkdtempSync(join(tmpdir(), "src-"));
  for (const [f, body] of Object.entries(files)) writeFileSync(join(src, f), body);
  await Bun.$`tar -czf ${src}.tgz -C ${src}/.. ${src.split("/").pop()}`.quiet();
  return readFileSync(`${src}.tgz`);
};
const good = await tarball({ Dockerfile: "FROM scratch" });
const bad = await tarball({ Dockerfile: "FROM scratch", FAIL: "" });

const gitlab = Bun.serve({ port: 0, fetch(req) {
  const url = new URL(req.url);
  if (req.headers.get("private-token") !== "readtoken") return new Response("401", { status: 401 });
  const p = decodeURIComponent(url.pathname);
  if (p === "/api/v4/projects/g/site/repository/files/Dockerfile") return new Response(null, { status: 200 });
  if (p === "/api/v4/projects/g/tool/repository/files/Dockerfile") return new Response(null, { status: 404 });
  if (p.startsWith("/api/v4/projects/g/site/repository/commits/")) return Response.json({ title: "Add a page", author_name: "Alice", web_url: "http://gl/g/site/-/commit/x" });
  if (p === "/api/v4/projects/g/site/repository/archive.tar.gz") return new Response(url.searchParams.get("sha")?.startsWith("bad") ? bad : good);
  if (p === "/api/v4/projects/g/site/variables") return Response.json([{ key: "SITE_ENV_SMTP_PASS", value: "hunter2" }, { key: "OTHER", value: "no" }]);
  return new Response("?", { status: 404 });
} });
Object.assign(process.env, { GITLAB_URL: `http://localhost:${gitlab.port}`, GITLAB_TOKEN: "readtoken", HOOK_SECRET: "s3cret", DOCKER_CLI: join(dir, "docker") });
const { handle, siteName, status } = await import("./builder");

const hook = (body: object, token = "s3cret") =>
  handle(new Request("http://builder/hook", { method: "POST", headers: { "x-gitlab-token": token }, body: JSON.stringify(body) }));
const push = (project: string, branch: string, after: string) => ({ event_name: "push", ref: `refs/heads/${branch}`, after, project: { path_with_namespace: project, web_url: `http://gl/${project}` } });
const settle = async () => { for (let i = 0; i < 100 && status().some((b) => b.state !== "failed"); i++) await Bun.sleep(20); };
const log = () => { try { return readFileSync(calls, "utf8"); } catch { return ""; } };

test("names match the ones GitLab CI used to make", () => {
  expect(siteName("officina-neurale/officina-neurale-website", "deck-look")).toBe("site-officina-neurale-officina-neurale-website-deck-look");
  expect(siteName("Raul/My_Site", "feature/New UI")).toBe("site-raul-my-site-feature-new-ui");
});

test("everything needs the hook secret", async () => {
  expect((await hook(push("g/site", "main", "a".repeat(40)), "wrong")).status).toBe(403);
  expect((await handle(new Request("http://builder/status"))).status).toBe(403);
  await Bun.sleep(50);
  expect(log()).toBe("");
});

test("a push with a Dockerfile builds and runs the site, locked down, with its SITE_ENV_ secrets", async () => {
  expect((await hook(push("g/site", "main", "a".repeat(40)))).status).toBe(200);
  await Bun.sleep(30);
  await settle();
  const out = log();
  expect(out).toContain("build --pull -t site-g-site-main");
  expect(out).toContain("run -d --name site-g-site-main --network sites --restart unless-stopped --memory 1g");
  expect(out).toContain("--cap-drop ALL --security-opt no-new-privileges");
  expect(out).toContain("--label hub.project=g/site --label hub.branch=main --label hub.commit=aaaaaaaa --label hub.title=Add a page --label hub.author=Alice");
  expect(out).toContain("SMTP_PASS=hunter2");
  // The secrets reach docker run only, never the build context.
  expect(out.slice(0, out.indexOf("run -d"))).not.toContain("hunter2");
  expect(out).not.toContain(".site.env");
  expect(out).not.toContain("OTHER=");
  const res = await handle(new Request("http://builder/log/site-g-site-main", { headers: { "x-gitlab-token": "s3cret" } }));
  expect(await res.text()).toContain("live");
});

test("repos without a Dockerfile and tag pushes are left alone", async () => {
  writeFileSync(calls, "");
  await hook(push("g/tool", "main", "a".repeat(40)));
  await hook({ ...push("g/site", "main", "a".repeat(40)), ref: "refs/tags/v1" });
  await Bun.sleep(50);
  expect(log()).toBe("");
  expect(status()).toEqual([]);
});

test("a failed build shows its error until the next push", async () => {
  await hook(push("g/site", "dev", "bad" + "0".repeat(37)));
  await Bun.sleep(30);
  await settle();
  const [f] = status();
  expect(f).toMatchObject({ site: "site-g-site-dev", state: "failed", error: 'error: Could not resolve "three"', title: "Add a page" });
});

test("deleting a branch or the project takes its sites down", async () => {
  writeFileSync(calls, "");
  await hook(push("g/site", "dev", "0".repeat(40)));
  await Bun.sleep(30);
  expect(log()).toContain("rm -f site-g-site-dev");
  expect(status()).toEqual([]);
  writeFileSync(calls, "");
  await hook({ event_name: "project_destroy", path_with_namespace: "g/site" });
  await Bun.sleep(30);
  expect(log()).toContain("rm -f site-g-site-main");
  expect(log()).toContain("rmi site-g-site-main");
});
