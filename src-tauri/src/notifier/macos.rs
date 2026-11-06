//! `UNUserNotificationCenter` backend.
//!
//! Threading: the center and its delegate live in a main-thread thread-local;
//! every operation hops there with `run_on_main_thread`, so no non-`Send`
//! Objective-C object crosses threads. Delegate callbacks arrive on arbitrary
//! threads and only touch the `Send + Sync` response sink.

use std::cell::RefCell;
use std::collections::HashMap;
use std::ptr::NonNull;
use std::sync::Mutex;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread, DefinedClass, MainThreadMarker};
use objc2_foundation::{
    NSArray, NSBundle, NSDictionary, NSError, NSObject, NSObjectProtocol, NSSet, NSString, NSURL,
};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationAction,
    UNNotificationActionOptions, UNNotificationAttachment, UNNotificationCategory,
    UNNotificationCategoryOptions, UNNotificationDefaultActionIdentifier,
    UNNotificationInterruptionLevel, UNNotificationPresentationOptions, UNNotificationRequest,
    UNNotificationResponse, UNNotificationSound, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};
use tauri::AppHandle;

use super::{
    Authorization, Capabilities, Notification, NotificationAction, NotificationResponse,
    NotifierBackend, ResponseSink, Urgency,
};

const PAYLOAD_KEY: &str = "atlasPayload";

#[derive(PartialEq, Eq, Hash, Clone)]
struct ActionKey {
    id: String,
    label: String,
    destructive: bool,
    requires_unlock: bool,
}

impl From<&NotificationAction> for ActionKey {
    fn from(action: &NotificationAction) -> Self {
        Self {
            id: action.id.clone(),
            label: action.label.clone(),
            destructive: action.destructive,
            requires_unlock: action.requires_unlock,
        }
    }
}

/// Each registered action set, with its category identifier and object.
type Categories = HashMap<Vec<ActionKey>, (String, Retained<UNNotificationCategory>)>;

struct MainThreadState {
    center: Retained<UNUserNotificationCenter>,
    /// The center's `delegate` property is weak; this keeps it alive.
    _delegate: Retained<ResponseDelegate>,
    /// Every action set registered so far. macOS replaces the whole registered
    /// category set on each call, so the union is re-sent every time.
    categories: RefCell<Categories>,
}

thread_local! {
    static STATE: RefCell<Option<MainThreadState>> = const { RefCell::new(None) };
}

pub struct MacosBackend {
    app: AppHandle,
}

impl MacosBackend {
    /// `None` when not running from an app bundle: `UNUserNotificationCenter`
    /// raises `NSInternalInconsistencyException` ("bundleProxyForCurrentProcess
    /// is nil"), aborting the process, outside one. A bundle identifier is
    /// only present when launched from a real `.app`.
    pub fn new(app: &AppHandle, sink: ResponseSink) -> Option<Self> {
        if NSBundle::mainBundle().bundleIdentifier().is_none() {
            tracing::info!("system notifications: not running from an app bundle, using fallback");
            return None;
        }
        if MainThreadMarker::new().is_none() {
            tracing::warn!("system notifications: backend must be created on the main thread");
            return None;
        }
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let delegate = ResponseDelegate::new(sink);
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        STATE.with(|state| {
            *state.borrow_mut() = Some(MainThreadState {
                center,
                _delegate: delegate,
                categories: RefCell::new(HashMap::new()),
            });
        });
        Some(Self { app: app.clone() })
    }

    fn on_main(&self, work: impl FnOnce(&MainThreadState) + Send + 'static) {
        let run = move || {
            STATE.with(|state| {
                if let Some(state) = state.borrow().as_ref() {
                    work(state);
                }
            });
        };
        if let Err(error) = self.app.run_on_main_thread(run) {
            tracing::warn!("system notifications: main-thread dispatch failed: {error}");
        }
    }
}

impl NotifierBackend for MacosBackend {
    fn name(&self) -> &'static str {
        "macos-un"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            actions: true,
            max_actions: 4,
            images: true,
            removal: true,
            grouping: true,
            sound: true,
            responses: true,
        }
    }

    fn request_authorization(&self, done: Box<dyn FnOnce(Authorization) + Send>) {
        self.on_main(move |state| {
            let done = Mutex::new(Some(done));
            let completion = RcBlock::new(move |granted: Bool, error: *mut NSError| {
                // SAFETY: when non-null, `error` is valid for the callback.
                if let Some(error) = unsafe { error.as_ref() } {
                    tracing::warn!(
                        "system notification authorization failed: {}",
                        error.localizedDescription()
                    );
                }
                let Some(done) = done.lock().ok().and_then(|mut slot| slot.take()) else {
                    return;
                };
                done(if granted.as_bool() {
                    Authorization::Granted
                } else {
                    Authorization::Denied
                });
            });
            state
                .center
                .requestAuthorizationWithOptions_completionHandler(
                    UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
                    &completion,
                );
        });
    }

    fn show(&self, notification: Notification) -> Result<(), String> {
        self.on_main(move |state| state.show(&notification));
        Ok(())
    }

    fn remove(&self, tag: &str) {
        let tag = tag.to_owned();
        self.on_main(move |state| {
            let identifiers = NSArray::from_retained_slice(&[NSString::from_str(&tag)]);
            state
                .center
                .removePendingNotificationRequestsWithIdentifiers(&identifiers);
            state
                .center
                .removeDeliveredNotificationsWithIdentifiers(&identifiers);
        });
    }

    fn remove_group(&self, group: &str) {
        let group = group.to_owned();
        self.on_main(move |state| {
            let center = state.center.clone();
            let completion = RcBlock::new(move |delivered: NonNull<NSArray<UNNotification>>| {
                // SAFETY: the array is valid for the duration of the callback.
                let delivered = unsafe { delivered.as_ref() };
                let identifiers: Vec<Retained<NSString>> = delivered
                    .iter()
                    .filter(|notification| {
                        notification
                            .request()
                            .content()
                            .threadIdentifier()
                            .to_string()
                            == group
                    })
                    .map(|notification| notification.request().identifier())
                    .collect();
                if !identifiers.is_empty() {
                    center.removeDeliveredNotificationsWithIdentifiers(
                        &NSArray::from_retained_slice(&identifiers),
                    );
                }
            });
            state
                .center
                .getDeliveredNotificationsWithCompletionHandler(&completion);
        });
    }
}

impl MainThreadState {
    fn show(&self, notification: &Notification) {
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&notification.title));
        if let Some(subtitle) = &notification.subtitle {
            content.setSubtitle(&NSString::from_str(subtitle));
        }
        content.setBody(&NSString::from_str(&notification.body));
        content.setThreadIdentifier(&NSString::from_str(&notification.group));
        content.setInterruptionLevel(match notification.urgency {
            Urgency::Low => UNNotificationInterruptionLevel::Passive,
            Urgency::Normal => UNNotificationInterruptionLevel::Active,
            Urgency::High => UNNotificationInterruptionLevel::TimeSensitive,
        });
        if let Some(sound) = &notification.sound {
            content.setSound(Some(&UNNotificationSound::soundNamed(&NSString::from_str(
                sound,
            ))));
        }
        if let Some(payload) = &notification.payload {
            let key = NSString::from_str(PAYLOAD_KEY);
            let value = NSString::from_str(payload);
            let info = NSDictionary::from_retained_objects(&[&*key], &[value]);
            // SAFETY: the dictionary holds only property-list values (strings).
            unsafe { content.setUserInfo(info.cast_unchecked()) };
        }
        if !notification.actions.is_empty() {
            let identifier = self.register_category(&notification.actions);
            content.setCategoryIdentifier(&NSString::from_str(&identifier));
        }
        if let Some(path) = &notification.image_path {
            match attachment_for(path) {
                Ok(attachment) => {
                    content.setAttachments(&NSArray::from_retained_slice(&[attachment]))
                }
                Err(error) => tracing::warn!("system notification image skipped: {error}"),
            }
        }

        // A nil trigger delivers immediately; reusing the tag as the request
        // identifier makes a newer notification with that tag replace the old.
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&notification.tag),
            &content,
            None,
        );
        let completion = RcBlock::new(|error: *mut NSError| {
            // SAFETY: when non-null, `error` is valid for the callback.
            if let Some(error) = unsafe { error.as_ref() } {
                tracing::warn!(
                    "failed to deliver system notification: {}",
                    error.localizedDescription()
                );
            }
        });
        self.center
            .addNotificationRequest_withCompletionHandler(&request, Some(&completion));
    }

    fn register_category(&self, actions: &[NotificationAction]) -> String {
        let key: Vec<ActionKey> = actions.iter().map(ActionKey::from).collect();
        let mut categories = self.categories.borrow_mut();
        if let Some((identifier, _)) = categories.get(&key) {
            return identifier.clone();
        }

        let identifier = format!("atlas-actions-{}", categories.len());
        let platform_actions: Vec<Retained<UNNotificationAction>> = actions
            .iter()
            .map(|action| {
                let mut options = UNNotificationActionOptions::empty();
                if action.destructive {
                    options |= UNNotificationActionOptions::Destructive;
                }
                if action.requires_unlock {
                    options |= UNNotificationActionOptions::AuthenticationRequired;
                }
                UNNotificationAction::actionWithIdentifier_title_options(
                    &NSString::from_str(&action.id),
                    &NSString::from_str(&action.label),
                    options,
                )
            })
            .collect();
        let category =
            UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
                &NSString::from_str(&identifier),
                &NSArray::from_retained_slice(&platform_actions),
                &NSArray::new(),
                UNNotificationCategoryOptions::empty(),
            );
        categories.insert(key, (identifier.clone(), category));
        let all: Vec<Retained<UNNotificationCategory>> = categories
            .values()
            .map(|(_, category)| category.clone())
            .collect();
        self.center
            .setNotificationCategories(&NSSet::from_retained_slice(&all));
        identifier
    }
}

/// The system takes ownership of an attachment's file, so attach a copy.
fn attachment_for(path: &str) -> Result<Retained<UNNotificationAttachment>, String> {
    let source = std::path::Path::new(path);
    let extension = source
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("png");
    let directory = std::env::temp_dir().join("atlas-notifier");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let copy = directory.join(format!("{}.{extension}", uuid::Uuid::new_v4()));
    std::fs::copy(source, &copy).map_err(|error| error.to_string())?;
    let url = NSURL::fileURLWithPath(&NSString::from_str(&copy.to_string_lossy()));
    // SAFETY: `url` is a file URL and `options` may be nil.
    unsafe {
        UNNotificationAttachment::attachmentWithIdentifier_URL_options_error(
            &NSString::from_str("image"),
            &url,
            None,
        )
    }
    .map_err(|error| error.localizedDescription().to_string())
}

struct DelegateIvars {
    sink: ResponseSink,
}

define_class!(
    // SAFETY: `NSObject` has no subclassing requirements and
    // `ResponseDelegate` does not implement `Drop`.
    #[unsafe(super(NSObject))]
    #[ivars = DelegateIvars]
    struct ResponseDelegate;

    unsafe impl NSObjectProtocol for ResponseDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for ResponseDelegate {
        // The user activated a delivered notification, possibly off the main
        // thread; the sink is thread-safe.
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive_notification_response(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion_handler: &block2::DynBlock<dyn Fn()>,
        ) {
            let request = response.notification().request();
            let tag = request.identifier().to_string();
            let payload = request
                .content()
                .userInfo()
                .objectForKey(&*NSString::from_str(PAYLOAD_KEY))
                .and_then(|value| value.downcast::<NSString>().ok())
                .map(|value| value.to_string());
            let action = response.actionIdentifier();
            // `UNNotificationDismissActionIdentifier` is only delivered for
            // categories that opt in, which we never do.
            let action_id = if &*action == unsafe { UNNotificationDefaultActionIdentifier } {
                None
            } else {
                Some(action.to_string())
            };
            (self.ivars().sink)(NotificationResponse {
                tag,
                action_id,
                payload,
            });
            completion_handler.call(());
        }

        // Without this macOS suppresses banners while the app is frontmost.
        // Whether to post is the frontend decision layer's call, not the
        // platform's.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present_notification(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion_handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion_handler
                .call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List,));
        }
    }
);

impl ResponseDelegate {
    fn new(sink: ResponseSink) -> Retained<Self> {
        let this = Self::alloc().set_ivars(DelegateIvars { sink });
        // SAFETY: `NSObject`'s `init` is its designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}
