//! Noticing that the computer slept under an in-flight agent turn.
//!
//! A turn that is streaming when the lid closes usually comes back broken: the
//! model's HTTP stream died while the machine was asleep, and what the user
//! sees on waking is a truncated reply, a hung spinner, or a transport error
//! ("connection reset", "error decoding response body") that says nothing
//! about the cause. [`SleepWatch`] notices the sleep and names it, as a
//! [`SessionDelta::SleptMidTurn`] for every session whose turn was running
//! across it. The chat attaches it to that turn.
//!
//! # Detection: a gap between two clocks
//!
//! No OS notification is used (that would need a new dependency for each
//! platform). Instead, two clocks are compared at every reading:
//!
//! - the monotonic clock (`Instant`), which does **not** advance while the
//!   machine sleeps on macOS (`CLOCK_UPTIME_RAW`) or Linux
//!   (`CLOCK_MONOTONIC`), and
//! - the wall clock (`SystemTime`), which does.
//!
//! Between two readings both normally advance by the same amount; after a
//! sleep the wall clock is ahead by roughly the time spent asleep. Neither a
//! busy machine nor App Nap timer throttling opens that gap — both clocks keep
//! running then — so it is specific to the machine actually being suspended.
//! A manual or NTP step of the wall clock forward by more than the threshold
//! would also read as a sleep; that is rare, and the cost is one spurious
//! hedge ("may be incomplete") on a running turn.
//!
//! Windows: `Instant` is `QueryPerformanceCounter` there, and whether it counts
//! time spent suspended is not something this code relies on or has verified.
//! If it does count it, the two clocks agree after a sleep and nothing fires —
//! the failure mode is silence, never a false warning.
//!
//! # When it is read
//!
//! On every delta (before that delta is delivered) and on a background tick.
//! The per-delta reading is what orders the notice before the turn's terminal:
//! after waking, the first thing a broken turn usually does is fail, and the
//! notice has to reach the chat before the failure does. The tick covers a turn
//! that wakes up silent — a hung stream emits nothing at all.
//!
//! # Which sessions it names
//!
//! A session counts when its turn was `Running` — not `Waiting` for the user,
//! where nothing is streaming — and it started running before the sleep began.
//! A turn started in the few seconds between waking and the reading must not
//! be blamed for a sleep it never saw, and the monotonic clock cannot tell the
//! two apart (it did not move during the sleep), so the start is kept in
//! wall-clock time: anything that started running after `now_wall - mono_gap`
//! may have started after the wake, and is left alone.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use atlas_agent_wire::{AgentId, SessionDelta, SessionDeltaEnvelope, SessionStatus};
use parking_lot::Mutex;

/// How far the wall clock must run ahead of the monotonic one between two
/// readings to count as a sleep. Comfortably above scheduling noise; well
/// below any sleep long enough to break a stream.
pub const SLEEP_THRESHOLD: Duration = Duration::from_secs(10);

/// How often the background tick reads the clocks. Bounds how late the notice
/// is for a turn that comes back from sleep silent.
pub const TICK_INTERVAL: Duration = Duration::from_secs(5);

/// Both clocks at one moment, as durations from their own origins.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reading {
    /// Monotonic time — pauses while the machine sleeps.
    pub mono: Duration,
    /// Wall-clock time since the Unix epoch — keeps running while it sleeps.
    pub wall: Duration,
}

/// Where readings come from. Injectable so the detector is testable without
/// putting a machine to sleep.
pub trait Clock: Send + Sync {
    fn read(&self) -> Reading;
}

/// The real clocks.
pub struct SystemClock {
    origin: Instant,
}

impl SystemClock {
    pub fn new() -> Self {
        Self {
            origin: Instant::now(),
        }
    }
}

impl Default for SystemClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for SystemClock {
    fn read(&self) -> Reading {
        Reading {
            mono: self.origin.elapsed(),
            // A wall clock before 1970 reads as 0: the gap then comes out
            // negative and saturates to "no sleep", which is the safe side.
            wall: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default(),
        }
    }
}

/// A sleep the detector saw between two readings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Slept {
    /// Roughly how long the machine was asleep.
    pub duration: Duration,
    /// The wall-clock time before which anything started running certainly
    /// started before the machine woke (see the module docs).
    pub woke_after: Duration,
}

/// The pure part: compares each reading with the previous one.
#[derive(Debug)]
pub struct GapDetector {
    last: Option<Reading>,
    threshold: Duration,
}

impl GapDetector {
    pub fn new(threshold: Duration) -> Self {
        Self {
            last: None,
            threshold,
        }
    }

    /// Take a reading. Returns the sleep, if one happened since the last.
    pub fn observe(&mut self, now: Reading) -> Option<Slept> {
        let last = self.last.replace(now)?;
        let mono_gap = now.mono.saturating_sub(last.mono);
        // A wall clock stepped backwards saturates to 0 — never a sleep.
        let wall_gap = now.wall.saturating_sub(last.wall);
        let duration = wall_gap.saturating_sub(mono_gap);
        (duration >= self.threshold).then(|| Slept {
            duration,
            woke_after: now.wall.saturating_sub(mono_gap),
        })
    }
}

/// One session whose turn is running.
#[derive(Debug, Clone, Copy)]
struct InFlight {
    agent_id: AgentId,
    turn_seq: u64,
    /// Wall-clock time it (last) went `Running`.
    since_wall: Duration,
    /// Already named in a notice; one per turn is enough.
    warned: bool,
}

struct State {
    detector: GapDetector,
    running: HashMap<String, InFlight>,
}

/// Tracks running turns from the delta stream and turns a detected sleep into
/// [`SessionDelta::SleptMidTurn`] envelopes for them.
pub struct SleepWatch {
    clock: Arc<dyn Clock>,
    state: Mutex<State>,
}

impl SleepWatch {
    pub fn new() -> Self {
        Self::with_clock(Arc::new(SystemClock::new()), SLEEP_THRESHOLD)
    }

    pub fn with_clock(clock: Arc<dyn Clock>, threshold: Duration) -> Self {
        let mut detector = GapDetector::new(threshold);
        // Prime it, so the first delta is compared against startup rather than
        // being swallowed as the first reading.
        detector.observe(clock.read());
        Self {
            clock,
            state: Mutex::new(State {
                detector,
                running: HashMap::new(),
            }),
        }
    }

    /// Read the clocks and name every turn a sleep since the last reading
    /// interrupted. The background tick.
    pub fn tick(&self) -> Vec<SessionDeltaEnvelope> {
        let now = self.clock.read();
        let mut state = self.state.lock();
        Self::check(&mut state, now)
    }

    /// Follow one delta. Returns the notices to deliver BEFORE it — so a turn
    /// that fails on waking shows why before it shows the failure.
    pub fn observe(&self, envelope: &SessionDeltaEnvelope) -> Vec<SessionDeltaEnvelope> {
        let now = self.clock.read();
        let mut state = self.state.lock();
        let notices = Self::check(&mut state, now);
        let sid = envelope.session_id.as_str();
        match &envelope.delta {
            SessionDelta::Status { status, turn_seq } => {
                if *status == SessionStatus::Running {
                    let same_turn = state
                        .running
                        .get(sid)
                        .is_some_and(|f| f.turn_seq == *turn_seq);
                    if !same_turn {
                        state.running.insert(
                            sid.to_string(),
                            InFlight {
                                agent_id: envelope.agent_id,
                                turn_seq: *turn_seq,
                                since_wall: now.wall,
                                warned: false,
                            },
                        );
                    }
                } else {
                    // Waiting (nothing streams while the user decides), idle
                    // or error: not running. A stale status from a superseded
                    // turn is ignored, as keep-awake does.
                    Self::stop(&mut state, sid, *turn_seq);
                }
            }
            SessionDelta::TurnFinished { turn_seq, .. }
            | SessionDelta::TurnFailed { turn_seq, .. } => Self::stop(&mut state, sid, *turn_seq),
            SessionDelta::AgentDisconnected { .. } => {
                state.running.remove(sid);
            }
            _ => {}
        }
        notices
    }

    /// The session ended without a terminal status (dropped, its agent
    /// killed, the app quitting).
    pub fn session_ended(&self, session_id: &str) {
        self.state.lock().running.remove(session_id);
    }

    fn stop(state: &mut State, session_id: &str, turn_seq: u64) {
        let stale = turn_seq != 0
            && state
                .running
                .get(session_id)
                .is_some_and(|f| turn_seq < f.turn_seq);
        if !stale {
            state.running.remove(session_id);
        }
    }

    fn check(state: &mut State, now: Reading) -> Vec<SessionDeltaEnvelope> {
        let Some(slept) = state.detector.observe(now) else {
            return Vec::new();
        };
        tracing::info!(
            target: "atlas::sleep_watch",
            "the computer slept for ~{}s; {} turn(s) running",
            slept.duration.as_secs(),
            state.running.len()
        );
        let mut out = Vec::new();
        for (session_id, flight) in &mut state.running {
            if flight.warned || flight.since_wall > slept.woke_after {
                continue;
            }
            flight.warned = true;
            out.push(SessionDeltaEnvelope {
                agent_id: flight.agent_id,
                session_id: session_id.clone(),
                delta: SessionDelta::SleptMidTurn {
                    turn_seq: flight.turn_seq,
                    slept_secs: slept.duration.as_secs(),
                },
            });
        }
        out
    }
}

impl Default for SleepWatch {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    /// A clock the test moves by hand: `awake` advances both clocks, `sleep`
    /// only the wall clock — which is what a suspended machine looks like.
    struct FakeClock(Mutex<Reading>);

    impl FakeClock {
        fn new() -> Arc<Self> {
            Arc::new(Self(Mutex::new(Reading {
                mono: Duration::from_secs(100),
                wall: Duration::from_secs(1_800_000_000),
            })))
        }
        fn awake(&self, secs: u64) {
            let mut r = self.0.lock();
            r.mono += Duration::from_secs(secs);
            r.wall += Duration::from_secs(secs);
        }
        fn sleep(&self, secs: u64) {
            self.0.lock().wall += Duration::from_secs(secs);
        }
        fn step_wall_back(&self, secs: u64) {
            self.0.lock().wall -= Duration::from_secs(secs);
        }
    }

    impl Clock for FakeClock {
        fn read(&self) -> Reading {
            *self.0.lock()
        }
    }

    fn watch(clock: &Arc<FakeClock>) -> SleepWatch {
        SleepWatch::with_clock(clock.clone(), SLEEP_THRESHOLD)
    }

    fn env(session: &str, delta: SessionDelta) -> SessionDeltaEnvelope {
        SessionDeltaEnvelope {
            agent_id: AgentId(Uuid::nil()),
            session_id: session.into(),
            delta,
        }
    }

    fn status(session: &str, status: SessionStatus, turn_seq: u64) -> SessionDeltaEnvelope {
        env(session, SessionDelta::Status { status, turn_seq })
    }

    fn chunk(session: &str) -> SessionDeltaEnvelope {
        env(
            session,
            SessionDelta::TextChunk {
                message_id: "m".into(),
                delta: "x".into(),
            },
        )
    }

    fn named(notices: &[SessionDeltaEnvelope]) -> Vec<(String, u64)> {
        let mut out: Vec<_> = notices
            .iter()
            .map(|n| match n.delta {
                SessionDelta::SleptMidTurn { turn_seq, .. } => (n.session_id.clone(), turn_seq),
                ref other => panic!("not a sleep notice: {other:?}"),
            })
            .collect();
        out.sort();
        out
    }

    #[test]
    fn the_detector_sees_the_wall_clock_run_ahead() {
        let mut d = GapDetector::new(SLEEP_THRESHOLD);
        let mut r = Reading {
            mono: Duration::from_secs(10),
            wall: Duration::from_secs(1_000),
        };
        assert_eq!(
            d.observe(r),
            None,
            "the first reading has nothing to compare"
        );
        r.mono += Duration::from_secs(3);
        r.wall += Duration::from_secs(3 + 600);
        let slept = d.observe(r).expect("a sleep");
        assert_eq!(slept.duration, Duration::from_secs(600));
        assert_eq!(slept.woke_after, r.wall - Duration::from_secs(3));
    }

    #[test]
    fn a_long_awake_gap_is_not_a_sleep() {
        // A stalled tick or a throttled background app: both clocks moved.
        let mut d = GapDetector::new(SLEEP_THRESHOLD);
        let mut r = Reading {
            mono: Duration::ZERO,
            wall: Duration::from_secs(1_000),
        };
        d.observe(r);
        r.mono += Duration::from_secs(120);
        r.wall += Duration::from_secs(120);
        assert_eq!(d.observe(r), None);
    }

    #[test]
    fn a_gap_under_the_threshold_is_not_a_sleep() {
        let mut d = GapDetector::new(SLEEP_THRESHOLD);
        let mut r = Reading {
            mono: Duration::ZERO,
            wall: Duration::from_secs(1_000),
        };
        d.observe(r);
        r.wall += SLEEP_THRESHOLD - Duration::from_secs(1);
        assert_eq!(d.observe(r), None);
    }

    #[test]
    fn a_wall_clock_stepped_back_is_not_a_sleep() {
        let clock = FakeClock::new();
        let w = watch(&clock);
        w.observe(&status("s1", SessionStatus::Running, 1));
        clock.step_wall_back(3_600);
        assert!(w.tick().is_empty());
    }

    #[test]
    fn a_running_turn_is_named_once() {
        let clock = FakeClock::new();
        let w = watch(&clock);
        w.observe(&status("s1", SessionStatus::Running, 4));
        clock.awake(2);
        clock.sleep(900);
        clock.awake(1);
        let notices = w.tick();
        assert_eq!(named(&notices), vec![("s1".to_string(), 4)]);
        let SessionDelta::SleptMidTurn { slept_secs, .. } = notices[0].delta else {
            unreachable!()
        };
        assert_eq!(slept_secs, 900);

        // A second sleep in the same turn does not say it again.
        clock.sleep(900);
        assert!(w.tick().is_empty());
    }

    #[test]
    fn the_notice_comes_before_the_failure_it_explains() {
        let clock = FakeClock::new();
        let w = watch(&clock);
        w.observe(&status("s1", SessionStatus::Running, 1));
        clock.sleep(300);
        // No tick ran: the failure on waking is the first reading.
        let failed = env(
            "s1",
            SessionDelta::TurnFailed {
                error: "error decoding response body".into(),
                turn_seq: 1,
                error_kind: None,
            },
        );
        assert_eq!(named(&w.observe(&failed)), vec![("s1".to_string(), 1)]);
        // And the turn is over now.
        clock.sleep(300);
        assert!(w.tick().is_empty());
    }

    #[test]
    fn idle_sessions_and_waiting_turns_are_not_named() {
        let clock = FakeClock::new();
        let w = watch(&clock);
        w.observe(&status("done", SessionStatus::Running, 1));
        w.observe(&env(
            "done",
            SessionDelta::TurnFinished {
                stop_reason: "end_turn".into(),
                turn_seq: 1,
                started_at_ms: None,
                ended_at_ms: None,
                worked_ms: None,
            },
        ));
        w.observe(&status("asking", SessionStatus::Running, 1));
        w.observe(&status("asking", SessionStatus::Waiting, 1));
        w.observe(&status("live", SessionStatus::Running, 7));
        clock.sleep(60);
        assert_eq!(named(&w.tick()), vec![("live".to_string(), 7)]);
    }

    #[test]
    fn a_turn_started_after_waking_is_not_blamed() {
        let clock = FakeClock::new();
        let w = watch(&clock);
        w.observe(&status("before", SessionStatus::Running, 1));
        clock.awake(1);
        clock.sleep(600);
        // Woke, and a second later a new turn starts — before any reading
        // noticed the sleep. Its own status delta is that first reading, so
        // the sleep is attributed before it is even tracked…
        clock.awake(1);
        let notices = w.observe(&status("after", SessionStatus::Running, 1));
        assert_eq!(named(&notices), vec![("before".to_string(), 1)]);

        // …and the same holds when something else took the reading first.
        let clock = FakeClock::new();
        let w = watch(&clock);
        w.observe(&status("before", SessionStatus::Running, 1));
        clock.awake(1);
        clock.sleep(600);
        clock.awake(1);
        w.state.lock().running.insert(
            "after".into(),
            InFlight {
                agent_id: AgentId(Uuid::nil()),
                turn_seq: 1,
                since_wall: clock.read().wall,
                warned: false,
            },
        );
        clock.awake(1);
        assert_eq!(named(&w.tick()), vec![("before".to_string(), 1)]);
    }

    #[test]
    fn a_stale_terminal_does_not_end_a_newer_turn() {
        let clock = FakeClock::new();
        let w = watch(&clock);
        w.observe(&status("s1", SessionStatus::Running, 2));
        w.observe(&status("s1", SessionStatus::Idle, 1));
        clock.sleep(60);
        assert_eq!(named(&w.observe(&chunk("s1"))), vec![("s1".to_string(), 2)]);
    }

    #[test]
    fn a_new_turn_can_be_named_again() {
        let clock = FakeClock::new();
        let w = watch(&clock);
        w.observe(&status("s1", SessionStatus::Running, 1));
        clock.sleep(60);
        assert_eq!(w.tick().len(), 1);
        w.observe(&status("s1", SessionStatus::Idle, 1));
        w.observe(&status("s1", SessionStatus::Running, 2));
        clock.awake(1);
        clock.sleep(60);
        assert_eq!(named(&w.tick()), vec![("s1".to_string(), 2)]);
    }

    #[test]
    fn an_ended_or_disconnected_session_is_forgotten() {
        let clock = FakeClock::new();
        let w = watch(&clock);
        w.observe(&status("ended", SessionStatus::Running, 1));
        w.observe(&status("gone", SessionStatus::Running, 1));
        w.session_ended("ended");
        w.observe(&env(
            "gone",
            SessionDelta::AgentDisconnected {
                reason: "process died".into(),
            },
        ));
        clock.sleep(60);
        assert!(w.tick().is_empty());
    }
}
