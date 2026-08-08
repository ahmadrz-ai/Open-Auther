# node:sqlite requires Node >= 22.5; 24 is what this is developed against.
FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json* ./
# `prepare` only wires up git hooks, which do not exist in an image.
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build


FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist

# The data directory holds live OAuth tokens. Mount it as a named volume so it
# does not vanish with the container, and keep it off any shared filesystem.
ENV AI_AUTHER_HOME=/data
# Bind to all interfaces *inside the container only*. Publish the port to
# 127.0.0.1 on the host unless you have read the exposure notes in the README.
ENV AI_AUTHER_HOST=0.0.0.0
ENV AI_AUTHER_PORT=8787

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
