# 0003 — Encryption trust model and key custody
Status: **Proposed**. Date: 2026-10-12. Owner: technical lead + security. Blocks: milestones 06–08.

## Context
The roadmap promises "optional encrypted cloud sync" and stores "encrypted immutable snapshots" in private object storage, with device-wrapped keys in the OS keychain. The open question is who can decrypt snapshots: only customer devices (end-to-end), or also our service (provider-managed keys). The answer drives team sharing, handoff, recovery and what marketing may claim.

## Options
| | A. Provider-managed envelope encryption | B. End-to-end (customer-held keys) |
|---|---|---|
| Who can decrypt | Customer devices; our service via KMS, under audit | Only devices holding the org key |
| Team handoff | Server authorizes and unwraps per request | Org key wrapped to each member device's public key |
| Recovery when a device is lost | Straightforward | Needs recovery key / escrow; data loss risk |
| Marketing claim allowed | "Encrypted in transit and at rest" | "End-to-end encrypted" only if no escrow |
| Complexity for v1 | Lower | Substantially higher |

## Proposed decision
- **v1: option A, client-side encrypted with provider-managed key custody.**
  - Each snapshot is encrypted on the device with a fresh 256-bit data key (scheme id `aes-256-gcm-chunked-v1`, chunked AEAD so large profiles stream). Object storage only ever receives ciphertext.
  - The data key is wrapped by a per-organization key held in a cloud KMS. Unwrap happens through the API only for an authenticated member with `snapshot.restore`, holding the live lease (fencing token), and every unwrap is audited.
  - Devices cache wrapped keys in the OS keychain; refresh tokens also live in the keychain.
- **Disclosures (security model):** we, as operator, could technically decrypt snapshots via KMS; access is restricted and audited. Profiles in active use are plaintext to Chromium on the device. We do not claim end-to-end or zero-knowledge encryption.
- **Later option:** an opt-in end-to-end mode (B) for organizations that accept recovery trade-offs, scoped separately.

## Consequences
- The API needs a key-wrap endpoint and KMS integration (07); key ids are already part of the snapshot manifest contract.
- Org key rotation must re-wrap data keys without re-uploading snapshots.
- Cross-tenant KMS permission boundaries are a security review item for 12.

## Revisit when
A pilot customer requires end-to-end encryption, or legal review of data-processing terms changes custody requirements.
