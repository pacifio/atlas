//! Everything resolution reads, loaded once per resolve pass: files, symbols, imports and
//! Rust `mod` declarations, with the lookup indexes the cascade needs.

use std::collections::HashMap;

use rusqlite::Connection;

use crate::graph_extract::RawMod;

pub(crate) const RUST: u8 = 0;
pub(crate) const TS: u8 = 1;
pub(crate) const PY: u8 = 2;
pub(crate) const GO: u8 = 3;
pub(crate) const OTHER: u8 = 9;

/// Language family: resolution never crosses families (CMM's cross-language veto).
pub(crate) fn family(lang: &str) -> u8 {
    match lang {
        "rust" => RUST,
        "typescript" | "tsx" | "javascript" | "jsx" => TS,
        "python" => PY,
        "go" => GO,
        _ => OTHER,
    }
}

#[derive(Debug, Clone)]
pub(crate) struct FileRow {
    pub id: i64,
    pub rel: String,
    pub lang: String,
    pub module: String,
}

#[derive(Debug, Clone)]
pub(crate) struct SymRow {
    pub id: i64,
    pub file_id: i64,
    pub parent: Option<i64>,
    pub kind: String,
    pub name: String,
    pub qn: String,
    pub exported: bool,
    pub is_test: bool,
    /// Header text (`pub fn open() -> io::Result<Self>`): Rust receiver typing reads return
    /// types and type aliases from it.
    pub sig: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ImportRow {
    pub rowid: i64,
    pub file_id: i64,
    pub local_name: String,
    pub module_path: String,
    pub imported_name: String,
    pub is_pub: bool,
    pub resolved_file_id: Option<i64>,
}

#[derive(Default)]
pub(crate) struct Universe {
    pub files: Vec<FileRow>,
    pub syms: Vec<SymRow>,
    pub imports: Vec<ImportRow>,
    pub mods: HashMap<i64, Vec<RawMod>>,
    pub file_ix: HashMap<i64, usize>,
    pub rel_ix: HashMap<String, i64>,
    pub sym_ix: HashMap<i64, usize>,
    /// name → symbol indexes, ascending id.
    pub by_name: HashMap<String, Vec<usize>>,
    pub by_file_name: HashMap<(i64, String), Vec<usize>>,
    /// (family, module) → file ids, ascending.
    pub by_module: HashMap<(u8, String), Vec<i64>>,
    /// Rust struct symbol id → its fields `(name, type text)`, in declaration order.
    pub fields: HashMap<i64, Vec<(String, String)>>,
}

impl Universe {
    pub(crate) fn load(conn: &Connection) -> rusqlite::Result<Universe> {
        let files = conn
            .prepare("SELECT id, rel, lang, module FROM files ORDER BY id")?
            .query_map([], |r| {
                Ok(FileRow {
                    id: r.get(0)?,
                    rel: r.get(1)?,
                    lang: r.get(2)?,
                    module: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let syms = conn
            .prepare("SELECT id, file_id, parent_id, kind, name, qualified_name, exported, is_test, signature FROM symbols ORDER BY id")?
            .query_map([], |r| {
                Ok(SymRow {
                    id: r.get(0)?,
                    file_id: r.get(1)?,
                    parent: r.get(2)?,
                    kind: r.get(3)?,
                    name: r.get(4)?,
                    qn: r.get(5)?,
                    exported: r.get::<_, i64>(6)? != 0,
                    is_test: r.get::<_, i64>(7)? != 0,
                    sig: r.get(8)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let imports = conn
            .prepare(
                "SELECT rowid, file_id, local_name, module_path, imported_name, is_pub, resolved_file_id
                 FROM imports ORDER BY file_id, line, rowid",
            )?
            .query_map([], |r| {
                Ok(ImportRow {
                    rowid: r.get(0)?,
                    file_id: r.get(1)?,
                    local_name: r.get(2)?,
                    module_path: r.get(3)?,
                    imported_name: r.get(4)?,
                    is_pub: r.get::<_, i64>(5)? != 0,
                    resolved_file_id: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut mods: HashMap<i64, Vec<RawMod>> = HashMap::new();
        let mut stmt = conn.prepare("SELECT file_id, name, path_attr, inline_parent, line FROM rust_mods ORDER BY file_id, line, name")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                RawMod {
                    name: r.get(1)?,
                    path_attr: r.get(2)?,
                    inline_parent: r.get(3)?,
                    line: r.get(4)?,
                },
            ))
        })?;
        for row in rows {
            let (fid, m) = row?;
            mods.entry(fid).or_default().push(m);
        }
        let mut u = Universe::from_parts(files, syms, imports, mods);
        let mut stmt = conn.prepare(
            "SELECT src_symbol_id, name, receiver FROM refs
             WHERE kind = 'field' AND src_symbol_id IS NOT NULL ORDER BY id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (sid, name, ty) = row?;
            u.fields.entry(sid).or_default().push((name, ty));
        }
        Ok(u)
    }

    pub(crate) fn from_parts(
        mut files: Vec<FileRow>,
        mut syms: Vec<SymRow>,
        imports: Vec<ImportRow>,
        mods: HashMap<i64, Vec<RawMod>>,
    ) -> Universe {
        files.sort_by_key(|f| f.id);
        syms.sort_by_key(|s| s.id);
        let mut u = Universe {
            files,
            syms,
            imports,
            mods,
            ..Universe::default()
        };
        for (i, f) in u.files.iter().enumerate() {
            u.file_ix.insert(f.id, i);
            u.rel_ix.insert(f.rel.clone(), f.id);
        }
        for (i, s) in u.syms.iter().enumerate() {
            u.sym_ix.insert(s.id, i);
            u.by_name.entry(s.name.clone()).or_default().push(i);
            u.by_file_name
                .entry((s.file_id, s.name.clone()))
                .or_default()
                .push(i);
        }
        u.index_modules();
        u
    }

    fn index_modules(&mut self) {
        self.by_module.clear();
        for f in &self.files {
            self.by_module
                .entry((family(&f.lang), f.module.clone()))
                .or_default()
                .push(f.id);
        }
    }

    /// Install freshly computed modules (aligned with `files`).
    pub(crate) fn set_modules(&mut self, modules: Vec<String>) {
        for (f, m) in self.files.iter_mut().zip(modules) {
            f.module = m;
        }
        self.index_modules();
    }

    pub(crate) fn file(&self, id: i64) -> &FileRow {
        &self.files[self.file_ix[&id]]
    }

    pub(crate) fn fam_of(&self, file_id: i64) -> u8 {
        family(&self.file(file_id).lang)
    }

    pub(crate) fn has_sym(&self, file_id: i64, name: &str) -> bool {
        self.by_file_name.contains_key(&(file_id, name.to_string()))
    }

    pub(crate) fn files_of_module(&self, fam: u8, module: &str) -> &[i64] {
        self.by_module
            .get(&(fam, module.to_string()))
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }
}
