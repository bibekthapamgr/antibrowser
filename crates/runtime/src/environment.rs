//! Per-profile privacy and environment settings (milestone 05).
//!
//! These are **configuration and QA controls** applied through switches and preferences that Chromium itself
//! supports: WebRTC IP handling, third-party cookies, Do Not Track, page language, time zone, initial window size,
//! text size and reduced motion. They change what the browser sends and shows. They do not make a profile look like
//! a different device, and nothing here randomises browser fingerprints.
//!
//! Support differs by operating system (see [`report`]): a setting the browser cannot apply on this OS is shown as
//! unavailable rather than claimed. The real-browser tests (`tests/browser.rs`) check each one per OS.

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

/// The WebRTC policy actually used: a proxy with fail-closed routing forces "proxy only".
pub fn effective_webrtc(c: &PrivacyConfig, fail_closed_proxy: bool) -> WebRtcPolicy {
    if fail_closed_proxy {
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
            effective_webrtc(&c, true),
            WebRtcPolicy::DisableNonProxiedUdp
        );
        assert_eq!(effective_webrtc(&c, false), WebRtcPolicy::Default);
        assert_eq!(accept_languages("de-DE"), "de-DE,de");
    }
}
