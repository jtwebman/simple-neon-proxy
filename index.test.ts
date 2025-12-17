/**
 * Comprehensive tests for Simple Neon Proxy
 *
 * Tests all PostgreSQL types and ensures compatibility with @neondatabase/serverless driver.
 *
 * Prerequisites:
 * - PostgreSQL running on localhost:5432
 * - Test database "simple_neon_proxy_test" created
 *
 * Run with: bun test
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { neon, neonConfig } from "@neondatabase/serverless";
import { startServer, type ProxyServer } from "./index";

const TEST_PORT = 4445;

// Configure neon driver for local proxy
neonConfig.fetchEndpoint = (host) => {
  const [protocol, port] = host === "db.localtest.me" ? ["http", TEST_PORT] : ["https", 443];
  return `${protocol}://${host}:${port}/sql`;
};
neonConfig.useSecureWebSocket = false;
neonConfig.wsProxy = (host) => `${host}:${TEST_PORT}/v2`;
neonConfig.pipelineTLS = false;
neonConfig.pipelineConnect = false;

const DATABASE_URL = process.env.DATABASE_URL || `postgres://postgres:postgres@db.localtest.me:${TEST_PORT}/simple_neon_proxy_test`;
const sql = neon(DATABASE_URL);

let proxy: ProxyServer | null = null;

describe("Simple Neon Proxy", () => {
  beforeAll(async () => {
    // Start the proxy directly
    proxy = startServer({
      port: TEST_PORT,
      connectionString: "postgres://postgres:postgres@localhost:5432/simple_neon_proxy_test",
    });

    // Drop and create test table with all types (drop first for clean state)
    await sql`DROP TABLE IF EXISTS type_tests`;
    await sql`DROP TABLE IF EXISTS error_test`;
    await sql`DROP TABLE IF EXISTS join_test_a`;
    await sql`DROP TABLE IF EXISTS join_test_b`;

    await sql`
      CREATE TABLE type_tests (
        id SERIAL PRIMARY KEY,
        -- Boolean
        bool_col BOOLEAN,
        -- Numbers
        int2_col SMALLINT,
        int4_col INTEGER,
        int8_col BIGINT,
        float4_col REAL,
        float8_col DOUBLE PRECISION,
        numeric_col NUMERIC(10, 2),
        -- Text
        text_col TEXT,
        varchar_col VARCHAR(255),
        char_col CHAR(10),
        -- JSON
        json_col JSON,
        jsonb_col JSONB,
        -- Timestamps
        timestamp_col TIMESTAMP,
        timestamptz_col TIMESTAMPTZ,
        date_col DATE,
        time_col TIME,
        -- Arrays
        text_array TEXT[],
        int_array INTEGER[],
        bool_array BOOLEAN[],
        -- UUID
        uuid_col UUID
      )
    `;
  });

  afterAll(async () => {
    // Stop the proxy (tables left intact for debugging)
    if (proxy) {
      proxy.stop();
    }
  });

  describe("Boolean types", () => {
    it("should handle true boolean", async () => {
      const result = await sql`SELECT true AS val`;
      expect(result[0].val).toBe(true);
      expect(typeof result[0].val).toBe("boolean");
    });

    it("should handle false boolean", async () => {
      const result = await sql`SELECT false AS val`;
      expect(result[0].val).toBe(false);
      expect(typeof result[0].val).toBe("boolean");
    });

    it("should insert and retrieve booleans", async () => {
      await sql`INSERT INTO type_tests (bool_col) VALUES (true), (false)`;
      const result = await sql`SELECT bool_col FROM type_tests WHERE bool_col IS NOT NULL ORDER BY id`;
      expect(result[0].bool_col).toBe(true);
      expect(result[1].bool_col).toBe(false);
    });
  });

  describe("Number types", () => {
    it("should handle integers", async () => {
      const result = await sql`SELECT
        1::smallint AS int2,
        42::integer AS int4,
        9223372036854775807::bigint AS int8
      `;
      expect(result[0].int2).toBe(1);
      expect(result[0].int4).toBe(42);
      // BigInt is returned as string to avoid precision loss
      expect(typeof result[0].int8 === "string" || typeof result[0].int8 === "number").toBe(true);
    });

    it("should handle floats", async () => {
      const result = await sql`SELECT
        3.14::real AS float4,
        3.141592653589793::double precision AS float8
      `;
      expect(result[0].float4).toBeCloseTo(3.14, 2);
      expect(result[0].float8).toBeCloseTo(3.141592653589793, 10);
    });

    it("should handle numeric/decimal", async () => {
      const result = await sql`SELECT 123.45::numeric(10,2) AS num`;
      expect(parseFloat(result[0].num)).toBeCloseTo(123.45, 2);
    });
  });

  describe("Text types", () => {
    it("should handle text", async () => {
      const result = await sql`SELECT 'hello world'::text AS val`;
      expect(result[0].val).toBe("hello world");
    });

    it("should handle varchar", async () => {
      const result = await sql`SELECT 'test'::varchar(255) AS val`;
      expect(result[0].val).toBe("test");
    });

    it("should handle char with padding", async () => {
      const result = await sql`SELECT 'test'::char(10) AS val`;
      expect(result[0].val).toBe("test      "); // char pads with spaces
    });

    it("should handle special characters", async () => {
      const result = await sql`SELECT ${"Hello 'world' \"test\" \\ backslash"} AS val`;
      expect(result[0].val).toBe("Hello 'world' \"test\" \\ backslash");
    });

    it("should handle unicode", async () => {
      const result = await sql`SELECT ${"日本語 中文 한국어 🎉"} AS val`;
      expect(result[0].val).toBe("日本語 中文 한국어 🎉");
    });
  });

  describe("JSON types", () => {
    it("should handle JSON objects", async () => {
      const obj = { name: "test", count: 42, active: true };
      const result = await sql`SELECT ${JSON.stringify(obj)}::json AS val`;
      expect(result[0].val).toEqual(obj);
    });

    it("should handle JSONB objects", async () => {
      const obj = { name: "test", nested: { key: "value" } };
      const result = await sql`SELECT ${JSON.stringify(obj)}::jsonb AS val`;
      expect(result[0].val).toEqual(obj);
    });

    it("should handle JSON arrays", async () => {
      const arr = [1, 2, 3, "four", { five: 5 }];
      const result = await sql`SELECT ${JSON.stringify(arr)}::json AS val`;
      expect(result[0].val).toEqual(arr);
    });

    it("should handle null in JSON", async () => {
      const result = await sql`SELECT '{"key": null}'::jsonb AS val`;
      expect(result[0].val).toEqual({ key: null });
    });
  });

  describe("Timestamp types", () => {
    it("should handle timestamptz (NOW())", async () => {
      const result = await sql`SELECT NOW() AS val`;
      expect(result[0].val instanceof Date).toBe(true);
    });

    it("should handle timestamp without timezone", async () => {
      const result = await sql`SELECT '2025-01-15 10:30:00'::timestamp AS val`;
      expect(result[0].val instanceof Date).toBe(true);
    });

    it("should handle timestamptz with timezone", async () => {
      const result = await sql`SELECT '2025-01-15 10:30:00+05:30'::timestamptz AS val`;
      expect(result[0].val instanceof Date).toBe(true);
    });

    it("should preserve timestamp values correctly", async () => {
      const future = await sql`SELECT NOW() + interval '7 days' AS val`;
      const now = new Date();
      const futureDate = future[0].val as Date;
      // Future should be ~7 days from now
      const diffDays = (futureDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeCloseTo(7, 0);
    });

    it("should handle date type", async () => {
      const result = await sql`SELECT '2025-01-15'::date AS val`;
      expect(result[0].val instanceof Date).toBe(true);
    });
  });

  describe("Array types", () => {
    it("should handle text arrays", async () => {
      const result = await sql`SELECT ARRAY['a', 'b', 'c']::text[] AS val`;
      expect(result[0].val).toEqual(["a", "b", "c"]);
      expect(Array.isArray(result[0].val)).toBe(true);
    });

    it("should handle integer arrays", async () => {
      const result = await sql`SELECT ARRAY[1, 2, 3]::integer[] AS val`;
      expect(result[0].val).toEqual([1, 2, 3]);
    });

    it("should handle boolean arrays", async () => {
      const result = await sql`SELECT ARRAY[true, false, true]::boolean[] AS val`;
      expect(result[0].val).toEqual([true, false, true]);
    });

    it("should handle empty arrays", async () => {
      const result = await sql`SELECT ARRAY[]::text[] AS val`;
      expect(result[0].val).toEqual([]);
    });

    it("should handle arrays with special characters", async () => {
      const result = await sql`SELECT ARRAY['hello, world', 'test "quotes"', 'back\\slash']::text[] AS val`;
      expect(result[0].val).toContain("hello, world");
      expect(result[0].val).toContain('test "quotes"');
    });

    it("should handle array_agg results", async () => {
      await sql`
        INSERT INTO type_tests (text_col) VALUES ('one'), ('two'), ('three')
      `;
      const result = await sql`
        SELECT array_agg(text_col) AS vals
        FROM type_tests
        WHERE text_col IS NOT NULL
      `;
      expect(Array.isArray(result[0].vals)).toBe(true);
      expect(result[0].vals).toContain("one");
      expect(result[0].vals).toContain("two");
      expect(result[0].vals).toContain("three");
    });
  });

  describe("NULL handling", () => {
    it("should handle NULL values", async () => {
      const result = await sql`SELECT NULL AS val`;
      expect(result[0].val).toBeNull();
    });

    it("should handle NULL in different types", async () => {
      await sql`INSERT INTO type_tests (text_col) VALUES (NULL)`;
      const result = await sql`SELECT text_col FROM type_tests WHERE text_col IS NULL LIMIT 1`;
      expect(result[0].text_col).toBeNull();
    });
  });

  describe("UUID type", () => {
    it("should handle UUID values", async () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      const result = await sql`SELECT ${uuid}::uuid AS val`;
      expect(result[0].val).toBe(uuid);
    });

    it("should handle gen_random_uuid()", async () => {
      const result = await sql`SELECT gen_random_uuid() AS val`;
      expect(typeof result[0].val).toBe("string");
      expect(result[0].val).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });

  describe("Error handling", () => {
    it("should return error code for constraint violations", async () => {
      // Create a table with unique constraint
      await sql`
        CREATE TABLE IF NOT EXISTS error_test (
          id SERIAL PRIMARY KEY,
          email TEXT UNIQUE
        )
      `;
      await sql`TRUNCATE error_test`;
      await sql`INSERT INTO error_test (email) VALUES ('test@example.com')`;

      try {
        await sql`INSERT INTO error_test (email) VALUES ('test@example.com')`;
        expect.fail("Should have thrown error");
      } catch (error: unknown) {
        const err = error as { code?: string };
        expect(err.code).toBe("23505"); // unique_violation
      }
    });

    it("should return error for syntax errors", async () => {
      try {
        await sql`SELEC * FROM nonexistent`;
        expect.fail("Should have thrown error");
      } catch (error: unknown) {
        const err = error as { code?: string };
        expect(err.code).toBe("42601"); // syntax_error
      }
    });

    it("should return error for missing table", async () => {
      try {
        await sql`SELECT * FROM this_table_does_not_exist_12345`;
        expect.fail("Should have thrown error");
      } catch (error: unknown) {
        const err = error as { code?: string };
        expect(err.code).toBe("42P01"); // undefined_table
      }
    });
  });

  describe("Query operations", () => {
    it("should handle INSERT RETURNING", async () => {
      const result = await sql`
        INSERT INTO type_tests (text_col) VALUES ('insert test') RETURNING id, text_col
      `;
      expect(result[0].text_col).toBe("insert test");
      expect(typeof result[0].id).toBe("number");
    });

    it("should handle UPDATE RETURNING", async () => {
      const inserted = await sql`INSERT INTO type_tests (text_col) VALUES ('before') RETURNING id`;
      const result = await sql`
        UPDATE type_tests SET text_col = 'after' WHERE id = ${inserted[0].id} RETURNING text_col
      `;
      expect(result[0].text_col).toBe("after");
    });

    it("should handle DELETE RETURNING", async () => {
      const inserted = await sql`INSERT INTO type_tests (text_col) VALUES ('to delete') RETURNING id`;
      const result = await sql`
        DELETE FROM type_tests WHERE id = ${inserted[0].id} RETURNING text_col
      `;
      expect(result[0].text_col).toBe("to delete");
    });

    it("should handle parameterized queries", async () => {
      const name = "test";
      const count = 42;
      await sql`INSERT INTO type_tests (text_col, int4_col) VALUES (${name}, ${count})`;
      const result = await sql`
        SELECT text_col, int4_col FROM type_tests
        WHERE text_col = ${name} AND int4_col = ${count}
        LIMIT 1
      `;
      expect(result[0].text_col).toBe(name);
      expect(result[0].int4_col).toBe(count);
    });

    it("should handle JOIN queries", async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS join_test_a (id INT PRIMARY KEY, name TEXT);
        CREATE TABLE IF NOT EXISTS join_test_b (id INT PRIMARY KEY, a_id INT, value TEXT);
        INSERT INTO join_test_a VALUES (1, 'first') ON CONFLICT DO NOTHING;
        INSERT INTO join_test_b VALUES (1, 1, 'related') ON CONFLICT DO NOTHING;
      `;
      const result = await sql`
        SELECT a.name, b.value
        FROM join_test_a a
        JOIN join_test_b b ON a.id = b.a_id
      `;
      expect(result[0].name).toBe("first");
      expect(result[0].value).toBe("related");
    });

    it("should handle COUNT aggregates", async () => {
      const result = await sql`SELECT COUNT(*) AS cnt FROM type_tests`;
      expect(typeof result[0].cnt === "string" || typeof result[0].cnt === "number").toBe(true);
    });
  });

  describe("Multiple rows", () => {
    it("should return multiple rows", async () => {
      await sql`TRUNCATE type_tests RESTART IDENTITY`;
      await sql`
        INSERT INTO type_tests (text_col) VALUES ('row1'), ('row2'), ('row3')
      `;
      const result = await sql`SELECT text_col FROM type_tests ORDER BY id`;
      expect(result.length).toBe(3);
      expect(result.map((r) => r.text_col)).toEqual(["row1", "row2", "row3"]);
    });

    it("should handle empty result sets", async () => {
      const result = await sql`SELECT * FROM type_tests WHERE 1 = 0`;
      expect(result.length).toBe(0);
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
