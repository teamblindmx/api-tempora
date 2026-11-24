# syntax=docker/dockerfile:1
# Imagen de producción de la API (ADR 0016). Se construye con: docker build -t tempora-api .
# Arranca la API; las migraciones se corren aparte con el mismo contenedor:
#   docker run --rm --env-file .env.production tempora-api npm run db:migrate:prod

FROM node:22.22-bookworm-slim AS base
# Prisma Migrate necesita OpenSSL; ca-certificates para Postgres con TLS y para Twilio.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json .npmrc prisma.config.ts ./
COPY prisma ./prisma
# npm ci corre prisma generate (postinstall) y baja el motor de migraciones.
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM base AS runtime
ENV NODE_ENV=production \
  PORT=3000 \
  NPM_CONFIG_UPDATE_NOTIFIER=false
COPY --from=build /app/package.json /app/prisma.config.ts ./
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Sin permisos de root, y sin poder escribir en el código.
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/src/main.js"]
