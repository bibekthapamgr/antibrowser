//! Navigation policy for the privileged manager webview.
//!
//! - The webview may only show the bundled app (and the Vite dev server in debug builds). Every other navigation
//!   and every new-window request is denied (milestone 02, step 1).
//! - External links (help, documentation) open in the user's ordinary default browser, never inside the manager,
//!   and only for https URLs on an allow-list. Untrusted browsing happens only in separate profile processes.

use url::Url;

/// Hosts whose https pages may be opened from the manager UI in the default browser.
pub const HELP_HOSTS: &[&str] = &["github.com"];

/// Origins the manager webview itself may display.
pub fn is_app_url(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => {
            let host = url.host_str().unwrap_or_default();
            (host == "tauri.localhost" && url.port().is_none())
                || (cfg!(debug_assertions) && host == "localhost" && url.port() == Some(5173))
        }
        _ => false,
    }
}

pub fn allowed_external(raw: &str) -> Option<Url> {
    if raw.len() > crate::ipc::limits::URL_BYTES {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    let ok = url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.host_str().is_some_and(|h| HELP_HOSTS.contains(&h));
    ok.then_some(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webview_navigation_is_limited_to_the_bundled_app() {
        let ok = ["tauri://localhost/index.html", "http://tauri.localhost/"];
        let bad = [
            "https://example.com/",
            "http://tauri.localhost:8080/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<script>",
            "tauri://evil/",
        ];
        for u in ok {
            assert!(
                is_app_url(&Url::parse(u).unwrap_or_else(|e| panic!("{e}"))),
                "{u}"
            );
        }
        for u in bad {
            if let Ok(parsed) = Url::parse(u) {
                assert!(!is_app_url(&parsed), "{u}");
            }
        }
    }

    #[test]
    fn external_links_are_https_allowlisted_only() {
        assert!(allowed_external("https://github.com/bibekthapamgr/antibrowser").is_some());
        for bad in [
            "http://github.com/",
            "https://evil.example/",
            "https://github.com.evil.example/",
            "https://user:pw@github.com/",
            "https://github.com:444/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "projectbrowser://auth/callback",
        ] {
            assert!(allowed_external(bad).is_none(), "{bad}");
        }
        assert!(allowed_external(&format!("https://github.com/{}", "a".repeat(3000))).is_none());
    }
}
