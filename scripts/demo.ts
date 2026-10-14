// Builds the GitHub Pages demo in docs/: the real hub page (router.ts) filled with made-up sites,
// plus one static page per site with the real badge. Run: bun scripts/demo.ts
const sites = [
  { name: "site-example-lab-project-wiki-main", project: "example-lab/project-wiki", branch: "main", title: "Add the calibration protocol page", author: "Jana Weber", hours: 3, page: "wiki" },
  { name: "site-example-lab-project-wiki-onboarding", project: "example-lab/project-wiki", branch: "onboarding", title: "Draft: first week for new students", author: "Tom Lindqvist", hours: 26, page: "onboarding" },
  { name: "site-example-lab-paper-companion-main", project: "example-lab/paper-companion", branch: "main", title: "Interactive figures for the preprint", author: "Maya Okafor", hours: 5, page: "paper" },
  { name: "site-example-lab-paper-companion-reviewer-2", project: "example-lab/paper-companion", branch: "reviewer-2", title: "Answer the second reviewer's comments", author: "Maya Okafor", hours: 1, page: "review" },
  { name: "site-maya-thesis-demo-main", project: "maya/thesis-demo", branch: "main", title: "Live demo of the chapter 3 model", author: "Maya Okafor", hours: 52, page: "thesis" },
];
const commit = (i: number) => ["4f2a9c1e", "b81d07aa", "9c3e55f0", "e06b12d4", "71aa3b9c"][i];

const docker = Bun.serve({ port: 0, fetch: () => Response.json(sites.map((s, i) => ({
  Names: ["/" + s.name], State: "running", Status: "Up", Created: Date.now() / 1000 - s.hours * 3600,
  Labels: { "hub.site": "1", "hub.project": s.project, "hub.branch": s.branch, "hub.title": s.title, "hub.commit": commit(i), "hub.author": s.author, "hub.url": "#" },
}))) });
// A pretend GitLab that lets the demo visitor push everywhere except the thesis, so Remove shows on most rows.
const gitlab = Bun.serve({ port: 0, fetch: (req) => Response.json({ can_push: !new URL(req.url).pathname.includes("thesis-demo") }) });
Object.assign(process.env, {
  DOCKER_API: `http://localhost:${docker.port}`, HUB_URL: "https://your-nas.example.org:4300", HUB_ORG: "Example Lab",
  GITLAB_URL: `http://localhost:${gitlab.port}`, GITLAB_CLIENT_ID: "demo", GITLAB_CLIENT_SECRET: "demo", OIDC_CLIENT_ID: "",
});
const { hubPage, badge, listSites } = await import("../router");
const live = (await listSites(true)).sites;

const DEMO = `<div class="demo-note" style="position:sticky;top:0;z-index:5;background:#000;color:#FFE14D;font:700 13px 'Space Mono',monospace;padding:10px 16px;text-align:center">
DEMO with made-up sites. Nothing here is real: search, open a site, or try Remove. <a href="./" style="color:#fff">← Back to the explanation</a></div>`;
// On GitHub Pages there is no server: Open goes to static pages, and Remove only pretends.
const SCRIPT = `<script>
rmdlg.querySelector("form").onsubmit = (e) => {
  if (e.submitter && e.submitter.classList.contains("cancel")) return;
  e.preventDefault();
  const site = decodeURIComponent(rmdlg.querySelector("form").action.split("/").pop());
  const b = document.querySelector('.rm[data-site="' + site + '"]');
  b.closest(".acts").innerHTML = '<span class="down">Removing… (demo: nothing happens)</span>';
  rmdlg.close();
};
</script>`;

let html = await (await hubPage("site-example-lab-paper-companion-main", "you", "demo-token")).text();
html = html
  .replaceAll('href="/_hub/logs/', 'href="logs/').replace(/href="logs\/([\w.-]+)"/g, 'href="logs/$1.txt"')
  .replace('<a href="/_hub/logout">Sign out →</a>', '<a href="./">About →</a>')
  .replace("<body><main>", "<body>" + DEMO + "<main>")
  .replace("</body></html>", SCRIPT + "</body></html>");
for (const s of live.values()) html = html.replaceAll(`href="${s.path}/"`, `href="sites/${s.name}.html"`);
await Bun.write("docs/demo.html", html);

const PAGES: Record<string, [string, string, string]> = {
  wiki: ["#F7F4EC", "Project wiki", "Protocols, data locations and who to ask, kept next to the code."],
  onboarding: ["#EEF3FF", "Your first week", "Accounts, safety briefing, the coffee rota. A draft for review."],
  paper: ["#F2F7EF", "Paper companion", "Every figure of the preprint, interactive, with the data behind it."],
  review: ["#FFF4EC", "Reviewer 2, answered", "Each comment, our reply and the change it led to, side by side."],
  thesis: ["#F3EFFA", "Chapter 3, live", "Move the sliders and watch the model respond, as in the defence."],
};
for (const s of sites) {
  const [bg, h, p] = PAGES[s.page];
  const site = { name: s.name, state: "running", status: "Up", created: 0, labels: { "hub.project": s.project, "hub.branch": s.branch } };
  await Bun.write(`docs/sites/${s.name}.html`, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${h}</title></head>
<body style="margin:0;min-height:100vh;background:${bg};font:18px/1.5 Georgia,serif;color:#1d1d1d">
<main style="max-width:720px;margin:0 auto;padding:96px 24px">
<p style="font:13px system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#666">A made-up site on branch <b>${s.branch}</b> of ${s.project}</p>
<h1 style="font-size:56px;line-height:1.05;margin:12px 0 16px">${h}</h1><p style="font-size:22px">${p}</p>
<p style="color:#666">In a real hub this is your own website, built from the branch's Dockerfile. The badge in the corner takes you back to the list.</p>
</main>${badge(site).replace('href="/_hub"', 'href="../demo.html"')}</body></html>`);
  await Bun.write(`docs/logs/${s.name}.txt`, `${new Date(Date.now() - s.hours * 3600_000).toISOString()} listening on :3000\n(demo log: in a real hub this is the last 300 lines of the site's output)\n`);
}
console.log(`docs/demo.html and ${sites.length} demo sites written`);
process.exit(0);
