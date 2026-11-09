# Console Lambdas (ARM64): console-api, usage-ingest and the seed-admin custom resource share this image; each
# function selects its handler with the image CMD (infra/src/console-stack.ts LAMBDA_CMD). Build context: the
# repository root, filtered by the ConsoleStack's asset excludes.
# Like the router image, the TypeScript sources run directly (Node 24 type stripping). Workspace packages are pnpm
# symlinks with real paths outside node_modules, which type stripping requires.
# Pin both images by digest before a production deploy (docker buildx imagetools inspect <image>).
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
ARG LAMBDA_IMAGE=public.ecr.aws/lambda/nodejs:24
FROM --platform=linux/arm64 ${NODE_IMAGE} AS build
WORKDIR /var/task
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/pricing/package.json packages/pricing/
COPY packages/core/package.json packages/core/
COPY packages/assessor/package.json packages/assessor/
COPY packages/router/package.json packages/router/
COPY packages/console-contract/package.json packages/console-contract/
COPY packages/console-api/package.json packages/console-api/
COPY packages/usage-ingest/package.json packages/usage-ingest/
RUN pnpm install --frozen-lockfile --prod --filter @auto-router/console-api... --filter @auto-router/usage-ingest...
COPY packages/pricing/src packages/pricing/src
COPY packages/core/src packages/core/src
COPY packages/assessor/src packages/assessor/src
COPY packages/assessor/prompts packages/assessor/prompts
COPY packages/router/src packages/router/src
COPY packages/console-contract/src packages/console-contract/src
COPY packages/console-api/src packages/console-api/src
COPY packages/usage-ingest/src packages/usage-ingest/src
COPY infra/lambda/handlers handlers
RUN find packages -name '*.test.ts' -delete \
 && rm -rf packages/*/src/__fixtures__ packages/*/src/test-helpers.ts packages/*/src/test-fixtures.ts packages/assessor/src/eval

FROM --platform=linux/arm64 ${LAMBDA_IMAGE}
COPY --from=build /var/task ${LAMBDA_TASK_ROOT}
ENV NODE_ENV=production
# The function's ImageConfig.Command overrides this (one of handlers/*.handler).
CMD ["handlers/console-api.handler"]
