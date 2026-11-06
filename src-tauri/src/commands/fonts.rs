//! The font families installed on this machine, for the font pickers in
//! Settings → General.
//!
//! The webview cannot answer this itself: `queryLocalFonts()` is Chromium-only,
//! so WKWebView (macOS) and WebKitGTK (Linux) have no way to list fonts. Each
//! platform's own font system can, and it also knows which families are
//! fixed-width, which the code font picker filters on.
//!
//! Windows returns `None`: WebView2 is Chromium, and the frontend asks
//! `queryLocalFonts()` there instead (`fonts-api.ts`).

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFamily {
    /// The family name, as CSS `font-family` takes it.
    pub name: String,
    /// Every glyph is the same width — what code and the terminal need.
    pub monospace: bool,
}

/// Installed families, sorted by name and deduplicated, or `None` where the
/// platform has no native listing here (Windows).
#[tauri::command]
pub async fn list_font_families() -> Result<Option<Vec<FontFamily>>, String> {
    tokio::task::spawn_blocking(platform::list)
        .await
        .map_err(|e| e.to_string())
}

/// Fold per-face entries into one per family: a family is monospace when any
/// of its faces is. Names starting with `.` are the OS's private UI fonts
/// (`.SF NS`, `.AppleSystemUIFont`); CSS cannot address them by name.
// Called by the macOS and Linux listings and the tests; Windows has none.
#[cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(dead_code))]
fn collect(faces: impl IntoIterator<Item = (String, bool)>) -> Vec<FontFamily> {
    let mut families = std::collections::BTreeMap::<String, bool>::new();
    for (name, monospace) in faces {
        let name = name.trim();
        if name.is_empty() || name.starts_with('.') {
            continue;
        }
        *families.entry(name.to_string()).or_default() |= monospace;
    }
    families
        .into_iter()
        .map(|(name, monospace)| FontFamily { name, monospace })
        .collect()
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{collect, FontFamily};
    use objc2_core_foundation::{CFArray, CFDictionary, CFNumber, CFRetained, CFString, CFType};
    use objc2_core_text::{
        kCTFontFamilyNameAttribute, kCTFontSymbolicTrait, kCTFontTraitsAttribute, CTFontCollection,
        CTFontDescriptor, CTFontSymbolicTraits,
    };

    pub fn list() -> Option<Vec<FontFamily>> {
        // SAFETY: CoreText's documented calls, with no options dictionary; the
        // returned array holds CTFontDescriptors, and the traits attribute is
        // a CFDictionary keyed by CFString.
        unsafe {
            let collection = CTFontCollection::from_available_fonts(None);
            let descriptors = collection.matching_font_descriptors()?;
            let descriptors: CFRetained<CFArray<CTFontDescriptor>> =
                CFRetained::cast_unchecked(descriptors);
            let faces = descriptors.iter().filter_map(|descriptor| {
                let name = descriptor
                    .attribute(kCTFontFamilyNameAttribute)?
                    .downcast::<CFString>()
                    .ok()?
                    .to_string();
                let monospace = descriptor
                    .attribute(kCTFontTraitsAttribute)
                    .and_then(|traits| traits.downcast::<CFDictionary>().ok())
                    .and_then(|traits| {
                        let traits: CFRetained<CFDictionary<CFString, CFType>> =
                            CFRetained::cast_unchecked(traits);
                        traits.get(kCTFontSymbolicTrait)
                    })
                    .and_then(|value| value.downcast::<CFNumber>().ok())
                    .and_then(|number| number.as_i64())
                    .is_some_and(|bits| {
                        CTFontSymbolicTraits(bits as u32)
                            .contains(CTFontSymbolicTraits::TraitMonoSpace)
                    });
                Some((name, monospace))
            });
            Some(collect(faces))
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{collect, FontFamily};
    use std::process::Command;

    /// fontconfig's own listing. `spacing` is 100 for monospace and 110 for
    /// charcell; proportional faces leave it out.
    pub fn list() -> Option<Vec<FontFamily>> {
        let output = Command::new("fc-list")
            .args(["--format", "%{family[0]}\t%{spacing}\n"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        Some(parse_fc_list(&String::from_utf8_lossy(&output.stdout)))
    }

    pub(super) fn parse_fc_list(text: &str) -> Vec<FontFamily> {
        collect(text.lines().filter_map(|line| {
            let (name, spacing) = line.split_once('\t').unwrap_or((line, ""));
            let monospace = matches!(spacing.trim().parse::<u32>(), Ok(100 | 110));
            (!name.is_empty()).then(|| (name.to_string(), monospace))
        }))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod platform {
    use super::FontFamily;

    pub fn list() -> Option<Vec<FontFamily>> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_faces_into_families_and_drops_private_fonts() {
        let families = collect([
            ("Menlo".to_string(), true),
            ("Helvetica".to_string(), false),
            ("Menlo".to_string(), false),
            (".SF NS".to_string(), false),
            ("  ".to_string(), false),
        ]);
        assert_eq!(
            families,
            vec![
                FontFamily {
                    name: "Helvetica".into(),
                    monospace: false
                },
                FontFamily {
                    name: "Menlo".into(),
                    monospace: true
                },
            ]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn lists_installed_families_with_menlo_as_monospace() {
        let families = platform::list().expect("CoreText lists fonts");
        let menlo = families
            .iter()
            .find(|f| f.name == "Menlo")
            .expect("Menlo ships with macOS");
        assert!(menlo.monospace);
        let helvetica = families
            .iter()
            .find(|f| f.name == "Helvetica")
            .expect("Helvetica ships");
        assert!(!helvetica.monospace);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parses_fc_list_spacing() {
        let families =
            platform::parse_fc_list("DejaVu Sans\t\nDejaVu Sans Mono\t100\nFixed\t110\n");
        assert_eq!(
            families
                .iter()
                .map(|f| (f.name.as_str(), f.monospace))
                .collect::<Vec<_>>(),
            vec![
                ("DejaVu Sans", false),
                ("DejaVu Sans Mono", true),
                ("Fixed", true)
            ]
        );
    }
}
