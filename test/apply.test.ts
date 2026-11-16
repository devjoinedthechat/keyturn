import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { apply, Database, logins, propose, refusal } from "./database.ts";

const schema = `
  create table items (
    id        integer primary key,
    name      text not null,
    price     numeric(10, 2) not null check (price >= 0),
    weight    double precision,
    tags      text[] not null default '{}',
    details   jsonb not null default '{}',
    seen_at   timestamptz not null,
    day       date not null,
    duration  interval,
    picture   bytea,
    deleted   boolean not null default false,
    label     text generated always as (upper(name)) stored
  );
  insert into items (id, name, price, weight, tags, details, seen_at, day, duration, picture)
    select n, 'item ' || n, 10.50, 0.1 + 0.2, array['a', 'b'], '{"z": 1, "a": [1, 2.0, "x"]}',
           '2026-03-29 01:30:00+01', '2026-03-29', interval '1 day 02:03:04.5', '\\x00ff10'
      from generate_series(1, 30) as n;
  select keyturn.protect('items');
  grant select on items to keyturn_agent, keyturn_approver;

  -- A table whose own trigger rewrites what is written to it.
  create table stamped (id integer primary key, body text not null, version integer not null default 1);
  create function bump() returns trigger language plpgsql as $$ begin new.version := old.version + 1; return new; end $$;
  create trigger bump before update on stamped for each row execute function bump();
  insert into stamped values (1, 'first'), (2, 'second');
  select keyturn.protect('stamped');
  grant select on stamped to keyturn_agent, keyturn_approver;
`;

let database: Database;
let owner: pg.Client;
let agent: pg.Client;
let alice: pg.Client;

beforeAll(async () => {
  database = await Database.create(schema);
  [owner, agent, alice] = await Promise.all([
    database.as(logins.owner),
    database.as(logins.agent),
    database.as(logins.alice),
  ]);
});

afterAll(async () => {
  await database.close();
});

const approved = async (client: pg.Client, changes: unknown[]) => {
  const proposed = await propose(client, changes);
  await alice.query("select keyturn.approve($1, $2)", [
    proposed.proposal_id,
    proposed.content_hash,
  ]);
  return proposed;
};
const item = async (id: number) =>
  (await owner.query("select *, price::text as price_text from items where id = $1", [id])).rows[0];

describe("a row is the same row however the session is set", () => {
  test("a proposal made in one time zone and number format applies from another", async () => {
    // The agent, the approver and whoever applies each have their own session settings.
    const tokyo = await database.as(logins.agent);
    await tokyo.query(
      "set timezone = 'Asia/Tokyo'; set datestyle = 'German, DMY'; set intervalstyle = 'sql_standard'; set extra_float_digits = 0; set bytea_output = 'escape'",
    );
    const samoa = await database.as(logins.bob);
    await samoa.query(
      "set timezone = 'Pacific/Apia'; set datestyle = 'SQL, MDY'; set extra_float_digits = -5",
    );

    const proposed = await approved(tokyo, [
      { table: "items", operation: "update", key: { id: 1 }, set: { name: "renamed" } },
    ]);

    expect(await apply(samoa, proposed.proposal_id)).toEqual({ status: "applied", changes: 1 });
    const row = await item(1);
    expect(row).toMatchObject({
      name: "renamed",
      price_text: "10.50",
      label: "RENAMED",
      tags: ["a", "b"],
      details: { z: 1, a: [1, 2.0, "x"] },
    });
    expect(row.seen_at.toISOString()).toBe("2026-03-29T00:30:00.000Z");
    expect(row.picture.toString("hex")).toBe("00ff10");
  });

  test("the hash of a proposal does not depend on who works it out, or with what settings", async () => {
    const tokyo = await database.as(logins.alice);
    await tokyo.query(
      "set timezone = 'Asia/Tokyo'; set datestyle = 'German, DMY'; set extra_float_digits = 0",
    );
    const proposed = await propose(agent, [
      { table: "items", operation: "update", key: { id: 2 }, set: { price: 12 } },
    ]);

    const hashes = await Promise.all(
      [agent, alice, tokyo, owner].map(
        async (client) =>
          (await client.query("select keyturn.hash_of($1) as hash", [proposed.proposal_id])).rows[0]
            .hash,
      ),
    );

    expect(new Set(hashes)).toEqual(new Set([proposed.content_hash]));
  });

  test("values of every kind come out as they went in", async () => {
    const proposed = await approved(agent, [
      {
        table: "items",
        operation: "update",
        key: { id: 3 },
        set: {
          price: "99999999.99",
          weight: 1e-7,
          tags: ["x", 'a "quoted" one', "æøå"],
          details: { nested: { deep: [null, true, 1.5] } },
          seen_at: "2027-01-01T00:00:00+09:00",
          day: "2028-02-29",
          duration: "PT36H",
          picture: "\\xdeadbeef",
          deleted: true,
        },
      },
      {
        table: "items",
        operation: "insert",
        values: {
          id: 500,
          name: "new",
          price: 0,
          seen_at: "2026-01-01T00:00:00Z",
          day: "2026-01-01",
        },
      },
    ]);

    expect(await apply(agent, proposed.proposal_id)).toEqual({ status: "applied", changes: 2 });

    const row = await item(3);
    expect(row).toMatchObject({
      price_text: "99999999.99",
      weight: 1e-7,
      tags: ["x", 'a "quoted" one', "æøå"],
      details: { nested: { deep: [null, true, 1.5] } },
      deleted: true,
    });
    expect(row.seen_at.toISOString()).toBe("2026-12-31T15:00:00.000Z");
    expect(row.picture.toString("hex")).toBe("deadbeef");
    // The inserted row took the table's defaults for what the proposal did not set.
    expect(await item(500)).toMatchObject({
      name: "new",
      tags: [],
      details: {},
      deleted: false,
      label: "NEW",
    });
  });

  test("a value the column cannot hold, or a column that works itself out, is refused when proposed", async () => {
    const message = async (set: Record<string, unknown>) =>
      (
        await refusal(
          propose(agent, [{ table: "items", operation: "update", key: { id: 4 }, set }]),
        )
      )?.message;

    expect(await message({ price: "not a number" })).toContain("invalid input syntax");
    expect(await message({ day: "2026-02-30" })).toContain("date/time field value out of range");
    expect(await message({ label: "SET BY HAND" })).toContain('no column "label" that can be set');
  });
});

describe("all of it or none of it", () => {
  test("a change the table itself refuses undoes the changes before it", async () => {
    // The second change breaks the table's own rule that a price is not negative.
    const proposed = await approved(agent, [
      { table: "items", operation: "update", key: { id: 5 }, set: { name: "written first" } },
      { table: "items", operation: "update", key: { id: 6 }, set: { price: -1 } },
      { table: "items", operation: "delete", key: { id: 7 } },
    ]);

    const outcome = await apply(agent, proposed.proposal_id);

    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("violates check constraint");
    expect(await item(5)).toMatchObject({ name: "item 5" });
    expect(await item(6)).toMatchObject({ price_text: "10.50" });
    expect(await item(7)).toBeDefined();
    // It failed for good. Asked again, it says the same and tries nothing.
    expect(await apply(agent, proposed.proposal_id)).toEqual(outcome);
    expect(
      (
        await owner.query("select status from keyturn.proposals where id = $1", [
          proposed.proposal_id,
        ])
      ).rows[0].status,
    ).toBe("failed");
  });

  test("an insert whose key is taken by the time it is applied writes nothing else either", async () => {
    const proposed = await approved(agent, [
      {
        table: "items",
        operation: "update",
        key: { id: 8 },
        set: { name: "should not be written" },
      },
      {
        table: "items",
        operation: "insert",
        values: {
          id: 600,
          name: "late",
          price: 1,
          seen_at: "2026-01-01T00:00:00Z",
          day: "2026-01-01",
        },
      },
    ]);
    await owner.query(
      "insert into items (id, name, price, seen_at, day) values (600, 'early', 1, now(), current_date)",
    );

    expect(await apply(agent, proposed.proposal_id)).toMatchObject({ status: "stale", change: 2 });
    expect(await item(8)).toMatchObject({ name: "item 8" });
  });

  test("a change to a column the proposal did not touch still makes it stale", async () => {
    // Approved while the price was 10.50. If the price moves, the approver approved a row that no longer exists.
    const proposed = await approved(agent, [
      { table: "items", operation: "update", key: { id: 9 }, set: { name: "renamed" } },
    ]);
    await owner.query("update items set price = 0.01 where id = 9");

    expect((await apply(agent, proposed.proposal_id)).reason).toContain(
      "has changed since the proposal was made",
    );
    expect(await item(9)).toMatchObject({ name: "item 9" });
  });

  test("a row changed and changed back is the same row, and the proposal applies", async () => {
    const proposed = await approved(agent, [
      { table: "items", operation: "update", key: { id: 10 }, set: { name: "renamed" } },
    ]);
    await owner.query("update items set price = 77 where id = 10");
    await owner.query("update items set price = 10.50 where id = 10");

    expect(await apply(agent, proposed.proposal_id)).toEqual({ status: "applied", changes: 1 });
  });
});

describe("a table that changes under a proposal", () => {
  test("a table whose shape has changed refuses the proposals made before", async () => {
    const proposed = await approved(agent, [
      { table: "items", operation: "update", key: { id: 11 }, set: { name: "renamed" } },
    ]);
    await owner.query("alter table items add column added_later text");
    try {
      expect(await apply(agent, proposed.proposal_id)).toMatchObject({
        status: "stale",
        reason: "public.items has changed shape since the proposal was made",
      });
      // And no new proposal is taken until the owner has looked and protected it again.
      expect(
        (
          await refusal(
            propose(agent, [
              { table: "items", operation: "update", key: { id: 12 }, set: { name: "x" } },
            ]),
          )
        )?.message,
      ).toContain("has changed shape since it was protected");
      await owner.query("select keyturn.protect('items')");
      expect(
        (
          await propose(agent, [
            { table: "items", operation: "update", key: { id: 12 }, set: { name: "x" } },
          ])
        ).content_hash,
      ).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await owner.query(
        "select keyturn.drop_view('items'); alter table items drop column added_later; select keyturn.protect('items')",
      );
    }
  });

  test("a row the table's own trigger rewrites is not what was approved, and the apply is undone", async () => {
    const proposed = await approved(agent, [
      { table: "stamped", operation: "update", key: { id: 1 }, set: { body: "edited" } },
    ]);

    const outcome = await apply(agent, proposed.proposal_id);

    expect(outcome).toMatchObject({ status: "failed" });
    expect(outcome.reason).toContain("not what was approved after the write");
    expect((await owner.query("select body, version from stamped where id = 1")).rows[0]).toEqual({
      body: "first",
      version: 1,
    });
  });

  test("unless the table's owner has said its triggers may do that", async () => {
    await owner.query("select keyturn.protect('stamped', false)");
    const proposed = await approved(agent, [
      { table: "stamped", operation: "update", key: { id: 2 }, set: { body: "edited" } },
    ]);

    expect(await apply(agent, proposed.proposal_id)).toEqual({ status: "applied", changes: 1 });
    expect((await owner.query("select body, version from stamped where id = 2")).rows[0]).toEqual({
      body: "edited",
      version: 2,
    });
  });
});
