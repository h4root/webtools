# syntax=docker/dockerfile:1

# Контекст сборки — корень репозитория, а не ws-chat: чат подключает lan-drop
# как file:-зависимость и грузит его TypeScript напрямую, поэтому в образе
# должен лежать и он, и tsx.
#   docker build -f ws-chat/Dockerfile -t ws-chat .

FROM node:22-alpine AS deps
WORKDIR /app

COPY lan-drop/package.json lan-drop/package-lock.json ./lan-drop/
COPY ws-chat/package.json ws-chat/package-lock.json ./ws-chat/

# Зависимости нужны обоим по отдельности: ссылка на lan-drop разрешается в его
# собственный каталог, и «ws» ищется уже оттуда, а не из дерева чата.
RUN npm ci --omit=dev --no-audit --no-fund --prefix lan-drop \
 && npm ci --omit=dev --no-audit --no-fund --prefix ws-chat

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app

COPY --from=deps /app/lan-drop/node_modules ./lan-drop/node_modules
COPY --from=deps /app/ws-chat/node_modules ./ws-chat/node_modules
COPY lan-drop/package.json ./lan-drop/
COPY lan-drop/src ./lan-drop/src
COPY lan-drop/public ./lan-drop/public
COPY ws-chat/package.json ./ws-chat/
COPY ws-chat/src ./ws-chat/src
COPY ws-chat/public ./ws-chat/public

RUN mkdir -p /data && chown -R node:node /data

USER node
WORKDIR /app/ws-chat
EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -q -O- http://127.0.0.1:3000/health >/dev/null || exit 1

# Напрямую, без npm: сервер по SIGTERM дописывает историю на диск, а npm
# сигнал до дочернего процесса не доносит.
CMD ["node_modules/.bin/tsx", "src/server.ts"]
