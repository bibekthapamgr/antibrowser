# 0006 — Supported operating systems
Status: **Accepted**. Date: 2026-10-12. Owner: product owner.

## Decision
- **v1 targets:** Windows 11 x64 and macOS on Apple Silicon (current and previous major macOS release).
- **Not v1:** macOS Intel and Linux desktop. Each needs an explicit support gate (CI build, test pass, signed artifact, validated sync pairs) before being offered. Linux is used only as the CI/spike harness.
- Windows 10 is not targeted (end of mainstream support October 2025).
- CI compiles and tests the desktop manager on `windows-latest` and `macos-14` (Apple Silicon) on every pull request (`.github/workflows/ci.yml`).
- Team beta: cloud sync and handoff are offered **only on OS combinations validated** by the step-6 spike (ADR-0002).

## Consequences
Code signing must be in place from milestone 02: Apple Developer Program enrollment for the company (D-U-N-S number) and a Windows code-signing certificate or signing service. Both have lead times of days to weeks; start now.
