import { describe, expect, it } from 'vitest'
import { createGame, legalActions } from '../engine/game'
import { searchBot } from '../bot/search'

describe('fixed-node self-play search', () => {
  it('keeps its last completed iteration and ignores wall-clock differences at a fixed node budget', () => {
    const root = createGame()
    const finished: number[] = []
    const limits = { timeMs: Infinity, maxNodes: 160, maxDepth: 4 }
    const fast = searchBot(root, { ...limits, now: () => 0, onProgress: result => finished.push(result.depth) })!
    let clock = 0
    const slow = searchBot(root, { ...limits, now: () => (clock += 90_000) })!

    expect(finished.length).toBeGreaterThan(0)
    expect(fast.depth).toBe(finished.at(-1))
    expect(fast.depth).toBeLessThan(limits.maxDepth)
    expect(fast.nodes).toBeLessThanOrEqual(limits.maxNodes)
    expect(slow.decision).toEqual(fast.decision)
    expect(slow.principalVariation).toEqual(fast.principalVariation)
    expect(slow.score).toBe(fast.score)
    expect(slow.nodes).toBe(fast.nodes)
  })

  it('still returns a legal fallback when the node budget runs out before depth one', () => {
    const root = createGame()
    const result = searchBot(root, { timeMs: Infinity, maxNodes: 1 })!
    expect(result.depth).toBe(0)
    expect(result.nodes).toBeLessThanOrEqual(1)
    expect(result.decision.kind).toBe('play')
    if (result.decision.kind === 'play') expect(legalActions(root)).toContainEqual(result.decision.action)
  })
})
