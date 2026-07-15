# syntax=docker/dockerfile:1

# --- Stage 1: compila il TypeScript ---
FROM node:20-alpine AS builder
WORKDIR /app
# 20260701 RG - Prisma su Alpine richiede openssl, altrimenti il query engine non carica.
RUN apk add --no-cache openssl
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Stage 2: node_modules di produzione, ripulito ---
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache openssl
COPY package*.json ./
# 20260701 RG - Il CLI prisma sta in dependencies (non devDependencies) perché
# l'entrypoint esegue `prisma db push` a ogni avvio, quindi serve anche qui.
RUN npm ci --omit=dev
COPY prisma ./prisma
RUN npx prisma generate
# 20260715 RG - Prisma spedisce il query engine (~18MB) in tre copie: prisma/,
# @prisma/engines/ e .prisma/client/. Al runtime ne serve una sola, quella che il
# client generato carica da .prisma/client/. Le altre due servono solo a comandi del
# CLI (studio, introspect) che qui non usiamo: `db push` gira sullo schema-engine, che
# resta. Elimino i duplicati e i wasm di postgres/mysql (l'app è solo sqlite).
RUN npm cache clean --force \
 && rm -f node_modules/prisma/libquery_engine-* \
          node_modules/@prisma/engines/libquery_engine-* \
          node_modules/@prisma/client/runtime/query_engine_bg.postgresql.wasm \
          node_modules/@prisma/client/runtime/query_engine_bg.mysql.wasm

# --- Stage 3: immagine finale ---
FROM node:20-alpine AS runner
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production
# 20260715 RG - `--chown` imposta il proprietario al momento della copia. Un `chown -R
# /app` in un RUN successivo riscriverebbe ogni file in un nuovo layer, raddoppiando
# il peso di node_modules (~145MB sprecati).
COPY --chown=node:node package*.json ./
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node public ./public
COPY --chown=node:node docker-entrypoint.sh ./

# 20260715 RG - Senza USER node il processo gira come root. data/ (il DB) ed evidence/
# devono essere scrivibili da node: i volumi nominati ereditano il proprietario dalla
# directory dell'immagine, quindi vanno chownati (solo queste due, non tutto /app).
RUN chmod +x docker-entrypoint.sh \
 && mkdir -p evidence data \
 && chown node:node evidence data
USER node

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
