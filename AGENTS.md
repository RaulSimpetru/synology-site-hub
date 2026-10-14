# synology-site-hub: notes for coding agents

The hub shows one live preview per git branch of every connected website, on a Synology NAS behind its login. `README.md` is the human guide; this is the short version.

## Add a version of an existing site

Push a branch. CI deploys it in about 2 minutes, every push updates it, and deleting the branch removes it. The preview link is `<HUB_URL>/_hub/open/site-<project-path-slug>-<branch-slug>`, also the pipeline's GitLab environment URL.

## Add a new website (another GitLab repo)

1. **Dockerfile at the repo root.** The server listens on `$PORT` (3000) and must run with no host mounts, no Linux capabilities and 1 GB of RAM. Start from `examples/Dockerfile.bun`.
2. **No `.gitlab-ci.yml`.** A Maintainer sets Settings → CI/CD → General pipelines → CI/CD configuration file to `review.gitlab-ci.yml@<group>/site-hub`.
3. **Runner.** A human enables the existing `site-hub` project runner for the project. Never register a new runner.

Steps 2 and 3 are GitLab settings: ask the user, or use `glab api` if you have permission.

## Rules

- **Never edit `review.gitlab-ci.yml` for one site's needs.** Its jobs hold the NAS Docker socket, which is root on the NAS. A site only changes its own Dockerfile.
- **Secrets:** the user adds a CI/CD variable `SITE_ENV_<NAME>` (masked, not protected); the container gets `<NAME>`. Never put secrets in the repo, the Dockerfile or commit messages, and don't print them.
- **No persistent storage:** what a site writes to disk is lost on the next deploy.
- **No WebSockets** through the hub.
- **Hub root:** typing or bookmarking it shows the site list; after `/_hub/open/<site>`, the `hub_site` cookie routes every path to that site. Share `/_hub/open/<site>` links.
- **Remove button:** needs `GITLAB_URL`, `GITLAB_CLIENT_ID` and `GITLAB_CLIENT_SECRET`. It shows only where GitLab says the person can push to the branch, and stops the `review/<slug>` environment as them.
- **Don't read the runner's config or probe the NAS's ports:** that is credential exploration.

## Check a deploy

```sh
glab api "projects/<group>%2F<project>/pipelines?ref=<branch>&per_page=1"
```

Wait for `"status":"success"`, then open the preview link.

## Changing the hub itself

- `router.ts` is the proxy, login and hub page; `router.test.ts` has its tests (`bun test`).
- `compose.yaml` runs the router, a read-only Docker API proxy and the runner in `/volume1/docker/site-hub` on the NAS. Settings live in `.env` there (`.env.example` lists them).
- DSM has no git: copy `router.ts` (and `compose.yaml` if changed) with `scp -O`, then run `sudo docker compose up -d --build router` in that folder. Changes to `review.gitlab-ci.yml` apply on each site's next pipeline.
