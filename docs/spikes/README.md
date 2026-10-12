# Milestone 01 spike reports

| Step | Question | Result | Report |
|---|---|---|---|
| 4 | Do two sandboxed Chromium instances with distinct directories isolate cookie, localStorage and IndexedDB on a controlled origin? | **Yes** (Linux harness). Windows/macOS runs pending with the chosen runtime. | [01-step4-storage-isolation.md](01-step4-storage-isolation.md) |
| 5 | Does Tauri IPC reject invalid profile/path launch requests before any process starts? | **Yes**, through the real IPC pipeline and capability ACL | [01-step5-ipc-validation.md](01-step5-ipc-validation.md) |
| 6 | Does a closed-profile snapshot restore on the same device, and across devices? | **Same device: yes.** Cross-device: Windows/macOS **not yet run**; ADR-0002 applies the stop gate | [01-step6-snapshot-restore.md](01-step6-snapshot-restore.md) |

Raw JSON output is in [results/](results/).

## Harness browser (important limitation)
The verification sandbox could not download Chrome, Chrome for Testing or a full Chromium build. The spikes therefore ran against **headless Chromium 153.0.8010.0** shipped inside the npm package `@sparticuz/chromium@153.0.0` (a serverless-oriented build), extracted to `/opt/pb-chromium` with its bundled NSS libraries and fonts. It is a test harness only, not a candidate product runtime (ADR-0001).

The harness keeps security features on: no `--no-sandbox`, no `--disable-web-security`, no site-isolation changes, no single-process mode. The only extra flag is `--disable-gpu` because the container has no GPU. Spikes refuse to run as root, and Chromium on Linux refuses to start without a usable sandbox, so a successful run means the sandbox was active.

To run with another browser (required on Windows/macOS):

```bash
pnpm spike:isolation -- --browser "/path/to/chromium-or-chrome" --headless new
pnpm spike:snapshot  -- --browser "/path/to/chromium-or-chrome" --headless new
```
