//! The one output contract every `atlas_code` tool answers in
//! (docs/research/codeindex-search/02-cmm-graph-incremental-tools.md §6):
//! a `name: N  (cols: a b c)` header with the count first, two-space-indented
//! rows best-first, then honest paging — and never more than the byte budget.
//! Whole rows are dropped from the end to fit; a row is never cut mid-cell.

/// One block of rows. `rows` are best-first; each has one cell per column.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Table {
    pub name: String,
    pub cols: Vec<&'static str>,
    pub rows: Vec<Vec<String>>,
}

/// Where this reply sits in the whole answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Page {
    pub total: usize,
    /// False when the search stopped early, so `total` is a lower bound.
    pub total_exact: bool,
    pub offset: usize,
    pub next_offset: Option<usize>,
    /// "page_limit" | "output_budget" | "deadline"
    pub truncation: Option<&'static str>,
}

/// Renders `name: N  (cols: a b c)` + 2-space-indented rows, then the page
/// footer; drops whole trailing rows until it fits `budget_bytes`, setting
/// truncation="output_budget" and `next_offset` to the first dropped row.
pub fn render(tables: &[Table], page: &Page, budget_bytes: usize) -> String {
    let all: usize = tables.iter().map(|t| t.rows.len()).sum();
    let full = assemble(tables, all, page);
    if full.len() <= budget_bytes || all == 0 {
        return full;
    }
    let cut = |kept: usize| Page {
        truncation: Some("output_budget"),
        next_offset: Some(page.offset + kept),
        ..*page
    };
    // The longest prefix of rows that fits; lengths grow with the prefix.
    let (mut lo, mut hi) = (0usize, all - 1);
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        if assemble(tables, mid, &cut(mid)).len() <= budget_bytes {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    assemble(tables, lo, &cut(lo))
}

/// The paging lines alone: `total`, then `next_offset` and `truncation` when set.
pub fn render_footer(page: &Page) -> String {
    let mut out = if page.total_exact {
        format!("total: {}\n", page.total)
    } else {
        format!("total: >={}\n", page.total)
    };
    if let Some(next) = page.next_offset {
        out.push_str(&format!("next_offset: {next}\n"));
    }
    if let Some(reason) = page.truncation {
        out.push_str(&format!("truncation: {reason}\n"));
    }
    out
}

/// A cell as written: bare when it is one plain token, otherwise quoted.
pub fn cell(value: &str) -> String {
    let plain = !value.is_empty()
        && !value
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '"' | ','));
    if plain {
        value.to_string()
    } else {
        format!("{value:?}")
    }
}

/// The first `kept` rows across `tables`, in order, then the footer.
fn assemble(tables: &[Table], kept: usize, page: &Page) -> String {
    let mut out = String::new();
    let mut left = kept;
    for table in tables {
        let n = table.rows.len().min(left);
        left -= n;
        out.push_str(&format!(
            "{}: {n}  (cols: {})\n",
            table.name,
            table.cols.join(" ")
        ));
        for row in &table.rows[..n] {
            let cells: Vec<String> = row.iter().map(|c| cell(c)).collect();
            out.push_str("  ");
            out.push_str(&cells.join(" "));
            out.push('\n');
        }
    }
    out.push_str(&render_footer(page));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(rows: usize) -> Table {
        Table {
            name: "files".into(),
            cols: vec!["path"],
            rows: (0..rows)
                .map(|i| vec![format!("src/file_{i:04}.rs")])
                .collect(),
        }
    }

    fn page(total: usize) -> Page {
        Page {
            total,
            total_exact: true,
            offset: 0,
            next_offset: None,
            truncation: None,
        }
    }

    #[test]
    fn the_count_comes_first_and_rows_are_indented() {
        assert_eq!(
            render(&[table(2)], &page(2), 1024),
            "files: 2  (cols: path)\n  src/file_0000.rs\n  src/file_0001.rs\ntotal: 2\n"
        );
    }

    #[test]
    fn rows_are_dropped_whole_to_fit_the_budget_and_paging_says_where_to_resume() {
        let text = render(&[table(500)], &page(500), 2048);
        assert!(text.len() <= 2048, "{} bytes", text.len());
        let kept = text.lines().filter(|l| l.starts_with("  src/")).count();
        assert!(kept > 10 && kept < 500);
        assert!(text.contains(&format!("files: {kept}  (cols: path)")));
        assert!(text.contains(&format!("next_offset: {kept}")));
        assert!(text.ends_with("truncation: output_budget\n"));
        assert!(text
            .lines()
            .all(|l| !l.starts_with("  src/") || l.len() == "  src/file_0000.rs".len()));
    }

    #[test]
    fn cells_with_spaces_or_quotes_are_quoted() {
        assert_eq!(cell("a.rs"), "a.rs");
        assert_eq!(cell("my file.rs"), "\"my file.rs\"");
        assert_eq!(cell(""), "\"\"");
    }

    #[test]
    fn an_inexact_total_is_a_lower_bound() {
        let p = Page {
            total_exact: false,
            truncation: Some("deadline"),
            ..page(7)
        };
        assert_eq!(render_footer(&p), "total: >=7\ntruncation: deadline\n");
    }
}
