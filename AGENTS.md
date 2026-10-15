# synology-site-hub: notes for coding agents

The hub shows one live preview per git branch of every connected website, on a Synology NAS behind its login. `README.md` is the human guide; this is the short version.

## Add a version of an existing site

Push a branch. The builder deploys it in about 2 minutes, every push updates it, and deleting the branch removes it. The site lives at `<HUB_URL>/<repo>/<branch-slug>/` (`/<group>/<repo>/<branch-slug>/` if two groups share a repo name).

## Add a new website (another GitLab repo)

Put a **Dockerfile at the repo root** and push. The server listens on `$PORT` (3000) and must run with no host mounts, no Linux capabilities and 1 GB of RAM. Start from `examples/Dockerfile.bun`. Nothing else: no `.gitlab-ci.yml`, no runner, no GitLab settings (the hub gets every push through a GitLab system hook).

## Rules

- **Secrets:** the user adds a CI/CD variable `SITE_ENV_<NAME>` (masked); the container gets `<NAME>` on the next push. Never put secrets in the repo, the Dockerfile or commit messages, and don't print them.
- **No persistent storage:** what a site writes to disk is lost on the next deploy.
- **No WebSockets** through the hub.
- **Paths:** sites are served under their path, and root-relative links, `src`, forms and redirects are rewritten. URLs a site builds in JavaScript are routed by their referer, else by the `hub_site` cookie (last site opened). SPAs with their own router may need `X-Forwarded-Prefix` as their base path.
- **Remove button:** needs `GITLAB_URL`, `GITLAB_CLIENT_ID` and `GITLAB_CLIENT_SECRET`. It shows only where GitLab says the person can push to the branch.
- **Don't read the NAS's `.env` or probe its ports:** that is credential exploration.

## Check a deploy

Open `<HUB_URL>/_hub`: the branch's row shows Queued, Build or the error line, and `<HUB_URL>/_hub/build/<container>` has the build log.

## Changing the hub itself

- `router.ts` is the proxy, login and hub page; `builder.ts` takes GitLab's push hooks (through the hub's `/_hub/hook`) and builds and runs the sites. Tests: `bun test`.
- **The builder is the only service with the Docker socket.** Keep what it runs fixed: `docker build` of the repo and the one `docker run` with no mounts and no capabilities. Never let a repo's content choose docker flags, mounts or networks.
- `compose.yaml` runs the router, a read-only Docker API proxy and the builder in `/volume1/docker/site-hub` on the NAS. Settings live in `.env` there (`.env.example` lists them).
- A push to `main` runs the tests on GitHub and publishes `ghcr.io/raulsimpetru/synology-site-hub:latest`; a NAS updates with `sudo docker compose pull && sudo docker compose up -d --remove-orphans`.
