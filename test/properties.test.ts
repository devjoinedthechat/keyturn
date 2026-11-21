import fc from "fast-check";
import type pg from "pg";
import { afterAll, beforeAll, describe, test } from "vitest";
import { apply, Database, logins, propose } from "./database.ts";

/**
 * The examples elsewhere say what happens in the cases somebody thought of. These say what
 * must hold in every case, and let the machine look for one where it does not.
 *
 * A table under Keyturn and a plain table of the same shape start with the same rows. A
 * proposal made of any mixture of inserts, updates and deletes is applied to the one, and
 * the same writes are made directly to the other, by PostgreSQL itself. The two must come
 * out alike. Taken back, the first must be exactly as it began.
 */

const columns = `
  id integer primary key, name text not null, qty numeric(12, 3) not null, tags text[] not null,
  meta jsonb not null, flag boolean not null, seen timestamptz, note text`;
const schema = `
  create table items (${columns});
  create table plain (${columns});
  select keyturn.protect('items');
  grant select on items to keyturn_agent, keyturn_approver;
`;

let database: Database;
let owner: pg.Client;
let agent: pg.Client;
let alice: pg.Client;
let stamp = 0;

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

// Text PostgreSQL can hold: anything but the zero character.
const text = fc
  .string({ unit: "grapheme", maxLength: 10 })
  .filter((value) => !value.includes("\u0000"));
const row = fc.record({
  name: text,
  qty: fc
    .tuple(fc.integer({ min: -99999, max: 99999 }), fc.integer({ min: 0, max: 999 }))
    .map(([whole, part]) => `${whole}.${String(part).padStart(3, "0")}`),
  tags: fc.array(text, { maxLength: 3 }),
  meta: fc.dictionary(
    fc.string({ maxLength: 5 }).filter((key) => !key.includes("\u0000")),
    fc.oneof(fc.integer(), text, fc.boolean(), fc.constant(null)),
    { maxKeys: 3 },
  ),
  flag: fc.boolean(),
  seen: fc.option(
    fc
      .date({
        min: new Date("2000-01-01T00:00:00Z"),
        max: new Date("2030-01-01T00:00:00Z"),
        noInvalidDate: true,
      })
      .map((date) => date.toISOString()),
  ),
  note: fc.option(text),
});
type Row = typeof row extends fc.Arbitrary<infer Value> ? Value : never;

const ids = Array.from({ length: 12 }, (_, index) => index + 1);
/** Which rows are there at the start, and what is done to each of some rows. */
const scenario = fc.record({
  start: fc.dictionary(fc.constantFrom(...ids.map(String)), row, { maxKeys: 8 }),
  steps: fc.uniqueArray(
    fc.record({
      id: fc.constantFrom(...ids),
      // Used if the row is there: change some of it, or remove it.
      remove: fc.boolean(),
      set: fc.record(
        {
          name: text,
          qty: row.map((one) => one.qty),
          tags: fc.array(text, { maxLength: 3 }),
          flag: fc.boolean(),
        },
        { requiredKeys: [] },
      ),
      // Used if the row is not there: this is the row to add.
      add: row,
    }),
    { selector: (step) => step.id, minLength: 1, maxLength: 6 },
  ),
});
type Scenario = typeof scenario extends fc.Arbitrary<infer Value> ? Value : never;

const all = async (table: string) =>
  (
    await owner.query(
      `select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]')::text as rows from ${table} t`,
    )
  ).rows[0].rows as string;

async function begin(given: Scenario) {
  const rows = Object.entries(given.start).map(([id, values]) => ({ id: Number(id), ...values }));
  await owner.query("delete from items");
  await owner.query("delete from plain");
  for (const table of ["items", "plain"]) {
    await owner.query(
      `insert into ${table} select * from jsonb_populate_recordset(null::${table}, $1::jsonb)`,
      [JSON.stringify(rows)],
    );
  }
}

/** The changes of a proposal, and the same done directly to the plain table. */
function changes(given: Scenario): { change: unknown; direct: [string, unknown[]] }[] {
  return given.steps.map((step) => {
    const there = String(step.id) in given.start;
    if (!there) {
      return {
        change: { table: "items", operation: "insert", values: { id: step.id, ...step.add } },
        direct: [
          "insert into plain select * from jsonb_populate_record(null::plain, $1::jsonb)",
          [JSON.stringify({ id: step.id, ...step.add })],
        ],
      };
    }
    if (step.remove) {
      return {
        change: { table: "items", operation: "delete", key: { id: step.id } },
        direct: ["delete from plain where id = $1", [step.id]],
      };
    }
    // A mark no row has yet, so that the update always changes something.
    stamp += 1;
    const set: Partial<Row> = { ...step.set, note: `changed ${stamp}` };
    const names = Object.keys(set)
      .map((name) => `"${name}"`)
      .join(", ");
    return {
      change: { table: "items", operation: "update", key: { id: step.id }, set },
      direct: [
        `update plain set (${names}) = (select ${names} from jsonb_populate_record(null::plain, $2::jsonb)) where id = $1`,
        [step.id, JSON.stringify(set)],
      ],
    };
  });
}

async function approved(given: Scenario) {
  const made = changes(given);
  const proposal = await propose(
    agent,
    made.map((one) => one.change),
  );
  await alice.query("select keyturn.approve($1, $2)", [
    proposal.proposal_id,
    proposal.content_hash,
  ]);
  return { proposal: proposal.proposal_id, made };
}

const runs = Number(process.env.PROPERTY_RUNS ?? 60);

describe("for any proposal", () => {
  test("applying it writes what the same statements would have written directly, and taking it back leaves no trace", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (given) => {
        await begin(given);
        const before = await all("items");
        const { proposal, made } = await approved(given);

        const outcome = await apply(agent, proposal);
        fc.pre(outcome.status === "applied" || outcome.status === "failed");
        if (outcome.status !== "applied") {
          throw new Error(`not applied: ${JSON.stringify(outcome)}`);
        }
        for (const { direct } of made) {
          await owner.query(direct[0], direct[1]);
        }
        const [written, wanted] = [await all("items"), await all("plain")];
        if (written !== wanted) {
          throw new Error(`applied\n${written}\ndirect\n${wanted}`);
        }

        const back = (await alice.query("select keyturn.revert($1) as outcome", [proposal])).rows[0]
          .outcome;
        if (back.status !== "reverted" || (await all("items")) !== before) {
          throw new Error(
            `taken back ${JSON.stringify(back)}\nnow\n${await all("items")}\nbefore\n${before}`,
          );
        }
      }),
      { numRuns: runs },
    );
  }, 300_000);

  test("a row written to in between stops it whole: nothing of it is applied, and nothing of it is taken back", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, fc.nat(), fc.boolean(), async (given, pick, early) => {
        await begin(given);
        const { proposal } = await approved(given);
        const step = given.steps[pick % given.steps.length] as Scenario["steps"][number];
        const there = String(step.id) in given.start;
        // Somebody else gets to one of its rows first: changes it, or takes the place of a row it would add.
        const meddle = () =>
          there
            ? owner.query("update items set name = name || '!' where id = $1", [step.id])
            : owner.query(
                "insert into items select * from jsonb_populate_record(null::items, $1::jsonb)",
                [JSON.stringify({ id: step.id, ...step.add, name: "somebody else's" })],
              );

        if (early) {
          await meddle();
          const then = await all("items");
          const outcome = await apply(agent, proposal);
          if (outcome.status !== "stale" || (await all("items")) !== then) {
            throw new Error(`applied over a changed row: ${JSON.stringify(outcome)}`);
          }
          return;
        }
        const outcome = await apply(agent, proposal);
        if (outcome.status !== "applied") {
          throw new Error(`not applied: ${JSON.stringify(outcome)}`);
        }
        // After it is applied, the same: a row it wrote is written to again, or a row it removed comes back.
        if (there && step.remove) {
          await owner.query(
            "insert into items select * from jsonb_populate_record(null::items, $1::jsonb)",
            [JSON.stringify({ id: step.id, ...step.add, name: "somebody else's" })],
          );
        } else {
          await owner.query("update items set name = name || '!' where id = $1", [step.id]);
        }
        const then = await all("items");
        const back = (await alice.query("select keyturn.revert($1) as outcome", [proposal])).rows[0]
          .outcome;
        if (back.status !== "conflict" || (await all("items")) !== then) {
          throw new Error(`taken back over later work: ${JSON.stringify(back)}`);
        }
      }),
      { numRuns: runs },
    );
  }, 300_000);
});
