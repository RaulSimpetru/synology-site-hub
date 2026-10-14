FROM oven/bun:1-slim
WORKDIR /app
COPY router.ts .
USER bun
CMD ["bun", "router.ts"]
