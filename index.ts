/**
 * Simple Neon HTTP/WebSocket Proxy for local development/testing
 *
 * Built with Bun for maximum performance:
 * - Native Bun.SQL PostgreSQL driver (50% faster than Node pg)
 * - Built-in WebSocket server
 * - Zero dependencies
 * - No TLS overhead
 */

export interface ProxyConfig {
  port?: number;
  connectionString?: string;
}

export interface ProxyServer {
  server: ReturnType<typeof Bun.serve>;
  db: ReturnType<typeof Bun.SQL>;
  stop: () => void;
}

// Type OIDs for proper serialization
const BOOL_OID = 16;
const JSON_OID = 114;
const JSONB_OID = 3802;
const TIMESTAMP_OID = 1114;
const TIMESTAMPTZ_OID = 1184;

// PostgreSQL array type OIDs
const ARRAY_OIDS = new Set([
  1000, // _bool
  1005, // _int2
  1007, // _int4
  1016, // _int8
  1009, // _text
  1014, // _bpchar
  1015, // _varchar
  1021, // _float4
  1022, // _float8
  1182, // _date
  1183, // _time
  1185, // _timestamptz
  1231, // _numeric
  199,  // _json
  3807, // _jsonb
  1115, // _timestamp
  1028, // _oid
  2277, // anyarray
]);

// Convert Date to PostgreSQL timestamp format
function dateToPgTimestamp(d: Date, withTz: boolean): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  const year = d.getUTCFullYear();
  const month = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const hours = pad(d.getUTCHours());
  const minutes = pad(d.getUTCMinutes());
  const seconds = pad(d.getUTCSeconds());
  const ms = pad(d.getUTCMilliseconds(), 3);
  const base = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
  return withTz ? `${base}+00` : base;
}

// Convert array to PostgreSQL literal format
function arrayToPgLiteral(arr: unknown[]): string {
  const elements = arr.map((el) => {
    if (el === null) return "NULL";
    if (typeof el === "string") {
      if (el.includes('"') || el.includes("\\") || el.includes(",") || el.includes("{") || el.includes("}") || el.includes(" ")) {
        return '"' + el.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
      }
      return el;
    }
    return String(el);
  });
  return "{" + elements.join(",") + "}";
}

// Serialize value based on PostgreSQL type OID
function serializeValue(v: unknown, dataTypeID: number): unknown {
  if (v === null || v === undefined) return null;

  // Timestamps in PostgreSQL format
  if (v instanceof Date) {
    if (dataTypeID === TIMESTAMPTZ_OID) return dateToPgTimestamp(v, true);
    if (dataTypeID === TIMESTAMP_OID) return dateToPgTimestamp(v, false);
    return v.toISOString();
  }

  // Booleans as 't'/'f'
  if (dataTypeID === BOOL_OID && typeof v === "boolean") {
    return v ? "t" : "f";
  }

  // Arrays in PostgreSQL literal format
  if (Array.isArray(v) && ARRAY_OIDS.has(dataTypeID)) {
    return arrayToPgLiteral(v);
  }

  // JSON/JSONB - serialize to string so neon driver can parse it
  if ((dataTypeID === JSON_OID || dataTypeID === JSONB_OID) && typeof v === "object") {
    return JSON.stringify(v);
  }

  return v;
}

interface NeonQueryRequest {
  query: string;
  params?: unknown[];
}

interface NeonField {
  name: string;
  dataTypeID: number;
}

interface NeonQueryResponse {
  fields: NeonField[];
  rows: unknown[][];
  rowCount: number;
  command: string;
}

// Handle SQL query
async function handleQuery(
  request: NeonQueryRequest,
  db: ReturnType<typeof Bun.SQL>
): Promise<NeonQueryResponse> {
  const { query, params = [] } = request;

  // Execute query using Bun.SQL
  // Bun.SQL uses tagged template literals, so we need to use unsafe for dynamic queries
  const result = await db.unsafe(query, params as any[]);

  // Get field info - Bun.SQL returns results as array of objects
  // We need to extract field metadata
  const rows = result as Record<string, unknown>[];

  if (rows.length === 0) {
    return {
      fields: [],
      rows: [],
      rowCount: 0,
      command: query.trim().split(/\s+/)[0].toUpperCase(),
    };
  }

  // Extract field names from first row
  const fieldNames = Object.keys(rows[0]);

  // For Bun.SQL, we need to infer types from values since it doesn't expose OIDs directly
  // This is a limitation - we'll use heuristics
  const fields: NeonField[] = fieldNames.map((name) => {
    const sampleValue = rows[0][name];
    let dataTypeID = 25; // default to text

    if (typeof sampleValue === "boolean") dataTypeID = BOOL_OID;
    else if (typeof sampleValue === "number") dataTypeID = Number.isInteger(sampleValue) ? 23 : 701; // int4 or float8
    else if (sampleValue instanceof Date) dataTypeID = TIMESTAMPTZ_OID;
    else if (Array.isArray(sampleValue)) {
      // Detect array element type
      const firstEl = sampleValue.find((el) => el !== null);
      if (typeof firstEl === "boolean") dataTypeID = 1000; // _bool
      else if (typeof firstEl === "number") dataTypeID = Number.isInteger(firstEl) ? 1007 : 1022; // _int4 or _float8
      else dataTypeID = 1009; // _text
    }
    else if (typeof sampleValue === "object" && sampleValue !== null) dataTypeID = JSONB_OID;
    else if (typeof sampleValue === "string") {
      // Detect JSON strings (Bun.SQL returns JSON as strings)
      const trimmed = sampleValue.trim();
      if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
          (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        try {
          JSON.parse(sampleValue);
          dataTypeID = JSONB_OID;
        } catch {
          // Not valid JSON, keep as text
        }
      }
    }

    return { name, dataTypeID };
  });

  // Convert rows to array format with proper serialization
  const serializedRows = rows.map((row) =>
    fieldNames.map((name, i) => serializeValue(row[name], fields[i].dataTypeID))
  );

  return {
    fields,
    rows: serializedRows,
    rowCount: rows.length,
    command: query.trim().split(/\s+/)[0].toUpperCase(),
  };
}

export function startServer(config: ProxyConfig = {}): ProxyServer {
  const port = config.port ?? (Number(Bun.env.PORT) || 4444);
  const connectionString =
    config.connectionString ?? Bun.env.PG_CONNECTION_STRING ?? "postgres://postgres:postgres@localhost:5432/postgres";

  // Native Bun PostgreSQL connection
  const db = new Bun.SQL(connectionString);

  // WebSocket connections for transactions
  const wsClients = new Map<unknown, ReturnType<typeof Bun.SQL>>();

  // Start server
  const server = Bun.serve({
    port,

    async fetch(req, server) {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Neon-Connection-String, Neon-Raw-Text-Output, Neon-Array-Mode, Neon-Pool-Opt-In, Neon-Batch-Read-Only, Neon-Batch-Isolation-Level",
        },
      });
    }

    // WebSocket upgrade for /v2
    if (url.pathname === "/v2") {
      const upgraded = server.upgrade(req);
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // HTTP SQL endpoint
    if (req.method === "POST" && url.pathname === "/sql") {
      try {
        const body = await req.json() as NeonQueryRequest;
        const response = await handleQuery(body, db);

        return Response.json(response, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Connection": "keep-alive",
            "Keep-Alive": "timeout=30",
          },
        });
      } catch (error) {
        console.error("HTTP query error:", error);
        const pgError = error as {
          message?: string;
          code?: string;
          errno?: string; // Bun.SQL puts PG error code here
          severity?: string;
          detail?: string;
          hint?: string;
          position?: string;
          where?: string;
          schema?: string;
          table?: string;
          column?: string;
          dataType?: string;
          constraint?: string;
        };

        return Response.json({
          message: pgError.message || "Unknown error",
          code: pgError.errno || pgError.code || "UNKNOWN", // Prefer errno (PG code) over code (Bun error type)
          severity: pgError.severity,
          detail: pgError.detail,
          hint: pgError.hint,
          position: pgError.position,
          where: pgError.where,
          schema: pgError.schema,
          table: pgError.table,
          column: pgError.column,
          dataType: pgError.dataType,
          constraint: pgError.constraint,
        }, {
          status: 400,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    return Response.json({ error: "Not found. Use POST /sql" }, { status: 404 });
  },

  websocket: {
    async open(ws) {
      // Create dedicated connection for this WebSocket (enables transactions)
      const client = new Bun.SQL(PG_CONNECTION_STRING);
      wsClients.set(ws, client);
    },

    async message(ws, message) {
      const client = wsClients.get(ws);
      if (!client) {
        ws.send(JSON.stringify({ type: "error", message: "No database connection" }));
        return;
      }

      try {
        const msg = JSON.parse(message.toString()) as { type: string; query?: string; params?: unknown[] };

        if (msg.type === "query" && msg.query) {
          const result = await client.unsafe(msg.query, (msg.params || []) as any[]);
          const rows = result as Record<string, unknown>[];

          const fieldNames = rows.length > 0 ? Object.keys(rows[0]) : [];
          const response: NeonQueryResponse = {
            fields: fieldNames.map((name) => ({ name, dataTypeID: 25 })),
            rows: rows.map((row) => fieldNames.map((name) => row[name])),
            rowCount: rows.length,
            command: msg.query.trim().split(/\s+/)[0].toUpperCase(),
          };

          ws.send(JSON.stringify({ type: "result", data: response }));
        } else {
          ws.send(JSON.stringify({ type: "error", message: "Unknown message type" }));
        }
      } catch (error) {
        console.error("WebSocket query error:", error);
        ws.send(JSON.stringify({
          type: "error",
          message: error instanceof Error ? error.message : "Unknown error",
          code: (error as { code?: string })?.code || "UNKNOWN",
        }));
      }
    },

    close(ws) {
      const client = wsClients.get(ws);
      if (client) {
        client.close();
        wsClients.delete(ws);
      }
    },
  },
  });

  // Startup message
  const maskedUrl = connectionString.replace(/:[^:@]+@/, ":***@");
  console.log(`Simple Neon Proxy v1.1.1 (Bun ${Bun.version})`);
  console.log(`HTTP endpoint: http://0.0.0.0:${port}/sql`);
  console.log(`WebSocket endpoint: ws://0.0.0.0:${port}/v2`);
  console.log(`PostgreSQL: ${maskedUrl}`);

  return {
    server,
    db,
    stop: () => {
      console.log("Shutting down...");
      db.close();
      server.stop();
    },
  };
}

// Main entry point - only runs when executed directly
if (import.meta.main) {
  const proxy = startServer();

  // Graceful shutdown
  process.on("SIGTERM", () => proxy.stop());
  process.on("SIGINT", () => proxy.stop());
}
