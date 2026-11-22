import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { version } from "../src/index.ts";

/**
 * A database knows Keyturn only by its version. SQL that changes under the same version can
 * never reach a database that has that version: upgrade says it is already there. So each
 * version's SQL is recorded here, and changing it means a new version.
 */
const recorded: Record<string, string> = {
  "0.3.0": "eb5a18564c6687ddb1c5c3f62ad7f61aa49793a8ad515945ccec198f35904ee6",
};

test("the SQL does not change without the version changing", async () => {
  const folder = new URL("../sql/", import.meta.url);
  const hash = createHash("sha256");
  for (const file of (await readdir(folder)).filter((name) => name.endsWith(".sql")).sort()) {
    hash.update(`${file}\n`).update(await readFile(new URL(file, folder)));
  }
  const now = await version();
  expect(
    recorded[now],
    `the SQL of ${now} is not recorded. Released, it cannot change again: add its hash`,
  ).toBeDefined();
  expect(
    hash.digest("hex"),
    `the SQL has changed since ${now} was recorded. Give it a new version in package.json, and record that`,
  ).toBe(recorded[now]);
});
