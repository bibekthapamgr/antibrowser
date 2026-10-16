//! The proxy location lock and the IP check page (ADR-0029).
//!
//! **Location lock.** Websites' account-security checks commonly react when a known account suddenly signs in from
//! somewhere else. So that a change never happens unnoticed, each profile remembers where its proxy exited at its
//! last successful open (address, country, city, time zone; `profile_locations`, and for a workspace profile also in
//! its encrypted backup's settings). With the lock on (`PrivacyConfig.location_lock`, on by default for a profile
//! with a proxy) every open compares a fresh check (reused when it is at most 10 minutes old, otherwise repeated for
//! at most 10 seconds through the existing pre-launch check) with that location:
//!
//! - another country, or no country could be checked when one was known before: the profile does **not** open; the
//!   launch fails with `PROXY_LOCATION_CHANGED` and a `PROXY_LOCATION_CHANGED` warning carries both locations, so the
//!   person can cancel or open anyway (an explicit override for that one open);
//! - same country, another city or address: the profile opens and the person gets a `PROXY_LOCATION_NOTICE`;
//! - nothing remembered yet: the profile opens and its location is remembered.
//!
//! The location is remembered once the browser has started. With the lock off nothing is checked or blocked. Audit
//! records hold only the outcome (`COUNTRY_CHANGED`, `IP_CHANGED`, …), never an address or a place; the warnings go
//! to this app's own window only. This is about consistency the person can see, not about hiding anything: the
//! website still sees the proxy's address, wherever that is.
//!
//! **IP check page.** With `PrivacyConfig.open_check_page` and an https account server, a profile opens
//! `<server>/check/` as its first tab (the public website's page that shows what the check service and the browser
//! itself report), followed by its own start pages; never for an automation session, and not when the profile's own
//! start pages already use every slot.

use crate::events::WARNING;
use crate::ipc::{self, IpcError};
use crate::state::AppState;
use pb_runtime::{MAX_START_URLS, ProfileId};
use pb_storage::network::{NetworkCheck, ProfileLocation};
use pb_storage::{LocalProfile, LocalStore};
use serde::Serialize;
use serde_json::json;

/// The lock reuses a check at most this old; an older one is repeated before the profile opens.
pub const LOCK_CHECK_MAX_AGE_SECS: i64 = 10 * 60;

/// A place as the lock compares it: the exit address and where the check service estimated it to be.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Place {
    pub ip: Option<String>,
    pub country: Option<String>,
    pub city: Option<String>,
    pub timezone: Option<String>,
}

impl Place {
    pub fn of_check(c: &NetworkCheck) -> Self {
        let geo = c.geo.clone().unwrap_or_default();
        Self {
            ip: c.egress_ip.clone(),
            country: geo.country,
            city: geo.city,
            timezone: geo.timezone,
        }
    }

    pub fn of_remembered(l: &ProfileLocation) -> Self {
        Self {
            ip: l.egress_ip.clone(),
            country: l.country.clone(),
            city: l.city.clone(),
            timezone: l.timezone.clone(),
        }
    }

    fn is_empty(&self) -> bool {
        self.ip.is_none() && self.country.is_none()
    }
}

/// How an open's proxy location compares with the one remembered from the last open.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// Nothing remembered yet.
    First,
    Same,
    /// Same country (and city, as far as known), another exit address.
    IpChanged,
    /// Same country, another city.
    CityChanged,
    CountryChanged,
    /// A country was known, but this check failed or gave none.
    Unverified,
}

impl Verdict {
    /// The profile opens only after the person confirms.
    pub fn needs_confirmation(self) -> bool {
        matches!(self, Self::CountryChanged | Self::Unverified)
    }

    /// Opens, with a notice.
    pub fn is_notice(self) -> bool {
        matches!(self, Self::IpChanged | Self::CityChanged)
    }

    /// The audit record's detail: the outcome only, never a value.
    pub fn code(self) -> &'static str {
        match self {
            Self::First => "FIRST",
            Self::Same => "SAME",
            Self::IpChanged => "IP_CHANGED",
            Self::CityChanged => "CITY_CHANGED",
            Self::CountryChanged => "COUNTRY_CHANGED",
            Self::Unverified => "UNVERIFIED",
        }
    }
}

/// Compares an open's check with the remembered location. `observed`: the place a working check reported, or the
/// check's error code.
pub fn compare(previous: Option<&Place>, observed: Result<&Place, &str>) -> Verdict {
    let Some(prev) = previous.filter(|p| !p.is_empty()) else {
        return Verdict::First;
    };
    let now = match observed {
        Ok(p) if !p.is_empty() => p,
        _ => return Verdict::Unverified,
    };
    let differs =
        |a: &Option<String>, b: &Option<String>| matches!((a, b), (Some(x), Some(y)) if x != y);
    match (&prev.country, &now.country) {
        (Some(_), None) => Verdict::Unverified,
        (Some(a), Some(b)) if a != b => Verdict::CountryChanged,
        _ if differs(&prev.city, &now.city) && prev.country.is_some() => Verdict::CityChanged,
        _ if differs(&prev.ip, &now.ip) => Verdict::IpChanged,
        _ => Verdict::Same,
    }
}

/// `<server>/check/` for an https account server with a host name (where the public website is served).
pub fn server_check_page(server: &str) -> Option<String> {
    let url = url::Url::parse(server).ok()?;
    if url.scheme() != "https" || url.query().is_some() || url.fragment().is_some() {
        return None;
    }
    let host = match url.host()? {
        url::Host::Domain(d) => d.to_owned(),
        _ => return None,
    };
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    Some(format!(
        "https://{host}{port}{}/check/",
        url.path().trim_end_matches('/')
    ))
}

/// The start pages of an open: the check page first (when wanted and there is room), then the profile's own.
pub fn with_check_page(check_page: Option<String>, urls: Vec<String>) -> Vec<String> {
    match check_page {
        Some(page) if urls.len() < MAX_START_URLS && !urls.contains(&page) => {
            std::iter::once(page).chain(urls).collect()
        }
        _ => urls,
    }
}

impl AppState {
    /// Whether the lock applies to this profile's opens: a proxy, and the lock not turned off.
    pub(crate) fn lock_applies(profile: &LocalProfile) -> bool {
        profile.privacy.location_lock_on(profile.proxy_id.is_some())
    }

    /// The proxy's last check when it worked within [`LOCK_CHECK_MAX_AGE_SECS`] (decided without waiting).
    pub(crate) fn recent_lock_check(
        &self,
        store: &LocalStore,
        profile: &LocalProfile,
    ) -> Option<NetworkCheck> {
        let proxy = store.get_proxy(profile.proxy_id.as_ref()?).ok().flatten()?;
        crate::network::check_is_fresh_within(
            &proxy,
            crate::network::now_seconds(),
            LOCK_CHECK_MAX_AGE_SECS,
        )
        .then_some(proxy.last_check)
        .flatten()
    }

    /// A check for the lock: recent enough, or a new one (blocks for at most 10 s; worker threads only).
    pub(crate) fn lock_check(
        &self,
        store: &LocalStore,
        profile: &LocalProfile,
    ) -> Result<NetworkCheck, String> {
        let proxy = profile
            .proxy_id
            .as_ref()
            .and_then(|id| store.get_proxy(id).ok().flatten())
            .ok_or_else(|| ipc::UNKNOWN_PROXY.code.to_owned())?;
        self.proxy_check_for_launch(store, &proxy, LOCK_CHECK_MAX_AGE_SECS)
    }

    /// Compares the check with the remembered location and decides: `Err(PROXY_LOCATION_CHANGED)` when the person
    /// has to confirm first (`allow_change` is that confirmation). Tells the person (warnings), records the outcome
    /// in the audit log (codes only) and keeps what this open saw, to be remembered once the browser has started.
    pub(crate) fn decide_location(
        &self,
        store: &LocalStore,
        profile: &LocalProfile,
        check: Result<NetworkCheck, String>,
        allow_change: bool,
    ) -> Result<Verdict, IpcError> {
        let id = &profile.id;
        let remembered = store.profile_location(id).ok().flatten();
        let previous = remembered.as_ref().map(Place::of_remembered);
        let observed: Result<Place, String> = match check {
            Ok(c) if c.result == "ok" => Ok(Place::of_check(&c)),
            Ok(c) => Err(c.error_code.unwrap_or_else(|| "CHECK_FAILED".into())),
            Err(code) => Err(code),
        };
        let verdict = compare(previous.as_ref(), observed.as_ref().map_err(String::as_str));
        let details = || {
            json!({
                "profile_id": id.as_str(),
                "verdict": verdict,
                "previous": previous,
                "previous_seen_at": remembered.as_ref().map(|l| l.seen_at.clone()),
                "current": observed.as_ref().ok(),
                "reason": observed.as_ref().err(),
            })
        };
        if verdict.needs_confirmation() {
            if !allow_change {
                let _ = store.audit(
                    Some(id),
                    "network",
                    "location_changed",
                    None,
                    Some(verdict.code()),
                );
                let mut payload = details();
                payload["code"] = json!("PROXY_LOCATION_CHANGED");
                self.events.emit_json(WARNING, payload);
                return Err(ipc::PROXY_LOCATION_CHANGED);
            }
            let _ = store.audit(
                Some(id),
                "network",
                "location_override",
                None,
                Some(verdict.code()),
            );
        } else if verdict.is_notice() {
            let _ = store.audit(
                Some(id),
                "network",
                "location_notice",
                None,
                Some(verdict.code()),
            );
            let mut payload = details();
            payload["code"] = json!("PROXY_LOCATION_NOTICE");
            self.events.emit_json(WARNING, payload);
        }
        match observed {
            Ok(place) if !place.is_empty() => self.keep_pending_location(
                id,
                ProfileLocation {
                    egress_ip: place.ip,
                    country: place.country,
                    city: place.city,
                    timezone: place.timezone,
                    seen_at: String::new(),
                },
            ),
            _ => self.forget_pending_location(id),
        }
        Ok(verdict)
    }

    fn keep_pending_location(&self, id: &ProfileId, location: ProfileLocation) {
        if let Ok(mut p) = self.pending_locations.lock() {
            p.insert(id.clone(), location);
        }
    }

    pub(crate) fn forget_pending_location(&self, id: &ProfileId) {
        if let Ok(mut p) = self.pending_locations.lock() {
            p.remove(id);
        }
    }

    /// The browser started: what this open saw becomes the remembered location.
    pub(crate) fn remember_location(&self, store: &LocalStore, id: &ProfileId) {
        let pending = self
            .pending_locations
            .lock()
            .ok()
            .and_then(|mut p| p.remove(id));
        if let Some(location) = pending {
            let _ = store.set_profile_location(id, &location);
        }
    }

    /// `<server>/check/` when an https account server is configured.
    pub(crate) fn check_page_url(&self, store: &LocalStore) -> Option<String> {
        store
            .cloud_state(pb_storage::cloud::SERVER_URL)
            .ok()
            .flatten()
            .and_then(|s| server_check_page(&s))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn place(ip: &str, country: Option<&str>, city: Option<&str>) -> Place {
        Place {
            ip: Some(ip.into()),
            country: country.map(Into::into),
            city: city.map(Into::into),
            timezone: None,
        }
    }

    #[test]
    fn the_lock_asks_only_when_the_country_changes_or_cannot_be_checked() {
        let ny = place("198.51.100.7", Some("US"), Some("New York"));
        let ny_new_ip = place("198.51.100.8", Some("US"), Some("New York"));
        let la = place("198.51.100.9", Some("US"), Some("Los Angeles"));
        let berlin = place("203.0.113.5", Some("DE"), Some("Berlin"));
        let us_no_city = place("198.51.100.7", Some("US"), None);
        let ip_only = place("198.51.100.7", None, None);

        assert_eq!(compare(None, Ok(&ny)), Verdict::First);
        assert_eq!(compare(None, Err("PROXY_TIMEOUT")), Verdict::First);
        assert_eq!(compare(Some(&ny), Ok(&ny)), Verdict::Same);
        assert_eq!(compare(Some(&ny), Ok(&ny_new_ip)), Verdict::IpChanged);
        assert_eq!(compare(Some(&ny), Ok(&la)), Verdict::CityChanged);
        assert_eq!(compare(Some(&ny), Ok(&berlin)), Verdict::CountryChanged);
        // A city the service no longer reports is not a change; the address still counts.
        assert_eq!(compare(Some(&ny), Ok(&us_no_city)), Verdict::Same);
        // A known country that cannot be checked now is never waved through.
        assert_eq!(
            compare(Some(&ny), Err("PROXY_TIMEOUT")),
            Verdict::Unverified
        );
        assert_eq!(compare(Some(&ny), Ok(&ip_only)), Verdict::Unverified);
        assert_eq!(
            compare(Some(&ny), Ok(&Place::default())),
            Verdict::Unverified
        );
        // Without a known country (e.g. no location service), only the address can be compared.
        assert_eq!(compare(Some(&ip_only), Ok(&ip_only)), Verdict::Same);
        assert_eq!(
            compare(Some(&ip_only), Ok(&place("192.0.2.1", None, None))),
            Verdict::IpChanged
        );
        assert_eq!(compare(Some(&ip_only), Ok(&berlin)), Verdict::IpChanged);
        assert_eq!(
            compare(Some(&ip_only), Err("CHECK_FAILED")),
            Verdict::Unverified
        );

        for v in [Verdict::CountryChanged, Verdict::Unverified] {
            assert!(v.needs_confirmation() && !v.is_notice(), "{v:?}");
        }
        for v in [Verdict::IpChanged, Verdict::CityChanged] {
            assert!(!v.needs_confirmation() && v.is_notice(), "{v:?}");
        }
        for v in [Verdict::First, Verdict::Same] {
            assert!(!v.needs_confirmation() && !v.is_notice(), "{v:?}");
        }
    }

    #[test]
    fn the_check_page_is_the_servers_and_comes_first_when_there_is_room() {
        assert_eq!(
            server_check_page("https://app.example.com").as_deref(),
            Some("https://app.example.com/check/")
        );
        assert_eq!(
            server_check_page("https://app.example.com:8443/").as_deref(),
            Some("https://app.example.com:8443/check/")
        );
        for bad in [
            "http://app.example.com",
            "https://192.0.2.1",
            "https://app.example.com/?x=1",
            "https://user:pw@app.example.com",
            "not a url",
        ] {
            assert_eq!(server_check_page(bad), None, "{bad}");
        }
        let page = Some("https://app.example.com/check/".to_owned());
        let own = vec!["https://shop.example/".to_owned()];
        assert_eq!(
            with_check_page(page.clone(), own.clone()),
            vec![
                "https://app.example.com/check/".to_owned(),
                "https://shop.example/".to_owned()
            ]
        );
        assert_eq!(
            with_check_page(page.clone(), vec![]),
            vec!["https://app.example.com/check/".to_owned()]
        );
        assert_eq!(with_check_page(None, own.clone()), own);
        // The profile's own start pages are never dropped to make room.
        let full: Vec<String> = (0..MAX_START_URLS)
            .map(|i| format!("https://site{i}.example/"))
            .collect();
        assert_eq!(with_check_page(page, full.clone()), full);
    }
}
