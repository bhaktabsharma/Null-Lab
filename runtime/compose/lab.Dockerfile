# Shared image for ALL lab targets in the EXPERIMENTAL docker runtime.
# ONE image holds every lab; the orchestrator selects which lab to run per
# container via the NULLLAB_LAB_ENTRY environment variable at `docker run`
# time, so launching a lab never needs a `docker build`.
#
# Build it once:   docker compose --profile docker-mode build lab-image
# Layout mirrors the main Dockerfile's runtime stage so the same
# workspace/lockfile resolution applies (npm ci, reproducible, no fallback).

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
RUN npm run build -w packages/shared -w packages/lab-sdk

# ---------------------------------------------------------------------------
FROM node:22.22.2-bookworm-slim AS runtime
WORKDIR /repo
COPY .npmrc package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/lab-sdk/package.json packages/lab-sdk/package.json
COPY runtime/orchestrator/package.json runtime/orchestrator/package.json
RUN npm ci --omit=dev && test -x node_modules/.bin/tsx

COPY tsconfig.base.json ./
COPY labs labs
COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/packages/lab-sdk/dist packages/lab-sdk/dist

# Least privilege: a non-root, no-login user. The orchestrator additionally
# runs the container read-only with all capabilities dropped.
RUN addgroup --system nulllab && adduser --system --ingroup nulllab nulllab
USER nulllab

# The orchestrator injects NULLLAB_LAB_ENTRY (path of the lab's server.ts
# relative to /repo), NULLLAB_LAB_PORT, NULLLAB_BIND_HOST=0.0.0.0, etc.
CMD ["sh", "-c", "exec node_modules/.bin/tsx \"$NULLLAB_LAB_ENTRY\""]
