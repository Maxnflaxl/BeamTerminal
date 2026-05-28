# syntax=docker/dockerfile:1.7

# Yarn version is pinned via "packageManager" in package.json; corepack
# downloads it on first invocation.

FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN yarn tsc -p tsconfig.json

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./dist/migrations
# Vendored read-only shader binaries (e.g. dapps_store_app.wasm). See
# backend/resources/README.md for provenance + SHA-256 pinning.
COPY resources ./resources
USER node
CMD ["node", "dist/src/indexer.js"]
