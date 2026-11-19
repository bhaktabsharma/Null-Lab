# NULLLAB control plane — builds the shared packages, the API, and the
# frontend, then runs everything from one small image. By default
# (RUNTIME_MODE=process, the recommended default — see .env.example) lab
# target instances run as isolated child processes *inside* this same
# container, each on its own port with its own SQLite file — this is the
# same orchestration code exercised by the automated test suite, just
# packaged for easy distribution. No Docker socket is needed for this mode.
#
# RUNTIME_MODE=docker (stronger, container-per-lab isolation) is an
# EXPERIMENTAL advanced option — see docs/docker-mode.md — and requires
# mounting the host's Docker socket into this container so the orchestrator
# can manage sibling lab containers.

# The Docker CLI binary only (no daemon). It is inert unless the experimental
# docker runtime is enabled AND the host socket is mounted — see
# docker-compose.docker-mode.yml and docs/docker-mode.md.
FROM docker:27-cli AS dockercli

FROM node:22.22.2-bookworm-slim AS build
WORKDIR /repo

COPY .npmrc package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/lab-sdk/package.json packages/lab-sdk/package.json
COPY runtime/orchestrator/package.json runtime/orchestrator/package.json
RUN npm ci

COPY tsconfig.base.json ./
COPY packages packages
COPY runtime runtime
COPY apps apps
COPY labs labs

RUN npm run build -w packages/shared -w packages/lab-sdk -w @nulllab/orchestrator -w @nulllab/api -w @nulllab/web

# ---------------------------------------------------------------------------
FROM node:22.22.2-bookworm-slim AS runtime
WORKDIR /repo

# Chromium's runtime libraries, for the XSS labs' headless-browser verifier.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libasound2 libpango-1.0-0 libcairo2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY .npmrc package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/lab-sdk/package.json packages/lab-sdk/package.json
COPY runtime/orchestrator/package.json runtime/orchestrator/package.json
# The browser must be installed to the SAME path the runtime user will look
# in, so set PLAYWRIGHT_BROWSERS_PATH *before* installing it. (Earlier
# revisions set it afterwards, so Chromium landed in root's cache and the
# runtime user's path was an empty directory.) tsx is a regular dependency
# of the API — process mode spawns it for every lab — so `--omit=dev` keeps it.
ENV PLAYWRIGHT_BROWSERS_PATH=/repo/.playwright-browsers
RUN npm ci --omit=dev \
    && node_modules/.bin/playwright-core install chromium \
    && test -x node_modules/.bin/tsx

COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY tsconfig.base.json ./
COPY labs labs
COPY runtime/compose runtime/compose
COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/packages/lab-sdk/dist packages/lab-sdk/dist
COPY --from=build /repo/runtime/orchestrator/dist runtime/orchestrator/dist
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/web/dist apps/web/dist

RUN addgroup --system nulllab && adduser --system --ingroup nulllab nulllab \
    && mkdir -p data/instances && chown -R nulllab:nulllab /repo

RUN chown -R nulllab:nulllab /repo/.playwright-browsers

USER nulllab
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/server.js"]
