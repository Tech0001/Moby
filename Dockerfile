# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source
COPY tsconfig*.json ./
COPY src ./src
COPY index.html ./
COPY vite.config.ts ./
COPY postcss.config.js ./

# Build
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 sweeper && \
    adduser -u 1001 -G sweeper -s /bin/sh -D sweeper

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built files
COPY --from=builder /app/dist ./dist

# Create data directory
RUN mkdir -p /app/data && chown -R sweeper:sweeper /app

# Switch to non-root user
USER sweeper

# Environment
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV DB_PATH=/app/data/sweeper.db

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/setup/status || exit 1

CMD ["node", "dist/server/app.js"]
