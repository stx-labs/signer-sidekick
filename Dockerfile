# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24.18.0

FROM node:${NODE_VERSION}-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
WORKDIR /workspace

RUN corepack enable

COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm protocol:verify \
  && pnpm check \
  && pnpm test \
  && pnpm test:regtest \
  && pnpm build \
  && pnpm --filter @stx-labs/signer-sidekick deploy --legacy --prod /opt/sidekick

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ARG VCS_REF=unknown

LABEL org.opencontainers.image.title="Signer Sidekick" \
  org.opencontainers.image.description="PoX-5 operations tooling for Stacks signer and pool operators" \
  org.opencontainers.image.licenses="GPL-3.0-only" \
  org.opencontainers.image.revision="${VCS_REF}" \
  org.opencontainers.image.source="https://github.com/stx-labs/signer-sidekick"

ENV NODE_ENV=production \
  SIDEKICK_HTTP_HOST=0.0.0.0 \
  SIDEKICK_HTTP_PORT=3998 \
  SIDEKICK_DATABASE_PATH=/data/sidekick.sqlite \
  SIDEKICK_STATIC_DIRECTORY=/app/dashboard

RUN groupadd --system --gid 10001 sidekick \
  && useradd --system --uid 10001 --gid sidekick --home-dir /app --shell /usr/sbin/nologin sidekick \
  && mkdir -p /data /app/dashboard \
  && chown -R sidekick:sidekick /data /app

COPY --from=build --chown=sidekick:sidekick /opt/sidekick /app
COPY --from=build --chown=sidekick:sidekick /workspace/apps/dashboard/dist /app/dashboard
COPY --from=build /workspace/LICENSE /workspace/NOTICE.md /usr/share/doc/signer-sidekick/
COPY --from=build /workspace/design/fonts/OFL-1.1.txt /usr/share/doc/signer-sidekick/OFL-1.1.txt

USER sidekick
WORKDIR /app
VOLUME ["/data"]
EXPOSE 3998

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3998/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["node", "/app/dist/main.js"]
CMD ["serve"]
