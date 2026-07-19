# Reference Architecture

## Objective

Answer consistently: which canonical actor is entitled to present, link, revoke, or use an external credential?

## Topology

```text
Inbound adapters: HTTP / bot / admin / MCP
             |
             v
Inbound ports: commands and queries
             |
             v
Application: link/auth/session use cases
             |
             v
Domain: users, credential links, intents, invariants
             |
             v
Outbound ports: repositories, verifiers, audit, tokens, clock
             |
             v
Adapters: Discord, Telegram, SIWX, passkey, Postgres, cookies
```

Dependencies point inward: `adapters -> ports -> application -> domain`.

## Provider-neutral evidence

```ts
type VerifiedCredentialEvidence = {
  provider: string
  issuer: string
  subject: string
  proofType: string
  proofVersion: string
  verifiedAt: string
  claims: Record<string, unknown>
  sourceReference?: string
}
```

## Transactional link completion

Atomically:

1. lock or compare-and-swap the intent
2. confirm pending, unexpired, unconsumed state
3. validate initiating user/session and provider context
4. resolve `provider + issuer + subject`
5. create, return idempotent success, or emit collision
6. append verification proof
7. consume intent
8. append audit event
9. commit

## World separation

```text
credential proof -> canonical user -> world membership / character / authorization
```

World roles, inventory, and character ownership do not belong in the credential-link aggregate.
