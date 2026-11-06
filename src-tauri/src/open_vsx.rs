//! Open VSX, the one remote source for themes: icon themes install from it
//! (`commands::icon_themes`) and colour themes import from it
//! (`commands::theme_import`).
//!
//! Everything here is explicitly invoked by a person in a dialog, bounded in
//! time and size, and fails with a message that dialog can show. **Nothing
//! here runs at startup**, and being offline costs a search, not a launch.

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Open VSX's public API. No key, no account.
const OPEN_VSX_API: &str = "https://open-vsx.org/api";

/// A search or a metadata read is a person waiting on a dialog.
const METADATA_TIMEOUT: Duration = Duration::from_secs(10);
/// A theme `.vsix` is ~1 MB for the largest published; a minute is generous.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
/// Past this, the payload is not a theme and the download is abandoned rather
/// than buffered. Material Icon Theme, the biggest by far, is 890 KB.
const MAX_VSIX_BYTES: usize = 32 * 1024 * 1024;

/// How many search hits are checked. Each costs one manifest fetch.
const SEARCH_CANDIDATES: usize = 20;

/// One search hit, reduced to what a picker shows and what a download needs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenVsxExtension {
    /// `namespace.name`.
    pub id: String,
    pub namespace: String,
    pub name: String,
    pub display_name: String,
    pub version: String,
    pub description: String,
    pub license: String,
    pub downloads: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Already installed under this id, so the picker offers "Reinstall".
    pub installed: bool,
}

/// What `contributes.<key>` a search keeps: the extension's own declaration
/// of what it carries.
#[derive(Debug, Clone, Copy)]
pub enum Contributes {
    IconThemes,
    ColorThemes,
}

impl Contributes {
    fn key(self) -> &'static str {
        match self {
            Self::IconThemes => "iconThemes",
            Self::ColorThemes => "themes",
        }
    }
}

/// A `.vsix`, and what Open VSX says about the version it is.
pub struct Download {
    pub bytes: Vec<u8>,
    /// The publisher as Open VSX shows it, else the namespace.
    pub publisher: String,
    /// `"Unspecified"` when the extension declares none.
    pub license: String,
}

fn http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .user_agent("Atlas-IDE")
        .build()
        .map_err(|error| format!("could not build an HTTP client: {error}"))
}

/// A network failure, said in a way a picker can show.
///
/// `reqwest`'s own Display is a chain ending in an OS errno, which reads as
/// noise in a dialog. Offline is the common case and deserves its own words.
fn network_error(context: &str, error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return format!("{context} timed out — Open VSX did not answer in time.");
    }
    if error.is_connect() {
        return format!("{context} failed — Atlas could not reach open-vsx.org. Are you online?");
    }
    format!("{context} failed: {error}")
}

fn text_field(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn or_unspecified(license: String) -> String {
    if license.is_empty() {
        "Unspecified".to_string()
    } else {
        license
    }
}

/// Search Open VSX for extensions that contribute `what`.
///
/// Open VSX's `Themes` category covers colour themes, product icon themes and
/// file icon themes alike — a search for "dracula" returns mostly colour
/// themes and one icon theme. Filtering on the name or the keywords would be a
/// guess, so each candidate's real `package.json` is fetched and checked for
/// `contributes.<what>`: the same fact the install would later discover,
/// learned before the user clicks rather than after a download.
///
/// The manifest lives at a predictable URL, so it is one request per
/// candidate, and the candidates are checked concurrently. `installed` lists
/// the ids to mark as already installed.
pub async fn search(
    query: &str,
    what: Contributes,
    installed: Vec<String>,
) -> Result<Vec<OpenVsxExtension>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let client = http_client(METADATA_TIMEOUT)?;
    let url = format!(
        "{OPEN_VSX_API}/-/search?query={}&category=Themes&size={SEARCH_CANDIDATES}&sortBy=relevance&includeAllVersions=false",
        urlencoding(trimmed)
    );
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|error| network_error("The Open VSX search", &error))?;
    if !response.status().is_success() {
        return Err(format!(
            "Open VSX answered {} to the search.",
            response.status()
        ));
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("Open VSX sent a search result Atlas could not read: {error}"))?;

    let entries = body
        .get("extensions")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut checks = tokio::task::JoinSet::new();
    for (rank, entry) in entries.into_iter().take(SEARCH_CANDIDATES).enumerate() {
        let namespace = text_field(&entry, "namespace");
        let name = text_field(&entry, "name");
        if namespace.is_empty() || name.is_empty() {
            continue;
        }
        let client = client.clone();
        let installed = installed.clone();
        checks.spawn(async move {
            if !contributes(&client, &namespace, &name, what).await {
                return None;
            }
            let id = format!("{namespace}.{name}");
            let display_name = text_field(&entry, "displayName");
            Some((
                rank,
                OpenVsxExtension {
                    installed: installed.contains(&id),
                    id,
                    namespace,
                    name: name.clone(),
                    display_name: if display_name.is_empty() {
                        name
                    } else {
                        display_name
                    },
                    version: text_field(&entry, "version"),
                    description: text_field(&entry, "description"),
                    license: or_unspecified(text_field(&entry, "license")),
                    downloads: entry
                        .get("downloadCount")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0),
                    icon: entry
                        .get("files")
                        .and_then(|files| files.get("icon"))
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string),
                },
            ))
        });
    }

    let mut ranked = Vec::new();
    while let Some(result) = checks.join_next().await {
        // A panicked check drops its row; it must not fail the search.
        if let Ok(Some(hit)) = result {
            ranked.push(hit);
        }
    }
    // The concurrent checks finish out of order, so relevance is restored from
    // the position Open VSX gave each hit.
    ranked.sort_by_key(|(rank, _)| *rank);
    Ok(ranked.into_iter().map(|(_, extension)| extension).collect())
}

/// `true` when the extension's own `package.json` declares `what`.
///
/// Anything that goes wrong answers `false`: one unreachable entry should drop
/// a row from the results, not fail the whole search.
async fn contributes(
    client: &reqwest::Client,
    namespace: &str,
    name: &str,
    what: Contributes,
) -> bool {
    let url = format!("{OPEN_VSX_API}/{namespace}/{name}/latest/file/package.json");
    let Ok(response) = client.get(&url).send().await else {
        return false;
    };
    let Ok(body) = response.json::<serde_json::Value>().await else {
        return false;
    };
    body.get("contributes")
        .and_then(|contributes| contributes.get(what.key()))
        .and_then(serde_json::Value::as_array)
        .is_some_and(|entries| !entries.is_empty())
}

/// Download an extension's `.vsix`: the latest version, or `version`.
///
/// `namespace` and `name` must already be held to an id alphabet by the
/// caller (`atlas_icon_theme::is_valid_id`); `version` is not, so it is
/// encoded as the one path segment it is.
pub async fn download(
    namespace: &str,
    name: &str,
    version: Option<&str>,
) -> Result<Download, String> {
    let id = format!("{namespace}.{name}");
    let metadata_url = match version {
        Some(version) => format!(
            "{OPEN_VSX_API}/{namespace}/{name}/{}",
            path_segment(version).ok_or_else(|| format!("\"{version}\" is not a version."))?
        ),
        None => format!("{OPEN_VSX_API}/{namespace}/{name}"),
    };
    let metadata: serde_json::Value = http_client(METADATA_TIMEOUT)?
        .get(&metadata_url)
        .send()
        .await
        .map_err(|error| network_error("Looking up the extension", &error))?
        .json()
        .await
        .map_err(|error| format!("Open VSX sent metadata Atlas could not read: {error}"))?;
    let url = metadata
        .get("files")
        .and_then(|files| files.get("download"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("Open VSX has no downloadable .vsix for \"{id}\"."))?
        .to_string();
    let publisher = text_field(&metadata, "namespaceDisplayName");

    let too_big = |size: usize| {
        format!(
            "\"{id}\" is {} MB, past the {} MB Atlas accepts for a theme.",
            size / (1024 * 1024),
            MAX_VSIX_BYTES / (1024 * 1024),
        )
    };
    let mut response = http_client(DOWNLOAD_TIMEOUT)?
        .get(&url)
        .send()
        .await
        .map_err(|error| network_error("The download", &error))?;
    if !response.status().is_success() {
        return Err(format!(
            "Open VSX answered {} to the download.",
            response.status()
        ));
    }
    // Refuse on the declared length before reading a byte, then hold the body
    // to the same cap as it streams — a server that lies about its length, or
    // sends none, must not get to fill memory first and be measured after.
    if let Some(length) = response.content_length() {
        if length > MAX_VSIX_BYTES as u64 {
            return Err(too_big(usize::try_from(length).unwrap_or(usize::MAX)));
        }
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| network_error("The download", &error))?
    {
        if bytes.len() + chunk.len() > MAX_VSIX_BYTES {
            return Err(too_big(bytes.len() + chunk.len()));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Download {
        bytes,
        publisher: if publisher.is_empty() {
            namespace.to_string()
        } else {
            publisher
        },
        license: or_unspecified(text_field(&metadata, "license")),
    })
}

/// Percent-encode one URL path segment: everything outside RFC 3986's
/// unreserved set, space included (as `%20`, not the query string's `+`).
/// `None` for an empty value or a dot-segment: the URL parser resolves `..`
/// (and `%2e%2e`, per the WHATWG spec) however it is spelled, so there is no
/// encoding of one that stays a single segment.
fn path_segment(value: &str) -> Option<String> {
    if value.is_empty() || value == "." || value == ".." {
        return None;
    }
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    Some(out)
}

/// Percent-encode a query string. `github.rs` keeps its own copy of this for
/// the same reason: one helper, four lines, no dependency.
fn urlencoding(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_strings_are_encoded() {
        assert_eq!(urlencoding("material icon"), "material+icon");
        assert_eq!(urlencoding("a/b?c=d"), "a%2Fb%3Fc%3Dd");
        assert_eq!(urlencoding("héllo"), "h%C3%A9llo");
    }

    /// A `version` of `../../evil/x` must stay one segment of the Open VSX
    /// path rather than walking to another endpoint.
    #[test]
    fn a_version_is_encoded_as_a_single_path_segment() {
        assert_eq!(path_segment("5.38.1").as_deref(), Some("5.38.1"));
        assert_eq!(path_segment("../../x").as_deref(), Some("..%2F..%2Fx"));
        assert_eq!(
            path_segment("1.0 beta?a=b#c").as_deref(),
            Some("1.0%20beta%3Fa%3Db%23c")
        );
        assert_eq!(path_segment(".."), None);
        assert_eq!(path_segment("."), None);
        assert_eq!(path_segment(""), None);
    }
}
