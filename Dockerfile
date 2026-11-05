FROM node:22.23.4-alpine AS base

WORKDIR /app

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

FROM base AS deps

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS builder

COPY tsconfig.json tsconfig.test.json vitest.config.ts ./
COPY src ./src
RUN pnpm run build

FROM base AS prod-deps

ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:22.23.4-alpine AS runner

WORKDIR /app

RUN apk add --no-cache curl

ENV NODE_ENV=production
ENV PORT=3100
ENV TWEETAPI_API_BASE_URL="https://api.tweetapi.com"

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

EXPOSE 3100

USER node

CMD ["node", "dist/http-bin.js"]
