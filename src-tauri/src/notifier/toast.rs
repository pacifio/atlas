//! Windows toast backend (`ToastNotificationManager`), built on the `windows`
//! crate directly: `tauri-winrt-notification` exposes neither a tag/group nor
//! removal, and does not escape button text.
//!
//! Identity: a toast is attributed to an AppUserModelID. The installed app's
//! Start-menu shortcut carries the bundle identifier (`dev.atlas.ide`) as its
//! AUMID, which is what `tauri-plugin-notification` also passes. A dev run
//! (`target\debug|release`) has no such shortcut, so `new` returns `None` and
//! the plugin fallback is used, as on macOS outside a bundle.
//!
//! Activation is in-process only: the `Activated` handler lives on the
//! `ToastNotification` object we keep, so a click while Atlas is running
//! routes through the shared response sink. A click on a toast that outlived
//! the process (left in the Action Center) just launches the app: routing it
//! needs a registered COM `INotificationActivationCallback` server and a
//! matching `ToastActivatorCLSID` on the shortcut, which the bundler does not
//! set. Not implemented; no response is emitted in that case.

use std::collections::HashMap;
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use windows::core::{IInspectable, Interface, HSTRING};
use windows::Data::Xml::Dom::XmlDocument;
use windows::Foundation::TypedEventHandler;
use windows::UI::Notifications::{
    NotificationSetting, ToastActivatedEventArgs, ToastNotification, ToastNotificationManager,
};

use super::{
    Authorization, Capabilities, Notification, NotificationResponse, NotifierBackend, ResponseSink,
    Urgency,
};

/// Longest tag/group Windows accepts (Anniversary Update and later).
const MAX_ID_LEN: usize = 64;
/// Windows renders at most five buttons.
const MAX_ACTIONS: usize = 5;
/// Toasts kept alive so their `Activated` handlers keep firing.
const MAX_LIVE: usize = 128;
const ACTION_PREFIX: &str = "a:";

struct Live {
    /// The group the toast was shown under (`remove(tag)` has no group).
    group: String,
    /// Holding the object keeps its activation handler registered.
    _toast: ToastNotification,
    seq: u64,
}

#[derive(Default)]
struct State {
    live: HashMap<String, Live>,
    next_seq: u64,
}

pub struct ToastBackend {
    app_id: HSTRING,
    sink: ResponseSink,
    state: Arc<Mutex<State>>,
}

impl ToastBackend {
    /// `None` without an installed app identity (dev runs).
    pub fn new(app: &AppHandle, sink: ResponseSink) -> Option<Self> {
        if tauri::is_dev() || is_unpackaged_exe() {
            tracing::info!("system notifications: no installed app identity, using fallback");
            return None;
        }
        let identifier = app.config().identifier.clone();
        Some(Self {
            app_id: HSTRING::from(identifier),
            sink,
            state: Arc::new(Mutex::new(State::default())),
        })
    }

    fn build(&self, n: &Notification) -> Result<ToastNotification, String> {
        let xml = XmlDocument::new().map_err(|e| e.to_string())?;
        xml.LoadXml(&HSTRING::from(toast_xml(n)))
            .map_err(|e| e.to_string())?;
        ToastNotification::CreateToastNotification(&xml).map_err(|e| e.to_string())
    }
}

impl NotifierBackend for ToastBackend {
    fn name(&self) -> &'static str {
        "windows-toast"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            actions: true,
            max_actions: MAX_ACTIONS as u8,
            images: true,
            removal: true,
            grouping: true,
            sound: true,
            responses: true,
        }
    }

    fn request_authorization(&self, done: Box<dyn FnOnce(Authorization) + Send>) {
        // Windows has no prompt; the user's per-app switch is the authority.
        let enabled = ToastNotificationManager::CreateToastNotifierWithId(&self.app_id)
            .and_then(|notifier| notifier.Setting())
            .map(|setting| setting == NotificationSetting::Enabled)
            .unwrap_or(false);
        done(if enabled {
            Authorization::Granted
        } else {
            Authorization::Denied
        });
    }

    fn show(&self, notification: Notification) -> Result<(), String> {
        let toast = self.build(&notification)?;
        let tag = notification.tag.clone();
        let group = notification.group.clone();
        toast
            .SetTag(&HSTRING::from(wire_id(&tag)))
            .map_err(|e| e.to_string())?;
        toast
            .SetGroup(&HSTRING::from(wire_id(&group)))
            .map_err(|e| e.to_string())?;

        let sink = self.sink.clone();
        let payload = notification.payload;
        let weak: Weak<Mutex<State>> = Arc::downgrade(&self.state);
        let handler_tag = tag.clone();
        let handler =
            TypedEventHandler::<ToastNotification, IInspectable>::new(move |_sender, args| {
                let action_id = activated_action(args.as_ref());
                sink(NotificationResponse {
                    tag: handler_tag.clone(),
                    action_id,
                    payload: payload.clone(),
                });
                // Activation takes the toast out of the Action Center.
                if let Some(state) = weak.upgrade() {
                    state.lock().live.remove(&handler_tag);
                }
                Ok(())
            });
        toast.Activated(&handler).map_err(|e| e.to_string())?;

        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&self.app_id)
            .map_err(|e| e.to_string())?;
        notifier.Show(&toast).map_err(|e| e.to_string())?;

        let mut state = self.state.lock();
        state.next_seq += 1;
        let seq = state.next_seq;
        state.live.insert(
            tag,
            Live {
                group,
                _toast: toast,
                seq,
            },
        );
        if state.live.len() > MAX_LIVE {
            if let Some(oldest) = state
                .live
                .iter()
                .min_by_key(|(_, live)| live.seq)
                .map(|(tag, _)| tag.clone())
            {
                state.live.remove(&oldest);
            }
        }
        Ok(())
    }

    fn remove(&self, tag: &str) {
        // Removal by tag needs the group the toast was shown under. A toast we
        // no longer track (evicted, or from a previous run) is left alone.
        let Some(live) = self.state.lock().live.remove(tag) else {
            return;
        };
        let result = ToastNotificationManager::History().and_then(|history| {
            history.RemoveGroupedTagWithId(
                &HSTRING::from(wire_id(tag)),
                &HSTRING::from(wire_id(&live.group)),
                &self.app_id,
            )
        });
        if let Err(error) = result {
            tracing::warn!("system notifications: remove failed: {error}");
        }
    }

    fn remove_group(&self, group: &str) {
        self.state.lock().live.retain(|_, live| live.group != group);
        let result = ToastNotificationManager::History().and_then(|history| {
            history.RemoveGroupWithId(&HSTRING::from(wire_id(group)), &self.app_id)
        });
        if let Err(error) = result {
            tracing::warn!("system notifications: remove_group failed: {error}");
        }
    }
}

/// True for `target\debug` / `target\release` builds, which have no shortcut
/// (and so no AUMID). Same test `tauri-plugin-notification` applies.
fn is_unpackaged_exe() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return true;
    };
    let Some(dir) = exe.parent() else {
        return true;
    };
    let dir = dir.display().to_string();
    dir.ends_with("\\target\\debug") || dir.ends_with("\\target\\release")
}

/// Tags and groups longer than the platform limit are replaced by a stable
/// hash; the same input always maps to the same wire id, so removal needs no
/// extra mapping.
fn wire_id(id: &str) -> String {
    if id.chars().count() <= MAX_ID_LEN {
        return id.to_owned();
    }
    let digest = Sha256::digest(id.as_bytes());
    let hex: String = digest.iter().take(16).map(|b| format!("{b:02x}")).collect();
    format!("h-{hex}")
}

fn activated_action(args: Option<&IInspectable>) -> Option<String> {
    let args = args?.cast::<ToastActivatedEventArgs>().ok()?;
    let arguments = args.Arguments().ok()?.to_string();
    parse_action(&arguments)
}

/// Body clicks carry no `a:` prefix; buttons carry `a:<action id>`.
fn parse_action(arguments: &str) -> Option<String> {
    arguments.strip_prefix(ACTION_PREFIX).map(str::to_owned)
}

fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // XML 1.0 forbids most control characters even escaped.
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            c => out.push(c),
        }
    }
    out
}

fn toast_xml(n: &Notification) -> String {
    let mut visual = String::new();
    if let Some(path) = n.image_path.as_deref().filter(|p| !p.is_empty()) {
        visual.push_str(&format!(
            r#"<image placement="appLogoOverride" hint-crop="circle" src="{}"/>"#,
            xml_escape(path)
        ));
    }
    visual.push_str(&format!("<text>{}</text>", xml_escape(&n.title)));
    if let Some(subtitle) = n.subtitle.as_deref().filter(|s| !s.is_empty()) {
        visual.push_str(&format!("<text>{}</text>", xml_escape(subtitle)));
    }
    if !n.body.is_empty() {
        visual.push_str(&format!("<text>{}</text>", xml_escape(&n.body)));
    }

    let actions: String = n
        .actions
        .iter()
        .take(MAX_ACTIONS)
        .map(|a| {
            format!(
                r#"<action content="{}" arguments="{}" activationType="foreground"/>"#,
                xml_escape(&a.label),
                xml_escape(&format!("{ACTION_PREFIX}{}", a.id)),
            )
        })
        .collect();
    let actions = if actions.is_empty() {
        String::new()
    } else {
        format!("<actions>{actions}</actions>")
    };

    // `reminder` keeps the toast up until acted on; it is only valid with
    // buttons, so only a high-urgency toast that has some gets it.
    let scenario = if matches!(n.urgency, Urgency::High) && !actions.is_empty() {
        r#" scenario="reminder""#
    } else {
        ""
    };
    let audio = if n.sound.is_some() && !matches!(n.urgency, Urgency::Low) {
        r#"<audio src="ms-winsoundevent:Notification.Default"/>"#
    } else {
        r#"<audio silent="true"/>"#
    };

    format!(
        r#"<toast launch="open" activationType="foreground"{scenario}><visual><binding template="ToastGeneric">{visual}</binding></visual>{actions}{audio}</toast>"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(json: &str) -> Notification {
        serde_json::from_str(json).expect("parses")
    }

    #[test]
    fn short_ids_pass_through_and_long_ids_hash_stably() {
        assert_eq!(wire_id("agent-done:abc"), "agent-done:abc");
        let long = "x".repeat(200);
        let hashed = wire_id(&long);
        assert!(hashed.chars().count() <= MAX_ID_LEN);
        assert_eq!(hashed, wire_id(&long));
        assert_ne!(hashed, wire_id(&"y".repeat(200)));
    }

    #[test]
    fn action_arguments_round_trip() {
        assert_eq!(parse_action("a:allow").as_deref(), Some("allow"));
        assert_eq!(parse_action("open"), None);
        assert_eq!(parse_action(""), None);
    }

    #[test]
    fn xml_is_escaped() {
        let n = note(
            r#"{"tag":"t","group":"g","title":"a<b & \"c\"","body":"x","actions":[{"id":"i'd","label":"<Go>"}]}"#,
        );
        let xml = toast_xml(&n);
        assert!(xml.contains("a&lt;b &amp; &quot;c&quot;"));
        assert!(xml.contains("content=\"&lt;Go&gt;\""));
        assert!(xml.contains("arguments=\"a:i&apos;d\""));
    }

    #[test]
    fn reminder_scenario_only_for_high_urgency_with_actions() {
        let high_with = note(
            r#"{"tag":"t","group":"g","title":"T","body":"B","urgency":"high","actions":[{"id":"a","label":"A"}]}"#,
        );
        assert!(toast_xml(&high_with).contains("reminder"));
        let high_bare = note(r#"{"tag":"t","group":"g","title":"T","body":"B","urgency":"high"}"#);
        assert!(!toast_xml(&high_bare).contains("reminder"));
    }

    #[test]
    fn sound_follows_the_field() {
        let silent = note(r#"{"tag":"t","group":"g","title":"T","body":"B"}"#);
        assert!(toast_xml(&silent).contains("silent"));
        let loud = note(r#"{"tag":"t","group":"g","title":"T","body":"B","sound":"Ping"}"#);
        assert!(toast_xml(&loud).contains("ms-winsoundevent"));
    }
}
