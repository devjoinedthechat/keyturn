import type { ColumnDiff, Extent, Finding, Proposal, RowDiff } from "./keyturn.ts";

/**
 * Text that came from an agent, made safe to print. A proposal's note and its values are
 * written by the party being reviewed. Left as they are, an escape sequence in one could
 * repaint the reviewer's screen, and a direction override could show a value back to front.
 * Each such character is printed as its code instead.
 */
export function plain(text: string): string {
  let result = "";
  for (const character of text) {
    const code = character.codePointAt(0) as number;
    result += hidden(code) ? `\\u{${code.toString(16)}}` : character;
  }
  return result;
}

/** Control characters but tab and line feed, and the characters that hide or reorder text. */
function hidden(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x09 && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0xfeff
  );
}

export interface Style {
  color: boolean;
  /** Show values whole, however long. */
  full: boolean;
  /** Show the columns an update leaves alone. */
  unchanged: boolean;
}

const codes = { dim: 2, bold: 1, red: 31, green: 32, yellow: 33 } as const;

function paint(style: Style, code: keyof typeof codes, text: string): string {
  const start = String.fromCharCode(27);
  return style.color ? `${start}[${codes[code]}m${text}${start}[0m` : text;
}

function value(style: Style, text: string | null, kind: ColumnDiff["beforeKind"]): string {
  if (kind === "absent") {
    return "(not given)";
  }
  if (kind === "null" || text === null) {
    return "null";
  }
  let shown = plain(kind === "string" ? JSON.stringify(text) : text).replace(/\n/g, "\\n");
  if (!style.full && shown.length > 300) {
    shown = `${shown.slice(0, 300)}… (${shown.length} characters, --full shows all)`;
  }
  return shown;
}

export function ago(from: Date, to: Date = new Date()): string {
  const seconds = Math.round(Math.abs(to.getTime() - from.getTime()) / 1000);
  const [amount, unit] =
    seconds < 90
      ? [seconds, "second"]
      : seconds < 5400
        ? [Math.round(seconds / 60), "minute"]
        : seconds < 129_600
          ? [Math.round(seconds / 3600), "hour"]
          : [Math.round(seconds / 86_400), "day"];
  return `${amount} ${unit}${amount === 1 ? "" : "s"}`;
}

export function standing(proposal: Proposal, now: Date = new Date()): string {
  if (proposal.expired) {
    return `${proposal.status}, expired ${ago(proposal.expiresAt, now)} ago`;
  }
  if (proposal.status === "pending" || proposal.status === "approved") {
    const by = proposal.decidedBy === null ? "" : ` by ${proposal.decidedBy}`;
    return `${proposal.status}${by}, expires in ${ago(proposal.expiresAt, now)}`;
  }
  const by = proposal.decidedBy === null ? "" : `, decided by ${proposal.decidedBy}`;
  return `${proposal.status}${by}`;
}

const count = (rows: number, operation: string) =>
  `${rows.toLocaleString("en")} ${operation}${rows === 1 ? "" : "s"}`;

export function renderProposal(
  proposal: Proposal,
  extent: Extent[],
  rows: RowDiff[],
  style: Style,
): string {
  const lines: string[] = [];
  const field = (name: string, text: string) =>
    lines.push(`${paint(style, "dim", name.padEnd(9))} ${text}`);

  field("proposal", `${paint(style, "bold", proposal.id)}  ${standing(proposal)}`);
  field("by", `${plain(proposal.proposedBy)}, ${ago(proposal.proposedAt)} ago`);
  if (proposal.note !== "") {
    field("note", plain(proposal.note).replace(/\n/g, "\n          "));
  }
  if (proposal.reason !== null) {
    field("reason", plain(proposal.reason).replace(/\n/g, "\n          "));
  }
  if (proposal.outcome?.reason !== undefined) {
    field("outcome", plain(proposal.outcome.reason));
  }
  field("hash", proposal.contentHash);
  lines.push("");

  const width = Math.max(...extent.map((part) => part.table.length), 0);
  for (const part of extent) {
    const text = count(part.rows, part.operation);
    lines.push(
      `  ${plain(part.table).padEnd(width)}  ${part.operation === "delete" ? paint(style, "red", text) : text}`,
    );
  }
  lines.push("");

  for (const row of rows) {
    const key = Object.entries(row.key)
      .map(([name, part]) => `${plain(name)} = ${plain(JSON.stringify(part))}`)
      .join(", ");
    lines.push(
      `${paint(style, "dim", `#${row.seq}`)} ${paint(style, "bold", row.operation)} ${plain(row.table)}  ${key}`,
    );
    const shown = row.columns.filter(
      (column) => row.operation !== "update" || column.changed || style.unchanged,
    );
    const name = Math.max(...shown.map((column) => column.column.length), 0);
    for (const column of shown) {
      const label = plain(column.column).padEnd(name);
      if (row.operation === "insert") {
        lines.push(
          paint(style, "green", `   + ${label}  ${value(style, column.after, column.afterKind)}`),
        );
      } else if (row.operation === "delete") {
        lines.push(
          paint(style, "red", `   - ${label}  ${value(style, column.before, column.beforeKind)}`),
        );
      } else if (column.changed) {
        lines.push(
          `     ${label}  ${paint(style, "red", value(style, column.before, column.beforeKind))}  ->  ${paint(style, "green", value(style, column.after, column.afterKind))}`,
        );
      } else {
        lines.push(
          paint(style, "dim", `     ${label}  ${value(style, column.before, column.beforeKind)}`),
        );
      }
    }
    const hidden = row.columns.length - shown.length;
    if (hidden > 0) {
      lines.push(
        paint(style, "dim", `     (${hidden} other column${hidden === 1 ? "" : "s"} unchanged)`),
      );
    }
  }

  const last = rows.at(-1)?.seq ?? 0;
  if (rows.length > 0 && last < proposal.changes) {
    lines.push("");
    lines.push(
      paint(
        style,
        "yellow",
        `Rows ${rows[0]?.seq} to ${last} of ${proposal.changes.toLocaleString("en")} are shown. --from ${last + 1} shows the next, --rows sets how many.`,
      ),
    );
  }
  return lines.join("\n");
}

export function renderList(proposals: Proposal[], style: Style): string {
  if (proposals.length === 0) {
    return "No proposals.";
  }
  const cells = proposals.map((proposal) => [
    proposal.id.slice(0, 8),
    proposal.expired ? "expired" : proposal.status,
    plain(proposal.proposedBy),
    `${ago(proposal.proposedAt)} ago`,
    count(proposal.changes, "row"),
    plain(proposal.note).replace(/\s+/g, " ").slice(0, 60),
  ]);
  const heads = ["proposal", "state", "by", "made", "size", "note"];
  const widths = heads.map((head, index) =>
    Math.max(head.length, ...cells.map((row) => (row[index] as string).length)),
  );
  const line = (row: string[]) =>
    row
      .map((cell, index) => cell.padEnd(widths[index] as number))
      .join("  ")
      .trimEnd();
  return [paint(style, "dim", line(heads)), ...cells.map(line)].join("\n");
}

export function renderFindings(findings: Finding[], style: Style): string {
  if (findings.length === 0) {
    return "Nothing wrong: an agent has no way to change a protected table but a proposal.";
  }
  const lines: string[] = [];
  for (const finding of findings) {
    const level =
      finding.level === "fail" ? paint(style, "red", "fail") : paint(style, "dim", "note");
    lines.push(`${level}  ${plain(finding.about)} ${plain(finding.finding)}`);
    if (finding.fix !== null) {
      lines.push(`      ${paint(style, "dim", "fix:")} ${plain(finding.fix)}`);
    }
  }
  const failures = findings.filter((finding) => finding.level === "fail").length;
  lines.push("");
  lines.push(
    failures === 0
      ? "Nothing fails. The notes are things to know, not faults."
      : `${failures} thing${failures === 1 ? "" : "s"} to fix before the guarantee holds here.`,
  );
  return lines.join("\n");
}
