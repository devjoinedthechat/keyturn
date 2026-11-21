// Scores the reviewers' decisions in results/ against the answers in items.json.
//
//   node study/catch-rate/score.ts

import { readdir, readFile } from "node:fs/promises";

type Item = { item: number; right: boolean };
type Result = { reviewer: string; sheet: "rows" | "context"; decisions: string[] };

const here = new URL("./", import.meta.url);
const items = JSON.parse(await readFile(new URL("items.json", here), "utf8")) as Item[];
const files = (await readdir(new URL("results/", here))).filter((name) => name.endsWith(".json"));

console.log(
  `${items.length} items: ${items.filter((item) => item.right).length} right, ${items.filter((item) => !item.right).length} wrong\n`,
);
console.log(
  "sheet    reviewer        wrong caught  right approved  wrong approved  could not tell",
);
for (const file of files.sort()) {
  const result = JSON.parse(await readFile(new URL(`results/${file}`, here), "utf8")) as Result;
  if (result.decisions.length !== items.length) {
    throw new Error(`${file} has ${result.decisions.length} decisions for ${items.length} items`);
  }
  const count = (right: boolean, decision: string) =>
    items.filter((item) => item.right === right && result.decisions[item.item - 1] === decision)
      .length;
  const wrong = items.filter((item) => !item.right).length;
  const right = items.length - wrong;
  console.log(
    [
      result.sheet.padEnd(8),
      result.reviewer.padEnd(15),
      `${count(false, "reject")} of ${wrong}`.padEnd(13),
      `${count(true, "approve")} of ${right}`.padEnd(15),
      String(count(false, "approve")).padEnd(15),
      String(result.decisions.filter((decision) => decision === "cannot_tell").length),
    ].join(" "),
  );
}
