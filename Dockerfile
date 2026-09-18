FROM oven/bun:alpine

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0

# Install only runtime dependencies.
# No bun.lock is committed in this repository, so Bun resolves package.json directly.
COPY package.json ./
RUN bun install --production --no-save

# Copy application source after dependency installation for better Docker layer caching.
COPY . .

# SQLite database is created automatically by the application.
RUN mkdir -p /app/data

EXPOSE 3000

# Run the server directly; do not use "bun --watch" in production.
# Koyeb injects PORT automatically and src/index.ts reads process.env.PORT.
CMD ["bun", "src/index.ts"]
