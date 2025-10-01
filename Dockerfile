# Simple container image for the server
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
# Default env; mount your JSON to /data/test.json or set DATA_PATH at run-time
ENV PORT=3000 DATA_PATH=/data/test.json WATCH_DATA=1
EXPOSE 3000
CMD ["node", "server.js"]
