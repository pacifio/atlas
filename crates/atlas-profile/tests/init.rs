//! `init` in a process of its own: an integration test is its own binary, so
//! fixing the profile here cannot leak into the unit tests, which rely on
//! never having called it.

use atlas_profile::{current, dir_in, dir_name, init, is_dev, Profile};
use std::path::Path;

#[test]
fn init_fixes_the_profile_for_the_whole_process() {
    init(Profile::Dev);
    assert_eq!(current(), Profile::Dev);
    assert!(is_dev());
    assert_eq!(dir_name(), ".atlas-dev");
    assert_eq!(dir_in(Path::new("/p")), Path::new("/p").join(".atlas-dev"));

    // Idempotent for the same profile...
    init(Profile::Dev);

    // ...and loud for a different one: a second answer to "whose data is
    // this" would split one process's writes across two profiles.
    let changed = std::panic::catch_unwind(|| init(Profile::Default));
    assert!(changed.is_err());
    assert_eq!(current(), Profile::Dev);
}
