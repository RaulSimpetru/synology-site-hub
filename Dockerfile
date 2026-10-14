FROM oven/bun:1-slim
WORKDIR /app
COPY router.ts og.png ./
USER bun
CMD ["bun", "router.ts"]
