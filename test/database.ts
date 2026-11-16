import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { inject } from "vitest";
import { logins, password } from "./postgres.ts";

export { logins };

/** A database of its own for one test file. */
export class Database {
  readonly name = `t_${randomBytes(6).toString("hex")}`;
  private readonly clients: pg.Client[] = [];

  /** A database with Keyturn installed by the owner, and the tables in `schema`. */
  static async create(schema: string): Promise<Database> {
    const database = await Database.bare();
    const installer = await database.as(logins.owner);
    for (const file of (await readdir(new URL("../sql/", import.meta.url)))
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      await installer.query(await readFile(new URL(`../sql/${file}`, import.meta.url), "utf8"));
    }
    await installer.query(schema);
    return database;
  }

  /** A database with nothing in it, owned by the owner. */
  static async bare(): Promise<Database> {
    const database = new Database();
    const server = inject("postgres");
    const owner = new pg.Client({
      host: server.host,
      port: server.port,
      user: logins.owner,
      password,
      database: "postgres",
    });
    await owner.connect();
    await owner.query(`create database ${database.name}`);
    await owner.end();
    return database;
  }

  /** Where one login connects. */
  url(login: string): string {
    const server = inject("postgres");
    return `postgres://${login}:${password}@${server.host}:${server.port}/${this.name}`;
  }

  /** A connection as one login. Closed with the database. */
  async as(login: string): Promise<pg.Client> {
    const server = inject("postgres");
    const client = new pg.Client({
      host: server.host,
      port: server.port,
      user: login,
      password,
      database: this.name,
    });
    await client.connect();
    this.clients.push(client);
    return client;
  }

  adopt(client: pg.Client): void {
    this.clients.push(client);
  }

  async close(): Promise<void> {
    // A connection a test cut off on purpose is already closed.
    await Promise.allSettled(this.clients.map((client) => client.end()));
  }
}

/** The error a statement ends in, or null when it does not. */
export async function refusal(
  work: Promise<unknown>,
): Promise<{ code: string; message: string } | null> {
  try {
    await work;
    return null;
  } catch (error) {
    const failure = error as { code?: string; message: string };
    return { code: failure.code ?? "", message: failure.message };
  }
}

export type Proposed = { proposal_id: string; content_hash: string };

export async function propose(agent: pg.Client, changes: unknown[], note = ""): Promise<Proposed> {
  const result = await agent.query<Proposed>("select * from keyturn.propose($1::jsonb, $2)", [
    JSON.stringify(changes),
    note,
  ]);
  return result.rows[0] as Proposed;
}

export async function apply(
  client: pg.Client,
  proposal: string,
): Promise<{ status: string; reason?: string; changes?: number }> {
  const result = await client.query("select keyturn.apply($1) as outcome", [proposal]);
  return result.rows[0].outcome;
}

/** A connection as the server's superuser, for what only an administrator does: making logins and wrong grants. */
export async function administrator(database: Database): Promise<pg.Client> {
  const server = inject("postgres");
  const client = new pg.Client({
    host: server.host,
    port: server.port,
    user: server.superuser,
    password: server.password,
    database: database.name,
  });
  await client.connect();
  database.adopt(client);
  return client;
}
