export type Window = {
  kind: string
  pct: number
  resetsAt?: string
  /** Estimated total size of the window in tokens, once calibrated. */
  estTotal?: number
}

declare module 'claude-code' {
  interface PluginState {
    'headroom': { windows: Window[]; chatTokens: number }
  }
}
