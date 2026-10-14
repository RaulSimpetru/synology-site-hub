# synology-site-hub

Live previews of every git branch of your websites, hosted on your own Synology NAS and behind its login.

Push a branch that has a `Dockerfile`, and about two minutes later it appears at `https://your-nas:4300` for everyone in your group. Every push updates it. Deleting the branch, or pressing **Remove** in the hub, takes it offline. It's built for sharing a project wiki, a demo or a paper page with colleagues, without a public server.

- **Hub page:** every running branch grouped by project, with fuzzy search, Open, logs and Remove.
- **Login:** your NAS accounts, through DSM's SSO Server. Without that, a shared password.
- **Remove:** shown only to people who can push to that branch in GitLab, and GitLab checks the rights itself.
- **Badge:** each preview gets a small "← All sites" badge to get back to the hub.
- **Isolation:** sites run with no host mounts, no Linux capabilities and 1 GB of RAM each.

**[See how it works and try the demo](https://raulsimpetru.github.io/synology-site-hub/)**, with made-up sites.

## What you need

- A Synology NAS with DSM 7.2 or later and **Container Manager** installed. Container Manager provides `docker` and `docker compose`.
- SSH access to the NAS with an account that can run `sudo`.
- **GitLab**: self-hosted (for example on the same NAS) or gitlab.com. The runner on the NAS only connects out to GitLab.
- Optional: the **SSO Server** package, so people sign in with their NAS accounts.

## Install (once, about 20 minutes)

### 1. Put the hub in GitLab

Create a GitLab project for the hub, for example `<group>/site-hub`, and push this repository to it. Site projects will use its `review.gitlab-ci.yml`.

Before you push, open `review.gitlab-ci.yml` and set `HUB_URL` to the address the hub will have, for example `https://your-nas.example.org:4300`.

### 2. Copy it to the NAS

DSM has no git, so copy the files over from your computer:

```sh
ssh you@your-nas 'mkdir -p /volume1/docker/site-hub'
scp -O router.ts Dockerfile compose.yaml .env.example you@your-nas:/volume1/docker/site-hub/
```

The `-O` flag is needed because DSM's SSH often refuses the newer scp protocol.

### 3. Configure and start

On the NAS:

```sh
cd /volume1/docker/site-hub
cp .env.example .env && chmod 600 .env
# Edit .env: at least HUB_URL. SESSION_SECRET: openssl rand -hex 32
sudo docker compose up -d --build
```

The hub now answers on port 4300 (set `HUB_PORT` in `.env` to change it). It serves HTTPS with DSM's default certificate, so use the hostname that certificate is issued for. If DSM's firewall is on, allow the port.

### 4. Register the runner

The compose file includes a dedicated GitLab runner that only takes jobs tagged `site-hub`.

1. In GitLab, open your first site project → Settings → CI/CD → Runners → **New project runner**. Set the tag `site-hub`, untick "Run untagged jobs", and copy the `glrt-…` token.
2. On the NAS, in `/volume1/docker/site-hub`:
   ```sh
   sudo docker compose run --rm runner register --non-interactive \
     --url https://your-gitlab.example.org --token glrt-… \
     --executor docker --docker-image docker:27-cli \
     --docker-volumes /var/run/docker.sock:/var/run/docker.sock --description site-hub
   ```

### 5. Sign-in with NAS accounts (recommended)

1. Install **SSO Server** in DSM.
2. Go to SSO Server → Application → Add, choose OIDC, and set the redirect URI to `https://your-nas:4300/_hub/callback`.
3. In `.env`, set `OIDC_ISSUER` (shown by SSO Server, usually `https://your-nas:8843/webman/sso`), `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`.
4. Run `sudo docker compose up -d router`.

Without SSO, set `HUB_PASSWORD` in `.env` instead, and everyone shares that password. With neither, the hub is open to anyone who can reach the port.

### 6. The Remove button (optional)

1. In GitLab, go to Admin → Applications → New application. On gitlab.com, use your group's Settings → Applications instead.
2. Set the redirect URI to `https://your-nas:4300/_hub/gitlab`, tick the scope `api`, and tick "Trusted" if you can, so nobody sees a consent screen.
3. In `.env`, set `GITLAB_URL`, `GITLAB_CLIENT_ID` and `GITLAB_CLIENT_SECRET`.
4. Run `sudo docker compose up -d router`.

Each person is signed into GitLab once; with SSO in front, that's usually invisible. **Remove** appears only on branches they can push to. It stops the branch's GitLab environment as that person, which runs the template's stop job; the branch itself is not touched.

## Add a website

1. **Dockerfile** at the repo root, with the server listening on `$PORT` (3000). `examples/Dockerfile.bun` is a starting point.
2. In the project, go to Settings → CI/CD → General pipelines → CI/CD configuration file, and set it to `review.gitlab-ci.yml@<group>/site-hub`. Don't add a `.gitlab-ci.yml` of your own.
3. In the project, go to Settings → CI/CD → Runners, and enable the `site-hub` runner.

Then push a branch. The preview link `https://your-nas:4300/_hub/open/site-<project>-<branch>` also appears as the pipeline's environment URL.

### Secrets for a site

Add a CI/CD variable `SITE_ENV_<NAME>` in the site's project, masked and not protected. The container receives it as `<NAME>`, so `SITE_ENV_SMTP_PASS` becomes `SMTP_PASS`. It's written after `docker build`, so it never ends up in the image.

## Limits

- **One site per browser at a time.** The chosen site is kept in a cookie, so use a private window to compare two sites side by side.
- **No WebSockets** through the hub.
- **No persistent storage.** Anything a site writes to disk is gone after the next deploy, so send data elsewhere, for example by email.
- **CPU:** the Synology kernel has no hard CPU cap, so sites get a lower CPU priority instead.
- **Trust:** the CI jobs hold the Docker socket, which is root on the NAS. That's why the CI file lives in the hub project and branches only supply a Dockerfile.
  - Enable the runner only for projects set up as in "Add a website".
  - Give people the **Developer** role on site projects. A Maintainer could point the project back at its own CI file.

## The project page

`docs/` is the GitHub Pages site: an explanation (`docs/index.html`) and a demo (`docs/demo.html`) that is the real hub page with made-up sites. Rebuild the demo after changing `router.ts` with `bun scripts/demo.ts`. To publish it, go to the GitHub repo's Settings → Pages and choose the `main` branch and the `/docs` folder.

## Updating the hub

Copy the new `router.ts` (and `compose.yaml` if it changed) to the NAS, then run `sudo docker compose up -d --build router`. To run the tests locally, use `bun test`.

## Licence

MIT. Made by Raul C. Sîmpetru.
