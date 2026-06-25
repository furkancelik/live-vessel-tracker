# Gemi Takip — Node WebSocket sunucusu (tek servis, veritabanı yok)
FROM node:22-alpine

WORKDIR /app

# Önce bağımlılıklar (katman önbelleği için)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Uygulama dosyaları
COPY server.js index.html app.js styles.css ./

ENV NODE_ENV=production
ENV PORT=8090
EXPOSE 8090

# Kök olmayan kullanıcı (güvenlik)
USER node

CMD ["node", "server.js"]
