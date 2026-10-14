import { expect, test } from "bun:test";

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
const stopped: string[] = [];
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
    if (url.pathname === "/api/v4/projects/g%2Fp/environments" && url.searchParams.get("name") === "review/main") return Response.json([{ id: 7 }]);
    if (url.pathname === "/api/v4/projects/g%2Fp/environments/7/stop" && req.method === "POST") { stopped.push("main"); return Response.json({}); }
    return new Response("?", { status: 404 });
  },
});
const site = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => new Response(`cookies=${req.headers.get("cookie")}`) });
const docker = Bun.serve({
  port: 0,
  fetch: () => Response.json([{ Names: ["/127.0.0.1"], State: "running", Status: "Up", Created: 1, Labels: { "hub.site": "1", "hub.port": String(site.port), "hub.project": "g/p", "hub.branch": "main" } },
    { Names: ["/locked-site"], State: "running", Status: "Up", Created: 1, Labels: { "hub.site": "1", "hub.port": "1", "hub.project": "g/p", "hub.branch": "locked" } }]),
});
Object.assign(process.env, {
  OIDC_ISSUER: `http://localhost:${sso.port}`, OIDC_CLIENT_ID: "hub", OIDC_CLIENT_SECRET: "s3cret",
  HUB_URL: "http://hub.test", DOCKER_API: `http://localhost:${docker.port}`,
  GITLAB_URL: `http://localhost:${gitlab.port}`, GITLAB_CLIENT_ID: "glhub", GITLAB_CLIENT_SECRET: "glsecret",
});
const { handle } = await import("./router");

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
  let session = setCookies(await signIn());
  const open = await get("/_hub/open/127.0.0.1", session);
  session += "; " + setCookies(open) + "; theme=dark";
  const body = await (await get("/", session)).text();
  expect(body).toContain("theme=dark");
  expect(body).not.toContain("hub_session");
});

test("proxied responses vary on the cookie, so switching sites skips the browser cache", async () => {
  const session = setCookies(await signIn());
  const open = await get("/_hub/open/127.0.0.1", session);
  const res = await get("/", session + "; " + setCookies(open));
  expect(res.headers.get("vary")?.toLowerCase()).toContain("cookie");
});

test("typing the hub address shows the site list, links inside a site still reach it", async () => {
  const session = setCookies(await signIn());
  const cookie = session + "; " + setCookies(await get("/_hub/open/127.0.0.1", session));
  const nav = (site: string, extra = {}) => handle(new Request("http://hub.test/", { headers: { cookie, "sec-fetch-site": site, "sec-fetch-mode": "navigate", ...extra } }));
  expect((await nav("none", { "cache-control": "max-age=0" })).status).toBe(200); // reload
  expect((await nav("same-origin")).status).toBe(200);
  expect((await nav("cross-site")).status).toBe(200); // a /_hub/open link from chat or email
  const pasted = (site: string) => handle(new Request("http://hub.test/", { headers: { cookie: cookie.replace(/; hub_opened=1/, ""), "sec-fetch-site": site, "sec-fetch-mode": "navigate" } }));
  expect(cookie).toContain("hub_opened=1");
  expect((await nav("none")).status).toBe(200); // a /_hub/open link pasted into the address bar
  expect((await pasted("none")).headers.get("location")).toBe("/_hub");
});

test("Remove shows only where GitLab says you can push, and stops the environment as you", async () => {
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
  expect(stopped).toEqual([]);
  expect((await post("127.0.0.1")).status).toBe(303);
  expect(stopped).toEqual(["main"]);
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
