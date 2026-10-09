//! Rust type text, read well enough to type a method receiver: `Arc<Mutex<Store>>`,
//! `anyhow::Result<(Store, u32)>`, `Option<&Item>`, `impl Future<Output = T>`. Paths keep
//! their segments, generic arguments nest, references, lifetimes, `mut`, `dyn` and extra
//! `+` bounds are dropped. Anything else (fn pointers, arrays' lengths, macros) parses as far
//! as it can and is not followed further.

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct RType {
    /// Path segments, `[]` for a tuple.
    pub path: Vec<String>,
    /// Generic arguments, or a tuple's elements.
    pub args: Vec<RType>,
}

impl RType {
    pub(crate) fn name(&self) -> &str {
        self.path.last().map(String::as_str).unwrap_or("")
    }

    pub(crate) fn is_tuple(&self) -> bool {
        self.path.is_empty()
    }

    /// `a::b::` for `a::b::C`, `""` for `C`.
    pub(crate) fn qualifier(&self) -> String {
        let n = self.path.len().saturating_sub(1);
        self.path[..n].iter().map(|s| format!("{s}::")).collect()
    }

    /// The first generic argument / tuple element.
    pub(crate) fn arg(&self, i: usize) -> Option<RType> {
        self.args.get(i).cloned()
    }
}

/// Types a method call sees through (auto-deref): `Arc<T>` has `T`'s methods.
pub(crate) const DEREF_WRAPPERS: &[&str] = &[
    "Arc",
    "Rc",
    "Box",
    "Cow",
    "Pin",
    "MutexGuard",
    "RwLockReadGuard",
    "RwLockWriteGuard",
    "Ref",
    "RefMut",
    "OwnedMutexGuard",
    "ArcSwap",
];

/// `.lock()` / `.read()` / `.write()` hand out their argument (through a guard).
pub(crate) const LOCKS: &[&str] = &["Mutex", "RwLock", "ReentrantMutex"];

/// Types `?`, `.unwrap()` and `.expect()` take apart.
pub(crate) const FALLIBLE: &[&str] = &["Option", "Result", "LockResult", "Poll"];

pub(crate) fn parse(text: &str) -> Option<RType> {
    let mut p = Parser {
        s: text.as_bytes(),
        i: 0,
        depth: 0,
    };
    p.ty()
}

/// The declared return type of a fn signature (`… -> T`, before any `where`), or `None`.
pub(crate) fn return_type(sig: &str) -> Option<&str> {
    let b = sig.as_bytes();
    let (mut paren, mut angle) = (0i32, 0i32);
    let mut i = 0;
    while i + 1 < b.len() {
        match b[i] {
            b'(' | b'[' => paren += 1,
            b')' | b']' => paren -= 1,
            b'<' => angle += 1,
            b'>' if i > 0 && b[i - 1] != b'-' => angle -= 1,
            b'-' if b[i + 1] == b'>' && paren == 0 && angle == 0 => {
                let rest = sig[i + 2..].trim();
                let rest = rest.split(" where ").next().unwrap_or(rest);
                let rest = rest.trim_end_matches('…').trim();
                return (!rest.is_empty()).then_some(rest);
            }
            _ => {}
        }
        i += 1;
    }
    None
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
    depth: u8,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
            self.i += 1;
        }
    }

    fn peek(&mut self) -> Option<u8> {
        self.ws();
        self.s.get(self.i).copied()
    }

    fn eat(&mut self, c: u8) -> bool {
        if self.peek() == Some(c) {
            self.i += 1;
            true
        } else {
            false
        }
    }

    fn ident(&mut self) -> Option<&str> {
        self.ws();
        let start = self.i;
        while self.i < self.s.len()
            && (self.s[self.i].is_ascii_alphanumeric() || self.s[self.i] == b'_')
        {
            self.i += 1;
        }
        (self.i > start).then(|| std::str::from_utf8(&self.s[start..self.i]).unwrap_or(""))
    }

    fn keyword(&mut self, kw: &str) -> bool {
        self.ws();
        let rest = &self.s[self.i..];
        if rest.starts_with(kw.as_bytes())
            && rest
                .get(kw.len())
                .is_none_or(|c| !(c.is_ascii_alphanumeric() || *c == b'_'))
        {
            self.i += kw.len();
            true
        } else {
            false
        }
    }

    fn ty(&mut self) -> Option<RType> {
        self.depth += 1;
        if self.depth > 24 {
            return None;
        }
        let out = self.ty_inner();
        self.depth -= 1;
        out
    }

    fn ty_inner(&mut self) -> Option<RType> {
        while self.eat(b'&') {
            if self.peek() == Some(b'\'') {
                self.i += 1;
                self.ident();
            }
            self.keyword("mut");
        }
        if self.keyword("dyn") || self.keyword("impl") {
            let t = self.ty()?;
            while self.eat(b'+') {
                if self.peek() == Some(b'\'') {
                    self.i += 1;
                    self.ident();
                } else {
                    self.ty()?;
                }
            }
            return Some(t);
        }
        if self.eat(b'(') {
            let mut args = Vec::new();
            while !self.eat(b')') {
                args.push(self.ty()?);
                if !self.eat(b',') && self.peek() != Some(b')') {
                    return None;
                }
            }
            return Some(RType {
                path: Vec::new(),
                args,
            });
        }
        if self.eat(b'[') {
            let inner = self.ty()?;
            while self.peek().is_some_and(|c| c != b']') {
                self.i += 1;
            }
            self.eat(b']');
            return Some(RType {
                path: vec!["[]".into()],
                args: vec![inner],
            });
        }
        let mut path = Vec::new();
        let mut args = Vec::new();
        loop {
            path.push(self.ident()?.to_string());
            self.ws();
            if self.s[self.i..].starts_with(b"::") {
                self.i += 2;
                if self.eat(b'<') {
                    args = self.generic_args()?;
                    break;
                }
                continue;
            }
            if self.eat(b'<') {
                args = self.generic_args()?;
            }
            break;
        }
        Some(RType { path, args })
    }

    /// After `<`: types, lifetimes skipped, `Name = T` bindings kept as `T`.
    fn generic_args(&mut self) -> Option<Vec<RType>> {
        let mut args = Vec::new();
        while !self.eat(b'>') {
            if self.peek() == Some(b'\'') {
                self.i += 1;
                self.ident();
            } else {
                let save = self.i;
                let binding = self.ident().is_some() && self.peek() == Some(b'=');
                if binding {
                    self.i += 1;
                } else {
                    self.i = save;
                }
                args.push(self.ty()?);
            }
            if !self.eat(b',') && self.peek() != Some(b'>') {
                return None;
            }
        }
        Some(args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn show(t: &RType) -> String {
        let head = if t.is_tuple() {
            String::new()
        } else {
            t.path.join("::")
        };
        if t.args.is_empty() && !t.is_tuple() {
            return head;
        }
        let inner: Vec<String> = t.args.iter().map(show).collect();
        if t.is_tuple() {
            format!("({})", inner.join(","))
        } else {
            format!("{head}<{}>", inner.join(","))
        }
    }

    #[test]
    fn types_parse_to_paths_and_arguments() {
        let p = |s: &str| parse(s).map(|t| show(&t));
        assert_eq!(p("Arc<Mutex<Store>>").as_deref(), Some("Arc<Mutex<Store>>"));
        assert_eq!(
            p("&'a mut crate::store::Store").as_deref(),
            Some("crate::store::Store")
        );
        assert_eq!(
            p("anyhow::Result<(Store, u32)>").as_deref(),
            Some("anyhow::Result<(Store,u32)>")
        );
        assert_eq!(p("Option<&Item>").as_deref(), Some("Option<Item>"));
        assert_eq!(
            p("impl std::future::Future<Output = Reply> + Send + 'static").as_deref(),
            Some("std::future::Future<Reply>")
        );
        assert_eq!(
            p("HashMap<String, Vec<u8>>").as_deref(),
            Some("HashMap<String,Vec<u8>>")
        );
        assert_eq!(p("Vec::<u8>").as_deref(), Some("Vec<u8>"));
    }

    #[test]
    fn a_return_type_is_after_the_top_level_arrow() {
        assert_eq!(
            return_type("pub fn open() -> std::io::Result<Self>"),
            Some("std::io::Result<Self>")
        );
        assert_eq!(
            return_type("fn f(cb: impl Fn() -> u8) -> Out where T: X"),
            Some("Out")
        );
        assert_eq!(return_type("fn g(&self)"), None);
        assert_eq!(
            return_type("pub fn r(&self) -> Result< ( Id, u8, ), E, >"),
            Some("Result< ( Id, u8, ), E, >")
        );
    }
}
