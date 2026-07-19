# Claude CLI Prompt — identity-api Authentication and Linking

You are a senior identity-platform engineer operating inside the target repository.

Implement the architecture in this package while preserving the repository's coding conventions, tests, public contracts, signer/JWKS behavior, release process, and migration system.

## Intent

`identity-api` is the canonical identity source of record and issuer.

Discord, Telegram, Telegram Mini Apps, bots, SIWE/SIWX, Reown, passkeys, Better Auth, Dynamic, Privy, and embedded-wallet systems are adapters. They may verify or transport credentials, but they may not become the canonical user store, merge authority, durable session authority, or token issuer.

## Required architecture

Use strict hexagonal architecture:

```text
src/
  domain/
  application/
  ports/
    inbound/
    outbound/
  adapters/
    inbound/
    outbound/
  composition/
```

Dependencies point inward only.

### Domain owns

- canonical user identity
- immutable external credential key
- credential standing and transitions
- link collision policy
- link/unlink/revoke rules
- chain-neutral account identifiers
- intent state transitions
- audit facts

The domain imports no HTTP framework, OAuth SDK, wallet SDK, database library, JWT library, or environment configuration.

### Application owns

- CreateLinkIntent
- CompleteCredentialLink
- CreateWalletAuthIntent
- CompleteWalletAuthentication
- ResumeSession
- RevokeCredential
- InspectCredentialStanding

Application depends only on domain and ports.

### Ports define

- user, credential, proof, link-intent, auth-intent, and session repositories
- unit of work
- clock, ID, nonce, and hash generators
- provider proof verifier registry
- wallet proof verifier registry
- session issuer
- service-token issuer
- audit sink

### Adapters implement

- Discord OAuth2 authorization code
- Telegram OIDC authorization code + PKCE
- Telegram Mini App initData
- guarded bot/deep-link one-time codes
- SIWE/SIWX
- Reown transport integration
- passkey/WebAuthn
- Postgres/Redis
- HTTP/cookie/session transport

## Security invariants

1. External credentials are uniquely keyed by `provider + issuer + subject`.
2. Never auto-link by email, username, display name, Discord handle, Telegram handle, or wallet label.
3. The identity-api user/session that starts a link must be the same one that completes it.
4. PKCE is required where supported, but is not sufficient. Bind provider, issuer, integration/toolkit, tenant/world, client ID, redirect URI, state, nonce, PKCE challenge, expiry, initiating user, and initiating session.
5. Bot/QR/deep-link codes are random, short-lived, single-use, context-bound, rate-limited, and visibly confirmed.
6. Wallet auth supports an addressless intent. Never trust a client-supplied address without proof.
7. Canonical wallet identity uses CAIP-2 chain IDs and CAIP-10 account IDs.
8. Wallet connection state is not a durable identity session.
9. Collision, transfer, merge, unlink, and revocation are explicit audited state transitions.

## Required vertical slice

Implement:

- CanonicalUser
- CredentialKey
- CredentialLink
- CredentialProof
- LinkIntent
- AuthIntent
- domain errors and collision outcomes
- CreateLinkIntent
- CompleteCredentialLink
- CreateWalletAuthIntent
- CompleteWalletAuthentication
- ResumeSession
- RevokeCredential
- all required ports
- in-memory adapters for tests
- repository-native Postgres adapters/migrations
- Discord OAuth2 adapter
- Telegram OIDC adapter
- SIWE/SIWX adapter
- durable cookie/session adapter
- repository-native HTTP handlers

## Persistence shape

Preserve these logical tables, adapted to repository conventions:

```text
canonical_users
credential_links
credential_proofs
link_intents
auth_intents
identity_sessions
identity_audit_events
```

Require `UNIQUE(provider, issuer, subject)` and transactionally atomic intent consumption.

## Completion policy

- no existing credential: link to initiating canonical user
- existing credential owned by same user: idempotent success
- existing credential owned by another user: explicit collision; never merge silently

## Wallet authentication ladder

1. Resume valid identity-api session.
2. Create addressless AuthIntent.
3. Use Reown SIWX / One-Click where supported.
4. Capability-detect newer methods.
5. Fall back to SIWE.
6. Verify server-side.
7. Resolve/link CAIP account.
8. Issue identity-api durable session.

## Workflow

1. Read all applicable CLAUDE.md files.
2. Inspect repository state, migrations, tests, signer/JWKS, existing credential bridges, and sessions.
3. Produce an implementation map: preserve, extend, add, migrate, compatibility risks.
4. Reconcile this handoff with repository reality. Preserve the architectural intent even when filenames differ.
5. Implement the smallest coherent vertical slice.
6. Run tests, type checking, lint, architecture checks, and migrations.
7. Report changed contracts, compatibility impact, security assumptions, remaining work, and exact verification commands.

## Do not

- replace the sovereign signer or JWKS contract casually
- make Better Auth, Dynamic, Privy, Reown, Discord, or Telegram the source of record
- create a second canonical session authority
- auto-link by email
- trust client-supplied wallet addresses
- leak provider SDK types into domain/application
- store provider access tokens unless provider API access is an explicit product need
- implement UI-first flows without server-side transaction binding

Use the files in `docs/` and `reference-implementation/` as a projection guide, not as code to paste blindly.
