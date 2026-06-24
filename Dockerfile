# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run lint
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
LABEL org.opencontainers.image.title="Apex Omega" \
      org.opencontainers.image.description="Execution container: Redis is the required hot-path opportunity ledger and live execution lock layer; durable sinks such as Firestore/BigQuery must stay off the broadcast path."
ENV NODE_ENV=production \
    PORT=3000 \
    SHADOW_MODE=true \
    LIVE_EXECUTION=false \
    REDIS_ENABLED=true \
    REDIS_REQUIRED_FOR_LIVE=true \
    REDIS_ARCHITECTURE=hot_path_execution_ledger

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN printf "{}\n" > ./config.json && chown -R node:node /app

USER node
EXPOSE 3000
CMD ["npm", "run", "start"]
