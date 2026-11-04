//! One rule for every file watcher in the app: a read is not a change.
//!
//! On Linux, `notify`'s inotify backend subscribes to `IN_OPEN`, so every
//! `read_dir` of a watched directory and every open of a watched file arrives
//! as `EventKind::Access`. macOS FSEvents and Windows
//! `ReadDirectoryChangesW` never produce one, which is why this was invisible
//! on the Mac. Each watcher callback here reads something to decide what an
//! event means — `.gitignore` for the file index, `.git/index` for git
//! status, `config.toml` for the config reload — and on Linux that read was
//! an event to itself and to every other watcher on the same tree. An idle
//! project measured ~1,300 events/s and three quarters of a core.
//!
//! So every callback drops `Access` events before any work. On the other
//! platforms that drops nothing. `tests/watcher-access-filter.test.ts` keeps
//! each watcher on this.

use notify::EventKind;
use notify_debouncer_full::DebouncedEvent;

/// Whether `kind` can mean something on disk changed.
pub fn is_change(kind: EventKind) -> bool {
    !matches!(kind, EventKind::Access(_))
}

/// `events` without the reads.
pub fn changes(mut events: Vec<DebouncedEvent>) -> Vec<DebouncedEvent> {
    events.retain(|e| is_change(e.event.kind));
    events
}

/// Whether anything in `events` is more than a read.
pub fn any_change(events: &[DebouncedEvent]) -> bool {
    events.iter().any(|e| is_change(e.event.kind))
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, AccessMode, CreateKind, ModifyKind};
    use std::time::Instant;

    fn ev(kind: EventKind) -> DebouncedEvent {
        DebouncedEvent::new(
            notify::Event::new(kind).add_path("/p".into()),
            Instant::now(),
        )
    }

    #[test]
    fn reads_are_not_changes() {
        assert!(!is_change(EventKind::Access(AccessKind::Open(
            AccessMode::Read
        ))));
        assert!(!is_change(EventKind::Access(AccessKind::Close(
            AccessMode::Read
        ))));
        assert!(!is_change(EventKind::Access(AccessKind::Any)));
    }

    #[test]
    fn writes_moves_and_the_unknown_are_changes() {
        assert!(is_change(EventKind::Modify(ModifyKind::Any)));
        assert!(is_change(EventKind::Create(CreateKind::File)));
        assert!(is_change(EventKind::Remove(notify::event::RemoveKind::Any)));
        assert!(is_change(EventKind::Any));
        assert!(is_change(EventKind::Other));
    }

    #[test]
    fn a_batch_of_reads_is_empty_and_one_write_keeps_it() {
        let reads = vec![
            ev(EventKind::Access(AccessKind::Open(AccessMode::Read))),
            ev(EventKind::Access(AccessKind::Close(AccessMode::Read))),
        ];
        assert!(!any_change(&reads));
        assert!(changes(reads).is_empty());

        let mixed = vec![
            ev(EventKind::Access(AccessKind::Open(AccessMode::Read))),
            ev(EventKind::Modify(ModifyKind::Any)),
        ];
        assert!(any_change(&mixed));
        assert_eq!(changes(mixed).len(), 1);
    }
}
