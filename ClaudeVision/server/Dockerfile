FROM node:22-alpine

# better-sqlite3 builds a native binding; alpine needs python3 + make + g++ to
# compile node-gyp targets. These are dev-only — pruned away in the final layer.
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
RUN npm prune --production
ENV NODE_ENV=production
EXPOSE 18790

# Tell docker (and `docker compose up --wait`) when this container is
# actually ready to serve. /health is unauthenticated and only does in-
# process work, so polling it cheaply is fine.
#
# start-period gives 20s for node + sqlite migrations to settle before
# unhealthy strikes count. interval=10s + retries=3 = a flapping
# container is marked unhealthy within ~30s, which is what restart
# policies key off of.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:18790/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
