# ── Base ─────────────────────────────────────────────────────
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache dumb-init

# ── Dependencies ──────────────────────────────────────────────
FROM base AS deps
COPY package*.json ./
RUN npm ci --prefer-offline

# ── Development ───────────────────────────────────────────────
FROM base AS development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3001
CMD ["dumb-init", "npm", "run", "start:dev"]

# ── Builder ───────────────────────────────────────────────────
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ── Production deps ───────────────────────────────────────────
FROM base AS prod-deps
COPY package*.json ./
RUN npm ci --omit=dev --prefer-offline

# ── Production ────────────────────────────────────────────────
FROM base AS production
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/i18n ./dist/i18n

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3001
CMD ["dumb-init", "node", "dist/main"]
