//! Authorized automation on the desktop (milestone 10, ADR-0017).
//!
//! - [`pipe`]: the browser's DevTools protocol over a protected pipe (never a debugging port).
//! - [`hub`]: one connection over that pipe, shared by this app's steps and, for a debugging session, one relayed
//!   client.
//! - [`workflow`]: the allowlisted steps (open an approved address, wait for a condition, take a screenshot).
//! - [`origin`]: approved-site matching (the same grammar and vectors as the API).
//! - [`broker`]: the authenticated loopback broker for Playwright debugging sessions (off by default).
//!
//! Automation sessions are launched with `--enable-automation`: websites can tell the browser is automated
//! (`navigator.webdriver`), and the window shows that it is being controlled. Nothing here hides automation.

pub mod broker;
pub mod hub;
pub mod origin;
pub mod pipe;
pub mod workflow;

#[cfg(any(test, feature = "testing"))]
pub mod fake;

pub use hub::{CdpError, Event, Hub};
pub use pipe::{DevtoolsPipes, PipeEnds};
pub use workflow::{Condition, Opened, Page, Shot, StepError, close_browser};

impl From<PipeEnds> for Hub {
    fn from(p: PipeEnds) -> Self {
        Hub::new(Box::new(p.from_browser), Box::new(p.to_browser))
    }
}

#[cfg(test)]
mod tests;
