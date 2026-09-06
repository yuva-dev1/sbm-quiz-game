# syntax=docker/dockerfile:1
# Build context is this directory (apps/self-paced-course), e.g.
#   gcloud run deploy bhagavatham-self-paced-course --source apps/self-paced-course ...
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs selfpaced

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder --chown=selfpaced:nodejs /app/dist ./dist
COPY --chown=selfpaced:nodejs server ./server

USER selfpaced
EXPOSE 8080
ENV PORT=8080

CMD ["node", "server/index.js"]
