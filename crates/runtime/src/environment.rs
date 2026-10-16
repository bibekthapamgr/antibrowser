//! Per-profile privacy and environment settings (milestone 05).
//!
//! These are **configuration and QA controls** applied through switches and preferences that Chromium itself
//! supports: WebRTC IP handling, third-party cookies, Do Not Track, page language, time zone, initial window size,
//! text size and reduced motion. They change what the browser sends and shows. They do not make a profile look like
//! a different device, and nothing here randomises browser fingerprints.
//!
//! Support differs by operating system (see [`report`]): a setting the browser cannot apply on this OS is shown as
//! unavailable rather than claimed. The real-browser tests (`tests/browser.rs`) check each one per OS.
//!
//! **Match the proxy** (`match_proxy`, ADR-0027): for a profile with a proxy, the time zone and page language follow
//! the location the check service estimated for the proxy's exit address, WebRTC may use only the proxy, and
//! websites are refused this computer's location (the permission is blocked unless the user allowed it). This keeps
//! the profile from showing this computer's own time zone, language and location next to the proxy's address. It is
//! still only configuration: canvas, WebGL, audio, fonts, `navigator` properties and other device signals are not
//! changed, the estimate can be wrong, and on Windows the browser keeps the computer's time zone.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebRtcPolicy {
    /// Chromium's default (local addresses hidden behind mDNS names).
    #[default]
    Default,
    /// Only the default route's public address is used.
    PublicInterfaceOnly,
    /// WebRTC may use only the proxy: UDP that cannot go through it is blocked. Forced for fail-closed proxies.
    DisableNonProxiedUdp,
}

impl WebRtcPolicy {
    /// Value of Chromium's `webrtc.ip_handling_policy` preference (`None`: leave the browser default).
    pub fn pref_value(self) -> Option<&'static str> {
        match self {
            Self::Default => None,
            Self::PublicInterfaceOnly => Some("default_public_interface_only"),
            Self::DisableNonProxiedUdp => Some("disable_non_proxied_udp"),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextSize {
    #[default]
    Default,
    Large,
    Larger,
}

impl TextSize {
    /// (default font size, fixed-width font size) in CSS pixels; `None` = browser default (16 / 13).
    pub fn font_sizes(self) -> Option<(u32, u32)> {
        match self {
            Self::Default => None,
            Self::Large => Some((20, 16)),
            Self::Larger => Some((24, 20)),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowSize {
    pub width: u32,
    pub height: u32,
}

impl WindowSize {
    pub const MIN: (u32, u32) = (800, 600);
    pub const MAX: (u32, u32) = (3840, 2160);
    pub fn valid(self) -> bool {
        (Self::MIN.0..=Self::MAX.0).contains(&self.width)
            && (Self::MIN.1..=Self::MAX.1).contains(&self.height)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PrivacyConfig {
    pub webrtc: WebRtcPolicy,
    /// Chromium's "Block third-party cookies".
    pub block_third_party_cookies: bool,
    /// Sends the `DNT: 1` request header (websites may ignore it).
    pub do_not_track: bool,
    /// Page language (Accept-Language and `navigator.languages`); one of [`LANGUAGES`].
    pub language: Option<String>,
    /// IANA time zone; one of [`TIME_ZONES`]. Not available on Windows.
    pub timezone: Option<String>,
    /// Initial window size (not a device screen size).
    pub window: Option<WindowSize>,
    pub text_size: TextSize,
    pub reduced_motion: bool,
    /// The preset last applied, for display only.
    pub preset: Option<String>,
    /// With a proxy: time zone and language follow the proxy's exit address (from its last check; manual `language`
    /// and `timezone` win), WebRTC uses only the proxy and websites are refused this computer's location (unless you allowed it).
    pub match_proxy: bool,
    /// ADR-0029, app behaviour (not a browser setting): with a proxy, warn before opening when the proxy's exit
    /// location differs from the one seen at the profile's last open. `None` = the default, which is on for a
    /// profile with a proxy. Never sent to the browser.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location_lock: Option<bool>,
    /// ADR-0029, app behaviour: open the account server's IP check page (`<server>/check/`) as the first tab.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub open_check_page: bool,
}

impl PrivacyConfig {
    /// Whether the proxy location lock (ADR-0029) applies to a launch: only with a proxy, on unless turned off.
    pub fn location_lock_on(&self, proxied: bool) -> bool {
        proxied && self.location_lock.unwrap_or(true)
    }

    /// The settings that reach the browser (the app-behaviour switches cleared): two configurations that differ only
    /// in those switches open the same browser, so changing them never asks for a restart.
    pub fn browser_settings(&self) -> PrivacyConfig {
        PrivacyConfig {
            location_lock: None,
            open_check_page: false,
            ..self.clone()
        }
    }
}

/// Where the check service estimated a proxy's exit address to be (ADR-0027). Each value was validated when the
/// check answer was read, and is validated again before it becomes a browser setting.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ProxyGeo {
    /// ISO 3166-1 alpha-2.
    pub country: Option<String>,
    pub city: Option<String>,
    /// IANA time zone name.
    pub timezone: Option<String>,
    /// BCP 47 language tag (`en-US`).
    pub language: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

/// A time zone name safe to pass as `TZ`: `UTC` or `Area/Location[/Sub]` in ASCII letters, digits and `_+-`.
pub fn valid_zone_name(s: &str) -> bool {
    if s == "UTC" {
        return true;
    }
    let mut parts = s.split('/');
    let area = parts.next().unwrap_or_default();
    let rest: Vec<&str> = parts.collect();
    s.len() <= 64
        && (1..=2).contains(&rest.len())
        && (2..=20).contains(&area.len())
        && area.starts_with(|c: char| c.is_ascii_uppercase())
        && area.bytes().all(|b| b.is_ascii_alphabetic())
        && rest.iter().all(|p| {
            (1..=30).contains(&p.len())
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'+' | b'-'))
        })
}

/// A language tag safe for `--lang` and Accept-Language: `ll-CC` or `lll-CC`.
pub fn valid_locale_tag(s: &str) -> bool {
    s.split_once('-').is_some_and(|(l, r)| {
        (2..=3).contains(&l.len())
            && l.bytes().all(|b| b.is_ascii_lowercase())
            && r.len() == 2
            && r.bytes().all(|b| b.is_ascii_uppercase())
    })
}

/// What matching the proxy sets for one launch. Empty when matching is off, the profile has no proxy, or the check
/// gave no usable location; a field the user set by hand is never replaced.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProxyMatch {
    pub language: Option<String>,
    pub timezone: Option<String>,
}

impl ProxyMatch {
    pub fn is_empty(&self) -> bool {
        self.language.is_none() && self.timezone.is_none()
    }
}

/// The time zone and language a launch takes from the proxy's location (`geo`: the proxy's fresh check).
pub fn proxy_match(c: &PrivacyConfig, proxied: bool, geo: Option<&ProxyGeo>) -> ProxyMatch {
    let Some(geo) = geo.filter(|_| c.match_proxy && proxied) else {
        return ProxyMatch::default();
    };
    ProxyMatch {
        language: geo
            .language
            .clone()
            .filter(|l| c.language.is_none() && valid_locale_tag(l)),
        timezone: geo
            .timezone
            .clone()
            .filter(|z| c.timezone.is_none() && valid_zone_name(z)),
    }
}

/// Page languages offered (BCP 47 tag, English name).
pub const LANGUAGES: &[(&str, &str)] = &[
    ("en-US", "English (United States)"),
    ("en-GB", "English (United Kingdom)"),
    ("de-DE", "German (Germany)"),
    ("fr-FR", "French (France)"),
    ("es-ES", "Spanish (Spain)"),
    ("es-MX", "Spanish (Mexico)"),
    ("it-IT", "Italian (Italy)"),
    ("pt-BR", "Portuguese (Brazil)"),
    ("nl-NL", "Dutch (Netherlands)"),
    ("pl-PL", "Polish (Poland)"),
    ("sv-SE", "Swedish (Sweden)"),
    ("tr-TR", "Turkish (Turkey)"),
    ("ru-RU", "Russian (Russia)"),
    ("ar-SA", "Arabic (Saudi Arabia)"),
    ("hi-IN", "Hindi (India)"),
    ("ne-NP", "Nepali (Nepal)"),
    ("id-ID", "Indonesian (Indonesia)"),
    ("ja-JP", "Japanese (Japan)"),
    ("ko-KR", "Korean (South Korea)"),
    ("zh-CN", "Chinese (Simplified, China)"),
];

/// Time zones offered (IANA names).
pub const TIME_ZONES: &[&str] = &[
    "UTC",
    "Europe/London",
    "Europe/Dublin",
    "Europe/Lisbon",
    "Europe/Paris",
    "Europe/Berlin",
    "Europe/Madrid",
    "Europe/Rome",
    "Europe/Amsterdam",
    "Europe/Stockholm",
    "Europe/Warsaw",
    "Europe/Athens",
    "Europe/Istanbul",
    "Europe/Moscow",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "America/Phoenix",
    "America/Anchorage",
    "America/Toronto",
    "America/Vancouver",
    "America/Mexico_City",
    "America/Bogota",
    "America/Sao_Paulo",
    "America/Argentina/Buenos_Aires",
    "Africa/Cairo",
    "Africa/Lagos",
    "Africa/Nairobi",
    "Africa/Johannesburg",
    "Asia/Dubai",
    "Asia/Karachi",
    "Asia/Kolkata",
    "Asia/Kathmandu",
    "Asia/Dhaka",
    "Asia/Bangkok",
    "Asia/Jakarta",
    "Asia/Singapore",
    "Asia/Manila",
    "Asia/Shanghai",
    "Asia/Hong_Kong",
    "Asia/Seoul",
    "Asia/Tokyo",
    "Australia/Perth",
    "Australia/Sydney",
    "Pacific/Auckland",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Windows,
    MacOs,
    Linux,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::MacOs
        } else {
            Self::Linux
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum EnvironmentError {
    #[error("that language is not one of the supported presets")]
    Language,
    #[error("that time zone is not one of the supported presets")]
    TimeZone,
    #[error("window size must be between 800×600 and 3840×2160")]
    Window,
    #[error("preset names are at most 40 characters")]
    Preset,
}

/// Checks a configuration before it is saved.
pub fn validate(c: &PrivacyConfig) -> Result<(), EnvironmentError> {
    if let Some(l) = &c.language
        && !LANGUAGES.iter().any(|(tag, _)| tag == l)
    {
        return Err(EnvironmentError::Language);
    }
    if let Some(tz) = &c.timezone
        && !TIME_ZONES.contains(&tz.as_str())
    {
        return Err(EnvironmentError::TimeZone);
    }
    if c.window.is_some_and(|w| !w.valid()) {
        return Err(EnvironmentError::Window);
    }
    if c.preset
        .as_deref()
        .is_some_and(|p| p.chars().count() > 40 || p.chars().any(|ch| ch.is_control()))
    {
        return Err(EnvironmentError::Preset);
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Support {
    /// Applied by the browser on this OS (or left at the browser default).
    Applied,
    /// Applied in part; the message says what is not.
    Partial,
    /// The browser cannot apply it on this OS; it is saved but has no effect here.
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FieldReport {
    pub field: &'static str,
    pub support: Support,
    pub message: &'static str,
}

/// What this OS's browser will do with each set field (`privacy.validate`).
pub fn report(c: &PrivacyConfig, platform: Platform) -> Vec<FieldReport> {
    let mut out = vec![];
    let mut push = |field, support, message| {
        out.push(FieldReport {
            field,
            support,
            message,
        })
    };
    if c.match_proxy {
        if platform == Platform::Windows {
            push(
                "match_proxy",
                Support::Partial,
                "With a proxy, the page language follows the proxy's location, WebRTC uses only the proxy and websites are refused this computer's location (unless you allowed it). On Windows the browser keeps the computer's time zone.",
            );
        } else {
            push(
                "match_proxy",
                Support::Applied,
                "With a proxy, the time zone and page language follow the proxy's location, WebRTC uses only the proxy and websites are refused this computer's location (unless you allowed it). Other device details are not changed.",
            );
        }
    }
    if c.timezone.is_some() {
        if platform == Platform::Windows {
            push(
                "timezone",
                Support::Unavailable,
                "On Windows the browser always uses the computer's time zone.",
            );
        } else {
            push(
                "timezone",
                Support::Applied,
                "Pages see this time zone (Date and Intl).",
            );
        }
    }
    if c.language.is_some() {
        if platform == Platform::MacOs {
            push(
                "language",
                Support::Partial,
                "Websites get this language; the browser's own menus follow macOS.",
            );
        } else {
            push(
                "language",
                Support::Applied,
                "Websites get this language, and the browser's menus use it where available.",
            );
        }
    }
    if c.window.is_some() {
        push(
            "window",
            Support::Applied,
            "The window opens at this size. It is not a screen or device size.",
        );
    }
    if c.text_size != TextSize::Default {
        push(
            "text_size",
            Support::Applied,
            "Default text size for pages.",
        );
    }
    if c.reduced_motion {
        push(
            "reduced_motion",
            Support::Applied,
            "Pages are told the user prefers reduced motion.",
        );
    }
    if c.webrtc != WebRtcPolicy::Default {
        push(
            "webrtc",
            Support::Applied,
            "Applied by the browser's WebRTC address handling.",
        );
    }
    if c.block_third_party_cookies {
        push(
            "block_third_party_cookies",
            Support::Applied,
            "Cookies of embedded third-party sites are blocked; some sign-in widgets may stop working.",
        );
    }
    if c.do_not_track {
        push(
            "do_not_track",
            Support::Applied,
            "Sends a Do Not Track request; websites may ignore it.",
        );
    }
    out
}

/// A named set of settings for a QA or accessibility task. Presets are configuration shortcuts: applying one
/// fills in the fields below and records its name; the user can change any field afterwards.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Preset {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub config: PrivacyConfig,
}

/// Coherent presets: a locale preset sets a language and a time zone that belong together; nothing is random.
pub fn presets() -> Vec<Preset> {
    let locale = |language: &str, timezone: &str| PrivacyConfig {
        language: Some(language.to_owned()),
        timezone: Some(timezone.to_owned()),
        ..PrivacyConfig::default()
    };
    let window = |width, height| PrivacyConfig {
        window: Some(WindowSize { width, height }),
        ..PrivacyConfig::default()
    };
    let named = |id: &'static str,
                 name: &'static str,
                 description: &'static str,
                 mut config: PrivacyConfig| {
        config.preset = Some(id.to_owned());
        Preset {
            id,
            name,
            description,
            config,
        }
    };
    vec![
        named(
            "standard",
            "Standard",
            "The browser's own defaults.",
            PrivacyConfig::default(),
        ),
        named(
            "privacy",
            "Stricter privacy",
            "Blocks third-party cookies, sends Do Not Track and limits the addresses WebRTC shares.",
            PrivacyConfig {
                webrtc: WebRtcPolicy::PublicInterfaceOnly,
                block_third_party_cookies: true,
                do_not_track: true,
                ..PrivacyConfig::default()
            },
        ),
        named(
            "accessibility",
            "Accessibility review",
            "Larger text, reduced motion and a 1280×800 window, for checking pages with these needs.",
            PrivacyConfig {
                text_size: TextSize::Larger,
                reduced_motion: true,
                window: Some(WindowSize {
                    width: 1280,
                    height: 800,
                }),
                ..PrivacyConfig::default()
            },
        ),
        named(
            "laptop",
            "Small laptop window",
            "Opens at 1366×768 to check layouts on common laptop sizes.",
            window(1366, 768),
        ),
        named(
            "desktop",
            "Full HD window",
            "Opens at 1920×1080.",
            window(1920, 1080),
        ),
        named(
            "locale-en-us",
            "English (US), New York time",
            "Pages in US English with Eastern time, for checking dates and formats.",
            locale("en-US", "America/New_York"),
        ),
        named(
            "locale-en-gb",
            "English (UK), London time",
            "Pages in UK English with London time.",
            locale("en-GB", "Europe/London"),
        ),
        named(
            "locale-de-de",
            "German, Berlin time",
            "Pages in German with Central European time.",
            locale("de-DE", "Europe/Berlin"),
        ),
        named(
            "locale-ja-jp",
            "Japanese, Tokyo time",
            "Pages in Japanese with Japan time.",
            locale("ja-JP", "Asia/Tokyo"),
        ),
        named(
            "locale-ne-np",
            "Nepali, Kathmandu time",
            "Pages in Nepali with Nepal time.",
            locale("ne-NP", "Asia/Kathmandu"),
        ),
    ]
}

/// The WebRTC policy actually used: a proxy with fail-closed routing, or matching the proxy, forces "proxy only"
/// (the real address is never offered over UDP).
pub fn effective_webrtc(c: &PrivacyConfig, proxied: bool, fail_closed: bool) -> WebRtcPolicy {
    if proxied && (fail_closed || c.match_proxy) {
        WebRtcPolicy::DisableNonProxiedUdp
    } else {
        c.webrtc
    }
}

/// `intl.accept_languages` value for a language tag: `de-DE` → `de-DE,de`.
pub fn accept_languages(tag: &str) -> String {
    match tag.split_once('-') {
        Some((base, _)) => format!("{tag},{base}"),
        None => tag.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_are_valid_and_coherent() {
        let all = presets();
        let ids: std::collections::HashSet<_> = all.iter().map(|p| p.id).collect();
        assert_eq!(ids.len(), all.len(), "unique ids");
        for p in &all {
            assert_eq!(validate(&p.config), Ok(()), "{}", p.id);
            assert_eq!(p.config.preset.as_deref(), Some(p.id));
            // A locale preset always sets both halves.
            assert_eq!(
                p.config.language.is_some(),
                p.config.timezone.is_some(),
                "{}",
                p.id
            );
        }
    }

    #[test]
    fn validation() {
        let mut c = PrivacyConfig::default();
        assert_eq!(validate(&c), Ok(()));
        c.language = Some("de-DE".into());
        c.timezone = Some("Asia/Kathmandu".into());
        c.window = Some(WindowSize {
            width: 1366,
            height: 768,
        });
        assert_eq!(validate(&c), Ok(()));
        c.language = Some("de-DE --no-sandbox".into());
        assert_eq!(validate(&c), Err(EnvironmentError::Language));
        c.language = None;
        c.timezone = Some("../../etc/passwd".into());
        assert_eq!(validate(&c), Err(EnvironmentError::TimeZone));
        c.timezone = None;
        c.window = Some(WindowSize {
            width: 10_000,
            height: 768,
        });
        assert_eq!(validate(&c), Err(EnvironmentError::Window));
    }

    #[test]
    fn unknown_fields_are_refused_and_missing_ones_default() {
        let c: PrivacyConfig = serde_json::from_str("{}").unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(c, PrivacyConfig::default());
        assert!(serde_json::from_str::<PrivacyConfig>(r#"{"canvas_noise": true}"#).is_err());
        assert!(serde_json::from_str::<PrivacyConfig>(r#"{"webrtc": "leak_everything"}"#).is_err());
    }

    #[test]
    fn support_differs_by_platform() {
        let c = PrivacyConfig {
            timezone: Some("Europe/Berlin".into()),
            language: Some("de-DE".into()),
            ..Default::default()
        };
        let tz = |p| {
            report(&c, p)
                .into_iter()
                .find(|r| r.field == "timezone")
                .map(|r| r.support)
        };
        assert_eq!(tz(Platform::Windows), Some(Support::Unavailable));
        assert_eq!(tz(Platform::Linux), Some(Support::Applied));
        assert_eq!(report(&PrivacyConfig::default(), Platform::Linux), vec![]);
    }

    #[test]
    fn proxies_force_proxy_only_webrtc() {
        let c = PrivacyConfig::default();
        assert_eq!(
            effective_webrtc(&c, true, true),
            WebRtcPolicy::DisableNonProxiedUdp
        );
        assert_eq!(effective_webrtc(&c, true, false), WebRtcPolicy::Default);
        assert_eq!(effective_webrtc(&c, false, true), WebRtcPolicy::Default);
        let matching = PrivacyConfig {
            match_proxy: true,
            ..Default::default()
        };
        assert_eq!(
            effective_webrtc(&matching, true, false),
            WebRtcPolicy::DisableNonProxiedUdp,
            "matching the proxy never lets WebRTC use this computer's own route"
        );
        assert_eq!(
            effective_webrtc(&matching, false, false),
            WebRtcPolicy::Default
        );
        assert_eq!(accept_languages("de-DE"), "de-DE,de");
    }

    fn berlin() -> ProxyGeo {
        ProxyGeo {
            country: Some("DE".into()),
            city: Some("Berlin".into()),
            timezone: Some("Europe/Berlin".into()),
            language: Some("de-DE".into()),
            latitude: Some(52.52),
            longitude: Some(13.41),
        }
    }

    #[test]
    fn matching_takes_the_proxy_location_but_manual_values_win() {
        let on = PrivacyConfig {
            match_proxy: true,
            ..Default::default()
        };
        let geo = berlin();
        assert_eq!(
            proxy_match(&on, true, Some(&geo)),
            ProxyMatch {
                language: Some("de-DE".into()),
                timezone: Some("Europe/Berlin".into()),
            }
        );
        // Off, no proxy, or no location: nothing.
        assert!(proxy_match(&PrivacyConfig::default(), true, Some(&geo)).is_empty());
        assert!(proxy_match(&on, false, Some(&geo)).is_empty());
        assert!(proxy_match(&on, true, None).is_empty());
        // A value the user chose is kept; only the other half follows the proxy.
        let manual = PrivacyConfig {
            timezone: Some("Asia/Kathmandu".into()),
            ..on.clone()
        };
        assert_eq!(
            proxy_match(&manual, true, Some(&geo)),
            ProxyMatch {
                language: Some("de-DE".into()),
                timezone: None,
            }
        );
        // Stored values are checked again before they become settings.
        let hostile = ProxyGeo {
            timezone: Some("../../etc/localtime".into()),
            language: Some("de --no-sandbox".into()),
            ..berlin()
        };
        assert!(proxy_match(&on, true, Some(&hostile)).is_empty());
        // Zones outside the preset list are fine when they come from the proxy (any IANA name).
        let lagos = ProxyGeo {
            timezone: Some("America/Argentina/Buenos_Aires".into()),
            language: Some("es-AR".into()),
            ..Default::default()
        };
        assert_eq!(
            proxy_match(&on, true, Some(&lagos)).timezone.as_deref(),
            Some("America/Argentina/Buenos_Aires")
        );
    }

    #[test]
    fn matching_is_reported_honestly_per_platform() {
        let on = PrivacyConfig {
            match_proxy: true,
            ..Default::default()
        };
        let support = |p| {
            report(&on, p)
                .into_iter()
                .find(|r| r.field == "match_proxy")
                .map(|r| (r.support, r.message))
        };
        let (win, win_msg) = support(Platform::Windows).unwrap_or((Support::Applied, ""));
        assert_eq!(win, Support::Partial);
        assert!(win_msg.contains("keeps the computer's time zone"));
        assert_eq!(
            support(Platform::Linux).map(|s| s.0),
            Some(Support::Applied)
        );
        for p in [Platform::Windows, Platform::MacOs, Platform::Linux] {
            let msg = support(p).map(|s| s.1).unwrap_or_default().to_lowercase();
            assert!(
                !msg.contains("undetect") && !msg.contains("fingerprint"),
                "{msg}"
            );
        }
        // The old field still deserialises (absent = off) and unknown fields are still refused.
        let c: PrivacyConfig =
            serde_json::from_str(r#"{"match_proxy": true}"#).unwrap_or_else(|e| panic!("{e}"));
        assert!(c.match_proxy);
        assert!(!PrivacyConfig::default().match_proxy);
    }

    #[test]
    fn location_lock_defaults_on_with_a_proxy_and_never_reaches_the_browser() {
        let none = PrivacyConfig::default();
        assert!(none.location_lock_on(true), "absent = on with a proxy");
        assert!(!none.location_lock_on(false), "no proxy, nothing to lock");
        let off = PrivacyConfig {
            location_lock: Some(false),
            open_check_page: true,
            ..Default::default()
        };
        assert!(!off.location_lock_on(true));
        // App-behaviour switches are not browser settings: they never ask for a restart.
        assert_eq!(off.browser_settings(), PrivacyConfig::default());
        // Stored documents stay as they were unless a switch is set (older builds keep reading them).
        assert_eq!(
            serde_json::to_string(&PrivacyConfig::default()).unwrap_or_default(),
            serde_json::to_string(&serde_json::from_str::<PrivacyConfig>("{}").unwrap_or_default())
                .unwrap_or_default()
        );
        let text = serde_json::to_string(&none).unwrap_or_default();
        assert!(
            !text.contains("location_lock") && !text.contains("open_check_page"),
            "{text}"
        );
        let back: PrivacyConfig =
            serde_json::from_str(&serde_json::to_string(&off).unwrap_or_default())
                .unwrap_or_default();
        assert_eq!(back, off);
    }
}
