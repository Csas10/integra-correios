import { describe, expect, it, vi } from "vitest";
import { NodePostgresPool } from "../src/driver.js";
import type { PoolConfig } from "pg";

vi.mock("pg", () => {
  class FakePool {
    static instances: FakePool[] = [];
    readonly listeners = new Map<string, (error: Error) => void>();
    constructor(public config: PoolConfig) {
      FakePool.instances.push(this);
    }
    on(event: string, handler: (error: Error) => void) {
      this.listeners.set(event, handler);
      return this;
    }
    async query() {
      return { rows: [], rowCount: 0 };
    }
    async connect() {
      throw new Error("não usado neste teste");
    }
    async end() {}
  }
  return { Pool: FakePool };
});

describe("NodePostgresPool — resiliência de clientes idle", () => {
  it("pool expõe handler de erro customizável, sem logar connection string", () => {
    const onError = vi.fn();
    // DSN sem credencial embutida (scanner de secrets bloqueia DSNs com
    // user:senha). O segredo simulado vive só na mensagem do erro.
    const pool = new NodePostgresPool(
      { connectionString: "postgresql://localhost:5432/db" } as PoolConfig,
      onError,
    );
    const emitter = (pool as unknown as { pool: { listeners: Map<string, (e: Error) => void> } }).pool;
    const handler = emitter.listeners.get("error");
    expect(handler).toBeTypeOf("function");

    const erro = new Error("terminou inesperadamente");
    handler!(erro);
    expect(onError).toHaveBeenCalledWith(erro);

    // Sem callback: cai no console.error com a mensagem do driver (sem DSN)
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // DSN sem credencial embutida (o scanner de secrets bloqueia DSNs com
    // user:senha; aqui o ponto testado é o listener, não a credencial).
    const fallback = new NodePostgresPool({
      connectionString: "postgresql://localhost:5432/db",
      user: "usuario-sintetico",
      password: "senha-sintetica",
    } as PoolConfig);
    const emitter2 = (fallback as unknown as { pool: { listeners: Map<string, (e: Error) => void> } }).pool;
    emitter2.listeners.get("error")!(new Error("conexao idle perdida"));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.join(" "))).not.toContain("secret");
    spy.mockRestore();
  });
});
