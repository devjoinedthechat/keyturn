// The review page. Everything an agent wrote reaches the screen through textContent: a
// note or a value is text here, whatever it contains.

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const state = {
  key: takeKey(),
  me: null,
  view: "waiting",
  list: [],
  id: null,
  proposal: null,
  extent: [],
  history: [],
  rows: [],
  // The hash of the content as it was when its rows were put on the screen. An approval sends this one.
  readHash: null,
  changedSince: false,
  mode: "idle",
  refused: null,
  busy: false,
  unchanged: new Set(),
};

const queue = document.getElementById("queue");
const sheet = document.getElementById("sheet");
const keys = document.getElementById("keys");
const said = document.getElementById("said");

/** The key for this run comes in the address, once. It is kept for the tab and taken out of the address bar. */
function takeKey() {
  const given = location.hash.slice(1);
  let key = null;
  try {
    if (/^[A-Za-z0-9_-]{24,}$/.test(given) && !uuid.test(given)) {
      sessionStorage.setItem("keyturn-key", given);
      history.replaceState(null, "", location.pathname);
    }
    key = sessionStorage.getItem("keyturn-key");
  } catch {
    key = /^[A-Za-z0-9_-]{24,}$/.test(given) ? given : null;
  }
  return key;
}

async function api(path, body) {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${state.key}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({ error: "The review page did not answer." }));
  if (!response.ok) {
    const problem = new Error(data.error ?? "The review page did not answer.");
    problem.status = response.status;
    throw problem;
  }
  return data;
}

/** An element. Children that are strings become text. */
function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "class") {
      node.className = value;
    } else if (name === "on") {
      for (const [event, handler] of Object.entries(value)) {
        node.addEventListener(event, handler);
      }
    } else if (value === true) {
      node.setAttribute(name, "");
    } else if (value !== false && value !== null && value !== undefined) {
      node.setAttribute(name, value);
    }
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

/** Characters that hide, or that turn the text after them round. Shown as their code. */
function hidden(code) {
  return (
    (code < 0x20 && code !== 0x09 && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0xfeff
  );
}

/** Text an agent wrote, with nothing in it left unseen. */
function written(text) {
  const parts = document.createDocumentFragment();
  let run = "";
  for (const character of text) {
    const code = character.codePointAt(0);
    if (hidden(code)) {
      parts.append(
        run,
        el(
          "span",
          { class: "code", title: "A character that does not show" },
          `U+${code.toString(16).toUpperCase().padStart(4, "0")}`,
        ),
      );
      run = "";
    } else {
      run += character;
    }
  }
  parts.append(run);
  return parts;
}

const clamp = 600;

/** One value, as the database wrote it. */
function value(text, kind) {
  if (kind === "absent") {
    return el("span", { class: "chip" }, "not given");
  }
  if (kind === "null" || text === null) {
    return el("span", { class: "chip" }, "null");
  }
  if (text === "") {
    return el("span", { class: "chip" }, "empty text");
  }
  if (text.length <= clamp) {
    return written(text);
  }
  const holder = el("span", {}, written(text.slice(0, clamp)), "… ");
  holder.append(
    el(
      "button",
      {
        type: "button",
        class: "link",
        on: { click: () => holder.replaceChildren(written(text)) },
      },
      `show all ${text.length.toLocaleString("en")} characters`,
    ),
  );
  return holder;
}

function ago(when, now = Date.now()) {
  const seconds = Math.round(Math.abs(now - new Date(when).getTime()) / 1000);
  if (seconds < 10) {
    return "a moment";
  }
  const [amount, unit] =
    seconds < 90
      ? [seconds, "second"]
      : seconds < 5400
        ? [Math.round(seconds / 60), "minute"]
        : seconds < 129600
          ? [Math.round(seconds / 3600), "hour"]
          : [Math.round(seconds / 86400), "day"];
  return `${amount} ${unit}${amount === 1 ? "" : "s"}`;
}

const many = (count, word) => `${count.toLocaleString("en")} ${word}${count === 1 ? "" : "s"}`;

function standing(proposal) {
  if (proposal.expired) {
    return "expired";
  }
  return proposal.status;
}

// ---------------------------------------------------------------- the queue

function drawQueue() {
  document
    .getElementById("view-waiting")
    .setAttribute("aria-pressed", String(state.view === "waiting"));
  document
    .getElementById("view-decided")
    .setAttribute("aria-pressed", String(state.view === "decided"));
  if (state.list.length === 0) {
    queue.replaceChildren(
      el(
        "p",
        { class: "none" },
        state.view === "waiting" ? "Nothing is waiting." : "Nothing has been decided yet.",
      ),
    );
    return;
  }
  queue.replaceChildren(
    ...state.list.map((proposal) => {
      const parts = el("span", { class: "parts" });
      proposal.extent.forEach((part, index) => {
        if (index > 0) {
          parts.append(", ");
        }
        parts.append(
          el(
            "span",
            { class: part.operation === "delete" ? "gone" : "" },
            `${many(part.rows, part.operation)} in ${part.table}`,
          ),
        );
      });
      return el(
        "button",
        {
          type: "button",
          "aria-current": proposal.id === state.id ? "true" : null,
          on: { click: () => open(proposal.id) },
        },
        el("span", { class: "size" }, many(proposal.changes, "row")),
        parts,
        el(
          "span",
          { class: "from" },
          written(
            `${proposal.proposedBy}, ${ago(proposal.proposedAt)} ago${state.view === "decided" ? `, ${standing(proposal)}` : ""}`,
          ),
        ),
        proposal.note === ""
          ? null
          : el("span", { class: "words" }, written(proposal.note.replace(/\s+/g, " "))),
      );
    }),
  );
}

async function loadList() {
  const data = await api(`proposals?show=${state.view}`);
  state.list = data.proposals;
  if (state.view === "waiting") {
    document.getElementById("count-waiting").textContent = String(state.list.length);
  }
  drawQueue();
}

// ---------------------------------------------------------------- one proposal

function drawSheet() {
  const proposal = state.proposal;
  if (proposal === null) {
    sheet.replaceChildren(
      el(
        "p",
        { class: "none" },
        state.list.length === 0 && state.view === "waiting"
          ? "No proposal is waiting. When an agent proposes a change, it appears here."
          : "Choose a proposal to read what it would change.",
      ),
    );
    return;
  }

  const parts = [];
  parts.push(
    proposal.note === ""
      ? el("p", { class: "note absent" }, "No note was given with this proposal.")
      : el("p", { class: "note" }, written(proposal.note)),
  );
  parts.push(
    el(
      "p",
      { class: "said-by" },
      written(proposal.proposedBy),
      ` proposed this ${ago(proposal.proposedAt)} ago. `,
      proposal.status === "pending" || proposal.status === "approved"
        ? proposal.expired
          ? `It expired ${ago(proposal.expiresAt)} ago.`
          : `It expires in ${ago(proposal.expiresAt)}.`
        : "",
    ),
  );

  if (state.changedSince) {
    parts.push(
      el(
        "p",
        { class: "banner" },
        "This proposal changed after you opened it. What is below is how it stands; read it again.",
      ),
    );
  }
  if (proposal.outcome?.reason) {
    parts.push(
      el("p", { class: "banner" }, "Nothing was written: ", written(proposal.outcome.reason)),
    );
  }

  parts.push(
    el(
      "ul",
      { class: "extent" },
      ...state.extent.map((part) =>
        el(
          "li",
          { class: part.operation === "delete" ? "gone" : "" },
          el("span", { class: "figure" }, many(part.rows, part.operation)),
          el("span", { class: "what" }, `in ${part.table}`),
        ),
      ),
    ),
  );

  parts.push(
    el(
      "ol",
      { class: "steps", "aria-label": "What has happened to this proposal" },
      ...state.history.map((step) =>
        el(
          "li",
          {},
          el("b", {}, step.event === "approved_by_rule" ? "let through by a rule" : step.event),
          " by ",
          written(
            step.event === "approved_by_rule"
              ? Object.keys(step.detail.rules ?? {}).join(", ")
              : step.actor,
          ),
          `, ${ago(step.at)} ago`,
        ),
      ),
    ),
  );

  parts.push(...drawRows());

  const last = state.rows.at(-1)?.seq ?? 0;
  if (last < proposal.changes) {
    parts.push(
      el(
        "p",
        { class: "more" },
        `${last.toLocaleString("en")} of ${many(proposal.changes, "row")} are on the page.`,
        el(
          "button",
          { type: "button", class: "link", on: { click: () => more() } },
          `Show the next ${Math.min(100, proposal.changes - last)}`,
        ),
      ),
    );
  }
  sheet.replaceChildren(...parts);
}

function drawRows() {
  const parts = [];
  let table = null;
  let index = 0;
  while (index < state.rows.length) {
    const row = state.rows[index];
    if (row.table !== table) {
      table = row.table;
      parts.push(el("h2", { class: "table-name" }, el("b", {}, table)));
    }
    if (row.operation === "update") {
      parts.push(drawUpdate(row));
      index += 1;
      continue;
    }
    let end = index;
    while (
      end < state.rows.length &&
      state.rows[end].table === table &&
      state.rows[end].operation === row.operation
    ) {
      end += 1;
    }
    parts.push(drawGrid(state.rows.slice(index, end), row.operation));
    index = end;
  }
  return parts;
}

function keyText(key) {
  return Object.entries(key)
    .map(([name, part]) => `${name} ${typeof part === "string" ? part : JSON.stringify(part)}`)
    .join(", ");
}

function drawUpdate(row) {
  const open = state.unchanged.has(row.seq);
  const same = row.columns.filter((column) => !column.changed);
  const body = el("tbody");
  for (const column of row.columns) {
    if (column.changed) {
      body.append(
        el(
          "tr",
          {},
          el("th", { scope: "row" }, written(column.column)),
          el("td", { class: "was" }, value(column.before, column.beforeKind)),
          el("td", { class: "arrow", "aria-label": "becomes" }, "→"),
          el("td", { class: "now" }, value(column.after, column.afterKind)),
        ),
      );
    } else if (open) {
      body.append(
        el(
          "tr",
          { class: "same" },
          el("th", { scope: "row" }, written(column.column)),
          el("td", { colspan: "3" }, value(column.before, column.beforeKind)),
        ),
      );
    }
  }
  return el(
    "section",
    { class: "change" },
    el(
      "p",
      { class: "row-key" },
      el("span", { class: "seq" }, `#${row.seq}`),
      " update ",
      written(keyText(row.key)),
    ),
    el("table", { class: "pairs" }, body),
    same.length === 0
      ? null
      : el(
          "button",
          {
            type: "button",
            class: "link",
            "aria-expanded": String(open),
            on: {
              click: () => {
                if (open) {
                  state.unchanged.delete(row.seq);
                } else {
                  state.unchanged.add(row.seq);
                }
                drawSheet();
              },
            },
          },
          open
            ? "Hide what stays the same"
            : `${many(same.length, "column")} stay${same.length === 1 ? "s" : ""} the same`,
        ),
  );
}

function drawGrid(rows, operation) {
  const columns = [];
  for (const row of rows) {
    for (const column of row.columns) {
      if (!columns.includes(column.column)) {
        columns.push(column.column);
      }
    }
  }
  const side = operation === "insert" ? "after" : "before";
  return el(
    "div",
    { class: "scroll" },
    el(
      "table",
      { class: `grid ${operation}` },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", { class: "seq", scope: "col" }, "#"),
          el("th", { class: "sign", scope: "col" }, el("span", { class: "chip" }, operation)),
          ...columns.map((name) => el("th", { scope: "col" }, written(name))),
        ),
      ),
      el(
        "tbody",
        {},
        ...rows.map((row) =>
          el(
            "tr",
            {},
            el("td", { class: "seq" }, String(row.seq)),
            el(
              "td",
              { class: "sign", "aria-label": operation === "insert" ? "added" : "removed" },
              operation === "insert" ? "+" : "−",
            ),
            ...columns.map((name) => {
              const column = row.columns.find((candidate) => candidate.column === name);
              return el(
                "td",
                {},
                column === undefined
                  ? value(null, "absent")
                  : value(column[side], column[`${side}Kind`]),
              );
            }),
          ),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------- the two keys

function drawKeys() {
  const proposal = state.proposal;
  if (proposal === null) {
    keys.hidden = true;
    return;
  }
  keys.hidden = false;
  const first = el(
    "section",
    { class: "key", "aria-label": "First key" },
    el("p", { class: "label turned" }, "First key, turned"),
    el("p", {}, written(proposal.proposedBy), ` proposed ${many(proposal.changes, "change")}.`),
    el(
      "p",
      {
        class: "hash",
        title: "The hash of this content. An approval is for this content and no other.",
      },
      state.readHash ?? proposal.contentHash,
    ),
  );

  const second = el("section", { class: "key", "aria-label": "Second key" });
  const label = (text, turned) =>
    second.append(el("p", { class: turned ? "label turned" : "label" }, text));
  const total = proposal.changes;
  const seen = state.rows.length;

  if (proposal.status === "pending" && proposal.expired) {
    label("Second key, never turned", false);
    second.append(el("p", {}, "Nobody decided before it expired. Nothing was written."));
  } else if (proposal.status === "pending" && !state.me.approver) {
    label("Second key", false);
    second.append(
      el(
        "p",
        {},
        written(`${state.me.login} cannot approve. Start the page as a login in keyturn_approver.`),
      ),
    );
  } else if (proposal.status === "pending" && proposal.proposedBy === state.me.login) {
    label("Second key", false);
    second.append(el("p", {}, "You proposed this. Someone else has to approve it."));
  } else if (proposal.status === "pending" && state.mode === "approve") {
    label("Second key", false);
    second.append(
      el(
        "p",
        { class: "ask" },
        seen < total
          ? `You have ${many(seen, "row")} of ${total.toLocaleString("en")} on the page. Approving covers all ${total.toLocaleString("en")}.`
          : `Approve ${total === 1 ? "this change" : `these ${total.toLocaleString("en")} changes`} as ${state.me.login}?`,
      ),
      el(
        "div",
        { class: "acts" },
        el(
          "button",
          {
            type: "button",
            class: "act turn",
            id: "confirm-approve",
            disabled: state.busy,
            on: { click: approve },
          },
          total === 1 ? "Approve" : `Approve all ${total.toLocaleString("en")}`,
        ),
        el(
          "button",
          { type: "button", class: "act", on: { click: () => setMode("idle") } },
          "Not yet",
        ),
      ),
    );
  } else if (proposal.status === "pending" && state.mode === "reject") {
    label("Second key", false);
    const reason = el("textarea", {
      id: "reason",
      maxlength: "2000",
      "aria-label": "Why it is rejected, for the record and the agent",
    });
    second.append(
      reason,
      el(
        "div",
        { class: "acts" },
        el(
          "button",
          {
            type: "button",
            class: "act",
            id: "confirm-reject",
            disabled: state.busy,
            on: { click: () => reject(reason.value) },
          },
          "Reject",
        ),
        el(
          "button",
          { type: "button", class: "act", on: { click: () => setMode("idle") } },
          "Not yet",
        ),
      ),
    );
  } else if (proposal.status === "pending") {
    label("Second key", false);
    second.append(
      el(
        "div",
        { class: "acts" },
        el(
          "button",
          {
            type: "button",
            class: "act turn",
            id: "approve",
            on: { click: () => setMode("approve") },
          },
          `Approve ${many(total, "change")}`,
        ),
        el(
          "button",
          { type: "button", class: "act", id: "reject", on: { click: () => setMode("reject") } },
          "Reject",
        ),
      ),
    );
  } else if (proposal.status === "approved") {
    label("Second key, turned", true);
    second.append(
      el(
        "p",
        {},
        proposal.decidedBy === "keyturn_rule"
          ? "A rule let this through; no person decided. "
          : written(`${proposal.decidedBy} approved this. `),
        proposal.expired ? "It expired before it was applied." : "The agent can apply it.",
      ),
    );
    if (!proposal.expired) {
      second.append(
        el(
          "div",
          { class: "acts" },
          el(
            "button",
            {
              type: "button",
              class: "act",
              id: "apply",
              disabled: state.busy,
              on: { click: applyNow },
            },
            "Apply it from here",
          ),
        ),
      );
    }
  } else if (proposal.status === "applied") {
    label("Second key, turned", true);
    second.append(
      el(
        "p",
        {},
        proposal.decidedBy === "keyturn_rule"
          ? "A rule let this through; no person decided. "
          : written(`${proposal.decidedBy} approved this. `),
        `Applied: ${many(proposal.outcome?.changes ?? total, "row")} written.`,
      ),
    );
  } else if (proposal.status === "rejected") {
    label("Second key, refused", false);
    second.append(
      el(
        "p",
        {},
        written(
          `${proposal.decidedBy} rejected this${proposal.reason ? `: ${proposal.reason}` : "."}`,
        ),
      ),
    );
  } else {
    label("Second key, turned", true);
    second.append(
      el(
        "p",
        {},
        written(
          `${proposal.decidedBy} approved this, and nothing was written: the proposal is ${proposal.status}.`,
        ),
      ),
    );
  }
  if (state.refused !== null) {
    second.append(
      el("p", { class: "refused", role: "alert" }, "Refused: ", written(state.refused)),
    );
  }
  keys.replaceChildren(first, second);
}

function setMode(mode) {
  state.mode = mode;
  state.refused = null;
  drawKeys();
  const focus = { approve: "confirm-approve", reject: "reason", idle: "approve" }[mode];
  document.getElementById(focus)?.focus();
}

async function act(path, body, done) {
  state.busy = true;
  state.refused = null;
  drawKeys();
  try {
    const data = await api(`proposals/${state.id}/${path}`, body);
    state.proposal = data.proposal;
    state.history = data.history;
    state.mode = "idle";
    said.textContent = done(data.proposal);
  } catch (problem) {
    state.refused = problem.message;
    said.textContent = `Refused: ${problem.message}`;
  } finally {
    state.busy = false;
  }
  drawSheet();
  drawKeys();
  await loadList().catch(() => {});
}

const approve = () => act("approve", { hash: state.readHash }, () => "Approved.");
const reject = (reason) => act("reject", { reason }, () => "Rejected.");
const applyNow = () =>
  act("apply", {}, (proposal) =>
    proposal.status === "applied"
      ? "Applied."
      : `Nothing was written: the proposal is ${proposal.status}.`,
  );

async function open(id) {
  state.id = id;
  state.proposal = null;
  state.rows = [];
  state.mode = "idle";
  state.refused = null;
  state.changedSince = false;
  state.unchanged = new Set();
  history.replaceState(null, "", `#${id}`);
  drawQueue();
  try {
    const [head, page] = await Promise.all([
      api(`proposals/${id}`),
      api(`proposals/${id}/rows?from=1`),
    ]);
    if (state.id !== id) {
      return;
    }
    state.proposal = head.proposal;
    state.extent = head.extent;
    state.history = head.history;
    state.rows = page.rows;
    state.readHash = head.proposal.contentHash;
  } catch (problem) {
    state.id = null;
    sheet.replaceChildren(el("p", { class: "none" }, problem.message));
    keys.hidden = true;
    return;
  }
  drawSheet();
  drawKeys();
  sheet.scrollTop = 0;
  sheet.focus({ preventScroll: true });
}

async function more() {
  const from = (state.rows.at(-1)?.seq ?? 0) + 1;
  const page = await api(`proposals/${state.id}/rows?from=${from}`);
  state.rows.push(...page.rows);
  const top = sheet.scrollTop;
  drawSheet();
  sheet.scrollTop = top;
  drawKeys();
}

/** Looks again at the list and at the open proposal, without disturbing someone who is reading or typing. */
async function refresh() {
  await loadList();
  if (state.id === null || state.proposal === null || state.busy) {
    return;
  }
  const id = state.id;
  const head = await api(`proposals/${id}`);
  if (state.id !== id || state.busy) {
    return;
  }
  const before = state.proposal;
  const moved = head.proposal.status !== before.status || head.proposal.expired !== before.expired;
  if (head.proposal.contentHash !== state.readHash && head.proposal.status === "pending") {
    const page = await api(`proposals/${id}/rows?from=1`);
    state.rows = page.rows;
    state.readHash = head.proposal.contentHash;
    state.changedSince = true;
    state.mode = "idle";
  } else if (!moved) {
    return;
  }
  state.proposal = head.proposal;
  state.extent = head.extent;
  state.history = head.history;
  if (moved) {
    state.mode = "idle";
  }
  const top = sheet.scrollTop;
  drawSheet();
  sheet.scrollTop = top;
  drawKeys();
}

async function start() {
  if (state.key === null) {
    sheet.replaceChildren(
      el(
        "p",
        { class: "none" },
        "Open the address that keyturn review printed in the terminal. It carries the key for this run, and this page shows nothing without it.",
      ),
    );
    return;
  }
  try {
    state.me = await api("me");
  } catch (problem) {
    sheet.replaceChildren(el("p", { class: "none" }, problem.message));
    return;
  }
  document
    .getElementById("who")
    .replaceChildren(
      written(`${state.me.login} on ${state.me.database}`),
      state.me.approver ? "" : " (cannot approve)",
    );
  document.title = `keyturn review: ${state.me.database}`;
  for (const view of ["waiting", "decided"]) {
    document.getElementById(`view-${view}`).addEventListener("click", async () => {
      state.view = view;
      await loadList();
    });
  }
  await loadList();
  const asked = location.hash.slice(1);
  if (uuid.test(asked)) {
    await open(asked);
  } else if (state.list.length > 0) {
    await open(state.list[0].id);
  } else {
    drawSheet();
  }
  setInterval(() => {
    if (!document.hidden) {
      refresh().catch(() => {});
    }
  }, 4000);
}

start();
