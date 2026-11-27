# Family Screen Warden: console server + built parent console.
# Build from the REPO ROOT so both server/ and web/ are in the build context:
#   docker build -f server/Dockerfile -t family-screen-warden .

# ---- 1. build the web app (skipped when web/ is not there) ----
FROM node:22-alpine AS web
WORKDIR /repo
# server/package.json always exists, so this COPY never fails; web* is copied only when present.
COPY server/package.json web* ./web/
RUN mkdir -p /out/dist && cd web && \
    if [ -f vite.config.ts ] || [ -f vite.config.js ]; then \
      rm -rf node_modules dist && \
      (npm ci || npm install) && npm run build && cp -r dist/. /out/dist/ ; \
    else \
      echo "No web app in the build context: the image will serve the API only." ; \
    fi

# ---- 2. build the server ----
FROM node:22-alpine AS server
WORKDIR /repo/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev

# ---- 3. the image that runs ----
FROM node:22-alpine
ENV NODE_ENV=production PORT=3000 WEB_DIST=/app/web/dist DATA_DIR=/data
# Published app versions, uploaded APKs, kids' photos and videos and photos from texts live here: mount a volume on /data to keep them.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
WORKDIR /app/server
COPY --from=server /repo/server/package.json ./
COPY --from=server /repo/server/node_modules ./node_modules
COPY --from=server /repo/server/dist ./dist
COPY --from=web /out/dist /app/web/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
