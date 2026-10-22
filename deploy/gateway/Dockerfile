FROM node:24-alpine
WORKDIR /app
COPY deploy/gateway/package.json deploy/gateway/gateway.mjs deploy/gateway/master-heartbeat.mjs deploy/gateway/stats.mjs deploy/gateway/presets.mjs deploy/gateway/aas.mjs deploy/gateway/chatvote.mjs ./
RUN npm install --omit=dev --silent
EXPOSE 8080
CMD ["node", "gateway.mjs"]
