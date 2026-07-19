# Security Model

## Cross-user session fixation

An attacker starts a link and sends it to a victim. Bind completion to the initiating identity-api user/session. PKCE alone is insufficient.

## Provider/toolkit mix-up

Persist and validate provider, issuer, client ID, redirect URI, tenant/world, and toolkit/integration context.

## Deep-link forwarding

Use short TTL, single use, visible confirmation, rate limits, and same-user binding. Possession of a forwarded link is not sufficient proof.

## Credential collision

Fail closed, audit, and require explicit recovery/transfer/merge workflow.

## Wallet address injection

Create addressless intents and derive/verify the account from the signature.

## Replay

Use nonce uniqueness, expiry, atomic intent consumption, compare-and-swap, and proof transaction references.

## Session policy

Prefer opaque secure HTTP-only cookies, rotation, revocation, bounded idle/absolute lifetimes, CSRF protection, and audience-specific downstream tokens. Avoid long-lived local-storage bearer tokens and provider tokens as identity sessions.
