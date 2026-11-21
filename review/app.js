// The review page. Everything an agent wrote reaches the screen through textContent: a
// note or a value is text here, whatever it contains.

import { hidden } from "/hidden.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const state = {
  key: takeKey(),
  me: null,
  view: "waiting",
  list: [],
  more: false,
  id: null,
  proposal: null,
  extent: [],
  history: [],
  // Why the open proposal has come to a person, for an approver.
  waits: [],
  rows: [],
  // The rows that the rows on the page point to through foreign keys, as they were when read.
  references: [],
  // The hash of the content whose rows are on the screen. An approval sends this one. Null
  // when the content changed after it was read: there is then nothing on the screen to approve.
  readHash: null,
  mode: "idle",
  refused: null,
  busy: false,
  loading: false,
  unchanged: new Set(),
  // When the confirming button may first be pressed.
  armedAt: 0,
};

const queue = document.getElementById("queue");
const sheet = document.getElementById("sheet");
const keys = document.getElementById("keys");
const said = document.getElementById("said");
const lost = document.getElementById("lost");

/** The key for this run comes in the address, once. It is kept for the tab and taken out of the address bar. */
function takeKey() {
  const given = location.hash.slice(1);
  const fits = /^[A-Za-z0-9_-]{24,}$/.test(given) && !uuid.test(given);
  let key = null;
  try {
    if (fits) {
      sessionStorage.setItem("keyturn-key", given);
      history.replaceState(null, "", location.pathname);
    }
    key = sessionStorage.getItem("keyturn-key");
  } catch {
    key = fits ? given : null;
  }
  return key;
}

async function api(path, body) {
  let response;
  try {
    response = await fetch(`/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${state.key}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    contact(
      "This page has lost contact with keyturn review. What is shown may be out of date. Check that it is still running in the terminal.",
    );
    throw new Error("No contact with keyturn review.");
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    contact(
      "keyturn review was started again, and this page belongs to the earlier run. Open the address the terminal printed.",
    );
  } else if (response.status >= 500) {
    contact("keyturn review cannot reach the database. What is shown may be out of date.");
  } else {
    contact(null);
  }
  if (!response.ok) {
    const problem = new Error(data.error ?? "The review page did not answer.");
    problem.status = response.status;
    throw problem;
  }
  return data;
}

/** Says, across the top, that what is on the page can no longer be trusted to be current. */
function contact(message) {
  lost.hidden = message === null;
  lost.textContent = message ?? "";
  if (message !== null) {
    // Nothing is approved from a page that cannot say what is current.
    state.mode = "idle";
    drawKeys();
  }
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

const chip = (text, title) => el("span", { class: "code", title }, text);

/** Text an agent wrote, with nothing in it left unseen. */
function written(text) {
  const parts = document.createDocumentFragment();
  let run = "";
  for (const character of text) {
    if (hidden(character)) {
      const code = character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
      parts.append(run, chip(`U+${code}`, "A character that does not show"));
      run = "";
    } else {
      run += character;
    }
  }
  parts.append(run);
  return parts;
}

/**
 * A value's text, with the white space a reader cannot otherwise see: spaces and tabs at
 * either end, and every line break. "a" and "a " are different values, and look the same.
 */
function exact(text) {
  const parts = document.createDocumentFragment();
  const lead = /^[ \t]+/.exec(text)?.[0] ?? "";
  const rest = text.slice(lead.length);
  const trail = rest === "" ? "" : (/[ \t]+$/.exec(rest)?.[0] ?? "");
  const middle = rest.slice(0, rest.length - trail.length);
  const blanks = (run) => {
    for (const character of run) {
      parts.append(
        chip(character === "\t" ? "tab" : "space", "White space at the end of the value"),
      );
    }
  };
  blanks(lead);
  middle.split("\n").forEach((line, index, lines) => {
    // Spaces before a line break are as invisible as spaces at the end.
    const tail = index < lines.length - 1 ? (/[ \t]+$/.exec(line)?.[0] ?? "") : "";
    parts.append(written(line.slice(0, line.length - tail.length)));
    blanks(tail);
    if (index < lines.length - 1) {
      parts.append(chip("line break", "A line break in the value"), "\n");
    }
  });
  blanks(trail);
  return parts;
}

const clamp = 600;

/** One value, as the database wrote it. `other` is the kind on the other side of a change. */
function value(text, kind, other) {
  if (kind === "absent") {
    return el("span", { class: "chip" }, "not given");
  }
  if (kind === "null" || text === null) {
    return el("span", { class: "chip" }, "null");
  }
  const holder = el("span", {});
  // The text 100 and the number 100 are written alike. Where a change turns one into the other, each says which it is.
  if (other !== undefined && other !== kind && other !== "absent" && other !== "null") {
    holder.append(el("span", { class: "chip" }, `${kind === "string" ? "text" : kind} `));
  }
  if (text === "") {
    holder.append(el("span", { class: "chip" }, "empty text"));
  } else if (text.length <= clamp) {
    holder.append(exact(text));
  } else {
    const short = el("span", {}, exact(text.slice(0, clamp)), "… ");
    short.append(
      el(
        "button",
        { type: "button", class: "link", on: { click: () => short.replaceChildren(exact(text)) } },
        `show all ${text.length.toLocaleString("en")} characters`,
      ),
    );
    holder.append(short);
  }
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

/** A time as "5 minutes ago" or "in 23 hours", with the exact time for whoever points at it. */
function when(moment, future) {
  const text = future ? `in ${ago(moment)}` : `${ago(moment)} ago`;
  return el(
    "time",
    { datetime: new Date(moment).toISOString(), title: new Date(moment).toLocaleString() },
    text,
  );
}

const many = (count, word) => `${count.toLocaleString("en")} ${word}${count === 1 ? "" : "s"}`;
const standing = (proposal) => (proposal.expired ? "expired" : proposal.status);
/** A proposal's state in the list, in the words a reader would use. */
const stateWords = {
  pending: "waiting",
  approved: "to apply",
  applied: "applied",
  rejected: "rejected",
  reverted: "taken back",
  stale: "stale",
  failed: "failed",
  expired: "expired",
};

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
  const items = state.list.map((proposal) => {
    const parts = el("span", { class: "parts" });
    proposal.extent.forEach((part, index) => {
      if (index > 0) {
        parts.append(", ");
      }
      parts.append(
        el(
          "span",
          { class: part.operation === "delete" ? "gone" : "" },
          `${many(part.rows, part.operation)} in `,
          written(part.table),
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
      el(
        "span",
        { class: "head" },
        el("span", { class: "size" }, many(proposal.changes, "row")),
        state.view === "decided" || proposal.expired
          ? el("span", { class: `state ${standing(proposal)}` }, stateWords[standing(proposal)])
          : null,
      ),
      parts,
      el(
        "span",
        { class: "from" },
        written(proposal.proposedBy),
        ", ",
        when(proposal.proposedAt, false),
      ),
      proposal.note === ""
        ? null
        : el("span", { class: "words" }, written(proposal.note.replace(/\s+/g, " "))),
    );
  });
  if (state.more) {
    items.push(
      el(
        "p",
        { class: "none" },
        "Only the first 200 are listed. The rest appear as these are decided.",
      ),
    );
  }
  // How to get about without the mouse, said once, where the eye ends up.
  if (state.list.length > 1) {
    items.push(
      el("p", { class: "hint" }, el("kbd", {}, "j"), " ", el("kbd", {}, "k"), " next and previous"),
    );
  }
  queue.replaceChildren(...items);
  const waiting = state.view === "waiting" ? state.list.length : null;
  if (state.me !== null && waiting !== null) {
    document.title = `${waiting > 0 ? `(${waiting}) ` : ""}keyturn review: ${state.me.database}`;
  }
}

/** The proposal after the open one in the list, or before it; the first when the open one is not listed. */
function neighbour(step) {
  if (state.list.length === 0) {
    return null;
  }
  const at = state.list.findIndex((proposal) => proposal.id === state.id);
  if (at === -1) {
    return state.list[0].id;
  }
  return state.list[at + step]?.id ?? null;
}

async function loadList() {
  const view = state.view;
  const data = await api(`proposals?show=${view}`);
  if (state.view !== view) {
    return;
  }
  state.list = data.proposals;
  state.more = data.more;
  if (view === "waiting") {
    document.getElementById("count-waiting").textContent =
      `${state.list.length}${state.more ? "+" : ""}`;
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
  const open_ = proposal.status === "pending" || proposal.status === "approved";
  parts.push(
    el(
      "p",
      { class: "said-by" },
      written(proposal.proposedBy),
      " proposed this ",
      when(proposal.proposedAt, false),
      ". ",
      ...(open_
        ? [
            proposal.expired ? "It expired " : "It expires ",
            when(proposal.expiresAt, !proposal.expired),
            ".",
          ]
        : []),
    ),
  );

  if (proposal.status === "reverted") {
    parts.push(
      el(
        "p",
        { class: "banner taken-back" },
        "This change was applied and has been taken back: every row is as it was before.",
        proposal.outcome?.reason ? " " : null,
        proposal.outcome?.reason ? written(proposal.outcome.reason) : null,
      ),
    );
  } else if (proposal.outcome?.reason) {
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
          el("span", { class: "what" }, "in ", written(part.table)),
        ),
      ),
    ),
  );

  if (state.waits.length > 0) {
    parts.push(
      el(
        "div",
        { class: "waits" },
        el("p", { class: "waits-head" }, "Why this has come to a person"),
        el(
          "ul",
          {},
          ...state.waits.map((wait) =>
            el(
              "li",
              {},
              wait.seq === null ? null : el("span", { class: "seq" }, `#${wait.seq}`),
              wait.seq === null ? null : " ",
              ...(wait.rule === null ? [] : ["the rule ", el("b", {}, written(wait.rule)), " "]),
              written(wait.because),
            ),
          ),
        ),
      ),
    );
  }

  // One entry says only that it was proposed, which the line above already says.
  if (state.history.length > 1) {
    parts.push(
      el(
        "ol",
        { class: "steps", "aria-label": "What has happened to this proposal" },
        ...state.history.map((step) =>
          el(
            "li",
            {},
            el(
              "b",
              {},
              { approved_by_rule: "let through by a rule", reverted: "taken back" }[step.event] ??
                step.event,
            ),
            " by ",
            written(
              step.event === "approved_by_rule"
                ? Object.keys(step.detail.rules ?? {}).join(", ")
                : step.actor,
            ),
            ", ",
            when(step.at, false),
          ),
        ),
      ),
    );
  }

  parts.push(...drawRows());

  const last = state.rows.at(-1)?.seq ?? 0;
  const left = proposal.changes - last;
  if (left > 0) {
    parts.push(
      el(
        "p",
        { class: "more" },
        `${last.toLocaleString("en")} of ${many(proposal.changes, "row")} are on the page.`,
        el(
          "button",
          {
            type: "button",
            class: "link",
            disabled: state.loading,
            on: { click: () => more(100) },
          },
          `Show the next ${Math.min(100, left).toLocaleString("en")}`,
        ),
        left > 100
          ? el(
              "button",
              {
                type: "button",
                class: "link",
                disabled: state.loading,
                on: { click: () => more(1000) },
              },
              `Show the next ${Math.min(1000, left).toLocaleString("en")}`,
            )
          : null,
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
      parts.push(el("h2", { class: "table-name" }, el("b", {}, written(table))));
    }
    if (row.operation === "update") {
      parts.push(drawUpdate(row), ...drawPointsTo([row.seq]));
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
    parts.push(
      drawGrid(state.rows.slice(index, end), row.operation),
      ...drawPointsTo(state.rows.slice(index, end).map((each) => each.seq)),
    );
    index = end;
  }
  return parts;
}

/**
 * The rows that some changes point to through foreign keys: one table for each table
 * pointed to, and one line for each row of it, with the changes that point there.
 *
 * These are read when the page asks, with the reviewer's own rights. They are no part of
 * what an approval names, and the page says so beside each.
 */
function drawPointsTo(seqs) {
  const wanted = new Set(seqs);
  const tables = new Map();
  for (const reference of state.references) {
    if (!wanted.has(reference.seq)) {
      continue;
    }
    const lines = tables.get(reference.table) ?? new Map();
    tables.set(reference.table, lines);
    const id = JSON.stringify([reference.via, reference.key]);
    const line = lines.get(id) ?? { reference, seqs: [] };
    lines.set(id, line);
    line.seqs.push(reference.seq);
  }
  return [...tables].map(([table, lines]) => {
    const columns = [];
    for (const { reference } of lines.values()) {
      for (const column of reference.columns) {
        if (!columns.includes(column.column)) {
          columns.push(column.column);
        }
      }
    }
    return el(
      "section",
      { class: "points-to" },
      el(
        "p",
        { class: "points-head" },
        "Points to ",
        el("b", {}, written(table)),
        " ",
        el(
          "span",
          {
            class: "chip",
            title:
              "Read when this page asked, with your own rights. It may be different a moment later, and an approval does not cover it.",
          },
          "as it is now, and no part of what is approved",
        ),
      ),
      el(
        "div",
        {
          class: "scroll",
          tabindex: "0",
          role: "group",
          "aria-label": `${many(lines.size, "row")} pointed to`,
        },
        el(
          "table",
          { class: "grid context" },
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              el("th", { class: "seq", scope: "col" }, "#"),
              el("th", { scope: "col" }, "pointed to by"),
              ...columns.map((name) => el("th", { scope: "col" }, written(name))),
            ),
          ),
          el(
            "tbody",
            {},
            ...[...lines.values()].map(({ reference, seqs: from }) =>
              el(
                "tr",
                { class: reference.state === "shown" ? "" : "absent-row" },
                el("td", { class: "seq" }, from.join(", ")),
                el("td", {}, keyParts(reference.key)),
                ...(reference.state === "shown"
                  ? columns.map((name) => {
                      const column = reference.columns.find(
                        (candidate) => candidate.column === name,
                      );
                      return el(
                        "td",
                        {},
                        column === undefined
                          ? value(null, "absent")
                          : value(column.value, column.kind),
                      );
                    })
                  : [
                      el(
                        "td",
                        { colspan: String(Math.max(columns.length, 1)) },
                        reference.state === "missing"
                          ? "There is no such row."
                          : "This login may not read that table.",
                      ),
                    ]),
              ),
            ),
          ),
        ),
      ),
    );
  });
}

/** A row's key, each part apart from the next, so that a comma inside a value is not read as the end of it. */
function keyParts(key) {
  const parts = document.createDocumentFragment();
  Object.entries(key).forEach(([name, part], index) => {
    if (index > 0) {
      parts.append(el("span", { class: "chip" }, " and "));
    }
    parts.append(
      el("span", { class: "key-name" }, written(name)),
      " ",
      part === null ? el("span", { class: "chip" }, "null") : exact(part),
    );
  });
  return parts;
}

function drawUpdate(row) {
  const open_ = state.unchanged.has(row.seq);
  const same = row.columns.filter((column) => !column.changed);
  const body = el("tbody");
  for (const column of row.columns) {
    if (column.changed) {
      body.append(
        el(
          "tr",
          {},
          el("th", { scope: "row" }, written(column.column)),
          el("td", { class: "was" }, value(column.before, column.beforeKind, column.afterKind)),
          el("td", { class: "arrow", "aria-label": "becomes" }, "→"),
          el("td", { class: "now" }, value(column.after, column.afterKind, column.beforeKind)),
        ),
      );
    } else if (open_) {
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
      keyParts(row.key),
    ),
    el("div", { class: "scroll" }, el("table", { class: "pairs" }, body)),
    same.length === 0
      ? null
      : el(
          "button",
          {
            type: "button",
            class: "link",
            "aria-expanded": String(open_),
            on: {
              click: () => {
                if (open_) {
                  state.unchanged.delete(row.seq);
                } else {
                  state.unchanged.add(row.seq);
                }
                const top = sheet.scrollTop;
                drawSheet();
                sheet.scrollTop = top;
              },
            },
          },
          open_
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
    {
      class: "scroll",
      tabindex: "0",
      role: "group",
      "aria-label": `${many(rows.length, "row")} to ${operation}`,
    },
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
  const decider =
    proposal.decidedBy === "keyturn_rule" ? "A rule let this through; no person decided. " : null;

  if (proposal.status === "pending" && proposal.expired) {
    label("Second key, never turned", false);
    second.append(el("p", {}, "Nobody decided before it expired. Nothing was written."));
  } else if (proposal.status === "pending" && !lost.hidden) {
    label("Second key", false);
    second.append(
      el("p", {}, "Nothing can be decided from this page until it is in contact again."),
    );
  } else if (proposal.status === "pending" && !state.me.approver) {
    label("Second key", false);
    second.append(
      el(
        "p",
        {},
        written(state.me.login),
        " cannot approve. Start the page as a login in keyturn_approver.",
      ),
    );
  } else if (proposal.status === "pending" && proposal.proposedBy === state.me.login) {
    label("Second key", false);
    second.append(el("p", {}, "You proposed this. Someone else has to approve it."));
  } else if (proposal.status === "pending" && state.readHash === null) {
    label("Second key", false);
    second.append(
      el(
        "p",
        { class: "refused" },
        "This proposal changed after you opened it. What you read is not what would be approved.",
      ),
      el(
        "div",
        { class: "acts" },
        el(
          "button",
          { type: "button", class: "act", id: "reread", on: { click: () => open(proposal.id) } },
          "Read it again",
        ),
      ),
    );
  } else if (proposal.status === "pending" && state.mode === "approve") {
    label("Second key", false);
    const unseen = seen < total;
    const count = unseen
      ? el("input", {
          id: "count",
          type: "text",
          inputmode: "numeric",
          autocomplete: "off",
          "aria-label": `Type ${total} to approve all ${total} changes`,
        })
      : null;
    const confirm = el(
      "button",
      {
        type: "button",
        class: "act turn",
        id: "confirm-approve",
        disabled: true,
        on: { click: approve },
      },
      total === 1 ? "Approve" : `Approve all ${total.toLocaleString("en")}`,
    );
    // The confirming button cannot be pressed in the first moment: a second click meant for
    // the button that was here before must not land on it. Rows nobody has put on the page
    // are approved by typing their number.
    const settle = () => {
      const typed = count === null || count.value.replace(/[\s,.]/g, "") === String(total);
      confirm.disabled = state.busy || Date.now() < state.armedAt || !typed;
    };
    count?.addEventListener("input", settle);
    setTimeout(settle, Math.max(0, state.armedAt - Date.now()) + 20);
    second.append(
      el(
        "p",
        { class: "ask" },
        unseen
          ? `${many(seen, "row")} of ${total.toLocaleString("en")} are on the page. Approving covers all ${total.toLocaleString("en")}. To approve rows you have not read, type their number: `
          : `Approve ${total === 1 ? "this change" : `these ${total.toLocaleString("en")} changes`} as `,
        unseen ? count : written(state.me.login),
        unseen ? "" : "?",
      ),
      el(
        "div",
        { class: "acts" },
        el(
          "button",
          {
            type: "button",
            class: "act",
            id: "not-yet",
            on: {
              // The second click of a double click lands here, where the first button was. It is not a decision to go back.
              click: (event) => {
                if (event.detail < 2) {
                  setMode("idle");
                }
              },
            },
          },
          "Not yet",
        ),
        confirm,
      ),
    );
  } else if (proposal.status === "pending" && state.mode === "reject") {
    label("Second key", false);
    const reason = el("textarea", {
      id: "reason",
      maxlength: "2000",
      placeholder: "Why. The agent reads this, and it stays on record.",
      "aria-label": "Why it is rejected, for the record and the agent",
    });
    second.append(
      reason,
      el(
        "div",
        { class: "acts" },
        el(
          "button",
          { type: "button", class: "act", on: { click: () => setMode("idle") } },
          "Not yet",
        ),
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
        decider ?? written(`${proposal.decidedBy} approved this. `),
        proposal.expired ? "It expired before it was applied." : "The agent can apply it.",
      ),
    );
    if (!proposal.expired && lost.hidden) {
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
        decider ?? written(`${proposal.decidedBy} approved this. `),
        `Applied: ${many(proposal.outcome?.changes ?? total, "row")} written.`,
      ),
    );
    // Taking it back is a person's act, as approving was.
    if (state.me.approver && lost.hidden && state.mode === "revert") {
      const why = el("textarea", {
        id: "revert-reason",
        maxlength: "2000",
        placeholder: "Why it is taken back. It stays on record.",
        "aria-label": "Why it is taken back, for the record",
      });
      second.append(
        el(
          "p",
          {},
          `Every row is put as it was before the change. If one of them has been written to since, nothing is taken back.`,
        ),
        why,
        el(
          "div",
          { class: "acts" },
          el(
            "button",
            { type: "button", class: "act", on: { click: () => setMode("idle") } },
            "Not yet",
          ),
          el(
            "button",
            {
              type: "button",
              class: "act",
              id: "confirm-revert",
              disabled: state.busy,
              on: { click: () => revertNow(why.value) },
            },
            `Take ${many(total, "change")} back`,
          ),
        ),
      );
    } else if (state.me.approver && lost.hidden) {
      second.append(
        el(
          "div",
          { class: "acts" },
          el(
            "button",
            { type: "button", class: "act", id: "revert", on: { click: () => setMode("revert") } },
            "Take this back",
          ),
        ),
      );
    }
  } else if (proposal.status === "reverted") {
    label("Second key, turned, and taken back", true);
    second.append(
      el(
        "p",
        {},
        decider ?? written(`${proposal.decidedBy} approved this. `),
        "It was applied, and has been taken back.",
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
        decider ?? written(`${proposal.decidedBy} approved this. `),
        `Nothing was written: the proposal is ${proposal.status}.`,
      ),
    );
  }
  if (state.refused !== null) {
    second.append(
      el("p", { class: "refused", role: "alert" }, "Refused: ", written(state.refused)),
    );
  }
  // Once this one is decided, the way on to the next is here, where the hand already is.
  const onward = state.view === "waiting" && proposal.status !== "pending" ? neighbour(1) : null;
  if (onward !== null && state.mode === "idle") {
    const next = el(
      "button",
      { type: "button", class: "act", id: "next", on: { click: () => open(onward) } },
      state.list.length === 1 ? "The one still waiting" : `Next of ${state.list.length} waiting`,
    );
    // Beside what is already offered here, not on a line of its own.
    const acts = second.querySelector(".acts");
    if (acts === null) {
      second.append(el("div", { class: "acts" }, next));
    } else {
      acts.append(next);
    }
  }
  keys.replaceChildren(first, second);
}

function setMode(mode) {
  state.mode = mode;
  state.refused = null;
  state.armedAt = Date.now() + 700;
  drawKeys();
  const focus = {
    approve: state.rows.length < (state.proposal?.changes ?? 0) ? "count" : "not-yet",
    reject: "reason",
    revert: "revert-reason",
    idle: state.proposal?.status === "applied" ? "revert" : "approve",
  }[mode];
  document.getElementById(focus)?.focus();
}

/** Decides or applies the open proposal. An answer that comes back after another was opened is not painted over it. */
async function act(path, body, done) {
  const id = state.id;
  state.busy = true;
  state.refused = null;
  drawKeys();
  let data = null;
  let refusal = null;
  try {
    data = await api(`proposals/${id}/${path}`, body);
  } catch (problem) {
    refusal = problem.message;
  }
  state.busy = false;
  if (state.id === id) {
    if (data !== null) {
      state.proposal = data.proposal;
      state.history = data.history;
      state.mode = "idle";
      said.textContent = done(data.proposal);
    } else {
      state.refused = refusal;
      state.mode = "idle";
      said.textContent = `Refused: ${refusal}`;
    }
    drawSheet();
    drawKeys();
  }
  await loadList().catch(() => {});
  // The list now says what else is waiting, which the bar offers to go on to.
  if (state.id === id) {
    drawKeys();
  }
}

const approve = () => act("approve", { hash: state.readHash }, () => "Approved.");
const reject = (reason) => act("reject", { reason }, () => "Rejected.");
const revertNow = (reason) =>
  act("revert", { reason }, (proposal) =>
    proposal.status === "reverted" ? "Taken back." : `It is still ${proposal.status}.`,
  );
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
  state.references = [];
  state.waits = [];
  state.readHash = null;
  state.mode = "idle";
  state.refused = null;
  state.loading = false;
  state.unchanged = new Set();
  history.replaceState(null, "", `#${id}`);
  drawQueue();
  // The proposal that was open leaves the page at once. Its rows and its buttons must not
  // stay on screen, under another proposal's name in the list, while the next one is read.
  sheet.replaceChildren(el("p", { class: "none" }, "Reading the proposal…"));
  keys.hidden = true;
  keys.replaceChildren();
  try {
    const page = await api(`proposals/${id}/rows?from=1`);
    const head = await api(`proposals/${id}`);
    if (state.id !== id) {
      return;
    }
    state.proposal = head.proposal;
    state.extent = head.extent;
    state.history = head.history;
    state.waits = head.waits ?? [];
    state.rows = page.rows;
    state.references = page.references ?? [];
    // The rows came with the hash of the content they belong to. If the proposal has another by now, nothing here is approvable.
    state.readHash = page.contentHash === head.proposal.contentHash ? page.contentHash : null;
  } catch (problem) {
    if (state.id !== id) {
      return;
    }
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

async function more(count) {
  const id = state.id;
  const from = (state.rows.at(-1)?.seq ?? 0) + 1;
  state.loading = true;
  let page = null;
  try {
    page = await api(`proposals/${id}/rows?from=${from}&count=${count}`);
  } catch (problem) {
    said.textContent = problem.message;
  }
  // Rows asked for one proposal are never added to another that was opened meanwhile.
  if (state.id !== id) {
    return;
  }
  state.loading = false;
  if (page !== null) {
    if (page.contentHash !== state.readHash) {
      state.readHash = null;
    } else {
      state.rows.push(...page.rows);
      state.references.push(...(page.references ?? []));
    }
  }
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
  const changed =
    state.readHash !== null &&
    head.proposal.status === "pending" &&
    head.proposal.contentHash !== state.readHash;
  if (!moved && !changed) {
    return;
  }
  if (changed) {
    state.readHash = null;
  }
  state.proposal = head.proposal;
  state.extent = head.extent;
  state.history = head.history;
  state.waits = head.waits ?? [];
  state.mode = "idle";
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
    document.getElementById(`view-${view}`).addEventListener("click", () => {
      state.view = view;
      drawQueue();
      // What the bar offers depends on which list is open.
      if (state.proposal !== null) {
        drawKeys();
      }
      loadList().catch(() => {});
    });
  }
  // A proposal's address, pasted or followed while the page is open, opens that proposal.
  // This listens before the first read: an address that arrives while the page is still
  // starting must not lose to whichever proposal happens to be first in the queue.
  window.addEventListener("hashchange", () => {
    const wanted = location.hash.slice(1);
    if (uuid.test(wanted) && wanted !== state.id) {
      open(wanted);
    }
  });
  await loadList().catch(() => {});
  const asked = location.hash.slice(1);
  if (uuid.test(asked)) {
    if (asked !== state.id) {
      await open(asked);
    }
  } else if (state.id === null && state.list.length > 0) {
    await open(state.list[0].id);
  } else if (state.id === null) {
    drawSheet();
  }
  // One look at a time: the next is not started until the last has come back.
  const again = async () => {
    if (!document.hidden) {
      await refresh().catch(() => {});
    }
    setTimeout(again, 4000);
  };
  setTimeout(again, 4000);
}

// Moving through the list from the keyboard. Nothing is decided by a single key.
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }
  if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select")) {
    return;
  }
  if (state.mode !== "idle" || state.busy) {
    return;
  }
  const step = { j: 1, k: -1 }[event.key];
  if (step === undefined) {
    return;
  }
  const id = neighbour(step);
  if (id !== null) {
    event.preventDefault();
    open(id);
  }
});

start();
