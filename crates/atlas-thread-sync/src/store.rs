//! The thread's object doors, as a session reaches them: blobs (Base content,
//! binary files, Thread Version copies), Base bundles, and compaction
//! snapshots — all under `/threads/{id}/…` in the app, a map in tests.
//!
//! A trait object rather than a type parameter, so a session can hold one for
//! its whole life without every caller naming it. The futures are boxed for
//! the same reason.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

/// A boxed, sendable future, so [`ObjectStore`] can be a trait object.
pub type StoreFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, StoreError>> + Send + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StoreError {
    /// The door refused with a reason the caller can act on — `limit_reached`
    /// for a bundle over the Organisation's limit, say.
    #[error("{code}: {message}")]
    Refused { code: String, message: String },
    #[error("not found")]
    NotFound,
    #[error("{0}")]
    Failed(String),
}

pub trait ObjectStore: Send + Sync {
    /// `PUT /threads/{id}/blobs/{sha256}`. Idempotent.
    fn put_blob(&self, sha256: String, bytes: Vec<u8>) -> StoreFuture<'_, ()>;
    /// `GET /threads/{id}/blobs/{sha256}`.
    fn get_blob(&self, sha256: String) -> StoreFuture<'_, Vec<u8>>;
    /// `PUT /threads/{id}/bundles/{sha256}?prerequisites=…`: the commits a
    /// joiner must already hold for the bundle to apply.
    fn put_bundle(
        &self,
        sha256: String,
        bytes: Vec<u8>,
        prerequisites: Vec<String>,
    ) -> StoreFuture<'_, ()>;
    /// `GET /threads/{id}/bundles/{sha256}`.
    fn get_bundle(&self, sha256: String) -> StoreFuture<'_, Vec<u8>>;
    /// `GET /threads/{id}/snapshots/{fileId}`: one file's compacted history
    /// as a single Yjs update (ATL-397).
    fn get_snapshot(&self, file_id: u64) -> StoreFuture<'_, Vec<u8>>;
}

/// No doors at all: every call fails. What a session holds until it is given
/// a store, so a test that never touches objects needs none.
pub struct NoStore;

fn unavailable<T: Send + 'static>() -> StoreFuture<'static, T> {
    Box::pin(async { Err(StoreError::Failed("no object store".into())) })
}

impl ObjectStore for NoStore {
    fn put_blob(&self, _: String, _: Vec<u8>) -> StoreFuture<'_, ()> {
        unavailable()
    }
    fn get_blob(&self, _: String) -> StoreFuture<'_, Vec<u8>> {
        unavailable()
    }
    fn put_bundle(&self, _: String, _: Vec<u8>, _: Vec<String>) -> StoreFuture<'_, ()> {
        unavailable()
    }
    fn get_bundle(&self, _: String) -> StoreFuture<'_, Vec<u8>> {
        unavailable()
    }
    fn get_snapshot(&self, _: u64) -> StoreFuture<'_, Vec<u8>> {
        unavailable()
    }
}

/// A bundle as the doors hold it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredBundle {
    pub bytes: Vec<u8>,
    pub prerequisites: Vec<String>,
}

#[derive(Default)]
struct Objects {
    blobs: HashMap<String, Vec<u8>>,
    bundles: HashMap<String, StoredBundle>,
    snapshots: HashMap<u64, Vec<u8>>,
    bundle_limit: Option<usize>,
    offline: bool,
}

/// An in-memory stand-in for the thread's object doors, with the real ones'
/// refusals: a bundle over the limit is `limit_reached`, and nothing answers
/// while it is offline. Shared by every clone, and by the
/// [`crate::FakeThreadServer`] it came from.
#[derive(Clone, Default)]
pub struct FakeStore {
    objects: Arc<Mutex<Objects>>,
}

impl FakeStore {
    pub fn blob(&self, sha256: &str) -> Option<Vec<u8>> {
        self.lock().blobs.get(sha256).cloned()
    }

    pub fn blobs(&self) -> usize {
        self.lock().blobs.len()
    }

    pub fn bundle(&self, sha256: &str) -> Option<StoredBundle> {
        self.lock().bundles.get(sha256).cloned()
    }

    /// Every bundle uploaded, as `(sha256, bundle)`.
    pub fn bundles(&self) -> Vec<(String, StoredBundle)> {
        let mut all: Vec<_> = self
            .lock()
            .bundles
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        all.sort_by(|a, b| a.0.cmp(&b.0));
        all
    }

    /// The Organisation's Base bundle limit, in bytes.
    pub fn set_bundle_limit(&self, bytes: Option<usize>) {
        self.lock().bundle_limit = bytes;
    }

    /// While offline, every door fails as a dropped network would.
    pub fn set_offline(&self, offline: bool) {
        self.lock().offline = offline;
    }

    pub(crate) fn put_snapshot(&self, file_id: u64, bytes: Vec<u8>) {
        self.lock().snapshots.insert(file_id, bytes);
    }

    pub(crate) fn snapshot(&self, file_id: u64) -> Option<Vec<u8>> {
        self.lock().snapshots.get(&file_id).cloned()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Objects> {
        self.objects.lock().expect("fake store")
    }

    fn answer<T: Send + 'static>(
        &self,
        read: impl FnOnce(&mut Objects) -> Result<T, StoreError>,
    ) -> StoreFuture<'static, T> {
        let result = {
            let mut objects = self.lock();
            if objects.offline {
                Err(StoreError::Failed("offline".into()))
            } else {
                read(&mut objects)
            }
        };
        Box::pin(async move { result })
    }
}

impl ObjectStore for FakeStore {
    fn put_blob(&self, sha256: String, bytes: Vec<u8>) -> StoreFuture<'_, ()> {
        self.answer(move |o| {
            o.blobs.insert(sha256, bytes);
            Ok(())
        })
    }

    fn get_blob(&self, sha256: String) -> StoreFuture<'_, Vec<u8>> {
        self.answer(move |o| o.blobs.get(&sha256).cloned().ok_or(StoreError::NotFound))
    }

    fn put_bundle(
        &self,
        sha256: String,
        bytes: Vec<u8>,
        prerequisites: Vec<String>,
    ) -> StoreFuture<'_, ()> {
        self.answer(move |o| {
            if let Some(limit) = o.bundle_limit {
                if bytes.len() > limit {
                    return Err(StoreError::Refused {
                        code: "limit_reached".into(),
                        message: format!(
                            "This bundle is {} bytes, more than your organisation's plan allows (Base bundle bytes: {limit}).",
                            bytes.len()
                        ),
                    });
                }
            }
            o.bundles.insert(
                sha256,
                StoredBundle {
                    bytes,
                    prerequisites,
                },
            );
            Ok(())
        })
    }

    fn get_bundle(&self, sha256: String) -> StoreFuture<'_, Vec<u8>> {
        self.answer(move |o| {
            o.bundles
                .get(&sha256)
                .map(|b| b.bytes.clone())
                .ok_or(StoreError::NotFound)
        })
    }

    fn get_snapshot(&self, file_id: u64) -> StoreFuture<'_, Vec<u8>> {
        self.answer(move |o| {
            o.snapshots
                .get(&file_id)
                .cloned()
                .ok_or(StoreError::NotFound)
        })
    }
}
