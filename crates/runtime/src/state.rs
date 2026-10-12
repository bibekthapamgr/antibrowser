//! Profile run-state machine (milestone 03, step 2).
//!
//! ```text
//!            start                ready
//!  STOPPED ────────▶ STARTING ────────────▶ RUNNING
//!     ▲  ▲  ▲           │ exit(crash)         │ exit(clean) ──▶ STOPPED
//!     │  │  │           ▼                     │ exit(crash) ──▶ CRASHED
//!     │  │  │        CRASHED ◀────────────────┘
//!     │  │  │  stop      │ start (reopen, user-initiated only)
//!     │  │  └── STOPPING ◀── stop (from STARTING or RUNNING)
//!     │  │         │ exited / force-stopped
//!     │  └─────────┘
//!     │ recovered          recover
//!     └──────────── RECOVERING ◀──── (from STOPPED or CRASHED)
//! ```
//! Every transition not listed is rejected, so a bug cannot, for example, start a profile that is still stopping.
//! The manager never restarts a crashed profile by itself: reopening is always a user action.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Crashed,
    Recovering,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunEvent {
    /// User asked to open the profile.
    Start,
    /// The browser holds its profile lock and has started its helper processes.
    Ready,
    /// The browser main process exited. `clean` comes from Chromium's own exit record (or exit status).
    Exited {
        clean: bool,
    },
    /// The process could not be created at all.
    StartFailed,
    /// User asked to close the profile.
    Stop,
    /// The user confirmed a forced close after the graceful timeout and the process tree is gone.
    ForceStopped,
    /// User asked to restore from the last good backup or start fresh.
    Recover,
    Recovered,
    RecoveryFailed,
    /// On manager start: a verified browser for this profile is still running.
    Adopt,
    /// On manager start: the manager died during STARTING/STOPPING/RECOVERING and no browser is running.
    Interrupted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("invalid transition from {from:?} on {event:?}")]
pub struct InvalidTransition {
    pub from: RunState,
    pub event: RunEvent,
}

impl RunState {
    pub fn next(self, event: RunEvent) -> Result<RunState, InvalidTransition> {
        use RunEvent as E;
        use RunState as S;
        let to = match (self, event) {
            (S::Stopped | S::Crashed, E::Start) => S::Starting,
            (S::Starting, E::Ready) => S::Running,
            (S::Starting, E::StartFailed) => S::Stopped,
            (S::Starting | S::Running, E::Exited { clean: true }) => S::Stopped,
            (S::Starting | S::Running, E::Exited { clean: false }) => S::Crashed,
            (S::Starting | S::Running, E::Stop) => S::Stopping,
            // Once the user asked to close, any exit counts as closed (the run record keeps the real outcome).
            (S::Stopping, E::Exited { .. } | E::ForceStopped) => S::Stopped,
            (S::Stopped | S::Crashed, E::Recover) => S::Recovering,
            (S::Recovering, E::Recovered) => S::Stopped,
            (S::Recovering, E::RecoveryFailed) => S::Crashed,
            (S::Stopped | S::Crashed | S::Starting | S::Stopping, E::Adopt) => S::Running,
            (S::Running, E::Adopt) => S::Running,
            (S::Starting | S::Stopping, E::Interrupted) => S::Stopped,
            (S::Recovering, E::Interrupted) => S::Crashed,
            (from, event) => return Err(InvalidTransition { from, event }),
        };
        Ok(to)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Crashed => "crashed",
            Self::Recovering => "recovering",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "stopped" => Self::Stopped,
            "starting" => Self::Starting,
            "running" => Self::Running,
            "stopping" => Self::Stopping,
            "crashed" => Self::Crashed,
            "recovering" => Self::Recovering,
            _ => return None,
        })
    }

    /// States in which a browser process may exist for the profile.
    pub fn is_active(self) -> bool {
        matches!(self, Self::Starting | Self::Running | Self::Stopping)
    }
}

#[cfg(test)]
mod tests {
    use super::RunEvent as E;
    use super::RunState as S;
    use super::*;

    const ALL_STATES: [S; 6] = [
        S::Stopped,
        S::Starting,
        S::Running,
        S::Stopping,
        S::Crashed,
        S::Recovering,
    ];
    const ALL_EVENTS: [E; 12] = [
        E::Start,
        E::Ready,
        E::Exited { clean: true },
        E::Exited { clean: false },
        E::StartFailed,
        E::Stop,
        E::ForceStopped,
        E::Recover,
        E::Recovered,
        E::RecoveryFailed,
        E::Adopt,
        E::Interrupted,
    ];

    #[test]
    fn normal_lifecycle() -> Result<(), InvalidTransition> {
        let s = S::Stopped.next(E::Start)?.next(E::Ready)?;
        assert_eq!(s, S::Running);
        assert_eq!(
            s.next(E::Stop)?.next(E::Exited { clean: true })?,
            S::Stopped
        );
        assert_eq!(
            s.next(E::Stop)?.next(E::ForceStopped)?,
            S::Stopped,
            "explicit force close after timeout"
        );
        assert_eq!(
            s.next(E::Exited { clean: true })?,
            S::Stopped,
            "user closed the window"
        );
        Ok(())
    }

    #[test]
    fn crash_and_recovery() -> Result<(), InvalidTransition> {
        let crashed = S::Running.next(E::Exited { clean: false })?;
        assert_eq!(crashed, S::Crashed);
        assert_eq!(S::Starting.next(E::Exited { clean: false })?, S::Crashed);
        assert_eq!(crashed.next(E::Start)?, S::Starting, "reopen is allowed");
        assert_eq!(crashed.next(E::Recover)?.next(E::Recovered)?, S::Stopped);
        assert_eq!(
            crashed.next(E::Recover)?.next(E::RecoveryFailed)?,
            S::Crashed
        );
        Ok(())
    }

    #[test]
    fn rejects_unsafe_transitions() {
        for (from, event) in [
            (S::Running, E::Start),
            (S::Starting, E::Start),
            (S::Stopping, E::Start),
            (S::Recovering, E::Start),
            (S::Running, E::Recover),
            (S::Stopping, E::Recover),
            (S::Stopped, E::Stop),
            (S::Stopped, E::Ready),
            (S::Recovering, E::Adopt),
        ] {
            assert!(from.next(event).is_err(), "{from:?} + {event:?}");
        }
    }

    #[test]
    fn every_state_round_trips_and_the_table_is_total() {
        for s in ALL_STATES {
            assert_eq!(S::parse(s.as_str()), Some(s));
            // Every (state, event) pair is either a defined transition or an explicit error: never a panic.
            for e in ALL_EVENTS {
                let _ = s.next(e);
            }
        }
        assert_eq!(S::parse("bogus"), None);
    }

    #[test]
    fn only_active_states_may_have_a_process() {
        let active: Vec<S> = ALL_STATES.into_iter().filter(|s| s.is_active()).collect();
        assert_eq!(active, vec![S::Starting, S::Running, S::Stopping]);
    }
}
