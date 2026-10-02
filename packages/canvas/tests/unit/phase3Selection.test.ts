import { describe, expect, it } from 'vitest'
import {
  resolveClickTarget,
  resolveDoubleClickTarget,
  type SelectionContext,
} from '../../src/math/selection.ts'

// page > artboard > group > [rect, inner group > deep]
// page > artboard > instance > inst/a > inst/a/b
// page > topGroup > child
// page > topRect
const parents: Record<string, string> = {
  artboard: 'page',
  group: 'artboard',
  rect: 'group',
  innerGroup: 'group',
  deep: 'innerGroup',
  instance: 'artboard',
  'instance/a': 'instance',
  'instance/a/b': 'instance/a',
  sibling: 'artboard',
  topGroup: 'page',
  child: 'topGroup',
  topRect: 'page',
}
const kinds: Record<string, 'group' | 'instance' | 'frame' | 'other'> = {
  artboard: 'frame',
  group: 'group',
  innerGroup: 'group',
  instance: 'instance',
  topGroup: 'group',
}

function ctx(selection: string[]): SelectionContext {
  return {
    selection,
    parentOf: (id) => parents[id] ?? null,
    isLocked: () => false,
    kind: (id) => kinds[id] ?? 'other',
  }
}

describe('group and instance selection (contract 5.2)', () => {
  const groupPath = ['artboard', 'group', 'innerGroup', 'deep']
  const instancePath = ['artboard', 'instance', 'instance/a', 'instance/a/b']

  it('a click inside a group selects the outermost group', () => {
    expect(resolveClickTarget(groupPath, ctx([]))).toBe('group')
    expect(resolveClickTarget(['artboard', 'group', 'rect'], ctx([]))).toBe('group')
  })

  it('a click inside an instance selects the instance', () => {
    expect(resolveClickTarget(instancePath, ctx([]))).toBe('instance')
  })

  it('once entered, clicks select inside, but nested groups are still outermost-first', () => {
    // A child of `group` is selected: `group` is entered, `innerGroup` is not.
    expect(resolveClickTarget(groupPath, ctx(['rect']))).toBe('innerGroup')
    expect(resolveClickTarget(['artboard', 'group', 'rect'], ctx(['innerGroup']))).toBe('rect')
    // Inside the entered nested group, its children are picked directly.
    expect(resolveClickTarget(groupPath, ctx(['deep']))).toBe('deep')
  })

  it('a sibling selection outside does not enter the group', () => {
    expect(resolveClickTarget(groupPath, ctx(['sibling']))).toBe('group')
  })

  it('Ctrl/Meta-click selects the deepest node, also inside instances', () => {
    expect(resolveClickTarget(groupPath, ctx([]), { deep: true })).toBe('deep')
    expect(resolveClickTarget(instancePath, ctx([]), { deep: true })).toBe('instance/a/b')
  })

  it('top-level groups and shapes are selected as themselves', () => {
    expect(resolveClickTarget(['topGroup', 'child'], ctx([]))).toBe('topGroup')
    expect(resolveClickTarget(['topRect'], ctx([]))).toBe('topRect')
    expect(resolveClickTarget(['topGroup', 'child'], ctx(['child']))).toBe('child')
  })

  it('double-click drills one level: into a group, then into instance content', () => {
    const isText = (): boolean => false
    expect(resolveDoubleClickTarget(groupPath, ctx(['group']), isText)).toEqual({
      id: 'innerGroup',
      editText: false,
    })
    expect(resolveDoubleClickTarget(instancePath, ctx(['instance']), isText)).toEqual({
      id: 'instance/a',
      editText: false,
    })
  })

  it('a selected group keeps the click (dragging the group by its content)', () => {
    expect(resolveClickTarget(groupPath, ctx(['group']))).toBe('group')
  })
})
