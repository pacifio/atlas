//! The HTTP seam.
//!
//! Zed threads an `Arc<dyn HttpClient>` through its registry store and its
//! downloader so tests can answer with a canned body. Same shape here, for the
//! same reason: without it every test of the registry parser or the checksum
//! path would be a network test.
//!
//! Responses are streamed rather than buffered because the same client fetches
//! a 2 KB registry index and a 200 MB agent archive.

use std::io;
use std::time::Duration;

use anyhow::{anyhow, Context as _, Result};
use futures::future::BoxFuture;
use futures::stream::BoxStream;
use futures::{StreamExt as _, TryStreamExt as _};

/// A response body, as it arrives.
pub type ByteStream = BoxStream<'static, io::Result<Vec<u8>>>;

pub struct HttpResponse {
    pub status: u16,
    pub body: ByteStream,
}

impl HttpResponse {
    pub async fn read_to_end(self) -> Result<Vec<u8>> {
        let mut body = self.body;
        let mut bytes = Vec::new();
        while let Some(chunk) = body.next().await {
            bytes.extend_from_slice(&chunk?);
        }
        Ok(bytes)
    }
}

pub trait HttpClient: Send + Sync {
    fn get(&self, url: &str) -> BoxFuture<'static, Result<HttpResponse>>;
}

/// GET a whole body, giving up after `timeout`.
///
/// Zed wraps the request *and* the body read in one timeout
/// (`agent_registry_store.rs:530-560`), because the shared client only has a
/// connect timeout and a stalled body read would otherwise hang forever.
pub async fn get_body(
    client: &dyn HttpClient,
    url: &str,
    timeout: Duration,
) -> Result<(u16, Vec<u8>)> {
    let request = client.get(url);
    tokio::time::timeout(timeout, async move {
        let response = request.await.with_context(|| format!("requesting {url}"))?;
        let status = response.status;
        let body = response
            .read_to_end()
            .await
            .with_context(|| format!("reading response from {url}"))?;
        Ok::<_, anyhow::Error>((status, body))
    })
    .await
    .map_err(|_| {
        anyhow!(
            "timed out after {}s while fetching {url}",
            timeout.as_secs()
        )
    })?
}

/// The real client.
///
/// A user agent is set because GitHub's release API rejects requests without
/// one, and the checksum-recovery path calls it.
pub struct ReqwestClient {
    client: reqwest::Client,
}

impl ReqwestClient {
    pub fn new(user_agent: &str) -> Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .user_agent(user_agent.to_owned())
                .build()
                .context("building the HTTP client")?,
        })
    }
}

impl HttpClient for ReqwestClient {
    fn get(&self, url: &str) -> BoxFuture<'static, Result<HttpResponse>> {
        let request = self.client.get(url).send();
        Box::pin(async move {
            let response = request.await?;
            let status = response.status().as_u16();
            let body = response
                .bytes_stream()
                .map_ok(|chunk| chunk.to_vec())
                .map_err(io::Error::other)
                .boxed();
            Ok(HttpResponse { status, body })
        })
    }
}
