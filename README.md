# Simple Neon Proxy

A blazing fast, zero-dependency HTTP/WebSocket proxy that allows the [@neondatabase/serverless](https://github.com/neondatabase/serverless) driver to work with local PostgreSQL.

**Powered by [Bun](https://bun.sh)** for maximum performance.

## Motivation

**Built for fast integration tests.** We needed to run 200+ integration tests against a PostgreSQL database using the Neon serverless driver. Hitting the real Neon service took ~3 minutes. With this proxy and a local PostgreSQL, tests complete in ~4 seconds (45x faster).

### Why Not Use...

**[timowilhelm/local-neon-http-proxy](https://github.com/timowilhelm/local-neon-http-proxy)?** It's great but uses Neon's full Rust `pg-gateway` with Caddy, designed for production routing and TLS. For local testing, it's overkill and slower.

**[Neon's official proxy](https://github.com/neondatabase/neon)?** That's for Neon's infrastructure - it routes to their cloud databases, not local PostgreSQL. It doesn't help with local development.

### Performance

This proxy is extremely fast because:
- **Zero dependencies** - Just Bun's built-in APIs
- **Native Bun.SQL** - Up to 50% faster than Node.js PostgreSQL drivers
- **Built-in WebSocket server** - No external libraries needed
- **No TLS overhead** - Plain HTTP for localhost
- **Connection pooling** - Automatic with Bun.SQL

## Limitations

This is a **development/testing tool**, not a production proxy:

- **Single database only** - No SNI-based routing, all queries go to one PostgreSQL instance
- **No TLS** - Plain HTTP/WebSocket only (fine for localhost)
- **Simplified protocol** - Only implements SQL-over-HTTP and basic WebSocket, not full PostgreSQL wire protocol
- **No Neon-specific features** - Branching, snapshots, and read replicas aren't supported
- **No authentication passthrough** - Ignores credentials in the connection string, connects directly to PostgreSQL

## Quick Start

### Docker Compose (Recommended)

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: mydb
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

  neon-proxy:
    image: jtwebman/simple-neon-proxy:latest
    environment:
      PG_CONNECTION_STRING: postgres://postgres:postgres@postgres:5432/mydb
      PORT: 4444
    ports:
      - "4444:4444"
    depends_on:
      postgres:
        condition: service_healthy
```

### Docker Run

```bash
docker run -p 4444:4444 \
  -e PG_CONNECTION_STRING="postgres://postgres:postgres@host.docker.internal:5432/mydb" \
  jtwebman/simple-neon-proxy:latest
```

### Bun (Development)

```bash
# Install Bun if you haven't: curl -fsSL https://bun.sh/install | bash
PG_CONNECTION_STRING="postgres://postgres:postgres@localhost:5432/mydb" bun run index.ts
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PG_CONNECTION_STRING` | `postgres://postgres:postgres@localhost:5432/linksonce_test` | PostgreSQL connection string |
| `PORT` | `4444` | Port to listen on |

## Using with @neondatabase/serverless

Configure the neon driver to use this proxy:

```typescript
import { neon, neonConfig } from "@neondatabase/serverless";

// Configure for local proxy
neonConfig.fetchEndpoint = (host) => {
  const [protocol, port] = host === "db.localtest.me" ? ["http", 4444] : ["https", 443];
  return `${protocol}://${host}:${port}/sql`;
};
neonConfig.useSecureWebSocket = false;
neonConfig.wsProxy = (host) => `${host}:4444/v2`;
neonConfig.pipelineTLS = false;
neonConfig.pipelineConnect = false;

// Connect using db.localtest.me (resolves to 127.0.0.1)
const sql = neon("postgres://postgres:postgres@db.localtest.me:4444/mydb");

// Now use it like normal
const result = await sql`SELECT * FROM users`;
```

> **Note:** `localtest.me` is a public DNS that resolves to 127.0.0.1. This works everywhere including in CI environments.

## Endpoints

- `POST /sql` - HTTP SQL endpoint (for `neon()` driver)
- `WS /v2` - WebSocket endpoint (for `Pool` with transactions)

## Features

- **HTTP Keep-Alive**: Connections are reused for multiple requests
- **Connection Pool**: Up to 100 concurrent connections to PostgreSQL
- **WebSocket Support**: Full WebSocket support for the Neon Pool class (enables transactions)
- **Type Handling**: Correctly handles JSON/JSONB, arrays, dates, and other PostgreSQL types

## License

MIT
