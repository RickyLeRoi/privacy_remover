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

FROM node:20-alpine AS runner
WORKDIR /app
RUN apk add --no-cache openssl
COPY package*.json ./
# 20260701 RG - Il CLI prisma sta in dependencies (non devDependencies) perché
# l'entrypoint esegue `prisma db push` a ogni avvio, quindi serve anche qui.
RUN npm ci --omit=dev
COPY prisma ./prisma
RUN npx prisma generate
COPY --from=builder /app/dist ./dist
COPY public ./public
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh
RUN mkdir -p evidence data

# 20260715 RG - Senza questo il processo gira come root. Il chown copre /app perché
# l'app scrive in data/ (il DB) e evidence/: i volumi nominati ereditano il
# proprietario dalla directory dell'immagine, quindi restano scrivibili.
RUN chown -R node:node /app
USER node

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
