import { describe, expect, it } from 'vitest'
import { keyOf, makePart } from '../apps/preview-circuit-board/board'
import { makeSandbox, stepOnce } from '../apps/preview-circuit-board/sandbox'

describe('observer pulse timing', () => {
  it("counts an observer's change pulse for exactly two ticks", () => {
    // Fails if the caller starts or shortens an observer pulse instead of holding it for two ticks.
    const observer = { x: 1, y: 2 }
    const watched = { x: 2, y: 2 }
    const observerKey = keyOf(observer)
    const watchedKey = keyOf(watched)
    const sandbox = makeSandbox(
      { width: 4, height: 4 },
      new Map([
        [observerKey, makePart('observer', { facing: 'right' })],
        [watchedKey, makePart('block')],
      ]),
    )

    stepOnce(sandbox)
    expect(sandbox.parts.get(observerKey)).toMatchObject({ active: false })

    sandbox.parts.set(watchedKey, makePart('obsidian'))
    stepOnce(sandbox)
    expect(sandbox.parts.get(observerKey)).toMatchObject({ active: true })

    stepOnce(sandbox)
    expect(sandbox.parts.get(observerKey)).toMatchObject({ active: true })

    stepOnce(sandbox)
    expect(sandbox.parts.get(observerKey)).toMatchObject({ active: false })
  })
})
