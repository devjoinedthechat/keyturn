// Makes the walkthrough at the top of the README: one animated SVG, built from stills of the
// real review page, taken in a real browser against PostgreSQL in a container.
//
//   node demo/walkthrough.ts [output file]
//
// No model is called. The "agent" is a script that sends the SQL a model sent in the run the
// demonstration was taken from, as an ordinary database login with ordinary rights. Every
// still is the page as it was at that moment; nothing is drawn or edited afterwards.

import { writeFileSync } from "node:fs";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { chromium, type Page } from "playwright";
import { install, Keyturn, protect, serveReview } from "../src/index.ts";

const OUT = process.argv[2] ?? "docs/walkthrough/keyturn-walkthrough.svg";
/** The picture as the README shows it, and the browser window it is taken from: the whole
 *  review page at a desk's width, drawn smaller, so nothing reads as zoomed in. */
const SIZE = { width: 860, height: 550 };
const WINDOW = { width: 1376, height: 880 };
/** Seconds each still is shown, and how long one fades into the next. */
const HOLD = 6;
const FADE = 0.5;

type Still = { caption: string; png: Buffer };
const stills: Still[] = [];

async function still(page: Page, caption: string) {
  // Lets the page finish drawing, and a key finish turning, before the picture is taken.
  await page.waitForTimeout(700);
  stills.push({ caption, png: await page.screenshot({ type: "png" }) });
  console.log(`still ${stills.length}: ${caption}`);
}

// ------------------------------------------------------------------ the shop

const container = await new PostgreSqlContainer(
  process.env.POSTGRES_IMAGE ?? "postgres:18.3",
).start();
const connect = async (user: string, password: string) => {
  const client = new pg.Client({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user,
    password,
  });
  client.on("error", () => {});
  await client.connect();
  return client;
};

const owner = await connect(container.getUsername(), container.getPassword());
await owner.query(`
  create role support_agent login password 'agent';
  create role dana login password 'dana';
  create table orders (
    id        integer primary key,
    customer  text not null,
    total     numeric(10, 2) not null,
    status    text not null default 'paid',
    placed    date not null
  );
  insert into orders
    select n, 'customer ' || (n * 7919 % 9000), 15 + (n * 31 % 400), 'paid', date '2024-01-01' + (n * 1050 / 40000)
      from generate_series(1, 39988) as n;
  insert into orders
    select 39988 + n, 'test ' || n, 1, 'paid', date '2026-11-10' from generate_series(1, 12) as n;
`);
await install(owner);
await protect(owner, "orders");
await owner.query(`
  grant keyturn_agent to support_agent;
  grant keyturn_approver to dana;
  grant select on orders to keyturn_agent, keyturn_approver;
`);

const agentDb = await connect("support_agent", "agent");
const agent = new Keyturn(agentDb);
const danaDb = await connect("dana", "dana");
const review = await serveReview(danaDb);

/** What the agent sends, as one transaction: a note, then ordinary SQL against the proposal view. */
async function agentProposes(note: string, sql: string): Promise<string> {
  await agentDb.query("begin");
  await agentDb.query("select keyturn.note($1)", [note]);
  await agentDb.query(sql);
  const made = (await agentDb.query("select proposal_id::text as id from keyturn.proposed()"))
    .rows[0] as { id: string };
  await agentDb.query("commit");
  return made.id;
}

// ------------------------------------------------------------------ the stills

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: WINDOW,
    // Twice the README's width once drawn at it, so the text stays sharp.
    deviceScaleFactor: (SIZE.width * 2) / WINDOW.width,
    // Fixed, so that a still shows nothing about the machine it was made on.
    timezoneId: "UTC",
    locale: "en-US",
    colorScheme: "light",
  });
  const page = await context.newPage();

  await agentProposes(
    "Cleaning up old test orders, as asked.",
    "delete from proposal.orders where placed < '2024-08-01'",
  );
  await page.goto(review.url);
  await page.locator("#approve").waitFor();
  await still(
    page,
    "An agent asked to clean up test orders deletes far too much. Nothing is deleted: it is a proposal.",
  );

  await page.evaluate("document.getElementById('sheet').scrollTop = 250");
  await still(
    page,
    "The approver sees its size first, then why it has come to a person, then the rows.",
  );

  await page.evaluate("document.getElementById('sheet').scrollTop = 0");
  await page.locator("#reject").click();
  await page
    .locator("#reason")
    .fill("These are real orders. Test orders have a customer starting with 'test'.");
  await still(page, "She rejects it and says why. The agent reads the reason.");
  await page.locator("#confirm-reject").click();
  await page.getByText("rejected this").first().waitFor();

  const second = await agentProposes(
    "Deleting the 12 test orders only.",
    "delete from proposal.orders where customer like 'test %'",
  );
  await page.goto(`${review.url.split("#")[0]}#${second}`);
  await page.locator("#approve").waitFor();
  await still(page, "The agent proposes the twelve rows that were meant.");

  await page.locator("#approve").click();
  await page.locator("#confirm-approve").waitFor();
  await still(page, "Approving asks once more. The approval is for these rows and no others.");
  // The page holds the confirming button back for a moment, against a double click.
  await page.waitForTimeout(900);
  await page.locator("#confirm-approve").click();
  await page.getByText("The agent can apply it.").waitFor();
  await still(page, "The second key is turned. Only now can the change be written.");

  await agent.apply(second);
  await page.reload();
  await page.getByText("Applied: 12 rows written.").waitFor();
  await still(page, "The agent applies it: twelve rows, exactly the ones approved, exactly once.");

  await page.locator("#revert").click();
  await page.locator("#revert-reason").fill("Finance wants them kept until the audit.");
  await page.locator("#confirm-revert").click();
  await page.getByText("has been taken back").first().waitFor();
  await still(page, "And an applied change can be taken back: every row as it was before.");
} finally {
  await browser.close();
  await review.close();
  await Promise.all([owner.end(), agentDb.end(), danaDb.end()]).catch(() => {});
  await container.stop();
}

// ------------------------------------------------------------------ the SVG

const CAPTION = 60;
const { width, height } = SIZE;
const total = stills.length * HOLD;
const percent = (seconds: number) => `${((seconds / total) * 100).toFixed(3)}%`;
const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const gap = 6;
const tick = (width - 48 - gap * (stills.length - 1)) / stills.length;
const parts = stills.map(({ caption, png }, index) => {
  const delay = `animation-delay:${index * HOLD}s`;
  return {
    image: `<image class="s" style="${delay}" width="${width}" height="${height}" href="data:image/png;base64,${png.toString("base64")}"/>`,
    caption: `<text class="s c" style="${delay}" x="24" y="${height + 41}">${escapeXml(caption)}</text>`,
    tick: `<rect class="s" style="${delay}" x="${24 + index * (tick + gap)}" y="${height + 12}" width="${tick}" height="3" rx="1.5" fill="#fb8a3c"/>`,
    track: `<rect x="${24 + index * (tick + gap)}" y="${height + 12}" width="${tick}" height="3" rx="1.5" fill="#fff" opacity=".22"/>`,
  };
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height + CAPTION}" width="${width}" role="img" aria-label="${escapeXml(stills.map((one) => one.caption).join(" "))}">
<style>
.s{opacity:0;animation:show ${total}s linear infinite both}
.c{font:500 15px/1 system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;fill:#f6f2ed}
@keyframes show{0%{opacity:0}${percent(FADE)}{opacity:1}${percent(HOLD)}{opacity:1}${percent(HOLD + FADE)}{opacity:0}100%{opacity:0}}
</style>
<clipPath id="frame"><rect width="${width}" height="${height + CAPTION}" rx="10"/></clipPath>
<g clip-path="url(#frame)">
<rect width="${width}" height="${height}" fill="#fffdfa"/>
${parts.map((part) => part.image).join("\n")}
<rect y="${height}" width="${width}" height="${CAPTION}" fill="#1b1816"/>
${parts.map((part) => part.track).join("")}
${parts.map((part) => part.tick).join("")}
${parts.map((part) => part.caption).join("\n")}
</g>
<rect x=".5" y=".5" width="${width - 1}" height="${height + CAPTION - 1}" rx="10" fill="none" stroke="#8b949e" stroke-opacity=".4"/>
</svg>
`;
writeFileSync(OUT, svg);
console.log(`wrote ${OUT}: ${stills.length} stills, ${Math.round(svg.length / 1024)} KB`);
process.exit(0);
