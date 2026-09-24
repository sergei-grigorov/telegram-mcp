# Коннектор на сервере (server/serve.js): MCP по HTTP за шлюзом.
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY manifest.json ./
COPY server ./server
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/data FILES_DIR=/files
USER node
EXPOSE 8080
CMD ["node", "server/serve.js"]
