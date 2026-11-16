import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    postgres: { host: string; port: number; superuser: string; password: string };
  }
}

/** The logins every test uses. They exist once for the whole server; databases come and go. */
export const logins = {
  /** Owns the application's tables and installs Keyturn. Not a superuser. */
  owner: "app_owner",
  /** The agent. */
  agent: "agent_bot",
  /** A second agent, to try one agent's proposals from another. */
  otherAgent: "agent_two",
  /** Two people who may approve. */
  alice: "alice",
  bob: "bob",
  /** A login with no part in Keyturn at all. */
  stranger: "mallory",
} as const;

export const password = "test-only";

export default async function setup(project: TestProject) {
  const image = process.env.POSTGRES_IMAGE ?? "postgres:18.3";
  const container = await new PostgreSqlContainer(image).start();
  const admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  // The two groups are made here by a superuser, as an administrator would. The install
  // script then finds them, so it can be run by an owner who may not create roles.
  await admin.query(`
    create role keyturn_agent nologin;
    create role keyturn_approver nologin;
    create role ${logins.owner} login createdb password '${password}';
    create role ${logins.agent} login password '${password}' in role keyturn_agent;
    create role ${logins.otherAgent} login password '${password}' in role keyturn_agent;
    create role ${logins.alice} login password '${password}' in role keyturn_approver;
    create role ${logins.bob} login password '${password}' in role keyturn_approver;
    create role ${logins.stranger} login password '${password}';
  `);
  await admin.end();
  project.provide("postgres", {
    host: container.getHost(),
    port: container.getPort(),
    superuser: container.getUsername(),
    password: container.getPassword(),
  });
  return async () => {
    await container.stop();
  };
}
