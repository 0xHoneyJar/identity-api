# Domain Model

## CanonicalUser

Stable identity-api actor. It is not synonymous with a wallet, Discord account, Telegram account, person, character, or world membership.

## CredentialKey

Immutable key: `provider + issuer + subject`.

Examples:

```text
discord | https://discord.com | 123456789
telegram | https://oauth.telegram.org | 99887766
wallet | did:pkh | eip155:1:0xabc...
passkey | https://identity.example | credential-id
```

## CredentialLink

Associates one CredentialKey with one CanonicalUser. Suggested states: ACTIVE, REVOKED, TRANSFER_PENDING, COLLISION_REVIEW.

## CredentialProof

Append-only verification evidence containing proof type/version, verifier, policy version, timestamp, claims, and source reference/hash.

## LinkIntent

One-time OAuth/OIDC/bot transaction: PENDING, CONSUMED, EXPIRED, CANCELLED.

## AuthIntent

One-time wallet challenge that can exist before an account is known.

## IdentitySession

A durable identity-api session, distinct from WalletConnect, provider access tokens, vendor sessions, and browser local state.

## Invariants

- a credential has at most one active canonical owner
- consumed or expired intents cannot complete
- completion must match initiating user/session
- collisions never silently merge users
- revocation preserves history
- profile metadata is not identity authority
