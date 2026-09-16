import { Pool, type PoolClient, type PoolConfig } from "pg";
import type { QueryResult, SqlPool, SqlTransaction } from "./contracts.js";

class NodePostgresTransaction implements SqlTransaction {
  constructor(private readonly client: PoolClient) {}

  async query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const result = await this.client.query<Row>(text, [...values]);
    return { rows: result.rows, rowCount: result.rowCount };
  }

  release(): void {
    this.client.release();
  }
}

export class NodePostgresPool implements SqlPool {
  private readonly pool: Pool;

  constructor(config: PoolConfig) {
    this.pool = new Pool(config);
  }

  async query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const result = await this.pool.query<Row>(text, [...values]);
    return { rows: result.rows, rowCount: result.rowCount };
  }

  async connect(): Promise<SqlTransaction> {
    return new NodePostgresTransaction(await this.pool.connect());
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createPostgresPoolFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  overrides: Omit<PoolConfig, "connectionString"> = {},
): NodePostgresPool {
  const connectionString = environment.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL não configurada");
  const parsed = new URL(connectionString);
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("DATABASE_URL deve usar o protocolo PostgreSQL");
  }
  return new NodePostgresPool({ ...overrides, connectionString });
}
