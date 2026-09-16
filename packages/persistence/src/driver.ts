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

  constructor(config: PoolConfig, onError?: (error: Error) => void) {
    this.pool = new Pool(config);
    // Um cliente idle que perde a conexão (restart do PostgreSQL, queda de
    // rede) emite 'error' num EventEmitter sem listener e encerra o processo
    // Node. Registramos o listener imediatamente após criar o Pool.
    // IMPORTANTE: `error` NÃO contém a connection string nem credenciais —
    // apenas código/mensagem do driver — portanto é seguro logar. Nunca
    // logar `config` nem `connectionString`.
    this.pool.on("error", (error: Error) => {
      if (onError) {
        onError(error);
        return;
      }
      console.error("[postgres] erro assíncrono no pool (cliente idle):", error.message);
    });
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
  overrides: Omit<PoolConfig, "connectionString"> & {
    onError?: (error: Error) => void;
  } = {},
): NodePostgresPool {
  const connectionString = environment.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL não configurada");
  const parsed = new URL(connectionString);
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("DATABASE_URL deve usar o protocolo PostgreSQL");
  }
  const { onError, ...config } = overrides;
  return new NodePostgresPool({ ...config, connectionString }, onError);
}
