//! Version comparison per ecosystem. Done in code, never by a model.
//!
//! crates.io and npm use semver, parsed leniently (`v1.2` is `1.2.0`). PyPI
//! uses a minimal PEP 440: epoch, release, a/b/rc pre-releases, post and dev
//! releases, and a local `+…` part that is ignored. Anything that does not
//! parse compares as `None`, which callers treat as "cannot tell", never as a
//! match.

use std::cmp::Ordering;

use crate::deps::lockfiles::Ecosystem;

pub fn cmp_versions(eco: Ecosystem, a: &str, b: &str) -> Option<Ordering> {
    match eco {
        Ecosystem::CratesIo | Ecosystem::Npm => Some(semver_lenient(a)?.cmp(&semver_lenient(b)?)),
        Ecosystem::PyPI => Some(Pep440::parse(a)?.cmp(&Pep440::parse(b)?)),
    }
}

fn semver_lenient(raw: &str) -> Option<semver::Version> {
    let v = raw.trim().trim_start_matches(['v', '=']);
    if let Ok(parsed) = semver::Version::parse(v) {
        return Some(parsed);
    }
    // Pad `1` or `1.2` (before any pre-release or build part) to three parts.
    let split = v.find(['-', '+']).unwrap_or(v.len());
    let (core, rest) = v.split_at(split);
    let parts = core.split('.').count();
    if parts == 0 || parts > 3 || core.split('.').any(|p| p.parse::<u64>().is_err()) {
        return None;
    }
    let padded = format!("{core}{}{rest}", ".0".repeat(3 - parts));
    semver::Version::parse(&padded).ok()
}

/// The parts of a PEP 440 version that decide ordering.
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Pep440 {
    epoch: u64,
    /// Trailing zeros trimmed, so `1.0` equals `1`.
    release: Vec<u64>,
    /// `(-1, 0)` for a dev release of the final version, `(0..=2, n)` for
    /// a/b/rc, `(3, 0)` for none: a dev release sorts before any pre-release.
    pre: (i8, u64),
    /// `-1` for none.
    post: i64,
    /// `u64::MAX` for none: a dev release sorts before its non-dev form.
    dev: u64,
}

impl Pep440 {
    fn parse(raw: &str) -> Option<Self> {
        let lower = raw.trim().to_ascii_lowercase();
        let v = lower.trim_start_matches('v');
        let v = v.split('+').next().unwrap_or(v);
        let (epoch, v) = match v.split_once('!') {
            Some((e, rest)) => (e.parse().ok()?, rest),
            None => (0, v),
        };

        let digits_end = v
            .find(|c: char| !(c.is_ascii_digit() || c == '.'))
            .unwrap_or(v.len());
        let release_str = v[..digits_end].trim_end_matches('.');
        if release_str.is_empty() {
            return None;
        }
        let mut release = release_str
            .split('.')
            .map(|p| p.parse::<u64>().ok())
            .collect::<Option<Vec<_>>>()?;
        while release.len() > 1 && release.last() == Some(&0) {
            release.pop();
        }

        let mut rest = &v[digits_end..];
        let mut pre = None;
        let mut post = -1i64;
        let mut dev = None;
        while !rest.is_empty() {
            rest = rest.trim_start_matches(['.', '-', '_']);
            let (tag, after_tag) = take_letters(rest);
            let (n, after_n) = take_number(after_tag);
            match tag {
                "a" | "alpha" => pre = Some((0, n)),
                "b" | "beta" => pre = Some((1, n)),
                "rc" | "c" | "pre" | "preview" => pre = Some((2, n)),
                "post" | "rev" | "r" => post = n as i64,
                "dev" => dev = Some(n),
                // `1.0-1` is an implicit post release.
                "" if !after_tag.is_empty() || n > 0 => post = n as i64,
                _ => return None,
            }
            if after_n.len() == rest.len() {
                return None;
            }
            rest = after_n;
        }

        let pre = match (pre, dev, post) {
            (Some(p), _, _) => p,
            (None, Some(_), -1) => (-1, 0),
            _ => (3, 0),
        };
        Some(Self {
            epoch,
            release,
            pre,
            post,
            dev: dev.unwrap_or(u64::MAX),
        })
    }
}

fn take_letters(s: &str) -> (&str, &str) {
    let end = s
        .find(|c: char| !c.is_ascii_alphabetic())
        .unwrap_or(s.len());
    s.split_at(end)
}

fn take_number(s: &str) -> (u64, &str) {
    let end = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    (s[..end].parse().unwrap_or(0), &s[end..])
}
