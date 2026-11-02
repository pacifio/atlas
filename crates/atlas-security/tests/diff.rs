use atlas_security::diff::{parse_unified, FileStatus, LineKind};

fn added(file: &atlas_security::diff::FileChange) -> Vec<(u32, String)> {
    file.hunks
        .iter()
        .flat_map(|h| &h.lines)
        .filter(|l| l.kind == LineKind::Added)
        .map(|l| (l.new_no.unwrap(), l.text.clone()))
        .collect()
}

#[test]
fn parses_added_lines_with_new_line_numbers() {
    let diff = b"diff --git a/src/main.rs b/src/main.rs
index 1111111..2222222 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -10,2 +10,3 @@ fn main()
     let a = 1;
+    let b = 2;
     let c = 3;
";
    let files = parse_unified(diff);
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "src/main.rs");
    assert_eq!(files[0].status, FileStatus::Modified);
    assert_eq!(files[0].hunks[0].context.as_deref(), Some("fn main()"));
    assert_eq!(added(&files[0]), vec![(11, "    let b = 2;".to_string())]);
    let context: Vec<_> = files[0].hunks[0]
        .lines
        .iter()
        .filter(|l| l.kind == LineKind::Context)
        .map(|l| (l.old_no, l.new_no))
        .collect();
    assert_eq!(context, vec![(Some(10), Some(10)), (Some(11), Some(12))]);
}

#[test]
fn parses_rename_with_edits() {
    let diff = b"diff --git a/a.rs b/b.rs
similarity index 90%
rename from a.rs
rename to b.rs
index 1111111..2222222 100644
--- a/a.rs
+++ b/b.rs
@@ -1 +1,2 @@
 fn a() {}
+fn b() {}
";
    let files = parse_unified(diff);
    assert_eq!(files[0].path, "b.rs");
    assert_eq!(
        files[0].status,
        FileStatus::Renamed {
            from: "a.rs".to_string()
        }
    );
    assert_eq!(added(&files[0]), vec![(2, "fn b() {}".to_string())]);
}

#[test]
fn parses_deletion_and_new_file() {
    let diff = b"diff --git a/old.txt b/old.txt
deleted file mode 100644
index 1111111..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello
";
    let files = parse_unified(diff);
    assert_eq!(files.len(), 2);
    assert_eq!(files[0].path, "old.txt");
    assert_eq!(files[0].status, FileStatus::Deleted);
    assert_eq!(files[1].path, "new.txt");
    assert_eq!(files[1].status, FileStatus::Added);
    assert_eq!(added(&files[1]), vec![(1, "hello".to_string())]);
}

#[test]
fn binary_file_has_no_hunks() {
    let diff = b"diff --git a/x.png b/x.png
index 1111111..2222222 100644
Binary files a/x.png and b/x.png differ
";
    let files = parse_unified(diff);
    assert_eq!(files[0].path, "x.png");
    assert!(files[0].binary);
    assert!(files[0].hunks.is_empty());
}

#[test]
fn mode_only_change_has_no_hunks() {
    let diff = b"diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
";
    let files = parse_unified(diff);
    assert_eq!(files[0].path, "run.sh");
    assert_eq!(files[0].status, FileStatus::Modified);
    assert!(files[0].hunks.is_empty());
}

#[test]
fn crlf_and_no_newline_marker() {
    let diff = b"diff --git a/w.txt b/w.txt
--- a/w.txt
+++ b/w.txt
@@ -1 +1 @@
-old\r
\\ No newline at end of file
+new\r
\\ No newline at end of file
";
    let files = parse_unified(diff);
    let lines = &files[0].hunks[0].lines;
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0].text, "old");
    assert_eq!(lines[1].text, "new");
}

#[test]
fn non_utf8_bytes_do_not_panic() {
    let mut diff = b"diff --git a/b.bin b/b.bin
--- a/b.bin
+++ b/b.bin
@@ -0,0 +1 @@
+ok "
        .to_vec();
    diff.extend_from_slice(&[0xff, 0xfe]);
    diff.push(b'\n');
    let files = parse_unified(&diff);
    assert!(added(&files[0])[0].1.contains('\u{FFFD}'));
}

#[test]
fn multiple_files_and_hunks() {
    let diff = b"diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,2 @@
 a
+b
@@ -20,1 +21,2 @@ function f()
 c
+d
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -5 +5,2 @@
 x
+y
@@ -9 +10,2 @@
 z
+w
";
    let files = parse_unified(diff);
    assert_eq!(files.len(), 2);
    assert_eq!(files[0].hunks.len(), 2);
    assert_eq!(files[1].hunks.len(), 2);
    assert_eq!(
        added(&files[0]),
        vec![(2, "b".to_string()), (22, "d".to_string())]
    );
    assert_eq!(files[0].hunks[1].context.as_deref(), Some("function f()"));
    assert_eq!(files[0].hunks[0].context, None);
    assert_eq!(
        added(&files[1]),
        vec![(6, "y".to_string()), (11, "w".to_string())]
    );
}
