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
CMD ["node", "dist/index.js"]
