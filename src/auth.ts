/**
 * PKCE login against a registered Speckle app (no client secret — Speckle
 * apps are public clients, `packages/server/modules/auth/services/serverApps.ts`).
 * Flow grounded in `pages/authn/verify/[appId]/[challenge]/index.vue` (consent
 * page; redirects to the app's registered `redirectUrl`, never a client-supplied
 * one) and the `/oauth/token` REST handler (`packages/server/modules/auth/rest/index.ts`),
 * the PKCE-correct exchange endpoint — `/auth/token` only accepts the legacy
 * non-PKCE challenge shape and rejects a PKCE-created code.
 */

/** Two registered apps: the hosted Pages origin's `redirectUrl` only accepts
 * that origin, so local dev (localhost:5183) needs its own app id. */
export const APP_ID = import.meta.env.DEV ? 'd120abde47' : 'f67c31ff29'

const VERIFIER_STORAGE_KEY = 'speckle-dev-mode:pkce-verifier'
const ORIGIN_STORAGE_KEY = 'speckle-dev-mode:pkce-origin'
const TOKEN_STORAGE_KEY = 'speckle-dev-mode:token'
/** The server a stored token is valid for — a token from one Speckle server is meaningless on another. */
const TOKEN_ORIGIN_STORAGE_KEY = 'speckle-dev-mode:token-origin'

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

export interface StoredSession {
  token: string
  origin: string
}

export function getStoredSession(): StoredSession | null {
  const token = sessionStorage.getItem(TOKEN_STORAGE_KEY)
  const origin = sessionStorage.getItem(TOKEN_ORIGIN_STORAGE_KEY)
  return token && origin ? { token, origin } : null
}

export function clearStoredSession(): void {
  sessionStorage.removeItem(TOKEN_STORAGE_KEY)
  sessionStorage.removeItem(TOKEN_ORIGIN_STORAGE_KEY)
}

/** `/authn/verify/{appId}/{challenge}?code_challenge_method=S256` — the consent page.
 * Its own `auth` middleware redirects to Speckle's regular login (which already offers a
 * "Continue with SSO" button) when the browser has no session, then back here. */
function verifyPath(challenge: string): string {
  return `/authn/verify/${APP_ID}/${challenge}?code_challenge_method=S256`
}

async function beginPkce(origin: string): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomVerifier()
  const challenge = await challengeFor(verifier)
  sessionStorage.setItem(VERIFIER_STORAGE_KEY, verifier)
  sessionStorage.setItem(ORIGIN_STORAGE_KEY, origin)
  return { verifier, challenge }
}

/** Redirects the browser to the consent page; resumes via {@link completePendingLogin} on return. */
export async function startLogin(origin: string): Promise<void> {
  const { challenge } = await beginPkce(origin)
  window.location.assign(new URL(verifyPath(challenge), origin).toString())
}

/**
 * Call once on page load. If the URL carries `?access_code=` from a completed
 * consent redirect, exchanges it for a token and strips the query param.
 * Returns the token on success, so the caller can skip a round trip through
 * {@link getStoredSession}.
 */
export async function completePendingLogin(): Promise<string | null> {
  const params = new URLSearchParams(window.location.search)
  const accessCode = params.get('access_code')
  if (!accessCode) return null

  const verifier = sessionStorage.getItem(VERIFIER_STORAGE_KEY)
  const origin = sessionStorage.getItem(ORIGIN_STORAGE_KEY)
  history.replaceState(null, '', window.location.pathname)
  if (!verifier || !origin) {
    throw new Error('No pending login found for this access code (storage was cleared?)')
  }

  const resp = await fetch(`${origin}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: APP_ID, accessCode, codeVerifier: verifier })
  })
  sessionStorage.removeItem(VERIFIER_STORAGE_KEY)
  sessionStorage.removeItem(ORIGIN_STORAGE_KEY)
  if (!resp.ok) {
    throw new Error(`token exchange failed: ${resp.status} ${resp.statusText}`)
  }
  const body = (await resp.json()) as { token: string }
  sessionStorage.setItem(TOKEN_STORAGE_KEY, body.token)
  sessionStorage.setItem(TOKEN_ORIGIN_STORAGE_KEY, origin)
  return body.token
}
