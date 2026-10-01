# Built from the workspace root, which holds the lockfile and the one
# workspace library the mediator imports:
#   docker build -f mediator/Dockerfile .
FROM node:26-slim AS build
RUN npm install --global pnpm@9.15.9
WORKDIR /repo
COPY . .
# better-sqlite3 ships its prebuilt binaries; its install script would only
# reach for node-gyp, which the slim image cannot run.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@estoc/mediator..."
RUN pnpm --filter @estoc/did-peer run build \
 && pnpm --filter @estoc/mediator exec tsc \
 && pnpm --filter @estoc/mediator deploy --prod --ignore-scripts /app

FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production \
    MEDIATOR_DATA_DIR=/data \
    MEDIATOR_PORT=8080
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
# The whole mediator state — keys and messages in one SQLite db — lives here;
# lose the volume, lose the DID.
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/index.js"]
