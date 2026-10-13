import type { ContainerNode, TreeNode } from './tree'
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
          for (const prop of props) {
            const propRow = el('div', 'prop')
            propRow.appendChild(el('span', 'prop-path', prop.path))
            propRow.appendChild(
              el('span', 'prop-value', `${prop.value ?? 'null'}${prop.unit ? ` ${prop.unit}` : ''}`)
            )
            propsWrap.appendChild(propRow)
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
