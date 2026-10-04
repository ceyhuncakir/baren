import type { CanvasController, Viewport } from '@baren/canvas'
import type { PeerPresence } from '@baren/sync-client'
import { describe, expect, it } from 'vitest'
import { createEditorStore } from '../session/store'
import { FollowController, PeerActivity, cameraFor, sameCamera, visibleWorldRect } from './follow'

function peer(over: Partial<PeerPresence> & Pick<PeerPresence, 'clientId'>): PeerPresence {
  return {
    userId: 'u2',
    name: 'Maya',
    color: '#6D4AFF',
    pageId: 'p1',
    cursor: null,
    selection: [],
    ...over,
  }
}

/**
 * A canvas stand-in: page, camera and the calls the controller made. `onChange` mirrors the
 * real canvas, whose throttled `onViewportChange` fires synchronously inside `setViewport` when
 * the last emit was long enough ago.
 */
function fakeCanvas(pageId = 'p1') {
  const state = {
    pageId,
    viewport: { x: 0, y: 0, zoom: 1, width: 1000, height: 800 } as Viewport,
    sets: 0,
    onChange: null as ((v: Viewport) => void) | null,
  }
  const canvas = {
    getPageId: () => state.pageId,
    getViewport: () => ({ ...state.viewport }),
    setViewport: (v: Partial<Viewport>) => {
      state.viewport = { ...state.viewport, ...v }
      state.sets += 1
      state.onChange?.({ ...state.viewport })
    },
  } as unknown as CanvasController
  return { state, canvas }
}

function setup(pages = ['p1', 'p2']) {
  const store = createEditorStore({ pageId: 'p1' })
  const { state, canvas } = fakeCanvas()
  let now = 0
  const follow = new FollowController(store, {
    canvas: () => canvas,
    hasPage: (id) => pages.includes(id),
    now: () => (now += 1),
  })
  const off = follow.attach()
  return { store, state, follow, off }
}

describe('viewport math', () => {
  it('turns a camera into the world rectangle it shows', () => {
    expect(visibleWorldRect({ x: -100, y: 50, zoom: 2, width: 1000, height: 800 })).toEqual({
      x: -100,
      y: 50,
      width: 500,
      height: 400,
    })
  })

  it('centres a followed rectangle and fits it whole', () => {
    // A 1440×900 world rect in a 720×900 canvas: width limits the zoom to 0.5.
    const cam = cameraFor({ x: 0, y: 0, width: 1440, height: 900 }, 720, 900)
    expect(cam.zoom).toBe(0.5)
    expect(cam.x).toBe(0)
    // 900 world px tall at 0.5 = 450 screen px, centred in 900: 225 px (450 world) above.
    expect(cam.y).toBe(-450)
    const shown = visibleWorldRect({ ...cam, width: 720, height: 900 })
    expect(shown.x + shown.width / 2).toBe(720)
    expect(shown.y + shown.height / 2).toBe(450)
  })

  it('compares cameras within float noise', () => {
    expect(sameCamera({ x: 1, y: 2, zoom: 0.5 }, { x: 1 + 1e-9, y: 2, zoom: 0.5 })).toBe(true)
    expect(sameCamera({ x: 1, y: 2, zoom: 0.5 }, { x: 1.5, y: 2, zoom: 0.5 })).toBe(false)
  })
})

describe('PeerActivity', () => {
  it('follows the window of a user that changed last', () => {
    const activity = new PeerActivity()
    const a = peer({ clientId: 'a' })
    const b = peer({ clientId: 'b' })
    activity.update([a, b], 1)
    const a2 = peer({ clientId: 'a', cursor: { x: 1, y: 1 } })
    activity.update([a2, b], 2)
    expect(activity.pick([a2, b], 'u2')?.clientId).toBe('a')
    const b2 = peer({ clientId: 'b', cursor: { x: 2, y: 2 } })
    activity.update([a2, b2], 3)
    expect(activity.pick([a2, b2], 'u2')?.clientId).toBe('b')
    expect(activity.pick([a2, b2], 'nobody')).toBeNull()
  })
})

describe('FollowController', () => {
  it("shows the followed user's viewport and tracks it", () => {
    const { store, state } = setup()
    store.setState({
      peers: [peer({ clientId: 'c', viewport: { x: 0, y: 0, width: 500, height: 400 } })],
    })
    store.setState({ following: 'u2' })
    expect(state.viewport).toMatchObject({ x: 0, y: 0, zoom: 2 })
    store.setState({
      peers: [peer({ clientId: 'c', viewport: { x: 100, y: 0, width: 500, height: 400 } })],
    })
    expect(state.viewport).toMatchObject({ x: 100, zoom: 2 })
    expect(store.getState().following).toBe('u2')
  })

  it('keeps following while they pan and zoom (the canvas reports each move at once)', () => {
    const { store, state, follow } = setup()
    state.onChange = (v) => follow.onViewport(v)
    const move = (viewport: { x: number; y: number; width: number; height: number }) =>
      store.setState({ peers: [peer({ clientId: 'c', viewport })] })
    move({ x: 0, y: 0, width: 500, height: 400 })
    store.setState({ following: 'u2' })
    move({ x: 300, y: 50, width: 500, height: 400 })
    move({ x: 300, y: 50, width: 2000, height: 1600 })
    move({ x: -40, y: 10, width: 250, height: 200 })
    expect(store.getState().following).toBe('u2')
    expect(state.viewport).toMatchObject({ x: -40, y: 10, zoom: 4 })
    // A camera move of this user's own still ends following.
    state.viewport = { ...state.viewport, x: state.viewport.x + 25 }
    follow.onViewport({ ...state.viewport })
    expect(store.getState().following).toBeNull()
  })

  it('switches to their page and applies the viewport once the canvas shows it', () => {
    const { store, state, follow } = setup()
    store.setState({
      peers: [
        peer({ clientId: 'c', pageId: 'p2', viewport: { x: 0, y: 0, width: 500, height: 400 } }),
      ],
      following: 'u2',
    })
    expect(store.getState().pageId).toBe('p2')
    expect(state.sets).toBe(0)
    // The canvas restores its own camera for the new page: not a user gesture.
    follow.onViewport({ x: 9, y: 9, zoom: 1, width: 1000, height: 800 })
    state.pageId = 'p2'
    follow.onCanvasPage()
    expect(state.viewport).toMatchObject({ x: 0, y: 0, zoom: 2 })
    expect(store.getState().following).toBe('u2')
  })

  it('stops when this user moves the camera, but not when the canvas resizes', () => {
    const { store, state, follow } = setup()
    store.setState({
      peers: [peer({ clientId: 'c', viewport: { x: 0, y: 0, width: 500, height: 400 } })],
      following: 'u2',
    })
    follow.onViewport({ ...state.viewport })
    // Resized: re-centred, still following.
    state.viewport = { ...state.viewport, width: 500, height: 800 }
    follow.onViewport({ ...state.viewport })
    expect(store.getState().following).toBe('u2')
    expect(state.viewport.zoom).toBe(1)
    follow.onViewport({ ...state.viewport, x: state.viewport.x + 40 })
    expect(store.getState().following).toBeNull()
  })

  it('stops when this user picks another page or the followed user leaves', () => {
    const { store } = setup()
    store.setState({ peers: [peer({ clientId: 'c' })], following: 'u2' })
    store.setState({ pageId: 'p2' })
    expect(store.getState().following).toBeNull()
    store.setState({ pageId: 'p1', following: 'u2' })
    expect(store.getState().following).toBe('u2')
    store.setState({ peers: [] })
    expect(store.getState().following).toBeNull()
  })

  it('stays put while their page has not synced yet', () => {
    const { store } = setup(['p1'])
    store.setState({ peers: [peer({ clientId: 'c', pageId: 'p9' })], following: 'u2' })
    expect(store.getState().pageId).toBe('p1')
    expect(store.getState().following).toBe('u2')
  })

  it('does nothing after detach', () => {
    const { store, state, off } = setup()
    off()
    store.setState({
      peers: [peer({ clientId: 'c', viewport: { x: 0, y: 0, width: 500, height: 400 } })],
      following: 'u2',
    })
    expect(state.sets).toBe(0)
  })
})
