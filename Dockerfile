# OpenWA - Dockerfile
# Multi-stage build for production-ready image

# ===== Stage 1: Builder =====
FROM public.ecr.aws/docker/library/node:22-slim AS builder

WORKDIR /app

# Puppeteer is brought by whatsapp-web.js. The production image provides
# system Chromium, so do not download an extra browser during npm install.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# ===== Stage 2: Production =====
FROM public.ecr.aws/docker/library/node:22-slim AS production

# Puppeteer must use the system Chromium installed below.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Install Chromium without Debian "recommended" packages. The recommended
# tree pulls many unrelated packages and makes Dokploy builds slow/fragile.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    dumb-init \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Create app user for security
RUN groupadd -r openwa && useradd -r -g openwa openwa

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Create data directories with proper permissions
RUN mkdir -p ./data/sessions ./data/media && \
    chown -R openwa:openwa ./data

# Note: Running as root to allow Docker socket access for orchestration
# For production with stricter security, consider using a Docker socket proxy
# USER openwa

# Expose port
EXPOSE 2785

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD node -e "require('http').get('http://localhost:2785/api/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Start with dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main"]
