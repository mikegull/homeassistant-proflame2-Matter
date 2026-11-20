# Works both as a Home Assistant add-on and as a standalone container.
ARG BUILD_FROM=node:22-alpine
FROM ${BUILD_FROM}

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

ENV NODE_ENV=production
CMD ["node", "/app/src/index.js"]
