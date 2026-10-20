# Build: every dependency, so Vite can build the web client.
FROM node:24-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY sim/package.json sim/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY tsconfig.base.json ./
COPY sim sim
COPY server server
COPY web web
RUN npm run build

# Runtime: production dependencies, the server and sim sources (run by tsx, which is a server dependency), the
# migrations and the built client. No dev tools, tests or web sources.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY sim/package.json sim/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev && npm cache clean --force

COPY sim/src sim/src
COPY server/src server/src
COPY server/drizzle server/drizzle
COPY --from=build /app/web/dist web/dist

# Files stay owned by root, so the app can't change its own code.
USER node
WORKDIR /app/server
ENV PORT=3080
EXPOSE 3080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Node itself as the main process, so it gets Docker's SIGTERM and shuts down cleanly.
CMD ["node", "--import", "tsx", "src/index.ts"]
