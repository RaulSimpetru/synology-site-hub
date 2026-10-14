# Published as ghcr.io/raulsimpetru/synology-site-hub by .github/workflows/ci.yml.
FROM oven/bun:1-slim
WORKDIR /app
COPY router.ts og.png review.gitlab-ci.yml ./
USER bun
CMD ["bun", "router.ts"]
