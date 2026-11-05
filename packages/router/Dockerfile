# Router image (ARM64). Build from the repository root:
#   docker build -f packages/router/Dockerfile -t llmar-router .
# Runs the TypeScript sources directly with Node 24 type stripping. Workspace packages are pnpm symlinks, so
# their real paths are outside node_modules (type stripping refuses files under node_modules).
# Base image: the Docker official Node image from its Amazon ECR Public mirror, pinned by digest (multi-arch index).
# To update: docker buildx imagetools inspect public.ecr.aws/docker/library/node:24-slim
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
FROM --platform=linux/arm64 ${NODE_IMAGE} AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/pricing/package.json packages/pricing/
COPY packages/core/package.json packages/core/
COPY packages/assessor/package.json packages/assessor/
COPY packages/router/package.json packages/router/
RUN pnpm install --frozen-lockfile --prod --filter @auto-router/router...
COPY packages/pricing/src packages/pricing/src
COPY packages/core/src packages/core/src
COPY packages/assessor/src packages/assessor/src
COPY packages/router/src packages/router/src
COPY packages/router/config packages/router/config
RUN find packages -name '*.test.ts' -delete \
 && rm -rf packages/*/src/__fixtures__ packages/*/src/test-helpers.ts packages/assessor/src/eval

FROM --platform=linux/arm64 ${NODE_IMAGE}
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production \
    ROUTER_PORT=8080 \
    ROUTER_POLICY_FILE=/app/packages/router/config/policy.default.json
USER node
EXPOSE 8080
# No HEALTHCHECK: the load balancer health-checks GET /healthz.
CMD ["node", "packages/router/src/main.ts"]
