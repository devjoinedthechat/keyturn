import { mkdir } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { AxeBuilder } from "@axe-core/playwright";
import type pg from "pg";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Keyturn } from "../src/index.ts";
import { type Review, serveReview } from "../src/review.ts";
import { Database, logins } from "./database.ts";

const schema = `
  create table orders (
    id        integer primary key,
    customer  text not null,
    total     numeric(10, 2) not null,
    status    text not null default 'paid',
    placed    date not null default '2026-03-01',
    memo      text
  );
  insert into orders (id, customer, total) select n, 'customer ' || n, 20 + n from generate_series(1, 400) as n;
  select keyturn.protect('orders');
  grant select on orders to keyturn_agent, keyturn_approver;
`;

const shots = process.env.SHOTS;
let database: Database;
let owner: pg.Client;
let agent: Keyturn;
let browser: Browser;
const reviews: Review[] = [];

beforeAll(async () => {
  database = await Database.create(schema);
  owner = await database.as(logins.owner);
  agent = new Keyturn(await database.as(logins.agent));
  browser = await chromium.launch();
  if (shots !== undefined) {
    await mkdir(shots, { recursive: true });
  }
});

afterAll(async () => {
  await browser?.close();
  await Promise.all(reviews.map((review) => review.close()));
  await database.close();
});

async function reviewAs(login: string): Promise<Review> {
  const review = await serveReview(await database.as(login));
  reviews.push(review);
  return review;
}

async function pageAt(
  url: string,
  options: { dark?: boolean; width?: number } = {},
): Promise<Page> {
  const context = await browser.newContext({
    colorScheme: options.dark ? "dark" : "light",
    viewport: { width: options.width ?? 1280, height: 860 },
  });
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

const refund = (id: number) => ({
  table: "orders",
  operation: "update" as const,
  key: { id },
  set: { total: 0, status: "refunded" },
});
const order = async (id: number) =>
  (await owner.query("select * from orders where id = $1", [id])).rows[0];
const keyOf = (review: Review) => review.url.split("#")[1] as string;

/** A request with every header chosen, which a browser's fetch does not allow. */
function raw(
  review: Review,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: review.port,
        path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
      },
    );
    request.on("error", reject);
    request.end(options.body);
  });
}

describe("the review page's server", () => {
  let review: Review;
  let made: { id: string; contentHash: string };
  const call = (
    path: string,
    headers: Record<string, string> = {},
    method = "GET",
    body?: string,
  ) =>
    raw(review, path, {
      method,
      headers: { authorization: `Bearer ${keyOf(review)}`, ...headers },
      ...(body === undefined ? {} : { body }),
    });

  beforeAll(async () => {
    review = await reviewAs(logins.alice);
    made = await agent.propose([refund(1)], { note: "A double payment." });
  });

  test("listens on this machine only, and gives data only with the key for this run", async () => {
    expect(review.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#[A-Za-z0-9_-]{32}$/);
    expect((await raw(review, "/api/proposals")).status).toBe(401);
    expect(
      (await raw(review, "/api/proposals", { headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(401);
    expect(
      (
        await raw(review, "/api/proposals", {
          headers: { authorization: `Bearer ${keyOf(review)}x` },
        })
      ).status,
    ).toBe(401);
    expect((await raw(review, `/api/proposals?key=${keyOf(review)}`)).status).toBe(401);
    const listed = await call("/api/proposals");
    expect(listed.status).toBe(200);
    expect(
      JSON.parse(listed.body).proposals.map((proposal: { id: string }) => proposal.id),
    ).toContain(made.id);
  });

  test("refuses a request that names another host or comes from another site", async () => {
    expect((await call("/api/proposals", { host: "evil.example" })).status).toBe(421);
    expect((await call("/", { host: `evil.example:${review.port}` })).status).toBe(421);
    expect((await call("/api/proposals", { origin: "https://evil.example" })).status).toBe(403);
    expect(
      (await call("/api/proposals", { origin: `http://127.0.0.1:${review.port}` })).status,
    ).toBe(200);

    // A form on another site can post, but not as JSON; and it has no key.
    const form = await call(
      `/api/proposals/${made.id}/approve`,
      { "content-type": "application/x-www-form-urlencoded" },
      "POST",
      `hash=${made.contentHash}`,
    );
    expect(form.status).toBe(415);
    expect((await agent.proposal(made.id))?.status).toBe("pending");
  });

  test("lets its page load nothing but its own files, and does not let it be framed", async () => {
    for (const path of ["/", "/app.js", "/style.css"]) {
      const file = await raw(review, path);
      expect(file.status, path).toBe(200);
      expect(file.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(file.headers["content-security-policy"]).toContain("script-src 'self'");
      expect(file.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(file.headers["x-content-type-options"]).toBe("nosniff");
      expect(file.headers["cache-control"]).toBe("no-store");
    }
    expect((await raw(review, "/../package.json")).status).toBe(404);
    expect((await raw(review, "/app.js/../../src/cli.ts")).status).toBe(404);
    expect((await raw(review, "/", { method: "POST" })).status).toBe(405);
  });

  test("turns down what is not a proper request, and passes on the database's refusals", async () => {
    const json = { "content-type": "application/json" };
    expect((await call("/api/proposals/not-an-id")).status).toBe(404);
    expect((await call(`/api/proposals/${made.id}/rows?from=0`)).status).toBe(400);
    expect((await call(`/api/proposals/${made.id}/approve`, json, "POST", "{}")).status).toBe(400);
    expect((await call(`/api/proposals/${made.id}/approve`, json, "POST", "[1]")).status).toBe(400);
    expect(
      (await call(`/api/proposals/${made.id}/approve`, json, "POST", "x".repeat(20_000))).status,
    ).toBe(413);
    expect((await call(`/api/proposals/${made.id}/drop`, json, "POST", "{}")).status).toBe(404);
    expect((await call("/api/proposals/00000000-0000-4000-8000-000000000000")).status).toBe(404);

    const swapped = await call(
      `/api/proposals/${made.id}/approve`,
      json,
      "POST",
      JSON.stringify({ hash: "0".repeat(64) }),
    );
    expect(swapped.status).toBe(409);
    expect(JSON.parse(swapped.body)).toMatchObject({ refused: true });
    expect((await agent.proposal(made.id))?.status).toBe("pending");
  });

  test("gives an agent's login no more than the database gives it", async () => {
    const asAgent = await reviewAs(logins.otherAgent);
    const headers = {
      authorization: `Bearer ${keyOf(asAgent)}`,
      "content-type": "application/json",
    };
    expect((await raw(asAgent, `/api/proposals/${made.id}`, { headers })).status).toBe(404);
    const attempt = await raw(asAgent, `/api/proposals/${made.id}/approve`, {
      method: "POST",
      headers,
      body: JSON.stringify({ hash: made.contentHash }),
    });
    expect(attempt.status).toBe(409);
    expect((await agent.proposal(made.id))?.status).toBe("pending");
  });
});

describe("the review page", () => {
  test("shows what would change, and approves exactly that when the reviewer says so twice", async () => {
    const made = await agent.propose(
      [refund(10), { table: "orders", operation: "delete", key: { id: 11 } }],
      { note: "Customer 10 was charged twice; order 11 is its duplicate." },
    );
    const review = await reviewAs(logins.alice);
    const page = await pageAt(`${review.url}`);
    await page.locator(".queue button", { hasText: "charged twice" }).click();

    // The key has left the address bar.
    expect(page.url()).not.toContain(keyOf(review));
    await expect
      .poll(() => page.locator("#who").textContent())
      .toContain(`${logins.alice} on ${database.name}`);

    const sheet = page.locator("#sheet");
    await expect.poll(() => sheet.locator(".note").textContent()).toContain("charged twice");
    expect(await sheet.locator(".extent").innerText()).toMatch(
      /1 delete\s+in public\.orders\s+1 update\s+in public\.orders/,
    );
    const update = sheet.locator(".change").first();
    expect(await update.locator(".row-key").innerText()).toContain("update id 10");
    expect(await update.locator("tr", { hasText: "total" }).innerText()).toMatch(
      /total\s+30\.00\s+→\s+0\.00/,
    );
    expect(await update.locator("tr", { hasText: "status" }).innerText()).toMatch(
      /status\s+paid\s+→\s+refunded/,
    );
    expect(await update.locator("tr").count()).toBe(2);
    await update.getByRole("button", { name: "4 columns stay the same" }).click();
    expect(await sheet.locator(".change").first().locator("tr").count()).toBe(6);
    expect(await sheet.locator(".grid.delete tbody tr").innerText()).toMatch(
      /2\s+−\s+11\s+customer 11\s+31\.00/,
    );
    expect(await page.locator(".key .hash").textContent()).toBe(made.contentHash);

    if (shots !== undefined) {
      await page.screenshot({ path: `${shots}/review-light.png` });
    }

    // One press asks; nothing is approved yet.
    await page.getByRole("button", { name: "Approve 2 changes" }).click();
    expect(await page.locator(".ask").textContent()).toContain("Approve these 2 changes as alice?");
    expect((await agent.proposal(made.id))?.status).toBe("pending");
    await page.getByRole("button", { name: "Not yet" }).click();
    await page.getByRole("button", { name: "Approve 2 changes" }).click();
    await page.getByRole("button", { name: "Approve all 2" }).click();

    await expect
      .poll(() => page.locator("#keys").innerText())
      .toContain("alice approved this. The agent can apply it.");
    expect(await agent.proposal(made.id)).toMatchObject({
      status: "approved",
      decidedBy: logins.alice,
    });
    expect(await order(10)).toMatchObject({ total: "30.00" });
    expect(await sheet.locator(".steps").innerText()).toMatch(
      /opened by agent_bot.*approved by alice/s,
    );

    await page.getByRole("button", { name: "Apply it from here" }).click();
    await expect
      .poll(() => page.locator("#keys").innerText())
      .toContain("Applied: 2 rows written.");
    expect(await order(10)).toMatchObject({ total: "0.00", status: "refunded" });
    expect(await order(11)).toBeUndefined();
    await page.context().close();
  });

  test("puts what an agent wrote on the screen as text, with nothing in it hidden", async () => {
    const override = String.fromCodePoint(0x202e);
    const hostile = `<img src=x onerror="document.title='owned'"><script>document.title='owned'</script>${override}evorppa`;
    const made = await agent.propose(
      [
        {
          table: "orders",
          operation: "update",
          key: { id: 20 },
          set: { memo: hostile, customer: "" },
        },
      ],
      { note: hostile },
    );
    const review = await reviewAs(logins.alice);
    const page = await pageAt(`${review.url}`);
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });
    await page.goto(`http://127.0.0.1:${review.port}/#${made.id}`);
    await expect.poll(() => page.locator("#sheet .note").textContent()).toContain("<img src=x");

    expect(await page.title()).not.toBe("owned");
    expect(await page.locator("#sheet img, #sheet script, #queue img, #queue script").count()).toBe(
      0,
    );
    expect(await page.locator("#sheet .note .code").textContent()).toBe("U+202E");
    expect(await page.locator("#sheet .note").textContent()).not.toContain(override);
    expect(await page.locator("#queue").textContent()).not.toContain(override);
    const memo = page.locator(".change tr", { hasText: "memo" });
    expect(await memo.locator(".was").innerText()).toBe("null");
    expect(await memo.locator(".now .code").textContent()).toBe("U+202E");
    expect(
      await page.locator(".change tr", { hasText: "customer" }).locator(".now").innerText(),
    ).toBe("empty text");
    expect(errors).toEqual([]);
    await page.context().close();
  });

  test("says how much of a large proposal has been read before it lets all of it be approved", async () => {
    const made = await agent.propose(
      Array.from({ length: 150 }, (_, index) => ({
        table: "orders",
        operation: "delete" as const,
        key: { id: 100 + index },
      })),
      { note: "Clean up old orders." },
    );
    const review = await reviewAs(logins.alice);
    const page = await pageAt(`http://127.0.0.1:${review.port}/#${keyOf(review)}`, { dark: true });
    await page.locator(".queue button", { hasText: "Clean up old orders" }).click();
    await expect.poll(() => page.locator(".extent .figure").textContent()).toBe("150 deletes");
    expect(await page.locator(".queue button[aria-current] .size").textContent()).toBe("150 rows");
    expect(await page.locator(".grid.delete tbody tr").count()).toBe(100);
    expect(await page.locator(".more").innerText()).toContain("100 of 150 rows are on the page.");

    await page.getByRole("button", { name: "Approve 150 changes" }).click();
    expect(await page.locator(".ask").textContent()).toBe(
      "You have 100 rows of 150 on the page. Approving covers all 150.",
    );
    if (shots !== undefined) {
      await page.screenshot({ path: `${shots}/review-dark-large.png` });
    }
    await page.getByRole("button", { name: "Not yet" }).click();

    await page.getByRole("button", { name: "Show the next 50" }).click();
    await expect.poll(() => page.locator(".grid.delete tbody tr").count()).toBe(150);
    expect(await page.locator(".more").count()).toBe(0);

    await page.getByRole("button", { name: "Reject" }).click();
    await page.locator("#reason").fill("These orders are not old: placed this month.");
    await page.locator("#confirm-reject").click();
    await expect
      .poll(() => page.locator("#keys").innerText())
      .toContain("alice rejected this: These orders are not old: placed this month.");
    expect(await agent.proposal(made.id)).toMatchObject({
      status: "rejected",
      reason: "These orders are not old: placed this month.",
    });
    expect(
      (await owner.query("select count(*)::int as n from orders where id between 100 and 249"))
        .rows[0].n,
    ).toBe(150);
    await page.context().close();
  });

  test("shows the database's refusal, and what someone else decided meanwhile", async () => {
    const made = await agent.propose([refund(30)], { note: "Refund order 30." });
    const review = await reviewAs(logins.alice);
    const page = await pageAt(`http://127.0.0.1:${review.port}/#${keyOf(review)}`);
    await page.locator(".queue button", { hasText: "Refund order 30" }).click();
    await page.getByRole("button", { name: "Approve 1 change" }).click();

    // Bob decides first, from somewhere else.
    const bob = new Keyturn(await database.as(logins.bob));
    await bob.reject(made.id, "Already refunded by hand.");
    await page.locator("#confirm-approve").click();
    await expect.poll(() => page.locator(".refused").count(), { timeout: 10_000 }).toBe(1);
    expect(await page.locator(".refused").innerText()).toContain("Refused:");
    await expect
      .poll(() => page.locator("#keys").innerText(), { timeout: 15_000 })
      .toContain("bob rejected this: Already refunded by hand.");
    expect((await order(30)).status).toBe("paid");
    await page.context().close();
  });

  test("offers an agent's login nothing to press, and shows nothing without the key", async () => {
    await agent.propose([refund(40)], { note: "Refund order 40." });
    const review = await reviewAs(logins.agent);
    const page = await pageAt(`http://127.0.0.1:${review.port}/#${keyOf(review)}`);
    await page.locator(".queue button", { hasText: "Refund order 40" }).click();
    await expect
      .poll(() => page.locator("#keys").innerText())
      .toContain("agent_bot cannot approve");
    expect(await page.locator("#keys button").count()).toBe(0);
    await page.context().close();

    const stranger = await pageAt(`http://127.0.0.1:${review.port}/`);
    await expect
      .poll(() => stranger.locator("#sheet").innerText())
      .toContain("Open the address that keyturn review printed");
    expect(await stranger.locator("#queue button").count()).toBe(0);
    await stranger.context().close();
  });

  test("can be used by people who do not see it the usual way, in light and dark and on a phone", async () => {
    await agent.propose(
      [
        refund(50),
        {
          table: "orders",
          operation: "insert",
          values: { id: 9001, customer: "walk-in", total: 12.5 },
        },
      ],
      { note: "Refund order 50 and add the walk-in sale." },
    );
    const review = await reviewAs(logins.alice);
    for (const look of [
      { name: "light", dark: false, width: 1280 },
      { name: "dark", dark: true, width: 1280 },
      { name: "phone", dark: false, width: 390 },
    ]) {
      const page = await pageAt(`http://127.0.0.1:${review.port}/#${keyOf(review)}`, look);
      await page.locator(".queue button", { hasText: "walk-in sale" }).click();
      await expect.poll(() => page.locator(".grid.insert tbody tr").count()).toBe(1);
      await page.getByRole("button", { name: "Approve 2 changes" }).click();
      const found = await new AxeBuilder({ page }).analyze();
      expect(
        found.violations.map(
          (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(" ")}`,
        ),
        look.name,
      ).toEqual([]);
      // Nothing is wider than the screen but the tables, which scroll inside themselves.
      expect(
        await page.evaluate(
          "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
        ),
        look.name,
      ).toBe(true);
      if (shots !== undefined) {
        await page.screenshot({
          path: `${shots}/review-${look.name}-confirm.png`,
          fullPage: look.width < 500,
        });
      }
      await page.context().close();
    }
  });
});
