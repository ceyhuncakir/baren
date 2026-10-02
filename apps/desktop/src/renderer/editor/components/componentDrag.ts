/**
 * Dragging a component (Components panel row, picker tile) onto the canvas: HTML5 drag and
 * drop with a private data type. The key is also kept here because `dragover` events cannot
 * read drag data (only its types), and the canvas highlights the target while dragging.
 */
export const COMPONENT_DRAG_TYPE = 'application/x-baren-component'

let dragging: string | null = null

export function startComponentDrag(data: DataTransfer, key: string): void {
  data.setData(COMPONENT_DRAG_TYPE, key)
  data.setData('text/plain', '')
  data.effectAllowed = 'copy'
  dragging = key
}

export function endComponentDrag(): void {
  dragging = null
}

/** The component key being dragged when `data` carries one. */
export function draggedComponent(data: DataTransfer | null): string | null {
  if (!data || !Array.from(data.types).includes(COMPONENT_DRAG_TYPE)) return null
  const key = data.getData(COMPONENT_DRAG_TYPE)
  return key !== '' ? key : dragging
}
