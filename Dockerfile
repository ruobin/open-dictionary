# Container image for the open-dictionary API server. The Vite SPA is built and
# deployed separately (any static host: Vercel, Netlify, Cloudflare Pages,
# S3+CloudFront, nginx, etc.) and proxies /api/* to this service.

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && adduser -S app -u 1001 -G nodejs
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=app:nodejs package.json ./
COPY --chown=app:nodejs tsconfig.json ./
COPY --chown=app:nodejs server ./server
USER app
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --spider -q http://localhost:3001/health || exit 1
# tsx is a production dependency; `node --import tsx` runs TypeScript directly
# with node as PID 1 so SIGTERM/SIGINT reach the app's graceful-shutdown handler.
CMD ["node", "--import", "tsx", "server/index.ts"]
