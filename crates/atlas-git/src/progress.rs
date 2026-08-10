//! Git `--progress` stderr parsing → smooth 0..1 progress values.
//!
//! Port of GitHub Desktop's `progress/git.ts`: each operation declares an
//! ordered, weighted list of steps ("Receiving objects" 0.7, …). A parsed
//! line advances monotonically through the steps — completed earlier steps
//! contribute their full weight, the current one contributes
//! `weight * value/total`. Unparseable lines just carry the last percent.

/// One expected progress step: its exact title prefix and relative weight.
#[derive(Debug, Clone, Copy)]
pub struct Step {
    pub title: &'static str,
    pub weight: f32,
}

/// A parsed git progress line: `Title: 47% (123/260)[, done.]`.
#[derive(Debug, Clone, PartialEq)]
pub struct ProgressLine {
    pub title: String,
    pub value: u64,
    pub total: Option<u64>,
    pub done: bool,
}

/// Parse one line of git progress output (grammar from git's progress.c).
pub fn parse_line(line: &str) -> Option<ProgressLine> {
    // Title = everything before the LAST ": " (titles never contain ": "
    // but values like "remote: Compressing objects" put one at the front).
    let idx = line.rfind(": ")?;
    let title = &line[..idx];
    let rest = &line[idx + 2..];

    let mut value: Option<u64> = None;
    let mut total: Option<u64> = None;
    let mut done = false;

    for part in rest.split(", ") {
        let part = part.trim();
        if part == "done." || part == "done" {
            done = true;
        } else if let Some(pct_split) = part.split_once('%') {
            // "47% (123/260)"
            let _pct: u32 = pct_split.0.trim().parse().ok()?;
            let inner = pct_split.1.trim().strip_prefix('(')?.strip_suffix(')')?;
            let (v, t) = inner.split_once('/')?;
            value = Some(v.trim().parse().ok()?);
            total = Some(t.trim().parse().ok()?);
        } else if value.is_none() {
            if let Ok(v) = part
                .trim_end_matches(|c: char| !c.is_ascii_digit())
                .parse::<u64>()
            {
                value = Some(v);
            }
        }
    }

    Some(ProgressLine {
        title: title.to_string(),
        value: value?,
        total,
        done,
    })
}

/// Weighted, monotonic multi-step progress accumulator.
pub struct ProgressParser {
    steps: Vec<Step>,
    step_index: usize,
    last_fraction: f32,
}

impl ProgressParser {
    pub fn new(steps: &[Step]) -> Self {
        let total: f32 = steps.iter().map(|s| s.weight).sum();
        let steps = steps
            .iter()
            .map(|s| Step { title: s.title, weight: if total > 0.0 { s.weight / total } else { 0.0 } })
            .collect();
        ProgressParser { steps, step_index: 0, last_fraction: 0.0 }
    }

    /// Feed one stderr line; returns the overall fraction (0..1) and the
    /// step title when the line advanced progress.
    pub fn advance(&mut self, line: &str) -> Option<(f32, String)> {
        let parsed = parse_line(line)?;
        // Find the step this line belongs to, at or after the current one
        // (never move backwards — late/interleaved lines are ignored).
        let idx = self.steps[self.step_index..]
            .iter()
            .position(|s| parsed.title.starts_with(s.title))?
            + self.step_index;
        self.step_index = idx;

        let mut fraction: f32 = self.steps[..idx].iter().map(|s| s.weight).sum();
        let step = &self.steps[idx];
        let within = match (parsed.done, parsed.total) {
            (true, _) => 1.0,
            (_, Some(t)) if t > 0 => parsed.value as f32 / t as f32,
            _ => 0.0,
        };
        fraction += step.weight * within.clamp(0.0, 1.0);

        if fraction > self.last_fraction {
            self.last_fraction = fraction;
        }
        Some((self.last_fraction, parsed.title))
    }
}

/// Desktop's step tables (clone.ts / fetch.ts / pull.ts / push.ts / checkout.ts).
pub fn steps_for(kind: &str) -> Vec<Step> {
    match kind {
        "clone" => vec![
            Step { title: "remote: Compressing objects", weight: 0.1 },
            Step { title: "Receiving objects", weight: 0.6 },
            Step { title: "Resolving deltas", weight: 0.1 },
            Step { title: "Checking out files", weight: 0.2 },
        ],
        "fetch" => vec![
            Step { title: "remote: Compressing objects", weight: 0.1 },
            Step { title: "Receiving objects", weight: 0.7 },
            Step { title: "Resolving deltas", weight: 0.2 },
        ],
        "pull" => vec![
            Step { title: "remote: Compressing objects", weight: 0.1 },
            Step { title: "Receiving objects", weight: 0.7 },
            Step { title: "Resolving deltas", weight: 0.15 },
            Step { title: "Checking out files", weight: 0.15 },
        ],
        "push" => vec![
            Step { title: "Compressing objects", weight: 0.2 },
            Step { title: "Writing objects", weight: 0.7 },
            Step { title: "remote: Resolving deltas", weight: 0.1 },
        ],
        "checkout" => vec![Step { title: "Checking out files", weight: 1.0 }],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_progress_lines() {
        let p = parse_line("Receiving objects:  47% (123/260)").unwrap();
        assert_eq!(p.title, "Receiving objects");
        assert_eq!((p.value, p.total, p.done), (123, Some(260), false));

        let p = parse_line("remote: Compressing objects: 100% (10/10), done.").unwrap();
        assert_eq!(p.title, "remote: Compressing objects");
        assert!(p.done);

        assert!(parse_line("warning: something odd").is_none());
        assert!(parse_line("").is_none());
    }

    #[test]
    fn weighted_monotonic_walk() {
        let mut parser = ProgressParser::new(&steps_for("fetch"));
        let (f1, _) = parser.advance("remote: Compressing objects: 100% (5/5), done.").unwrap();
        assert!((f1 - 0.1).abs() < 0.01, "{f1}");
        let (f2, t) = parser.advance("Receiving objects:  50% (100/200)").unwrap();
        assert!((f2 - (0.1 + 0.35)).abs() < 0.01, "{f2}");
        assert_eq!(t, "Receiving objects");
        // Backtracking line is ignored (monotonic).
        assert!(parser.advance("remote: Compressing objects: 10% (1/10)").is_none());
        let (f3, _) = parser.advance("Resolving deltas: 100% (50/50), done.").unwrap();
        assert!((f3 - 1.0).abs() < 0.01, "{f3}");
    }

    #[test]
    fn skipped_steps_count_as_complete() {
        let mut parser = ProgressParser::new(&steps_for("clone"));
        // Small repos may never print compressing — jump straight in.
        let (f, _) = parser.advance("Checking out files:  50% (10/20)").unwrap();
        assert!((f - (0.8 + 0.1)).abs() < 0.01, "{f}");
    }
}
