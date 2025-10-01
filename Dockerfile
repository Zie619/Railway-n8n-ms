FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
# Browsers already included in this base image; no need to install again.

COPY server.js ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node","server.js"]
