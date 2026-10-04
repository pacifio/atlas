//! Stopping a search early: the caller gave up, or its deadline passed.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

/// Shared stop signal for one search. Clones share the flag (and keep the
/// deadline), so the tool server cancels the copy the worker thread holds.
/// Checked between files and on every match, so a stop is prompt even
/// inside a huge file.
#[derive(Debug, Clone, Default)]
pub struct CancelToken {
    flag: Arc<AtomicBool>,
    deadline: Option<Instant>,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// The same token, which also reads as cancelled once `deadline` passes.
    #[must_use]
    pub fn with_deadline(mut self, deadline: Instant) -> Self {
        self.deadline = Some(deadline);
        self
    }

    /// Stop every search holding a clone of this token.
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::Relaxed) || self.deadline.is_some_and(|d| Instant::now() >= d)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_clone_shares_the_flag() {
        let token = CancelToken::new();
        let worker = token.clone();
        assert!(!worker.is_cancelled());
        token.cancel();
        assert!(worker.is_cancelled());
    }

    #[test]
    fn a_passed_deadline_reads_as_cancelled() {
        let past = CancelToken::new().with_deadline(Instant::now());
        assert!(past.is_cancelled());
        let future = CancelToken::new().with_deadline(Instant::now() + Duration::from_secs(60));
        assert!(!future.is_cancelled());
    }
}
