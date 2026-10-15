# Published as ghcr.io/raulsimpetru/synology-site-hub by .github/workflows/ci.yml.
# One image, two services: the hub (router.ts) and the builder (builder.ts, which needs the docker CLI).
FROM oven/bun:1-slim
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:27-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
WORKDIR /app
COPY router.ts builder.ts og.png ./
USER bun
CMD ["bun", "router.ts"]
