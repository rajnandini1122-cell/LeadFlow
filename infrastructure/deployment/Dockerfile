# LeadFlow — one image, two processes.
#
# The API and the worker are the same build; WORKER_ENABLED decides which role a
# container plays. That is what guarantees they cannot drift: the worker uses
# the same repositories, the same Prisma tenant scoping and the same domain
# rules as an HTTP request, because it is literally the same code.

# --- build ---------------------------------------------------------------
FROM node:24-alpine AS build

WORKDIR /app

# Manifests first, so a dependency install is cached independently of source
# changes. Without this every source edit re-runs npm ci.
COPY package.json package-lock.json ./
COPY packages/api-types/package.json packages/api-types/
COPY packages/shared-config/package.json packages/shared-config/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN npm ci

COPY . .

# api-types is a workspace dependency of both the API and the web build, so it
# has to be compiled before either.
RUN npm run build -w packages/api-types \
 && npm run db:generate -w apps/api \
 && npm run build -w apps/api \
 && npm run build -w apps/web

# --- runtime -------------------------------------------------------------
FROM node:24-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Production dependencies only. The build stage's devDependencies — TypeScript,
# Jest, Vite — have no business in a running container.
COPY package.json package-lock.json ./
COPY packages/api-types/package.json packages/api-types/
COPY apps/api/package.json apps/api/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/packages/api-types/dist packages/api-types/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/src/generated apps/api/src/generated
# Migrations ship with the image so the deploy step can apply them from the
# same artefact that will run against them.
COPY --from=build /app/apps/api/prisma apps/api/prisma
COPY --from=build /app/apps/web/dist apps/web/dist

# Never root.
USER node

EXPOSE 3000

# Overridden to `node apps/api/dist/worker.js` for the worker role.
CMD ["node", "apps/api/dist/main.js"]
