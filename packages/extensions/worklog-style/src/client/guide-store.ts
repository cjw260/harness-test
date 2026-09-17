/** Tiny shared store bridging the sidebar guide button and the overlay modal. */

export interface GuideStore {
  get(): boolean
  set(value: boolean): void
  subscribe(listener: () => void): () => void
}

export function createGuideStore(): GuideStore {
  let open = false
  const listeners = new Set<() => void>()
  return {
    get: () => open,
    set: (value: boolean) => {
      open = value
      for (const listener of listeners) listener()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
