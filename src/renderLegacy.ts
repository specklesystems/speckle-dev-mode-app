import { fetchLegacyObject, isReferenceStub, type LegacyObject, type LegacyRef } from './legacyGraph'

/** Internal bookkeeping, not data — `__closure` is the id→depth map ObjectLoader2
 * and `operations.receive` use to resolve detached children; not useful to browse. */
const SKIP_KEYS = new Set(['__closure'])

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function typeLabel(value: unknown): string {
  if (Array.isArray(value)) return `array[${value.length}]`
  if (value === null) return 'null'
  if (typeof value === 'object') {
    const speckleType = (value as Record<string, unknown>).speckle_type
    return typeof speckleType === 'string' ? speckleType : 'object'
  }
  return typeof value
}

function renderExpandable(
  label: string,
  type: string,
  count: string | null,
  loadChildren: () => HTMLElement[] | Promise<HTMLElement[]>
): HTMLElement {
  const row = el('div', 'node')
  const header = el('div', 'node-header expandable')
  row.appendChild(header)

  const toggle = el('span', 'toggle', '▶')
  header.appendChild(toggle)
  header.appendChild(el('span', 'label', label))
  header.appendChild(el('span', 'type', type))
  if (count !== null) header.appendChild(el('span', 'count', count))

  const childWrap = el('div', 'children collapsed')
  row.appendChild(childWrap)
  let expanded = false
  /** Separate from `childWrap.childNodes.length` so a failed fetch doesn't
   * permanently wedge the row: an error row still leaves childNodes
   * non-empty, but `loaded` stays false, so collapsing and re-expanding
   * retries instead of just toggling the stale error message. */
  let loaded = false
  header.addEventListener('click', () => {
    expanded = !expanded
    toggle.textContent = expanded ? '▼' : '▶'
    childWrap.classList.toggle('collapsed', !expanded)
    if (expanded && !loaded) {
      childWrap.innerHTML = ''
      childWrap.appendChild(el('div', 'loading', 'loading…'))
      Promise.resolve(loadChildren())
        .then((children) => {
          loaded = true
          childWrap.innerHTML = ''
          if (children.length === 0) {
            childWrap.appendChild(el('div', 'empty', '(empty)'))
            return
          }
          for (const child of children) childWrap.appendChild(child)
        })
        .catch((err) => {
          childWrap.innerHTML = ''
          const message = err instanceof Error ? err.message : String(err)
          childWrap.appendChild(el('div', 'empty error', `${message} — collapse and re-expand to retry`))
        })
    }
  })
  return row
}

function renderObjectEntries(data: Record<string, unknown>, ref: LegacyRef, token: string): HTMLElement[] {
  return Object.entries(data)
    .filter(([key]) => !SKIP_KEYS.has(key))
    .map(([key, value]) => renderValue(key, value, ref, token))
}

function renderValue(key: string, value: unknown, ref: LegacyRef, token: string): HTMLElement {
  if (isReferenceStub(value)) {
    return renderExpandable(key, 'reference', null, async () => {
      const resolved = await fetchLegacyObject(ref, value.referencedId, token)
      return renderObjectEntries(resolved.data, ref, token)
    })
  }
  if (Array.isArray(value)) {
    return renderExpandable(key, typeLabel(value), null, () =>
      value.map((item, i) => renderValue(`[${i}]`, item, ref, token))
    )
  }
  if (value !== null && typeof value === 'object') {
    return renderExpandable(key, typeLabel(value), null, () =>
      renderObjectEntries(value as Record<string, unknown>, ref, token)
    )
  }

  const row = el('div', 'node')
  const header = el('div', 'node-header leaf')
  header.appendChild(el('span', 'toggle'))
  header.appendChild(el('span', 'label', key))
  header.appendChild(el('span', 'prop-value', JSON.stringify(value)))
  row.appendChild(header)
  return row
}

/**
 * Renders the root's own properties flush at the top level — no
 * `(root) Base totalChildrenCount: N` wrapper row — matching how
 * frontend-3's own Dev mode panel starts straight into an object's fields
 * (`id`, `@Data`, …) rather than requiring one more click to get past a
 * synthetic root. The root's own `totalChildrenCount` is just one of
 * those fields, same as any nested object's.
 */
export function renderLegacyTree(root: LegacyObject, ref: LegacyRef, token: string, mount: HTMLElement): void {
  mount.innerHTML = ''
  for (const row of renderObjectEntries(root.data, ref, token)) {
    mount.appendChild(row)
  }
}
