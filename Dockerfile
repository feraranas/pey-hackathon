FROM golang:1.27.3-bookworm AS sidecar
WORKDIR /src
COPY sidecar/go.mod sidecar/go.sum ./
RUN go mod download
COPY sidecar ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/pey-sidecar .

FROM node:24.22.2-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build && npm prune --omit=dev

FROM node:24.22.2-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/data HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY --from=sidecar /out/pey-sidecar /usr/local/bin/pey-sidecar
RUN mkdir -p /data /run/pey/merchant /run/pey/product && chown -R node:node /data /run/pey
USER node
VOLUME /data
EXPOSE 3000
CMD ["node", "dist/src/app.js"]
