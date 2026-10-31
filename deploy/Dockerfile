# Build from the repository root:  docker build -f deploy/Dockerfile .
FROM node:24-alpine

ENV NODE_ENV=production \
    APPS_DATA_DIR=/data \
    APPS_PORT=3000

WORKDIR /app
# No runtime dependencies: Node runs the TypeScript sources directly.
COPY server/package.json ./package.json
COPY server/src ./src

RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
