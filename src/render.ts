import type { ContainerNode, ObjectProperty, TreeNode } from './tree'
import { getObjectProperties } from './tree'

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

/**
 * A dumped-flat property list (125+ dotted paths like
 * `properties.Material Quantities.Gas.Air.area`, one per row) was illegible
 * next to the legacy graph's proper nesting. Grouping by path segment into
 * the same collapsed-by-default node/children structure as the rest of the
 * tree — matching `renderLegacy.ts`'s `renderObjectEntries` — makes a wide
 * object's properties navigable instead of a wall of text.
 */
interface PropGroup {
  kind: 'group'
  segment: string
  children: PropNode[]
}
interface PropLeaf {
  kind: 'leaf'
  segment: string
  prop: ObjectProperty
}
type PropNode = PropGroup | PropLeaf

function buildPropertyTree(props: ObjectProperty[]): PropNode[] {
  const root: PropGroup = { kind: 'group', segment: '', children: [] }
  for (const prop of props) {
    const segments = prop.path.split('.')
    let current = root
    segments.forEach((segment, i) => {
      if (i === segments.length - 1) {
        current.children.push({ kind: 'leaf', segment, prop })
        return
      }
      let next = current.children.find(
        (c): c is PropGroup => c.kind === 'group' && c.segment === segment
      )
      if (!next) {
        next = { kind: 'group', segment, children: [] }
        current.children.push(next)
      }
      current = next
    })
  }
  return root.children
}

function renderPropNode(node: PropNode): HTMLElement {
  const row = el('div', 'node')
  if (node.kind === 'leaf') {
    const header = el('div', 'node-header leaf')
    header.appendChild(el('span', 'toggle'))
    header.appendChild(el('span', 'label', node.segment))
    header.appendChild(
      el('span', 'prop-value', `${node.prop.value ?? 'null'}${node.prop.unit ? ` ${node.prop.unit}` : ''}`)
    )
    row.appendChild(header)
    return row
  }

  const header = el('div', 'node-header expandable')
  const toggle = el('span', 'toggle', '▶')
  header.appendChild(toggle)
  header.appendChild(el('span', 'label', node.segment))
  header.appendChild(el('span', 'count', `${node.children.length}`))
  row.appendChild(header)

  const childWrap = el('div', 'children collapsed')
  row.appendChild(childWrap)
  let expanded = false
  header.addEventListener('click', () => {
    expanded = !expanded
    toggle.textContent = expanded ? '▼' : '▶'
    childWrap.classList.toggle('collapsed', !expanded)
    if (expanded && childWrap.childNodes.length === 0) {
      for (const child of node.children) childWrap.appendChild(renderPropNode(child))
    }
  })
  return row
}

function renderNode(node: TreeNode, schema: string, expandedByDefault = false): HTMLElement {
  const row = el('div', 'node')
  const header = el('div', 'node-header expandable')
  row.appendChild(header)

  const toggle = el('span', 'toggle', '▶')
  header.appendChild(toggle)

  if (node.kind === 'container') {
    header.appendChild(el('span', 'label', node.name))
    header.appendChild(el('span', 'type', node.subtype ?? (node.id === -1 ? 'Root' : 'Collection')))
    header.appendChild(
      el('span', 'count', `totalObjectCount: ${node.totalObjectCount}`)
    )

    const childWrap = el('div', 'children collapsed')
    row.appendChild(childWrap)
    let expanded = false
    const toggleOpen = (): void => {
      expanded = !expanded
      toggle.textContent = expanded ? '▼' : '▶'
      childWrap.classList.toggle('collapsed', !expanded)
      if (expanded && childWrap.childNodes.length === 0) {
        for (const child of node.children) {
          childWrap.appendChild(renderNode(child, schema))
        }
      }
    }
    header.addEventListener('click', toggleOpen)
    if (expandedByDefault) toggleOpen()
  } else {
    header.appendChild(el('span', 'label', node.applicationId))
    header.appendChild(el('span', 'type', 'Object'))
    header.appendChild(
      el('span', 'count', `propertyCount: ${node.propertyCount}`)
    )

    const propsWrap = el('div', 'children collapsed')
    row.appendChild(propsWrap)
    let expanded = false
    header.addEventListener('click', () => {
      expanded = !expanded
      toggle.textContent = expanded ? '▼' : '▶'
      propsWrap.classList.toggle('collapsed', !expanded)
      if (expanded && propsWrap.childNodes.length === 0) {
        propsWrap.appendChild(el('div', 'loading', 'loading properties…'))
        getObjectProperties(schema, node.objectIndex).then((props) => {
          propsWrap.innerHTML = ''
          if (props.length === 0) {
            propsWrap.appendChild(el('div', 'empty', '(no properties)'))
            return
          }
          for (const propNode of buildPropertyTree(props)) {
            propsWrap.appendChild(renderPropNode(propNode))
          }
        })
      }
    })
  }

  return row
}

export function renderTree(root: ContainerNode, schema: string, mount: HTMLElement): void {
  mount.innerHTML = ''
  mount.appendChild(renderNode(root, schema, true))
}
