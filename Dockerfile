# Use the official Playwright image (Chromium already installed)
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app

# Install deps first for better caching
COPY package.json ./
RUN npm install --omit=dev

# Then copy the app code
COPY server.js ./

ENV NODE_ENV=production
EXPOSE 3000

# Railway injects PORT; server.js reads it
CMD ["node", "server.js"]
