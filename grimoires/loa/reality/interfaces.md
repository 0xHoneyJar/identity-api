# Interfaces & External Seams

## Ports (`packages/ports`)

- `SpinePort` — spine read/write (used by engine)
- `JWTSigner` — `jwt-signer.port.ts`
- JWT verifier / JWKS provider ports
- Credential bridge interface (adapters implement)

## Outbound adapters

| Seam | Adapter |
|------|---------|
| Postgres spine | `postgres-spine-adapter.ts` |
| Inventory HTTP | `http-inventory-adapter.ts` |
| SIWE / EIP191 / Dynamic | `credential-bridge-*.ts` |
| Gateway sign | `http-jwt-signer.ts` |
| Local svc sign | `local-es256-signer.ts` |
| JWKS validate | `jwks-validator.ts`, `svc-jwt-verifier.ts` |

## Inbound

- Hyper routes under `src/api/routes/*`
- Discord OAuth helpers `src/discord-oauth.ts`
- MCP: not implemented in-package (see mcp-tools README pointing at freeside-ruggy)
