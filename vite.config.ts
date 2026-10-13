import { defineConfig } from 'vite'

/**
 * GitHub Pages serves a project repo from `/<repo>/`, not root, so the built
 * `index.html`'s asset references need that prefix — but only for `build`;
 * the dev server at localhost:5183 stays at `/` (the registered OAuth
 * redirectUrl is a plain origin, not this subpath).
 */
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/speckle-dev-mode-app/' : '/'
}))
