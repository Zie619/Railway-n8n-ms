# Match Playwright version with the npm package (1.55.1)
FROM mcr.microsoft.com/playwright:v1.55.1-jammy

WORKDIR /app

# Install deps first for better caching
COPY package.json package-lock.json* ./
# If you don't have a lockfile, this still works:
RUN npm install --omit=dev

# Then copy code
COPY server.js ./

ENV NODE_ENV=production
EXPOSE 8080

# Railway sets PORT (often 8080). server.js reads it.
CMD ["node", "server.js"]
