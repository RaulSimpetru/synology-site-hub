import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fake `docker` that records each call (and the env file it was given), and a fake GitLab with two repos:
// g/site has a Dockerfile, g/tool doesn't.
const dir = mkdtempSync(join(tmpdir(), "builder-test-"));
const calls = join(dir, "calls");
const legacyLabels = join(dir, "legacy-labels");
const runFailure = join(dir, "run-failure");
writeFileSync(join(dir, "docker"), `#!/bin/sh
echo "$*" >> ${calls}
for a in "$@"; do case "$prev" in --env-file) cat "$a" >> ${calls};; esac; prev=$a; done
case "$1" in
  image) exit 1;;
  inspect) [ -f ${legacyLabels} ] || exit 1; cat ${legacyLabels};;
  run) [ ! -f ${runFailure} ] || { echo "error: could not start container" >&2; exit 1; };;
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
const longProject = "n-squared-lab/projects/pre-release-software/myolytica";
const legacyName = "site-n-squared-lab-projects-pre-release-software-myolytica-develop";

const gitlab = Bun.serve({ port: 0, fetch(req) {
  const url = new URL(req.url);
  if (req.headers.get("private-token") !== "readtoken") return new Response("401", { status: 401 });
  const p = decodeURIComponent(url.pathname).replace(`/projects/${longProject}/`, "/projects/g/site/");
  if (p === "/api/v4/projects/g/site/repository/files/Dockerfile") return new Response(null, { status: 200 });
  if (p === "/api/v4/projects/g/tool/repository/files/Dockerfile") return new Response(null, { status: 404 });
  if (p.startsWith("/api/v4/projects/g/site/repository/commits/")) return Response.json({ title: "Add a page", author_name: "Alice", web_url: "http://gl/g/site/-/commit/x" });
  if (p === "/api/v4/projects/g/site/repository/archive.tar.gz") return new Response(url.searchParams.get("sha")?.startsWith("bad") ? bad : good);
  if (p === "/api/v4/projects/g/site/variables") return Response.json([{ key: "SITE_ENV_SMTP_PASS", value: "hunter2" }, { key: "OTHER", value: "no" }]);
  return new Response("?", { status: 404 });
} });
Object.assign(process.env, { GITLAB_URL: `http://localhost:${gitlab.port}`, GITLAB_TOKEN: "readtoken", HOOK_SECRET: "s3cret", DOCKER_CLI: join(dir, "docker") });
const { handle, onHook, siteName, status } = await import("./builder");

const hook = (body: object, token = "s3cret") =>
  handle(new Request("http://builder/hook", { method: "POST", headers: { "x-gitlab-token": token }, body: JSON.stringify(body) }));
const push = (project: string, branch: string, after: string) => ({ event_name: "push", ref: `refs/heads/${branch}`, after, project: { path_with_namespace: project, web_url: `http://gl/${project}` } });
const settle = async () => { for (let i = 0; i < 100 && status().some((b) => b.state !== "failed"); i++) await Bun.sleep(20); };
const log = () => { try { return readFileSync(calls, "utf8"); } catch { return ""; } };

test("site identities use standard UUIDv5 values (verified with Python's uuid.uuid5)", () => {
  expect(siteName("g/site", "main")).toBe("site-3789bce5-3886-542c-8bc2-5b4ae1373110");
  expect(siteName(longProject, "develop")).toBe("site-ae249273-8346-5e30-a077-4bb72d3e9dfc");
});

test("all project and branch names yield stable 41-character DNS labels", () => {
  expect(legacyName.length).toBe(66);
  for (const [project, branch] of [["g/site", "main"], [longProject, "main"], [longProject, "mains"], [longProject, "develop"], [longProject, "feat/new-manual"], ["a".repeat(200), "b".repeat(200)], ["組/專案", "改進"]]) {
    const name = siteName(project, branch);
    expect(name.length).toBe(41);
    expect(name).toMatch(/^site-[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(siteName(project, branch)).toBe(name);
  }
});

test("UUIDs distinguish full project and branch identities, even when their slugs match", () => {
  const prefix = "x".repeat(80);
  const pairs = [[`${prefix}/one`, "develop"], [`${prefix}/two`, "develop"],
    [longProject, `${prefix}/one`], [longProject, `${prefix}/two`],
    [longProject, "feature/a"], [longProject, "feature-a"], [longProject, "Feature/a"],
    ["a/b", "c"], ["a", "b/c"], ["g/site", "feature/a"], ["g/site", "feature-a"]];
  expect(new Set(pairs.map(([project, branch]) => siteName(project, branch))).size).toBe(pairs.length);
});

test("everything needs the hook secret", async () => {
  expect((await hook(push("g/site", "main", "a".repeat(40)), "wrong")).status).toBe(403);
  expect((await handle(new Request("http://builder/status"))).status).toBe(403);
  await Bun.sleep(50);
  expect(log()).toBe("");
});

test("a push with a Dockerfile builds and runs the site, locked down, with its SITE_ENV_ secrets", async () => {
  writeFileSync(legacyLabels, JSON.stringify({ "hub.site": "1", "hub.project": "g/site", "hub.branch": "main" }));
  expect((await hook(push("g/site", "main", "a".repeat(40)))).status).toBe(200);
  await Bun.sleep(30);
  await settle();
  const out = log();
  const name = siteName("g/site", "main");
  expect(out).toContain(`build --pull -t ${name}`);
  expect(out).toContain(`run -d --name ${name} --network sites --restart unless-stopped --memory 1g`);
  expect(out).toContain("--cap-drop ALL --security-opt no-new-privileges");
  expect(out).toContain("--label hub.project=g/site --label hub.branch=main --label hub.commit=aaaaaaaa --label hub.title=Add a page --label hub.author=Alice");
  expect(out).toContain("SMTP_PASS=hunter2");
  // The secrets reach docker run only, never the build context.
  expect(out.slice(0, out.indexOf("run -d"))).not.toContain("hunter2");
  expect(out).not.toContain(".site.env");
  expect(out).not.toContain("OTHER=");
  expect(out).toContain("rm -f site-g-site-main\n");
  expect(out.indexOf("rm -f site-g-site-main\n")).toBeGreaterThan(out.indexOf(`run -d --name ${name} `));
  rmSync(legacyLabels);
  const res = await handle(new Request(`http://builder/log/${name}`, { headers: { "x-gitlab-token": "s3cret" } }));
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
  expect(f).toMatchObject({ site: siteName("g/site", "dev"), state: "failed", error: 'error: Could not resolve "three"', title: "Add a page" });
});

test("deleting a branch or the project takes its sites down", async () => {
  writeFileSync(calls, "");
  await hook(push("g/site", "dev", "0".repeat(40)));
  await Bun.sleep(30);
  expect(log()).toContain(`rm -f ${siteName("g/site", "dev")}`);
  expect(status()).toEqual([]);
  writeFileSync(calls, "");
  await hook({ event_name: "project_destroy", path_with_namespace: "g/site" });
  await Bun.sleep(30);
  expect(log()).toContain("rm -f site-g-site-main");
  expect(log()).toContain("rmi site-g-site-main");
});

test("a long-name site migrates only after its replacement starts, keeping its original labels and build log", async () => {
  writeFileSync(calls, "");
  writeFileSync(legacyLabels, JSON.stringify({ "hub.site": "1", "hub.project": longProject, "hub.branch": "develop" }));
  await onHook(push(longProject, "develop", "a".repeat(40)));
  await settle();
  const name = siteName(longProject, "develop");
  const out = log();
  expect(out).toContain(`build --pull -t ${name} `);
  expect(out).toContain(`run -d --name ${name} --network sites`);
  expect(out).toContain(`--label hub.project=${longProject} --label hub.branch=develop`);
  expect(out).toContain(`rm -f ${legacyName}\n`);
  expect(out).toContain(`rmi ${legacyName}\n`);
  expect(out.indexOf(`rm -f ${legacyName}\n`)).toBeGreaterThan(out.indexOf(`run -d --name ${name} `));
  const res = await handle(new Request(`http://builder/log/${name}`, { headers: { "x-gitlab-token": "s3cret" } }));
  expect(await res.text()).toContain("live");
  expect(status()).toEqual([]);
});

test("failed builds and failed starts leave the legacy container alone", async () => {
  for (const failRun of [false, true]) {
    writeFileSync(calls, "");
    if (failRun) writeFileSync(runFailure, "");
    try {
      await onHook(push(longProject, "develop", failRun ? "a".repeat(40) : "bad" + "0".repeat(37)));
      await settle();
      expect(status()).toContainEqual(expect.objectContaining({ site: siteName(longProject, "develop"), state: "failed" }));
      expect(log()).not.toContain(`rm -f ${legacyName}\n`);
      expect(log()).not.toContain(`rmi ${legacyName}\n`);
    } finally {
      rmSync(runFailure, { force: true });
    }
  }
});

test("deleting a long-name branch removes both names and clears its failed build", async () => {
  writeFileSync(calls, "");
  await onHook(push(longProject, "develop", "0".repeat(40)));
  const out = log();
  for (const name of [siteName(longProject, "develop"), legacyName]) {
    expect(out).toContain(`rm -f ${name}\n`);
    expect(out).toContain(`rmi ${name}\n`);
  }
  expect(status()).toEqual([]);
});

test("migration never removes a legacy name belonging to another branch or project, or an unmanaged container", async () => {
  for (const labels of [
    { "hub.site": "1", "hub.project": longProject, "hub.branch": "Develop" },
    { "hub.site": "1", "hub.project": longProject.replace("n-squared", "n_squared"), "hub.branch": "develop" },
    { "hub.project": longProject, "hub.branch": "develop" },
  ]) {
    writeFileSync(calls, "");
    writeFileSync(legacyLabels, JSON.stringify(labels));
    await onHook(push(longProject, "develop", "0".repeat(40)));
    expect(log()).not.toContain(`rm -f ${legacyName}\n`);
    expect(log()).not.toContain(`rmi ${legacyName}\n`);
  }
  rmSync(legacyLabels);
});
