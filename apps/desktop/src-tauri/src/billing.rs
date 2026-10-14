//! Billing pages (milestone 11, ADR-0018). The payment provider's checkout, customer portal and invoice pages open in
//! the person's default browser, never inside the manager, and only after the shell checks the address: https, no
//! user name or password, no port, and a host of the provider's hosted pages. The shell creates the checkout and
//! portal sessions itself (with the session's own credentials), so the manager window never receives a payment
//! address it could change or redirect.

use crate::ipc::{self, IpcError};
use crate::state::AppState;
use pb_cloud::Method;
use pb_sync::ApiError;
use pb_sync::rest::id_ok;
use serde_json::json;
use url::Url;

/// Hosts of the provider's hosted pages (checkout, customer portal, invoices and receipts).
pub const PAYMENT_HOSTS: &[&str] = &[
    "checkout.stripe.com",
    "billing.stripe.com",
    "invoice.stripe.com",
    "pay.stripe.com",
];

/// A provider page the shell may open, or None.
pub fn payment_url(raw: &str) -> Option<Url> {
    if raw.len() > ipc::limits::URL_BYTES {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    let ok = url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.host_str().is_some_and(|h| PAYMENT_HOSTS.contains(&h));
    ok.then_some(url)
}

fn plan_ok(plan: &str) -> bool {
    (2..=32).contains(&plan.len())
        && plan.as_bytes()[0].is_ascii_lowercase()
        && plan
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn invoice_ok(id: &str) -> bool {
    id.len() <= 67
        && id
            .strip_prefix("in_")
            .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// The API's answer as an error the window can explain.
fn billing_error(e: ApiError) -> IpcError {
    match e {
        ApiError::Offline => ipc::CLOUD_OFFLINE,
        ApiError::SignedOut => ipc::CLOUD_SIGNED_OUT,
        ApiError::Code { code, status } => match code.as_str() {
            "FORBIDDEN" | "NOT_FOUND" => ipc::BILLING_FORBIDDEN,
            "ALREADY_SUBSCRIBED" => ipc::ALREADY_SUBSCRIBED,
            "PLAN_NOT_AVAILABLE" => ipc::PLAN_NOT_AVAILABLE,
            "BILLING_UNAVAILABLE" => ipc::BILLING_UNAVAILABLE,
            _ if status >= 500 || status == 0 => ipc::BILLING_UNAVAILABLE,
            _ => ipc::CLOUD_BAD_RESPONSE,
        },
        _ => ipc::BILLING_UNAVAILABLE,
    }
}

impl AppState {
    /// Starts the provider's hosted checkout for a plan (owners) and returns the page to open.
    pub fn billing_checkout(&self, org: &str, plan: &str) -> Result<Url, IpcError> {
        if !id_ok("org", org) || !plan_ok(plan) {
            return Err(ipc::INVALID_ARGUMENT);
        }
        let key = pb_cloud::pkce::random_token(18).map_err(|_| ipc::INTERNAL)?;
        let answer = self
            .shell_api(
                Method::Post,
                &format!("/v1/orgs/{org}/billing/checkout-session"),
                Some(&key),
                Some(&json!({ "plan_id": plan })),
            )
            .map_err(billing_error)?;
        answer
            .get("url")
            .and_then(|u| u.as_str())
            .and_then(payment_url)
            .ok_or(ipc::DISALLOWED_URL)
    }

    /// The provider's customer portal (plan changes, payment methods, cancellation, invoices).
    pub fn billing_portal(&self, org: &str) -> Result<Url, IpcError> {
        if !id_ok("org", org) {
            return Err(ipc::INVALID_ARGUMENT);
        }
        let answer = self
            .shell_api(
                Method::Post,
                &format!("/v1/orgs/{org}/billing/portal-session"),
                None,
                None,
            )
            .map_err(billing_error)?;
        answer
            .get("url")
            .and_then(|u| u.as_str())
            .and_then(payment_url)
            .ok_or(ipc::DISALLOWED_URL)
    }

    /// One invoice's hosted page or PDF.
    pub fn billing_invoice(&self, org: &str, invoice: &str, pdf: bool) -> Result<Url, IpcError> {
        if !id_ok("org", org) || !invoice_ok(invoice) {
            return Err(ipc::INVALID_ARGUMENT);
        }
        let answer = self
            .shell_api(
                Method::Get,
                &format!("/v1/orgs/{org}/billing/invoices/{invoice}/links"),
                None,
                None,
            )
            .map_err(billing_error)?;
        let field = if pdf { "pdf_url" } else { "hosted_url" };
        answer
            .get(field)
            .and_then(|u| u.as_str())
            .and_then(payment_url)
            .ok_or(ipc::BILLING_PAGE_UNAVAILABLE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_providers_hosted_pages_open() {
        for ok in [
            "https://checkout.stripe.com/c/pay/cs_test_a1B2c3",
            "https://billing.stripe.com/p/session/test_abc",
            "https://invoice.stripe.com/i/acct_1/test_abc",
            "https://pay.stripe.com/invoice/acct_1/test_abc/pdf",
        ] {
            assert!(payment_url(ok).is_some(), "{ok}");
        }
        for bad in [
            "http://checkout.stripe.com/c/pay/cs_test",
            "https://checkout.stripe.com.evil.example/c/pay",
            "https://evil.example/checkout.stripe.com",
            "https://user:pw@checkout.stripe.com/c/pay",
            "https://checkout.stripe.com:8443/c/pay",
            "https://dashboard.stripe.com/",
            "javascript:alert(1)",
            "file:///etc/passwd",
        ] {
            assert!(payment_url(bad).is_none(), "{bad}");
        }
        assert!(
            payment_url(&format!("https://checkout.stripe.com/{}", "a".repeat(3000))).is_none()
        );
    }

    #[test]
    fn arguments_are_checked_before_any_request() {
        assert!(plan_ok("team") && plan_ok("agency_2"));
        assert!(!plan_ok("Team") && !plan_ok("t") && !plan_ok("team@1") && !plan_ok("../x"));
        assert!(invoice_ok("in_1MtHbELkdIwHu7ixl4OzzPMv"));
        assert!(!invoice_ok("in_") && !invoice_ok("in_1/../x") && !invoice_ok("ch_1"));
    }
}
