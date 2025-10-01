# Match Playwright version
FROM mcr.microsoft.com/playwright:v1.55.1-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node","server.js"]
