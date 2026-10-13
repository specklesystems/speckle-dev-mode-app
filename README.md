# speckle-dev-mode-app

Standalone kiosk: sign in with Speckle, paste a model/version URL, and it
loads whatever's actually there — a v2 parquet bundle (DuckDB-WASM, no
server component), or the legacy object graph one object at a time when
there's no bundle — and renders it as an expandable tree. The bundle-era
successor to frontend-3's legacy "Dev mode" raw-object browser.

A bundle's `objects` / `eav` / `relations` / `nodes` tables are the full
object representation on their own, independent of whether the source
legacy objects still exist in Postgres — no reconstruction needed when a
bundle exists. But not every version has one: the bundle vocabulary
(`elements` / `displayValue` / collections) only covers geometry-shaped
data, so a generic `Base`-as-container payload (e.g. a custom pydantic
schema with no CAD-connector conventions) correctly migrates to zero bundle
rows. For those, the kiosk falls back to the legacy graph, resolving each
`{referencedId, speckle_type: "reference"}` detached child lazily on expand.

## Running it

```bash
mise run i
mise run dev
```

Sign in, then paste a URL shaped like
`https://<server>/projects/<projectId>/models/<modelId>[@<versionId>]`
(version optional — resolves to latest) and click "load data".

Pass `?url=<that URL>` to pre-fill and auto-load — it survives a sign-in
redirect round trip if you're not already authenticated.

## Hosting

Live at **https://specklesystems.github.io/speckle-dev-mode-app/**.
`.github/workflows/deploy.yml` builds and force-pushes `dist/` to `gh-pages`
on every push to `main` (classic branch-push Pages deploy, not the
Actions `deploy-pages`/environments flow — this repo's `github-pages`
environment only allow-lists the `gh-pages` branch, and widening that needs
admin rights neither of us has yet; see the workflow file's comment).
`main` is protected; ship changes as a feature branch + PR.

## Auth

Registered as a Speckle OAuth app (PKCE, public client — no secret; appId
`f67c31ff29` in `src/auth.ts`), via `appCreate` with a single granular scope,
`project.core.read` (the new `domain.feature.verb` token-scope vocabulary
alongside the legacy `streams:read` style — covers "your projects, and the
models, versions and objects inside them", which is all `/v2/.../artifacts`
checks). One sign-in path: **"sign in with Speckle"** → `/authn/verify/{appId}/{challenge}`,
the consent page; its own `auth` middleware handles a logged-out browser by
redirecting to the regular login screen — which already has its own
"Continue with SSO" option — and back. That works identically whether the
browser's existing session came from SSO or anything else, so there's no
separate kiosk-side SSO sign-in path to maintain (tried one — a
workspace-slug/email-lookup shortcut straight to the IdP — and pulled it back
out: it only shaved a screen off *initial* sign-in, which Speckle's own login
page already covers for SSO users).

**SSO session expiry mid-use**: a workspace on SSO (Haskoning is) gates every
API call behind its own session, separate from the bearer token's own
lifetime — default 7 days (`getDefaultSsoSessionExpirationDate`,
`speckle-server-internal/packages/server/modules/workspaces/domain/sso/logic.ts`).
Once that session times out, the server returns 401
`SSO_SESSION_MISSING_OR_EXPIRED_ERROR` with the workspace slug even though
the token itself is still valid. `src/speckleApi.ts` detects that response
specifically (`SsoSessionExpiredError`) and the UI offers a
"sign in to `<slug>` SSO" button plus a retry — completing SSO there
refreshes the session server-side, so the same token works again without
being reissued.

## `window.speckleDevMode`

The live tab exposes its own functions on `window`, the same pattern as
Bashboards' browser API — drive it from the console or a JS-eval tool
instead of clicking and pasting:

```js
await window.speckleDevMode.attach(url)       // { format, schema, tree }
window.speckleDevMode.getSession()            // { origin } | null
window.speckleDevMode.getTree()
window.speckleDevMode.getStatus()
await window.speckleDevMode.getObjectProperties(objectIndex)
await window.speckleDevMode.query(sql)        // raw SQL against the mounted schema, for ad hoc digging
```

It drives the same visible UI (the tree renders, status bar updates) rather
than running a second headless copy.

## Provenance

The view SQL in `src/bundleSchema.ts` and the container/relation vocabulary
in `src/tree.ts` (`kind = 7` containers, `REL_IN_COLLECTION` / `REL_IN_MODEL`)
mirror `speckle-server-internal/packages/ts-sdk/src/data/bundleAttach.ts` and
`src/data/bundleQueries.ts`. This kiosk inlines its own copy rather than
depending on `@speckle/ts-sdk` directly, so it stays runnable outside the
monorepo — re-check against that package if a query here starts returning an
unexpected shape.
