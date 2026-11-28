import { describe, expect, it } from 'vitest'
import { applyAction, createGame } from '../engine/game'
import { deriveMatchSeed, runMatch } from '../selfPlay/run'

describe('deterministic self-play matches', () => {
  it('replays seeded opening and bot turns, and separates bot-only counts from the full ply cap', () => {
    const options = {
      maxPlies: 7, openingPlies: 4, maxNodes: 250, maxDepth: 2, includeHistory: true,
    }
    const firstSeed = deriveMatchSeed(12012, 0)
    const secondSeed = deriveMatchSeed(12012, 1)
    const match = runMatch(firstSeed, options)

    expect(runMatch(firstSeed, options)).toEqual(match)
    expect(runMatch(secondSeed, options).opening).not.toEqual(match.opening)
    expect(match).toMatchObject({ outcome: { kind: 'capped' }, plies: options.maxPlies })
    expect(match.opening).toHaveLength(4)
    expect(match.searches.map(({ ply }) => ply)).toEqual([5, 6, 7])
    expect(match.stats.white.plies).toBe(2)
    expect(match.stats.black.plies).toBe(1)

    const actions = [...match.opening]
    for (const { decision, nodes } of match.searches) {
      expect(nodes).toBeLessThanOrEqual(options.maxNodes)
      if (decision.kind !== 'play') throw new Error('Expected a played turn in the opening')
      actions.push(decision.action)
    }
    let replay = createGame()
    for (const action of actions) {
      const next = applyAction(replay, action)
      expect(next).not.toBeNull()
      replay = next!
    }
    expect(replay.moveHistory).toEqual(match.history)
    expect(replay.status.kind).toBe('active')
  })
})
