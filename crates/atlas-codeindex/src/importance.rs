//! Symbol importance: CMM `pass_importance` (Aider-style weighted in-degree), written to
//! `symbols.importance`. Used by `related`/`repo_map` ordering and Phase 4's ranking prior.

use std::collections::HashMap;

use rusqlite::Connection;

/// `sqrt(in-degree) × 0.1 (_private) × 0.1 (name defined in ≥ 5 files) × 10 (snake/camel/kebab,
/// ≥ 8 chars) × 0.1 (test)`. Zero in-degree ⇒ 0.
pub fn importance(in_degree: i64, name: &str, defined_in_files: i64, is_test: bool) -> f64 {
    if in_degree <= 0 {
        return 0.0;
    }
    let mut w = (in_degree as f64).sqrt();
    if name.starts_with('_') {
        w *= 0.1;
    }
    if defined_in_files >= 5 {
        w *= 0.1;
    }
    if name.chars().count() >= 8 && is_word_style(name) {
        w *= 10.0;
    }
    if is_test {
        w *= 0.1;
    }
    w
}

/// Aider's "meaningful identifier" test: snake_case, kebab-case or camelCase.
pub(crate) fn is_word_style(name: &str) -> bool {
    let alpha = name.chars().any(char::is_alphabetic);
    let snake = name.contains('_') && alpha;
    let kebab = name.contains('-') && alpha;
    let camel = name.chars().any(char::is_uppercase) && name.chars().any(char::is_lowercase);
    snake || kebab || camel
}

/// Recompute every symbol's importance from `edges`; writes only rows that changed.
pub(crate) fn recompute(conn: &Connection) -> rusqlite::Result<usize> {
    let in_deg: HashMap<i64, i64> = conn
        .prepare("SELECT dst_symbol_id, COUNT(*) FROM edges GROUP BY dst_symbol_id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let name_files: HashMap<String, i64> = conn
        .prepare("SELECT name, COUNT(DISTINCT file_id) FROM symbols GROUP BY name")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let rows: Vec<(i64, String, bool, f64)> = conn
        .prepare("SELECT id, name, is_test, importance FROM symbols")?
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0, r.get(3)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut upd = conn.prepare("UPDATE symbols SET importance = ?2 WHERE id = ?1")?;
    let mut changed = 0;
    for (id, name, is_test, old) in rows {
        let files = name_files.get(&name).copied().unwrap_or(1);
        let new = importance(in_deg.get(&id).copied().unwrap_or(0), &name, files, is_test);
        if (new - old).abs() > 1e-9 {
            upd.execute(rusqlite::params![id, new])?;
            changed += 1;
        }
    }
    Ok(changed)
}

/// Distinct call/value callers of a symbol — the `(N callers)` in grep annotations.
pub fn caller_count(conn: &Connection, symbol_id: i64) -> rusqlite::Result<u32> {
    conn.query_row(
        "SELECT COUNT(DISTINCT src_symbol_id) FROM edges WHERE dst_symbol_id = ?1 AND kind IN ('call','value')",
        [symbol_id],
        |r| r.get(0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn importance_formula_matches_cmm() {
        assert_eq!(importance(0, "anything", 1, false), 0.0);
        assert!((importance(4, "run", 1, false) - 2.0).abs() < 1e-9);
        assert!((importance(4, "_run", 1, false) - 0.2).abs() < 1e-9);
        assert!((importance(4, "run", 5, false) - 0.2).abs() < 1e-9);
        assert!((importance(4, "resolve_all", 1, false) - 20.0).abs() < 1e-9);
        assert!((importance(4, "resolveAll", 1, false) - 20.0).abs() < 1e-9);
        assert!((importance(4, "resolveall", 1, false) - 2.0).abs() < 1e-9);
        assert!((importance(4, "resolve_all", 1, true) - 2.0).abs() < 1e-9);
    }
}
