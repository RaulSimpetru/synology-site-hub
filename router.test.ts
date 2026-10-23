import { expect, test } from "bun:test";
import { siteId } from "./site-id";

const mainPath = `/${siteId("g/p", "main")}`;

// Fake Synology SSO + fake Docker API + one fake site that echoes the cookies it receives.
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
let claims: Record<string, unknown> = {};
const sso = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const issuer = `http://localhost:${sso.port}`;
    if (url.pathname === "/.well-known/openid-configuration")
      return Response.json({ issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token` });
    if (url.pathname === "/token") {
      const form = new URLSearchParams(await req.text());
      if (req.headers.get("authorization") !== `Basic ${btoa("hub:s3cret")}` || form.get("code") !== "good") return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ id_token: `x.${b64({ iss: issuer, aud: "hub", exp: Date.now() / 1000 + 60, username: "alice", ...claims })}.sig` });
    }
    return new Response("?", { status: 404 });
  },
});
// Fake GitLab: alice may push to main, nobody to "locked".
const gitlab = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/oauth/token") {
      const form = new URLSearchParams(await req.text());
      return form.get("code") === "glgood" && form.get("client_secret") === "glsecret"
        ? Response.json({ access_token: "alice-token", expires_in: 7200 }) : Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (req.headers.get("authorization") !== "Bearer alice-token") return new Response("401", { status: 401 });
    const branch = url.pathname.match(/^\/api\/v4\/projects\/g%2Fp\/repository\/branches\/(.+)$/);
    if (branch) return Response.json({ can_push: branch[1] === "main" });
    return new Response("?", { status: 404 });
  },
});
const site = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/page") return new Response('<html><body><a href="/about">a</a><img src="/img.png" srcset="/s.png 1x, /l.png 2x"><a href="https://x.org/">x</a><a href="//cdn.x/y">c</a><a href="rel">r</a><form action="/send"></form></body></html>', { headers: { "content-type": "text/html" } });
  if (url.pathname === "/old") return new Response(null, { status: 302, headers: { location: "/new" } });
  if (url.pathname === "/old-prefix") return new Response('<a href="/p/main/page">Page</a>', { headers: { "content-type": "text/html" } });
  if (url.pathname === "/submit") return req.text().then((body) => new Response(`${req.method} ${body}`));
  return new Response(`path=${url.pathname} prefix=${req.headers.get("x-forwarded-prefix")} cookies=${req.headers.get("cookie")}`);
} });
// Fake builder: a few builds on their way; records removals and forwarded hooks.
const removed: string[] = [], hooks: string[] = [];
const started = Date.now() - 72_000;
const builder = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get("x-gitlab-token") !== "hooksecret") return new Response("Forbidden", { status: 403 });
    const b = (branch: string, sha: string, state: string) => ({ site: `site-g-p-${branch}`, project: "g/p", branch, sha, title: `Commit ${sha.slice(0, 4)}`, url: `http://gl/c/${sha}`, state, at: started, started });
    if (url.pathname === "/status") return Response.json([b("locked", "cccc3333ffff", "failed"), b("fresh-idea", "dddd4444ffff", "building"), b("waiting", "eeee5555ffff", "queued")].map((x) => x.state === "failed" ? { ...x, error: 'error: Could not resolve "three"' } : x));
    if (url.pathname === "/log/site-g-p-fresh-idea") return new Response("$ docker build\nstep 3/7\n");
    if (url.pathname.startsWith("/remove/") && req.method === "POST") { removed.push(url.pathname.slice(8)); return new Response("removed"); }
    if (url.pathname === "/hook" && req.method === "POST") { hooks.push(await req.text()); return new Response("ok"); }
    return new Response("?", { status: 404 });
  },
});
let containers = [{ Names: ["/127.0.0.1"], State: "running", Status: "Up", Created: 1, Labels: { "hub.site": "1", "hub.port": String(site.port), "hub.project": "g/p", "hub.branch": "main", "hub.commit": "aaaa1111", "hub.title": "Main site" } },
  { Names: ["/locked-site"], State: "running", Status: "Up", Created: 1, Labels: { "hub.site": "1", "hub.port": "1", "hub.project": "g/p", "hub.branch": "locked", "hub.commit": "bbbb2222", "hub.title": "Locked site" } }];
const docker = Bun.serve({ port: 0, fetch: () => Response.json(containers) });
Object.assign(process.env, {
  OIDC_ISSUER: `http://localhost:${sso.port}`, OIDC_CLIENT_ID: "hub", OIDC_CLIENT_SECRET: "s3cret",
  HUB_URL: "http://hub.test", DOCKER_API: `http://localhost:${docker.port}`,
  BUILDER_API: `http://localhost:${builder.port}`, HOOK_SECRET: "hooksecret",
  GITLAB_URL: `http://localhost:${gitlab.port}`, GITLAB_CLIENT_ID: "glhub", GITLAB_CLIENT_SECRET: "glsecret",
});
const { handle, listSites } = await import("./router");

const get = (path: string, cookie = "") => handle(new Request(`http://hub.test${path}`, { headers: { cookie } }));
const setCookies = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

async function signIn(code = "good", back = "/impressum") {
  const start = await get(back);
  const auth = new URL(start.headers.get("location")!);
  const state = auth.searchParams.get("state")!;
  return get(`/_hub/callback?code=${code}&state=${state}`, setCookies(start));
}

test("unauthenticated requests go to Synology SSO", async () => {
  const res = await get("/anything");
  expect(res.status).toBe(302);
  const auth = new URL(res.headers.get("location")!);
  expect(auth.pathname).toBe("/auth");
  expect(auth.searchParams.get("redirect_uri")).toBe("http://hub.test/_hub/callback");
});

test("login sets a session and returns to the page asked for", async () => {
  const res = await signIn();
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/impressum");
  const session = setCookies(res);
  expect((await get("/_hub", session + "; hub_gl=none")).status).toBe(200);
  expect(await (await get("/_hub", session + "; hub_gl=none")).text()).toContain("<span>alice</span><a href=\"/_hub/logout\">Sign out →</a>");
});

test("wrong state, bad code, wrong audience and tampered cookies are rejected", async () => {
  const start = await get("/");
  expect((await get("/_hub/callback?code=good&state=forged", setCookies(start))).status).toBe(400);
  expect((await signIn("bad")).status).toBe(502);
  claims = { aud: "someone-else" };
  expect((await signIn()).status).toBe(401);
  claims = {};
  const session = setCookies(await signIn()).replace("alice", "mallory");
  expect((await get("/_hub", session)).status).toBe(302);
});

test("no open redirect after login", async () => {
  expect((await signIn("good", "//evil.example")).headers.get("location")).toBe("/_hub");
});

test("the hub session cookie is not forwarded to sites", async () => {
  const session = setCookies(await signIn()) + "; theme=dark";
  const body = await (await get(`${mainPath}/`, session)).text();
  expect(body).toContain("theme=dark");
  expect(body).not.toContain("hub_session");
});

test("proxied responses vary on the cookie, so switching sites skips the browser cache", async () => {
  const session = setCookies(await signIn());
  const res = await get(`${mainPath}/`, session);
  expect(res.headers.get("vary")?.toLowerCase()).toContain("cookie");
});

test("each site has a UUID URL even before its container is migrated", async () => {
  const session = setCookies(await signIn());
  expect((await get("/_hub/open/127.0.0.1", session)).headers.get("location")).toBe(`${mainPath}/`);
  expect((await get(`${mainPath}?q=1`, session)).headers.get("location")).toBe(`${mainPath}/?q=1`);
  expect(await (await get(`${mainPath}/deep/page?q=1`, session)).text()).toContain(`path=/deep/page prefix=${mainPath}`);
  expect((await get("/", session)).headers.get("location")).toBe("/_hub");
  const html = await (await get("/_hub", session + "; hub_gl=none")).text();
  expect(html).toContain(`href="${mainPath}/"`);
  expect(html).not.toContain('href="/p/main/"');
});

test("old short and namespaced links redirect to the UUID, preserving pages, queries and POST bodies", async () => {
  const session = setCookies(await signIn());
  for (const old of ["/p/main", "/g/p/main"]) {
    for (const suffix of ["", "/", "/deep/page?q=a%2Fb&n=1"]) {
      const res = await get(old + suffix, session);
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe(mainPath + (suffix || "/"));
    }
  }
  const send = (path: string) => handle(new Request(`http://hub.test${path}`, { method: "POST", headers: { cookie: session }, body: "message=hello" }));
  for (const old of ["/p/main/submit", mainPath]) {
    const res = await send(old);
    expect(res.status).toBe(308);
  }
  const moved = await send("/p/main/submit");
  expect(await (await send(moved.headers.get("location")!)).text()).toBe("POST message=hello");
});

test("a site's root-relative links and redirects point at its own path", async () => {
  const session = setCookies(await signIn());
  const html = await (await get(`${mainPath}/page`, session)).text();
  for (const want of [`href="${mainPath}/about"`, `src="${mainPath}/img.png"`, `srcset="${mainPath}/s.png 1x, ${mainPath}/l.png 2x"`, `action="${mainPath}/send"`, 'href="https://x.org/"', 'href="//cdn.x/y"', 'href="rel"', 'href="/_hub"'])
    expect(html).toContain(want);
  expect((await get(`${mainPath}/old`, session)).headers.get("location")).toBe(`${mainPath}/new`);
  expect(await (await get(`${mainPath}/old-prefix`, session)).text()).toContain(`href="${mainPath}/page"`);
});

test("root-relative requests from a site's own script reach that site", async () => {
  const session = setCookies(await signIn());
  const req = (path: string, headers: Record<string, string>) => handle(new Request(`http://hub.test${path}`, { headers: { cookie: session, ...headers } }));
  for (const path of [mainPath, "/p/main"]) expect(await (await req("/api/data", { referer: `http://hub.test${path}/page` })).text()).toContain("path=/api/data");
  const nav = await req("/control", { referer: `http://hub.test${mainPath}/page`, "sec-fetch-mode": "navigate" });
  expect(nav.headers.get("location")).toBe(`${mainPath}/control`);
  expect((await req("/api/data", { referer: "http://evil.test/p/main/" })).headers.get("location")).toBe("/_hub");
  // No referer: the site this browser last opened.
  expect(await (await req("/api/data", { cookie: session + "; hub_site=127.0.0.1" })).text()).toContain("path=/api/data");
});

test("unknown UUID links never fall through to the last-viewed site's cookie or referer", async () => {
  const session = setCookies(await signIn());
  const res = await handle(new Request("http://hub.test/00000000-0000-5000-8000-000000000000/page", {
    headers: { cookie: session + "; hub_site=127.0.0.1", referer: `http://hub.test${mainPath}/page` },
  }));
  expect(res.status).toBe(404);
});

test("UUID paths survive container renaming and distinguish repo-name and branch-slug collisions", async () => {
  const original = containers;
  const session = setCookies(await signIn());
  try {
    containers = [["g/p", "main"], ["other/p", "main"], ["g/p", "feature/a"], ["g/p", "feature-a"]].map(([project, branch]) => ({
      ...original[0], Names: [`/site-${siteId(project, branch)}`], Labels: { ...original[0].Labels, "hub.project": project, "hub.branch": branch },
    }));
    const { sites } = await listSites(true);
    const paths = [...sites.values()].map(s => s.path);
    expect(new Set(paths).size).toBe(4);
    expect(paths).toContain(mainPath);
    expect((await get("/g/p/main/page", session)).headers.get("location")).toBe(`${mainPath}/page`);
    expect((await get("/other/p/main/page", session)).headers.get("location")).toBe(`/${siteId("other/p", "main")}/page`);
    expect((await get("/g/p/feature-a/", session)).status).toBe(404);
  } finally {
    containers = original;
    await listSites(true);
  }
});

test("Remove shows only where GitLab says you can push, and has the builder take the site down", async () => {
  const session = setCookies(await signIn());
  const bounce = await get("/_hub", session);
  const auth = new URL(bounce.headers.get("location")!);
  expect(auth.origin + auth.pathname).toBe(`http://localhost:${gitlab.port}/oauth/authorize`);
  const back = await get(`/_hub/gitlab?code=glgood&state=${auth.searchParams.get("state")}`, session + "; " + setCookies(bounce));
  const cookie = session + "; " + setCookies(back).replace(/hub_glstate=; /, "");
  const page = await (await get("/_hub", cookie)).text();
  expect(page).toContain('data-site="127.0.0.1"');
  expect(page).not.toContain('data-site="locked-site"');
  const post = (name: string, origin = "http://hub.test") => handle(new Request(`http://hub.test/_hub/remove/${name}`, { method: "POST", headers: { cookie, origin } }));
  expect((await post("locked-site")).status).toBe(403);
  expect((await post("127.0.0.1", "http://evil.test")).status).toBe(403);
  expect(removed).toEqual([]);
  expect((await post("127.0.0.1")).status).toBe(303);
  expect(removed).toEqual(["127.0.0.1"]);
  expect(await (await get("/_hub", cookie)).text()).toContain("Removing…");
});

test("a declined GitLab sign-in doesn't loop", async () => {
  const session = setCookies(await signIn());
  const back = await get("/_hub/gitlab?error=access_denied", session);
  expect(setCookies(back)).toContain("hub_gl=none");
  const page = await get("/_hub", session + "; hub_gl=none");
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("/_hub/gitlab/login");
});

test("the search script survives the template (regex escapes intact)", async () => {
  const page = await (await get("/_hub", setCookies(await signIn()) + "; hub_gl=none")).text();
  expect(page).toContain("split(/\\s+/)");
});

test("the shared password check accepts only the right password", async () => {
  const { authorizedFor } = await import("./router");
  const basic = (pw: string) => new Request("http://hub.test/", { headers: { authorization: `Basic ${btoa(`anyone:${pw}`)}` } });
  expect(authorizedFor(basic("right:pw"), "right:pw")).toBe(true);
  expect(authorizedFor(basic("wrong"), "right:pw")).toBe(false);
  expect(authorizedFor(new Request("http://hub.test/"), "right:pw")).toBe(false);
  expect(authorizedFor(new Request("http://hub.test/"), "")).toBe(true);
});

test("search only indexes site rows, not the Remove dialog's bullet points", async () => {
  const page = await (await get("/_hub", setCookies(await signIn()) + "; hub_gl=none")).text();
  expect(page).toContain('querySelectorAll("section ol>li")');
});

test("chat apps get a preview card built from the address, not the login page", async () => {
  const bot = (path: string) => handle(new Request(`http://hub.test${path}`, { headers: { "user-agent": "WhatsApp/2.23.20.0 A" } }));
  const card = await (await bot("/emg-website/main/")).text();
  expect(card).toContain('<meta property="og:title" content="emg-website · main">');
  expect(card).toContain("Sign in with your NAS account");
  expect(await (await bot("/_hub")).text()).toContain('content="Site hub"');
  const uuidCard = await (await bot(`${mainPath}/decomposition/`)).text();
  expect(uuidCard).toContain('<meta property="og:title" content="Site preview">');
  expect(uuidCard).not.toContain("Main site");
  expect(uuidCard).toContain("Sign in with your NAS account");
  // Only what's in the URL: no site list, no commit titles.
  expect(card).not.toContain("127.0.0.1");
  // People still go to sign-in.
  expect((await get("/emg-website/main/")).status).toBe(302);
});

test("the preview picture is public and the card points at it", async () => {
  const img = await handle(new Request("http://hub.test/_hub/og.png"));
  expect(img.status).toBe(200);
  expect(img.headers.get("content-type")).toBe("image/png");
  expect((await img.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  const card = await (await handle(new Request("http://hub.test/r/b/", { headers: { "user-agent": "WhatsApp/2" } }))).text();
  expect(card).toContain('<meta property="og:image" content="http://hub.test/_hub/og.png?v=2">');
});

test("build statuses: a step track for queued, building, failed and stopped branches", async () => {
  const session = setCookies(await signIn());
  const bounce = await get("/_hub", session);
  const state = new URL(bounce.headers.get("location")!).searchParams.get("state");
  const cookie = session + "; " + setCookies(await get(`/_hub/gitlab?code=glgood&state=${state}`, session + "; " + setCookies(bounce))).replace(/hub_glstate=; /, "");
  const page = await (await get("/_hub", cookie)).text();
  const row = (branch: string) => page.split("<li").find((li) => li.includes(`<code>${branch}</code>`)) ?? "";
  // Running and up to date: no track.
  expect(row("main")).not.toContain('class="track"');
  // A live site whose newer build failed: old version stays open, the error line and the job log are shown.
  expect(row("locked")).toContain('<span class="st fail">Build ✕</span>');
  expect(row("locked")).toContain("live: <span class=\"mono\">bbbb2222</span> · failed:");
  expect(row("locked")).toContain('error: Could not resolve &#34;three&#34;');
  expect(row("locked")).toContain('href="/_hub/build/site-g-p-locked">Build log');
  // A new branch on its first build, and one waiting for the runner: listed before anything is deployed.
  expect(row("fresh-idea")).toMatch(/<span class="st now">Build <span data-since="\d+">1:1/);
  expect(row("fresh-idea")).toContain("Not live yet");
  expect(row("fresh-idea")).toContain("<p>Commit dddd</p>");
  expect(row("locked")).toContain("“Commit cccc”");
  expect(row("fresh-idea")).toContain("data-active");
  expect(row("fresh-idea")).toContain('href="/_hub/build/site-g-p-fresh-idea">Watch log');
  expect(await (await get("/_hub/build/site-g-p-fresh-idea", cookie)).text()).toContain("step 3/7");
  expect(row("waiting")).toContain('<span class="st now">Queued</span>');
  expect(page).toContain("2 building · 1 failed");
});

test("GitLab push hooks reach the builder without a login, with their token passed on", async () => {
  const hook = (token: string) => handle(new Request("http://hub.test/_hub/hook", { method: "POST", headers: { "x-gitlab-token": token, "content-type": "application/json" }, body: '{"event_name":"push"}' }));
  expect((await hook("wrong")).status).toBe(403);
  expect((await hook("hooksecret")).status).toBe(200);
  expect(hooks).toEqual(['{"event_name":"push"}']);
  // Only POST /_hub/hook is open; the build log needs a login.
  expect((await get("/_hub/build/site-g-p-fresh-idea")).status).toBe(302);
});
