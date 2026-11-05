# CelChat hub + web client in one image.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production HUB_PORT=8781 DATA_DIR=/data STATIC_DIR=/app/dist
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY shared ./shared
COPY hub ./hub
COPY keeper ./keeper
COPY client/src/core ./client/src/core
COPY tsconfig.json ./
VOLUME /data
EXPOSE 8781
CMD ["npx", "tsx", "hub/src/index.ts"]
