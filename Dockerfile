# Simple Neon Proxy - Blazing fast, zero dependencies
FROM oven/bun:1-alpine

WORKDIR /app

# Copy source file only - no dependencies needed!
COPY index.ts ./

ENV PORT=4444
EXPOSE 4444

CMD ["bun", "run", "index.ts"]
