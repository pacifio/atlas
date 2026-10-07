//! A path resolved before `init` settled on the default profile; a later
//! `init(Dev)` must refuse rather than leave that path pointing into the
//! released app's data. Its own binary, for the same reason as `init.rs`.

use atlas_profile::{current, init, Profile};

#[test]
fn a_dev_init_after_a_read_panics() {
    assert_eq!(current(), Profile::Default);
    let late = std::panic::catch_unwind(|| init(Profile::Dev));
    assert!(late.is_err());
    assert_eq!(current(), Profile::Default);
}

#[test]
fn a_default_init_after_a_read_is_fine() {
    // What every release build does if anything reads the profile early.
    assert_eq!(current(), Profile::Default);
    init(Profile::Default);
}
