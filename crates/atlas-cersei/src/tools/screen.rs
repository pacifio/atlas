//! Turn raw PTY bytes into what a reader would actually see.
//!
//! A PTY carries the *instructions* a terminal follows, not the text it ends up
//! showing. `npm install` renders a spinner by emitting, thousands of times,
//! `ESC[1G` (cursor to column 1), `ESC[0K` (erase to end of line), and one
//! character. Handing that stream to a model verbatim spends its entire context
//! on cursor movements: one observed session reached 172.8K tokens, almost all
//! of it escape sequences describing a spinner that, rendered, is a single line.
//!
//! Worse, the raw bytes also *evict* real output — the ring is capped, so a
//! chatty spinner pushes the error message that followed it off the front.
//! Rendering therefore happens on the way **in**, not on the way out.
//!
//! This is deliberately **not** a terminal emulator. It models one line at a
//! time: the cursor moves within the current line, and a newline commits it.
//! Row addressing, scroll regions and alternate screens are not modelled, and
//! anything unrecognised is dropped rather than guessed at — dropping a colour
//! code loses nothing a model needed, where guessing at cursor geometry would
//! silently corrupt the transcript.

use std::collections::VecDeque;

/// Bytes of rendered output a session may hold before the oldest is dropped.
const RETAIN_BYTES: usize = 256 * 1024;

/// A partial escape sequence longer than this is not one — resume as text so a
/// stray `ESC` cannot swallow the rest of the stream.
const MAX_ESCAPE: usize = 64;

/// A line this long is committed as it stands. Without it a stream carrying no
/// newline at all — `cat` of a binary, a minified bundle — would grow the line
/// in progress without bound, and the whole point of draining incrementally is
/// that memory stays flat.
const MAX_LINE: usize = 64 * 1024;

#[derive(Default)]
enum Mode {
    #[default]
    Text,
    /// Saw `ESC`, waiting to learn which kind.
    Escape,
    /// Inside `ESC[…` — ends at a byte in `0x40..=0x7E`.
    Csi,
    /// Inside `ESC]…` — ends at BEL or `ESC\`.
    Osc,
}

/// Rendered output a session has produced but not yet handed to the model.
pub struct Screen {
    /// Committed lines, oldest first.
    lines: VecDeque<Vec<u8>>,
    /// The line being written.
    cur: Vec<u8>,
    /// Cursor position within `cur`, as a byte offset.
    col: usize,
    mode: Mode,
    /// Parameter bytes of the sequence being parsed.
    seq: Vec<u8>,
    retained: usize,
    /// Bytes of *rendered* output dropped because the buffer was full.
    dropped: u64,
}

impl Default for Screen {
    fn default() -> Self {
        Self::new()
    }
}

impl Screen {
    pub fn new() -> Self {
        Self {
            lines: VecDeque::new(),
            cur: Vec::new(),
            col: 0,
            mode: Mode::Text,
            seq: Vec::new(),
            retained: 0,
            dropped: 0,
        }
    }

    /// Feed a chunk straight off the PTY. Escape sequences may be split across
    /// chunks; the parser keeps its state, so they are handled either way.
    pub fn push(&mut self, chunk: &[u8]) {
        for &b in chunk {
            match self.mode {
                Mode::Text => self.text_byte(b),
                Mode::Escape => match b {
                    b'[' => self.mode = Mode::Csi,
                    b']' => self.mode = Mode::Osc,
                    // A two-byte escape (`ESC =`, `ESC >`, charset selects).
                    _ => self.mode = Mode::Text,
                },
                Mode::Csi => {
                    if (0x40..=0x7e).contains(&b) {
                        self.csi(b);
                        self.seq.clear();
                        self.mode = Mode::Text;
                    } else if self.seq.len() >= MAX_ESCAPE {
                        // Not a real sequence. Resume rather than swallow.
                        self.seq.clear();
                        self.mode = Mode::Text;
                        self.text_byte(b);
                    } else {
                        self.seq.push(b);
                    }
                }
                Mode::Osc => {
                    // A window title tells the model nothing; drop it whole.
                    // Ends at BEL or the ESC of a string terminator — or, if
                    // neither ever arrives, at a length no real one reaches.
                    let terminated = b == 0x07 || b == 0x1b;
                    if terminated || self.seq.len() >= MAX_ESCAPE * 8 {
                        self.seq.clear();
                        self.mode = Mode::Text;
                    } else {
                        self.seq.push(b);
                    }
                }
            }
        }
        self.trim();
    }

    fn text_byte(&mut self, b: u8) {
        match b {
            0x1b => self.mode = Mode::Escape,
            b'\n' => self.commit(),
            // The oldest way to draw a progress line: back to the start and
            // write over it.
            b'\r' => self.col = 0,
            0x08 => self.col = self.col.saturating_sub(1),
            // Bell, and the vertical movements a line-oriented renderer has no
            // place to put.
            0x07 | 0x0b | 0x0c => {}
            _ => self.write(b),
        }
    }

    fn write(&mut self, b: u8) {
        if self.cur.len() >= MAX_LINE {
            self.commit();
        }
        if self.col < self.cur.len() {
            self.cur[self.col] = b;
        } else {
            // A cursor moved past the end pads with spaces, exactly as a real
            // terminal would.
            while self.cur.len() < self.col {
                self.cur.push(b' ');
            }
            self.cur.push(b);
        }
        self.col += 1;
    }

    /// The numeric parameters of the sequence being parsed.
    fn params(&self) -> Vec<usize> {
        String::from_utf8_lossy(&self.seq)
            .split(';')
            .map(|p| p.trim().parse::<usize>().unwrap_or(0))
            .collect()
    }

    fn csi(&mut self, final_byte: u8) {
        let p = self.params();
        let first = p.first().copied().unwrap_or(0);
        match final_byte {
            // CHA — cursor to an absolute column. `ESC[1G` is half of every
            // spinner frame.
            b'G' | b'`' => self.col = first.saturating_sub(1).min(MAX_LINE),
            // CUB / CUF — relative moves within the line.
            b'D' => self.col = self.col.saturating_sub(first.max(1)),
            b'C' => self.col = (self.col + first.max(1)).min(MAX_LINE),
            // CUP — row addressing is not modelled, but the column is.
            b'H' | b'f' => {
                self.col = p.get(1).copied().unwrap_or(1).saturating_sub(1).min(MAX_LINE)
            }
            // EL — erase in line. The other half of a spinner frame.
            b'K' => match first {
                1 => {
                    for i in 0..self.col.min(self.cur.len()) {
                        self.cur[i] = b' ';
                    }
                }
                2 => self.cur.clear(),
                // 0 and the default: from the cursor to the end.
                _ => self.cur.truncate(self.col.min(self.cur.len())),
            },
            // ED — erase display. Only the current line is touched: committed
            // output is what the model came for, and a `clear` must not take
            // the build error above it.
            b'J' => self.cur.truncate(self.col.min(self.cur.len())),
            // Colours, styles, mode sets, everything else: nothing a reader of
            // the text needs.
            _ => {}
        }
    }

    fn commit(&mut self) {
        let line = std::mem::take(&mut self.cur);
        self.retained += line.len() + 1;
        self.lines.push_back(line);
        self.col = 0;
    }

    fn trim(&mut self) {
        while self.retained > RETAIN_BYTES {
            match self.lines.pop_front() {
                Some(line) => {
                    let n = line.len() + 1;
                    self.retained -= n;
                    self.dropped += n as u64;
                }
                None => break,
            }
        }
    }

    pub fn is_empty(&self) -> bool {
        self.lines.is_empty() && self.cur.is_empty()
    }

    /// Take the lines completed so far, leaving the line in progress alone.
    ///
    /// This is what lets a caller drain every chunk it reads without breaking
    /// the rendering: a progress line is rewritten in place across many reads
    /// and only becomes a line when a newline arrives, so taking it early would
    /// emit one copy of it per read — which is the accumulation this module
    /// exists to prevent.
    pub fn take_committed(&mut self) -> String {
        let mut out = String::new();
        for line in self.lines.drain(..) {
            self.retained -= line.len() + 1;
            out.push_str(&String::from_utf8_lossy(&line));
            out.push('\n');
        }
        out
    }

    /// Take everything rendered so far. Delivered output is removed, so a
    /// second call returns only what is new.
    ///
    /// The line in progress is included — a prompt or a progress line that has
    /// not ended in a newline is often the only thing worth reading.
    pub fn take(&mut self) -> (String, u64) {
        let mut out = String::new();
        for line in self.lines.drain(..) {
            out.push_str(&String::from_utf8_lossy(&line));
            out.push('\n');
        }
        if !self.cur.is_empty() {
            out.push_str(&String::from_utf8_lossy(&self.cur));
            self.cur.clear();
            self.col = 0;
        }
        self.retained = 0;
        (out, std::mem::take(&mut self.dropped))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(chunks: &[&[u8]]) -> String {
        let mut s = Screen::new();
        for c in chunks {
            s.push(c);
        }
        s.take().0
    }

    #[test]
    fn plain_output_is_untouched() {
        assert_eq!(render(&[b"hello\nworld\n"]), "hello\nworld\n");
    }

    #[test]
    fn an_npm_spinner_collapses_to_the_line_it_draws() {
        // The exact shape observed in the wild: cursor to column 1, erase to
        // end of line, one character — thousands of times.
        let mut raw = Vec::new();
        for frame in 0..5_000 {
            raw.extend_from_slice(b"\x1b[1G\x1b[0K");
            raw.push(b"|/-\\"[frame % 4]);
        }
        raw.extend_from_slice(b"\x1b[1G\x1b[0Kadded 312 packages\n");

        let out = render(&[&raw]);
        assert_eq!(out, "added 312 packages\n");
        assert!(
            raw.len() > 40_000 && out.len() < 40,
            "{} bytes of spinner rendered to {}",
            raw.len(),
            out.len()
        );
    }

    #[test]
    fn carriage_return_progress_overwrites_rather_than_accumulates() {
        let out = render(&[b"  0%\r 50%\r100%\rdone\n"]);
        assert_eq!(out, "done\n");
    }

    #[test]
    fn a_shorter_overwrite_does_not_leave_the_old_tail_behind() {
        // Without the erase, a real terminal *would* leave it — so the erase is
        // what has to be honoured, not the overwrite alone.
        assert_eq!(render(&[b"downloading\rok\x1b[0K\n"]), "ok\n");
        assert_eq!(render(&[b"downloading\rok\n"]), "okwnloading\n");
    }

    #[test]
    fn colours_are_dropped_and_their_text_kept() {
        assert_eq!(
            render(&[b"\x1b[31mERROR\x1b[0m: build failed\n"]),
            "ERROR: build failed\n"
        );
    }

    #[test]
    fn a_window_title_is_dropped_whole() {
        assert_eq!(render(&[b"\x1b]0;npm install\x07real output\n"]), "real output\n");
    }

    #[test]
    fn an_escape_split_across_chunks_is_still_handled() {
        // The PTY read boundary lands wherever it lands.
        assert_eq!(render(&[b"aaa\x1b", b"[1G\x1b[0K", b"bbb\n"]), "bbb\n");
        assert_eq!(render(&[b"x\x1b[", b"31mred\x1b[0m\n"]), "xred\n");
    }

    #[test]
    fn a_stray_escape_does_not_swallow_the_rest_of_the_stream() {
        let long: Vec<u8> = [b"\x1b[".as_slice(), &[b'0'; 200], b"important\n"].concat();
        let out = render(&[&long]);
        assert!(out.contains("important"), "{out:?}");
    }

    #[test]
    fn a_clear_screen_does_not_take_the_output_above_it() {
        // Losing a build error to a `clear` is worse than showing stale text.
        let out = render(&[b"error: undefined symbol\n\x1b[2J\x1b[Hnext line\n"]);
        assert!(out.contains("error: undefined symbol"), "{out:?}");
        assert!(out.contains("next line"), "{out:?}");
    }

    #[test]
    fn a_line_still_in_progress_is_delivered() {
        // A prompt waiting for input never ends in a newline, and is exactly
        // what the model needs to see.
        assert_eq!(render(&[b"Ok to proceed? (y) "]), "Ok to proceed? (y) ");
    }

    #[test]
    fn draining_every_chunk_still_collapses_a_spinner_across_them() {
        // The caller that reads a pipe drains on every read to keep memory
        // flat. If that drain took the line in progress, each read would emit
        // its own copy of the progress line and the collapse would be undone.
        let mut s = Screen::new();
        let mut drained = String::new();
        for frame in 0..500 {
            s.push(b"\x1b[1G\x1b[0K");
            s.push(&[b"|/-\\"[frame % 4]]);
            drained.push_str(&s.take_committed());
        }
        assert_eq!(drained, "", "an unfinished line is not a line yet");
        s.push(b"\x1b[1G\x1b[0Kdone\n");
        drained.push_str(&s.take_committed());
        assert_eq!(drained, "done\n");
    }

    #[test]
    fn a_committed_line_is_handed_over_and_not_repeated() {
        let mut s = Screen::new();
        s.push(b"one\ntwo\nthr");
        assert_eq!(s.take_committed(), "one\ntwo\n");
        assert_eq!(s.take_committed(), "");
        s.push(b"ee\n");
        assert_eq!(s.take_committed(), "three\n");
    }

    #[test]
    fn a_stream_with_no_newline_does_not_grow_without_bound() {
        // `cat` of a binary, a minified bundle: nothing commits the line, so
        // the cap has to.
        let mut s = Screen::new();
        let mut total = 0usize;
        for _ in 0..64 {
            s.push(&[b'x'; 64 * 1024]);
            total += s.take_committed().len();
        }
        assert!(s.cur.len() <= MAX_LINE, "line in progress grew to {}", s.cur.len());
        assert!(total > 0, "a capped line must still be delivered");
    }

    #[test]
    fn a_wild_cursor_column_does_not_allocate_a_wild_line() {
        let mut s = Screen::new();
        s.push(b"\x1b[999999999Gx\n");
        assert!(s.take().0.len() <= MAX_LINE + 2);
    }

    #[test]
    fn taking_twice_returns_only_what_is_new() {
        let mut s = Screen::new();
        s.push(b"first\n");
        assert_eq!(s.take().0, "first\n");
        assert!(s.is_empty());
        s.push(b"second\n");
        assert_eq!(s.take().0, "second\n");
    }

    #[test]
    fn output_is_bounded_and_reports_what_it_dropped() {
        let mut s = Screen::new();
        for i in 0..200_000u32 {
            s.push(format!("line {i}\n").as_bytes());
        }
        let (text, dropped) = s.take();
        assert!(text.len() <= RETAIN_BYTES + 64, "{} bytes retained", text.len());
        assert!(dropped > 0, "a bounded buffer must say what it lost");
        assert!(text.contains("line 199999"), "the newest output must survive");
    }

    #[test]
    fn utf8_survives_a_round_trip() {
        assert_eq!(render(&[b"caf\xc3\xa9 \xe2\x9c\x93\n"]), "café ✓\n");
    }
}
