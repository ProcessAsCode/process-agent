FROM node:20-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY config/agent.example.yaml ./config/agent.example.yaml

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 4100
VOLUME ["/app/data"]
CMD ["node", "src/server.js"]
