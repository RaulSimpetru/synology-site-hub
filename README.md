<div align="center">

# synology-site-hub

**Every git branch of your websites, live on your own Synology NAS, behind its login.**

**[Try the live demo](https://raulsimpetru.github.io/synology-site-hub/demo.html)** · [Project page](https://raulsimpetru.github.io/synology-site-hub/) · [MIT licence](LICENSE)

<img src="docs/explainer.gif" width="800" alt="Push a branch, it goes live on your NAS, open and share it, find and remove it">

[How it works](#how-it-works) · [Install](#install-about-20-minutes) · [Add a website](#add-a-website) · [Limits](#limits)

</div>

---

Want to share a project wiki, a demo or a paper page with your colleagues, without putting it on the public internet? Push a branch that has a `Dockerfile`. About two minutes later it's live at `https://your-nas:4300/<repo>/<branch>/` for everyone in your group. Every push updates it, and deleting the branch takes it down.

- **Your NAS accounts.** People sign in through DSM's SSO Server, or with a shared password.
- **Fuzzy search.** Every running branch, grouped by project; type `rv2` to find `reviewer-2`.
- **A link for every page.** Each site lives at `/<repo>/<branch>/`, so any page can be shared, and several sites work side by side in tabs. A small "← All sites" badge leads back to the list.
- **Remove.** Only shown to people who can push to that branch; GitLab checks and records it.
- **Isolated sites.** No host mounts, no Linux capabilities, 1 GB of RAM each.
- **Small.** One TypeScript file on Bun, with tests.

## How it works

```mermaid
flowchart LR
  dev([git push]) --> gl[GitLab CI]
  gl -- "builds the branch's Dockerfile<br/>on the NAS runner" --> site[(site container)]
  user([colleague]) -- "NAS login" --> hub[hub :4300]
  hub -- "lists and proxies" --> site
```

- **GitLab CI** builds each branch on a runner on the NAS and starts it as a container. Projects point at this repo's `review.gitlab-ci.yml`.
- **The hub** (`router.ts`) lists the running containers through a read-only Docker API and serves each one under its own path, rewriting the site's root-relative links to match.
- **Removing** a preview stops its GitLab environment, which runs the template's stop job.

## What you need

- A Synology NAS with **DSM 7.2+** and **Container Manager**, which provides `docker` and `docker compose`.
- SSH access to the NAS with an account that can run `sudo`.
- **GitLab**: self-hosted, for example on the same NAS, or gitlab.com. The runner only connects out to GitLab.
- Optional: DSM's **SSO Server** package, so people sign in with their NAS accounts.

## Install (about 20 minutes)

<details open>
<summary><b>1. Put the hub in GitLab</b></summary>

<br>

Create a GitLab project for the hub, for example `<group>/site-hub`, and push this repository to it. Site projects will use its `review.gitlab-ci.yml`.

Before you push, set `HUB_URL` in `review.gitlab-ci.yml` to the hub's address, for example `https://your-nas.example.org:4300`.

</details>

<details open>
<summary><b>2. Copy it to the NAS</b></summary>

<br>

DSM has no git, so copy the files from your computer. `-O` is needed because DSM's SSH often refuses the newer scp protocol.

```sh
ssh you@your-nas 'mkdir -p /volume1/docker/site-hub'
scp -O router.ts Dockerfile compose.yaml .env.example you@your-nas:/volume1/docker/site-hub/
```

</details>

<details open>
<summary><b>3. Configure and start</b></summary>

<br>

On the NAS:

```sh
cd /volume1/docker/site-hub
cp .env.example .env && chmod 600 .env
# edit .env: at least HUB_URL; SESSION_SECRET from `openssl rand -hex 32`
sudo docker compose up -d --build
```

The hub answers on port 4300 (`HUB_PORT` changes it). It serves HTTPS with DSM's default certificate, so use the hostname that certificate is issued for. If DSM's firewall is on, allow the port.

</details>

<details open>
<summary><b>4. Register the runner</b></summary>

<br>

The compose file includes a dedicated GitLab runner that only takes jobs tagged `site-hub`.

1. In GitLab, open your first site project → Settings → CI/CD → Runners → **New project runner**. Set the tag `site-hub`, untick "Run untagged jobs", and copy the `glrt-…` token.
2. On the NAS, in `/volume1/docker/site-hub`:

```sh
sudo docker compose run --rm runner register --non-interactive \
  --url https://your-gitlab.example.org --token glrt-… \
  --executor docker --docker-image docker:27-cli \
  --docker-volumes /var/run/docker.sock:/var/run/docker.sock --description site-hub
```

</details>

<details>
<summary><b>5. Sign-in with NAS accounts</b> (recommended)</summary>

<br>

1. Install **SSO Server** in DSM.
2. SSO Server → Application → Add → OIDC, with the redirect URI `https://your-nas:4300/_hub/callback`.
3. In `.env`, set `OIDC_ISSUER` (shown by SSO Server, usually `https://your-nas:8843/webman/sso`), `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`.
4. Run `sudo docker compose up -d router`.

Without SSO, set `HUB_PASSWORD` instead and everyone shares that password. With neither, the hub is open to anyone who can reach the port.

</details>

<details>
<summary><b>6. The Remove button</b> (optional)</summary>

<br>

1. In GitLab: Admin → Applications → New application (on gitlab.com: your group's Settings → Applications).
2. Redirect URI `https://your-nas:4300/_hub/gitlab`, scope `api`, and tick "Trusted" if you can, so nobody sees a consent screen.
3. In `.env`, set `GITLAB_URL`, `GITLAB_CLIENT_ID` and `GITLAB_CLIENT_SECRET`.
4. Run `sudo docker compose up -d router`.

Each person is signed into GitLab once, which is usually invisible behind SSO. Remove stops the branch's GitLab environment *as that person*; the branch itself is never touched.

</details>

### Settings

All settings live in `.env` on the NAS; [`.env.example`](.env.example) lists them.

| Variable | Needed for | Example |
|---|---|---|
| `HUB_URL` | always | `https://your-nas.example.org:4300` |
| `HUB_ORG` | label at the top right | `Example Lab` |
| `SESSION_SECRET` | staying signed in across restarts | output of `openssl rand -hex 32` |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | NAS sign-in | from DSM's SSO Server |
| `HUB_PASSWORD` | shared password instead of SSO | |
| `GITLAB_URL`, `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET` | the Remove button | from a GitLab OAuth app |

## Add a website

1. Add a **`Dockerfile`** at the repo root whose server listens on `$PORT` (3000). [`examples/Dockerfile.bun`](examples/Dockerfile.bun) is a starting point.
2. In the project, go to Settings → CI/CD → General pipelines, and set the **CI/CD configuration file** to `review.gitlab-ci.yml@<group>/site-hub`. Don't add a `.gitlab-ci.yml` of your own.
3. In the project, go to Settings → CI/CD → Runners, and **enable the `site-hub` runner**.

Then push a branch. It appears at `https://your-nas:4300/<repo>/<branch>/` (the branch name as GitLab slugs it, e.g. `feature/x` → `feature-x`). The pipeline's environment URL leads there too.

> **Secrets:** add a CI/CD variable `SITE_ENV_<NAME>` (masked, not protected). The site receives it as `<NAME>`, so `SITE_ENV_SMTP_PASS` becomes `SMTP_PASS`. It's written after `docker build`, so it never ends up in the image.

## Limits

- **Sites are served under a path.** Plain links, images, forms and redirects are rewritten automatically, and URLs that a site's JavaScript builds are routed by the page that asked for them. A single-page app with its own router may need its base path set; the hub sends it as the `X-Forwarded-Prefix` header.
- **No WebSockets** through the hub.
- **No persistent storage.** Whatever a site writes to disk is gone on its next deploy, so send data elsewhere, for example by email.
- **CPU priority, not a cap.** The Synology kernel can't hard-limit CPU, so sites get a lower priority instead.

> [!IMPORTANT]
> The CI jobs hold the Docker socket, which is root on the NAS. That's why the CI file lives in the hub project and branches can only supply a Dockerfile.
> - Enable the runner only for projects set up as in [Add a website](#add-a-website).
> - Give people the **Developer** role on site projects. A Maintainer could point the project back at its own CI file.

## Development

- **Tests:** `bun test`.
- **Update a running hub:** copy the new `router.ts` (and `compose.yaml` if it changed) to the NAS, then run `sudo docker compose up -d --build router`.
- **Project page:** `docs/` is the GitHub Pages site, served from `main` / `docs`. `docs/demo.html` is the real hub page with made-up sites; rebuild it after changing `router.ts` with `bun scripts/demo.ts`.

## Licence

[MIT](LICENSE), made by Raul C. Sîmpetru.
