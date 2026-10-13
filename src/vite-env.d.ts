/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SPECKLE_APP_ID: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
