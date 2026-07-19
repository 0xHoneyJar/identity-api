# Types / Persistence

## Spine tables (authoritative)

From `packages/adapters/src/migrations/0001_init_spine.up.sql`:

- `users(user_id, primary_wallet, …)`
- `wallet_links(wallet_address, user_id, chain_ids[], is_primary, verified_at, unlinked_at)`
- `linked_accounts(user_id, provider, external_id, …)` providers: `discord|telegram|dynamic_user_id`
- `worlds`, `world_identity`
- `audit_events`, `auth_nonces`

Later: `cell_api_keys`, `operator_grants`, `service_jwt_*`, `world_managers`, `world_name_types`, `world_identity_names`.

## Protocol highlights

- JWT claims / tier schemas — `packages/protocol`
- Resolve result shapes — `packages/protocol/src/resolve-result.ts`

## Handoff types (not in repo)

`CredentialKey`, `LinkIntent`, `CompleteCredentialLink` live only under `context/handoff/.../reference-implementation/`.
