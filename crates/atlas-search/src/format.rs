//! Model-facing text for `grep` and `find_files`, inside a byte budget.
//!
//! Files and count modes are [`compact`] tables. Content mode is ripgrep's
//! heading style — the path once, then `N:` match lines and `N-` context
//! lines, `--` between non-adjacent groups — with the same paging footer.
//! Content mode pages over matching lines (at most 20 kept per file).

use crate::compact::{self, Page, Table};
use crate::grep::{HARD_MATCH_CAP, PER_FILE_LINE_CAP};
use crate::{
    EnclosingSymbol, FileHit, FindRequest, FindResult, GrepRequest, GrepResult, LineHit,
    OutputMode, SymbolLocator,
};

/// `res` as text for the model, never longer than `budget_bytes`.
/// `locator` (Phase 2) names the symbol each group of content lines sits in.
pub fn grep_text(
    res: &GrepResult,
    req: &GrepRequest,
    locator: Option<&dyn SymbolLocator>,
    budget_bytes: usize,
) -> String {
    let notes = notes(res);
    if res.files.is_empty() {
        return fit(format!("{}{notes}", no_matches(res, req)), budget_bytes);
    }
    let pat = shown_pattern(req);
    match req.mode {
        OutputMode::FilesWithMatches => {
            let head = format!(
                "grep {pat}: {} files, newest first\n",
                at_least(res.total_files, res)
            );
            let rows = res.files.iter().map(|f| vec![f.rel.clone()]).collect();
            tabled(
                res,
                req,
                head,
                "files",
                vec!["path"],
                rows,
                &notes,
                budget_bytes,
            )
        }
        OutputMode::Count => {
            let head = format!(
                "grep {pat}: {} matching lines in {} files, newest first\n",
                at_least(res.total_matches, res),
                at_least(res.total_files, res)
            );
            let rows = res
                .files
                .iter()
                .map(|f| vec![f.rel.clone(), f.matches.to_string()])
                .collect();
            tabled(
                res,
                req,
                head,
                "counts",
                vec!["path", "matches"],
                rows,
                &notes,
                budget_bytes,
            )
        }
        OutputMode::Content => content(res, req, locator, &notes, budget_bytes),
    }
}

/// `res` as text for the model, never longer than `budget_bytes`.
pub fn find_text(res: &FindResult, req: &FindRequest, budget_bytes: usize) -> String {
    let partial = if res.partial {
        "partial: stopped at the deadline or on cancel; total is a lower bound\n"
    } else {
        ""
    };
    if res.total == 0 {
        let ignored = if req.include_ignored {
            ""
        } else {
            "; gitignored files excluded — set include_ignored=true to include"
        };
        return fit(
            format!(
                "No paths match {:?} under {}{ignored}.\n{partial}",
                req.query,
                where_(req.path.as_deref())
            ),
            budget_bytes,
        );
    }
    if res.paths.is_empty() {
        return fit(
            format!(
                "No results at offset {}: {} paths match.\n{partial}",
                req.offset, res.total
            ),
            budget_bytes,
        );
    }
    let order = if req.is_glob() {
        "newest first"
    } else {
        "best match first"
    };
    let head = format!("find_files {:?}: {} paths, {order}\n", req.query, res.total);
    let shown = req.offset + res.paths.len();
    let next = (shown < res.total).then_some(shown);
    let page = Page {
        total: res.total,
        total_exact: !res.partial,
        offset: req.offset,
        next_offset: next,
        truncation: if next.is_some() {
            Some("page_limit")
        } else if res.partial {
            Some("deadline")
        } else {
            None
        },
    };
    let table = Table {
        name: "paths".into(),
        cols: vec!["path"],
        rows: res.paths.iter().map(|p| vec![p.clone()]).collect(),
    };
    let body_budget = budget_bytes.saturating_sub(head.len() + partial.len());
    format!(
        "{head}{}{partial}",
        compact::render(&[table], &page, body_budget)
    )
}

fn shown_pattern(req: &GrepRequest) -> String {
    if req.literal {
        format!("{:?}", req.pattern)
    } else {
        format!("/{}/", req.pattern)
    }
}

fn where_(path: Option<&std::path::Path>) -> String {
    path.map_or_else(|| "the project".to_string(), |p| p.display().to_string())
}

/// A total, as `>=N` when the search stopped early (the match cap, the
/// deadline or a cancel), so it is never mistaken for the whole count.
fn at_least(n: usize, res: &GrepResult) -> String {
    if res.partial || res.match_cap_hit {
        format!(">={n}")
    } else {
        n.to_string()
    }
}

fn notes(res: &GrepResult) -> String {
    let mut out = String::new();
    if res.partial {
        out.push_str("partial: stopped at the deadline or on cancel; totals are lower bounds\n");
    }
    if res.match_cap_hit {
        out.push_str(&format!(
            "partial: stopped after {HARD_MATCH_CAP} matching lines; narrow with path, glob or type\n"
        ));
    }
    if res.skipped_large > 0 {
        out.push_str(&format!(
            "skipped: {} files over 10 MiB\n",
            res.skipped_large
        ));
    }
    if res.skipped_by_index > 0 {
        out.push_str(&format!(
            "index: {} files ruled out unread by the grep index\n",
            res.skipped_by_index
        ));
    }
    out
}

fn no_matches(res: &GrepResult, req: &GrepRequest) -> String {
    if res.total_files > 0 {
        return format!(
            "No results at offset {}: {} files match.\n",
            req.offset, res.total_files
        );
    }
    let ignored = if req.include_ignored {
        ""
    } else {
        "; gitignored files excluded — set include_ignored=true to include"
    };
    let by_index = if res.skipped_by_index > 0 {
        format!(", {} ruled out by the index", res.skipped_by_index)
    } else {
        String::new()
    };
    format!(
        "No matches for {} in {} (searched {} files{by_index}{ignored}).\n",
        shown_pattern(req),
        where_(req.path.as_deref()),
        res.searched_files
    )
}

/// Cut plain text to the budget at a char boundary (it only ever trips on an
/// absurd budget; every builder below stays inside it).
fn fit(mut text: String, budget_bytes: usize) -> String {
    if text.len() > budget_bytes {
        let mut end = budget_bytes;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    text
}

fn truncation(res: &GrepResult, next: Option<usize>) -> Option<&'static str> {
    if next.is_some() {
        Some("page_limit")
    } else if res.partial || res.match_cap_hit {
        Some("deadline")
    } else {
        None
    }
}

#[allow(clippy::too_many_arguments)]
fn tabled(
    res: &GrepResult,
    req: &GrepRequest,
    head: String,
    name: &str,
    cols: Vec<&'static str>,
    all_rows: Vec<Vec<String>>,
    notes: &str,
    budget_bytes: usize,
) -> String {
    if req.offset >= all_rows.len() {
        return fit(format!("{}{notes}", no_matches(res, req)), budget_bytes);
    }
    let rows: Vec<Vec<String>> = all_rows
        .into_iter()
        .skip(req.offset)
        .take(req.page_limit())
        .collect();
    let shown = req.offset + rows.len();
    let next = (shown < res.total_files).then_some(shown);
    let page = Page {
        total: res.total_files,
        total_exact: !(res.partial || res.match_cap_hit),
        offset: req.offset,
        next_offset: next,
        truncation: truncation(res, next),
    };
    let table = Table {
        name: name.to_string(),
        cols,
        rows,
    };
    let body_budget = budget_bytes.saturating_sub(head.len() + notes.len());
    format!(
        "{head}{}{notes}",
        compact::render(&[table], &page, body_budget)
    )
}

/// One output line of content mode. Paging counts `Match` lines; `Other`
/// lines (a path, `--`, an annotation, a note) are never left dangling.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Match,
    Context,
    Other,
}

struct Out {
    text: String,
    kind: Kind,
}

fn content(
    res: &GrepResult,
    req: &GrepRequest,
    locator: Option<&dyn SymbolLocator>,
    notes: &str,
    budget_bytes: usize,
) -> String {
    let total_kept: usize = res
        .files
        .iter()
        .map(|f| f.lines.iter().filter(|l| l.is_match).count())
        .sum();
    if req.offset >= total_kept {
        return fit(
            format!(
                "No results at offset {}: {total_kept} matching lines can be shown.\n{notes}",
                req.offset
            ),
            budget_bytes,
        );
    }
    let (from, to) = (req.offset, req.offset + req.page_limit());
    let mut lines: Vec<Out> = Vec::new();
    let mut seen = 0usize;
    for file in &res.files {
        let matches: Vec<u64> = file
            .lines
            .iter()
            .filter(|l| l.is_match)
            .map(|l| l.line)
            .collect();
        let n = matches.len();
        if seen + n <= from {
            seen += n;
            continue;
        }
        if seen >= to {
            break;
        }
        let lo = from.saturating_sub(seen);
        let hi = (to - seen).min(n);
        let chosen = &matches[lo..hi];
        let more = if hi == n {
            (file.matches as usize).saturating_sub(n)
        } else {
            0
        };
        push_file(&mut lines, file, chosen, req, more, locator);
        seen += n;
    }

    let head = format!(
        "grep {}: {} matching lines in {} files, newest first (at most {PER_FILE_LINE_CAP} shown per file)\n",
        shown_pattern(req),
        at_least(res.total_matches, res),
        at_least(res.total_files, res)
    );
    let assemble = |lines: &[Out], page: &Page| {
        let mut out = head.clone();
        for line in lines {
            out.push_str(&line.text);
            out.push('\n');
        }
        out.push_str(&compact::render_footer(page));
        out.push_str(notes);
        out
    };
    let page_for = |shown: usize, cut: bool| {
        let end = from + shown;
        let next = (end < total_kept).then_some(end);
        Page {
            total: total_kept,
            total_exact: !(res.partial || res.match_cap_hit),
            offset: from,
            next_offset: next,
            truncation: if cut {
                Some("output_budget")
            } else {
                truncation(res, next)
            },
        }
    };
    let shown = |lines: &[Out]| lines.iter().filter(|l| l.kind == Kind::Match).count();

    let text = assemble(&lines, &page_for(shown(&lines), false));
    if text.len() <= budget_bytes || lines.is_empty() {
        return fit(text, budget_bytes);
    }
    // Drop lines from the end until it fits, counting bytes rather than
    // assembling the text again per line (a large page is thousands of lines).
    let mut keep = lines.len();
    let mut body: usize = lines.iter().map(|l| l.text.len() + 1).sum();
    let mut matches = shown(&lines);
    loop {
        // One line, then any it leaves dangling: never end on a path,
        // separator or annotation.
        loop {
            keep -= 1;
            body -= lines[keep].text.len() + 1;
            if lines[keep].kind == Kind::Match {
                matches -= 1;
            }
            if keep == 0 || lines[keep - 1].kind != Kind::Other {
                break;
            }
        }
        let page = page_for(matches, true);
        let size = head.len() + body + compact::render_footer(&page).len() + notes.len();
        if size <= budget_bytes || keep == 0 {
            return fit(assemble(&lines[..keep], &page), budget_bytes);
        }
    }
}

/// One file's heading, its chosen match lines with the context around them,
/// `--` between groups, the enclosing symbol per group when known, and the
/// "+N more" note when the file's kept lines end here.
fn push_file(
    out: &mut Vec<Out>,
    file: &FileHit,
    chosen: &[u64],
    req: &GrepRequest,
    more: usize,
    locator: Option<&dyn SymbolLocator>,
) {
    let near = |l: &LineHit| {
        chosen.iter().any(|&m| {
            (l.line < m && m - l.line <= req.before as u64)
                || (l.line > m && l.line - m <= req.after as u64)
        })
    };
    let picked: Vec<&LineHit> = file
        .lines
        .iter()
        .filter(|l| {
            if l.is_match {
                chosen.contains(&l.line)
            } else {
                near(l)
            }
        })
        .collect();
    if !out.is_empty() {
        out.push(Out {
            text: String::new(),
            kind: Kind::Other,
        });
    }
    out.push(Out {
        text: file.rel.clone(),
        kind: Kind::Other,
    });
    let mut previous: Option<u64> = None;
    let mut last_symbol: Option<EnclosingSymbol> = None;
    for line in picked {
        let new_group = previous.is_none_or(|p| line.line != p + 1);
        if new_group && previous.is_some() {
            out.push(Out {
                text: "--".into(),
                kind: Kind::Other,
            });
        }
        if new_group {
            if let Some(symbol) = locator
                .and_then(|l| l.enclosing(&file.rel, u32::try_from(line.line).unwrap_or(u32::MAX)))
            {
                if last_symbol.as_ref() != Some(&symbol) {
                    let callers = if symbol.callers > 0 {
                        format!(" ({} callers)", symbol.callers)
                    } else {
                        String::new()
                    };
                    out.push(Out {
                        text: format!(
                            "@ {} {} L{}-{}{callers}",
                            symbol.kind, symbol.qualified_name, symbol.start_line, symbol.end_line
                        ),
                        kind: Kind::Other,
                    });
                    last_symbol = Some(symbol);
                }
            }
        }
        let (sep, kind) = if line.is_match {
            (':', Kind::Match)
        } else {
            ('-', Kind::Context)
        };
        out.push(Out {
            text: format!("{}{sep}{}", line.line, line.text),
            kind,
        });
        previous = Some(line.line);
    }
    if more > 0 {
        out.push(Out {
            text: format!("… +{more} more matching lines in this file"),
            kind: Kind::Other,
        });
    }
}
