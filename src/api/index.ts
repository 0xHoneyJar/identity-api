/**
 * src/api/index.ts — identity-api Hyper runtime entry.
 *
 * Wires the building's Hyper app:
 *   - secure-by-default plugin set: hyperLog + openapiPlugin + authJwtPlugin
 *   - openapiHandlers mounted at /openapi.json (+ /docs Swagger UI)
 *   - MCP scaffolding via the per-route meta.mcp opt-in (routes that set
 *     `meta.mcp.{title,description}` are exposed as MCP tools)
 *   - all SDD §5.x spine endpoints registered as 501 stubs (real impls land
 *     in subsequent T1.x / T2.x / T3.x / T4.x tasks)
 *
 * IMPORTANT — import order matters:
 *   1. `../auth` is imported FIRST (transitively, via every route file).
 *      It runs `installAuthMethod(authJwt(config))` at module load, which
 *      mutates `RouteBuilder.prototype` to add `.auth()`. This MUST happen
 *      before any route module evaluates `.auth()` on a builder chain. The
 *      route modules below all `import { route, withSession } from "../auth"`,
 *      so the order is guaranteed by JS module-eval semantics. (Verdict L4.)
 *
 *   2. `authJwtPlugin` IS still installed on the app via `.use(authJwtPlugin(...))`
 *      below — this wires the per-request JWT verification middleware. The
 *      `installAuthMethod` in src/auth.ts only adds the `.auth()` sugar;
 *      the plugin install adds the runtime check.
 *
 *   3. `openapiHandlers` is constructed AFTER all routes are registered,
 *      so the manifest includes the full route graph.
 *
 * Listener — verdict L1 fix: `hostname: "0.0.0.0"` is mandatory. The
 * default localhost bind defeats Railway healthchecks. NEVER remove.
 */

import { Hyper, jsonResponse, type Route } from "@hyper/core"
import { hyperLog } from "@hyper/log"
import { openapiPlugin, openapiHandlers } from "@hyper/openapi"
import { zodConverter } from "@hyper/openapi-zod"
import { authJwtPlugin } from "@hyper/auth-jwt"

// Import auth.ts FIRST so installAuthMethod runs before any route module
// uses .auth(). (Route modules below transitively import auth.ts too —
// this explicit import is belt-and-suspenders + a grep-friendly anchor.)
import { JWT_SECRET, route } from "../auth"

// Routes. Each file imports `route` from `../auth` so the L4 install order
// is correct.
import { health } from "./routes/health"
import { authChallenge, authVerify } from "./routes/auth"
import { me } from "./routes/me"
import { resolveWallet, resolveAccount, resolveNym, getIdentity } from "./routes/resolve"
import { getProfile, getMiberaDimensions } from "./routes/profile"
import { linkVerifiedWallet } from "./routes/link"

// ---------------------------------------------------------------------------
// App composition.
// ---------------------------------------------------------------------------
const app = new Hyper()
  .use(hyperLog({ service: "identity-api" }))
  .use(openapiPlugin())
  .use(
    authJwtPlugin({
      secret: JWT_SECRET,
      algorithms: ["HS256"], // TODO(sprint-1.1-3): swap to ["ES256"] when src/auth.ts swaps
    }),
  )
  // Register all spine routes. Hyper's `.use()` accepts `UseArg[]` — a heterogeneous
  // array of routes/middlewares/plugins. The `as UseArg[]` cast bridges the
  // RouteBuilder vs the spike's `as any` workaround.
  .use([
    health,
    authChallenge,
    authVerify,
    me,
    resolveWallet,
    resolveAccount,
    resolveNym,
    getIdentity,
    getProfile,
    getMiberaDimensions,
    linkVerifiedWallet,
  ] as unknown as readonly Route[])

// ---------------------------------------------------------------------------
// OpenAPI spec + docs — mounted AFTER routes so the manifest is complete.
//
// Verdict L8: the runtime endpoint (/openapi.json) is the canonical spec
// path. The CLI `bunx hyper openapi` does NOT pick up the zodConverter
// configuration (it runs its own generate without converters). For CI
// artifact emit, scrape /openapi.json against a booted app — Sprint-1.1
// follow-up #4 will land `scripts/emit-openapi.ts` for headless emit.
// ---------------------------------------------------------------------------
const openapi = openapiHandlers(app as never, {
  title: "identity-api",
  version: "0.1.0",
  converters: [zodConverter],
})

const openapiSpec = route
  .get("/openapi.json")
  .handle(({ req }: { req: Request }) => openapi.spec(req))

const openapiDocs = route
  .get("/docs")
  .handle(({ req }: { req: Request }) => openapi.docs(req))

app.use([openapiSpec, openapiDocs] as unknown as readonly Route[])

// ---------------------------------------------------------------------------
// Listen. Verdict L1 defused — hostname:"0.0.0.0" so Railway healthchecks
// reach the service. NEVER remove. Default PORT=3000 per task spec.
// ---------------------------------------------------------------------------
app.listen({
  port: Number(process.env.PORT ?? 3000),
  hostname: "0.0.0.0",
})

export default app

// Silence "imported but unused" for jsonResponse which is only used by
// the route stubs (re-exported here as a convenience anchor for future
// 5xx handlers wired at this level).
export { jsonResponse }
