// A rendered markdown table back to text, for its Copy button: as a GFM table
// or as CSV. Read from the DOM, so it copies what the reader sees — with one
// exception: a file chip that reads as a base name copies the path it stood
// for (`data-file-text`), and inline code keeps its backticks in the GFM form.

/** A cell's text as markdown: inline code in backticks, a chip as the path
 *  written, links as `[text](href)`, on one line, pipes escaped. */
function cellMarkdown(cell: Element): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      parts.push(node.textContent ?? "");
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.classList.contains("atlas-file-chip")) {
      const written =
        node.getAttribute("data-file-text") ??
        node.querySelector(".atlas-mention-chip__label")?.textContent ??
        "";
      parts.push(`\`${written}\``);
      return;
    }
    if (node.tagName === "CODE") {
      parts.push(`\`${node.textContent ?? ""}\``);
      return;
    }
    if (node.tagName === "A") {
      const href = node.getAttribute("href");
      const text = node.textContent ?? "";
      parts.push(href && href !== text ? `[${text}](${href})` : text);
      return;
    }
    if (node.tagName === "BR") {
      parts.push(" ");
      return;
    }
    for (const child of node.childNodes) walk(child);
  };
  for (const child of cell.childNodes) walk(child);
  return parts.join("").replace(/\s+/g, " ").trim().replaceAll("|", "\\|");
}

/** A cell's text as the reader sees it, a chip as the path written. */
function cellText(cell: Element): string {
  const copy = cell.cloneNode(true) as Element;
  for (const chip of copy.querySelectorAll(".atlas-file-chip[data-file-text]")) {
    chip.replaceWith(chip.getAttribute("data-file-text") ?? "");
  }
  return copy.textContent ?? "";
}

function rowsOf(table: Element): Element[][] {
  return [...table.querySelectorAll(":scope > thead > tr, :scope > tbody > tr, :scope > tr")]
    .map((row) => [...row.children].filter((c) => c.tagName === "TH" || c.tagName === "TD"))
    .filter((cells) => cells.length > 0);
}

function separatorFor(cells: Element[]): string {
  const markers = cells.map((cell) => {
    const align = (cell as HTMLElement).style?.textAlign || cell.getAttribute("align") || "";
    if (align === "center") return ":---:";
    if (align === "right") return "---:";
    return "---";
  });
  return `| ${markers.join(" | ")} |`;
}

/** The table as a GFM table. */
export function tableToMarkdown(table: Element): string {
  const lines: string[] = [];
  rowsOf(table).forEach((cells, i) => {
    lines.push(`| ${cells.map(cellMarkdown).join(" | ")} |`);
    if (i === 0) lines.push(separatorFor(cells));
  });
  return lines.join("\n");
}

function csvCell(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return /[",\n]/.test(normalized) ? `"${normalized.replaceAll('"', '""')}"` : normalized;
}

/** The table as CSV. */
export function tableToCsv(table: Element): string {
  return rowsOf(table)
    .map((cells) => cells.map((cell) => csvCell(cellText(cell))).join(","))
    .join("\n");
}
