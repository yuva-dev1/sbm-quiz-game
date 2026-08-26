# syntax=docker/dockerfile:1
# Build context is this directory (apps/self-study), e.g.
#   gcloud run deploy bhagavatham-self-study --source apps/self-study ...
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
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs selfstudy

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder --chown=selfstudy:nodejs /app/dist ./dist
COPY --chown=selfstudy:nodejs server ./server

USER selfstudy
EXPOSE 8080
ENV PORT=8080

CMD ["node", "server/index.js"]
