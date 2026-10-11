FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/desktop/package.json packages/desktop/
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
COPY packages ./packages
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 SFU=1 SFU_PORT=40000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/server/package.json ./packages/server/
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/client/dist ./packages/client/dist
USER node
EXPOSE 3000 40000/udp 40000/tcp
CMD ["node", "packages/server/dist/index.js"]
