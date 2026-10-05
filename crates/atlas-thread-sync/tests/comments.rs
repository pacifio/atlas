//! Line comments on a Shared Thread's files (ATL-413, ATL-416) through the
//! crate's API: a `thread_range` anchor is two Yjs relative positions into the
//! file's text. Made here, it must resolve on the web and the reverse, follow
//! its text through edits above it and through a rename, and resolve to
//! nothing — outdated — once its text is deleted.

use std::fs;
use std::sync::Arc;
use std::time::Duration;

use atlas_thread_sync::doc::{random_client_id, FileDoc, LineSpan, RangeAnchor};
use atlas_thread_sync::{FakeThreadServer, FakeTransport, LocalChange, ThreadSession};
use base64::Engine as _;

mod common;
use common::*;

const QUIET: Duration = Duration::from_millis(50);
const TEXT: &str = "one\ntwo\nthree\nfour\n";

/// What the web's `yjs` writes for [`TEXT`], built under the seed client in
/// one insert — the same items the desktop's seed makes — and the anchors its
/// `anchorLines` makes there (`apps/web/src/lib/thread-ranges.ts`).
const WEB_SEED: &str = "AQEBAAQBB2NvbnRlbnQTb25lCnR3bwp0aHJlZQpmb3VyCgA=";
const WEB_LINES_2_TO_3: (&str, &str) = ("AAEEAA==", "AAENQQ==");
const WEB_LINE_4: (&str, &str) = ("AAEOAA==", "AAESQQ==");

fn span(start: u32, end: u32) -> LineSpan {
    LineSpan { start, end }
}

fn seeded() -> FileDoc {
    let doc = FileDoc::new(random_client_id());
    for u in FileDoc::seed_updates(TEXT) {
        doc.apply(&u).unwrap();
    }
    doc
}

#[test]
fn an_anchor_made_here_is_byte_for_byte_what_the_web_makes() {
    let b64 = base64::engine::general_purpose::STANDARD;
    assert_eq!(b64.encode(&FileDoc::seed_updates(TEXT)[0]), WEB_SEED);
    let doc = seeded();
    assert_eq!(
        doc.anchor_lines(span(2, 3)),
        Some(RangeAnchor {
            start: WEB_LINES_2_TO_3.0.into(),
            end: WEB_LINES_2_TO_3.1.into(),
            quote: "two\nthree\n".into(),
        })
    );
    // And the web's anchors resolve here.
    assert_eq!(doc.resolve_lines(WEB_LINE_4.0, WEB_LINE_4.1), Some(span(4, 4)));
    assert_eq!(doc.resolve_lines(WEB_LINES_2_TO_3.0, WEB_LINES_2_TO_3.1), Some(span(2, 3)));
}

#[test]
fn an_anchor_follows_its_text_and_is_outdated_once_the_text_is_gone() {
    let doc = seeded();
    let anchor = doc.anchor_lines(span(3, 3)).unwrap();
    assert_eq!(anchor.quote, "three\n");

    // Lines typed above move it down; typing just after it does not widen
    // it. (`set_content` makes one replace between the common prefix and
    // suffix, so each edit here is the insertion a person would type.)
    doc.set_content("zero\none\ntwo\nthree\nfour\n");
    doc.set_content("zero\none\ntwo\nthree\nthree and a half\nfour\n");
    assert_eq!(doc.resolve_lines(&anchor.start, &anchor.end), Some(span(4, 4)));

    // Its text deleted: outdated, and the quote is what is left to show.
    doc.set_content("zero\none\ntwo\nfour\n");
    assert_eq!(doc.resolve_lines(&anchor.start, &anchor.end), None);

    // Lines the text does not have, and garbage, anchor or resolve nothing.
    assert_eq!(doc.anchor_lines(span(9, 9)), None);
    assert_eq!(doc.anchor_lines(span(3, 2)), None);
    assert_eq!(doc.resolve_lines("not base64!", &anchor.end), None);
}

async fn pair() -> (
    World,
    ThreadSession<FakeTransport>,
    ThreadSession<FakeTransport>,
    std::path::PathBuf,
) {
    let w = world();
    let server = FakeThreadServer::new();
    let mut joy = open(&server, &w.joy, &w.base, &w.replicas.join("joy"), "joy").await;
    joy.set_store(Arc::new(server.store()));
    joy.share_working_changes(&w.joy, &[]).await.unwrap();
    let mut monzim = open(&server, &w.monzim, &w.base, &w.replicas.join("monzim"), "monzim").await;
    monzim.set_store(Arc::new(server.store()));
    monzim.pump(QUIET).await.unwrap();
    let joy_root = joy.materialize().await.unwrap();
    (w, joy, monzim, joy_root)
}

#[tokio::test]
async fn a_comment_anchored_on_one_replica_stays_on_its_text_on_another_through_edits_and_a_rename() {
    let (_w, mut joy, mut monzim, joy_root) = pair().await;
    // Monzim comments on `color: green;`, line 2 of the banner.
    let (file_id, anchor) = monzim
        .anchor_range("src/banner.css", span(2, 2))
        .unwrap();
    assert_eq!(anchor.quote, "  color: green;\n");
    let range = |a: &RangeAnchor| vec![(file_id, a.start.clone(), a.end.clone())];

    // Joy, on her replica, sees it on the same line.
    joy.pump(QUIET).await.unwrap();
    assert_eq!(joy.resolve_ranges(&range(&anchor)), vec![Some(span(2, 2))]);

    // She adds a comment line above it, then moves the file.
    write(&joy_root, "src/banner.css", "/* brand */\n.banner {\n  color: green;\n}\n");
    joy.file_saved("src/banner.css").await.unwrap();
    fs::rename(joy_root.join("src/banner.css"), joy_root.join("src/brand.css")).unwrap();
    assert!(matches!(
        joy.file_saved("src/brand.css").await.unwrap(),
        LocalChange::Renamed { .. }
    ));
    joy.file_saved("src/banner.css").await.unwrap();
    joy.settle_removals().await.unwrap();

    monzim.pump(QUIET).await.unwrap();
    assert_eq!(monzim.replica().file_id("src/brand.css"), Some(file_id));
    assert_eq!(monzim.resolve_ranges(&range(&anchor)), vec![Some(span(3, 3))]);

    // She deletes the line: outdated everywhere.
    write(&joy_root, "src/brand.css", "/* brand */\n.banner {\n}\n");
    joy.file_saved("src/brand.css").await.unwrap();
    monzim.pump(QUIET).await.unwrap();
    assert_eq!(monzim.resolve_ranges(&range(&anchor)), vec![None]);
    assert_eq!(joy.resolve_ranges(&range(&anchor)), vec![None]);

    // A path the thread does not hold as text anchors nothing.
    assert!(monzim.anchor_range("nope.css", span(1, 1)).is_none());
}
