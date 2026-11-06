//! What an import actually did, in a shape the UI can render without knowing
//! anything about the source format.
//!
//! The report is the product here, not a diagnostic. A VS Code theme converted
//! to Atlas is a *starting point* — well over half of [`crate::theme_keys`] has
//! no workbench or TextMate equivalent at all — and a user who cannot see that
//! will read the result as a faithful port and file the difference as a bug.
//! So every importer records three things for every value it produces:
//!
//! | | meaning |
//! |---|---|
//! | **mapped** | the source said this, verbatim |
//! | **derived** | the source did not say it; Atlas worked it out (and from what) |
//! | **ignored** | the source said it and Atlas has nowhere to put it |
//!
//! `ignored` is the one that earns its keep: a bare count reads as failure,
//! while "42 ignored — 31 workbench chrome, 8 markup scopes, 3 shadow recipe"
//! reads as the honest summary it is. Hence [`ImportCounts::ignored_by_category`].

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// How close the converted theme can get to the source, by construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Fidelity {
    /// shadcn: Atlas's base tokens *are* shadcn's, so nothing is lost.
    Native,
    /// Zed: its colour roles map onto Atlas's theme keys almost one-to-one, so
    /// nearly every key has a counterpart; what is missing is a shadcn layer Zed never had.
    NearLossless,
    /// VS Code: a workbench theme and an app theme are different things.
    Lossy,
}

/// One value the source provided and Atlas kept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MappedKey {
    /// Where it landed, fully qualified: `dark.base.background`.
    pub target: String,
    /// What it came from, in the source's own vocabulary.
    pub source: String,
    pub value: String,
}

/// One value Atlas invented because the source had none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DerivedKey {
    pub target: String,
    /// The Atlas token or source role it was taken from, or `"atlas default"`.
    pub from: String,
    pub value: String,
}

/// One thing the source said that Atlas has no home for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredKey {
    pub source: String,
    /// Groups the list so a hundred entries read as a handful of facts.
    pub category: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportCounts {
    pub mapped: usize,
    pub derived: usize,
    pub ignored: usize,
    pub ignored_by_category: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// `shadcn` | `shadcn-css` | `zed` | `vscode`.
    pub format: String,
    /// What the source called this theme, before any renaming.
    pub source_name: String,
    /// `dark`, `light`, or both.
    pub variants: Vec<String>,
    pub fidelity: Fidelity,
    /// One line per importer saying what the format cannot carry. Shown above
    /// the lists, because it is the part a user must read.
    pub summary: Vec<String>,
    pub mapped: Vec<MappedKey>,
    pub derived: Vec<DerivedKey>,
    pub ignored: Vec<IgnoredKey>,
    /// Things that are wrong rather than merely absent — a `spacing` Atlas will
    /// not honour, an `include` that could not be resolved.
    pub warnings: Vec<String>,
    pub counts: ImportCounts,
}

impl ImportReport {
    pub(crate) fn new(format: &str, source_name: String, fidelity: Fidelity) -> Self {
        Self {
            format: format.to_string(),
            source_name,
            variants: Vec::new(),
            fidelity,
            summary: Vec::new(),
            mapped: Vec::new(),
            derived: Vec::new(),
            ignored: Vec::new(),
            warnings: Vec::new(),
            counts: ImportCounts::default(),
        }
    }

    pub(crate) fn ignore(&mut self, source: impl Into<String>, category: &str, reason: &str) {
        self.ignored.push(IgnoredKey {
            source: source.into(),
            category: category.to_string(),
            reason: reason.to_string(),
        });
    }

    pub(crate) fn warn(&mut self, message: impl Into<String>) {
        self.warnings.push(message.into());
    }

    pub(crate) fn note(&mut self, message: impl Into<String>) {
        self.summary.push(message.into());
    }

    /// Recomputes [`ImportCounts`] from the three lists. Called once, last, so
    /// no importer has to remember to keep a counter in step with a push.
    pub(crate) fn finish(&mut self) {
        let mut by_category: BTreeMap<String, usize> = BTreeMap::new();
        for entry in &self.ignored {
            *by_category.entry(entry.category.clone()).or_default() += 1;
        }
        self.counts = ImportCounts {
            mapped: self.mapped.len(),
            derived: self.derived.len(),
            ignored: self.ignored.len(),
            ignored_by_category: by_category,
        };
    }
}
