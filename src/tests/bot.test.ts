import { describe, expect, it } from 'vitest'
import { evaluatePosition, evaluatePositionBreakdown } from '../bot/evaluation'
import type { BotAnalysis } from '../bot/protocol'
import { searchBot } from '../bot/search'
import { applyAction, claimDraw, legalActions, startPosition } from '../engine/game'
import type { Action, GameState } from '../engine/model'
import { positionKey } from '../engine/rules'
import { position, sq } from './fixture'

const fixedTime = () => 0
const move = (pieceId: string, to: string): Action => ({ kind: 'move', pieceId, destination: sq(to) })

function quietPosition() {
  return startPosition(position([
    ['white', 'king', 'A1'], ['white', 'knight', 'C2'],
    ['black', 'king', 'L12'], ['black', 'knight', 'J11'],
  ]))
}

function chosenAction(result: BotAnalysis | null): Action {
  if (!result || result.decision.kind !== 'play') throw new Error('Expected a bot move')
  return result.decision.action
}

function play(state: GameState, action: Action): GameState {
  const next = applyAction(state, action)
  expect(next, JSON.stringify(action)).not.toBeNull()
  return next!
}

describe('iterative bot search', () => {
  it('returns the same legal fallback if the clock expires before an iteration completes', () => {
    const state = quietPosition()
    function timedSearch() {
      let calls = 0
      return searchBot(state, {
        timeMs: 5,
        maxDepth: 5,
        now: () => calls++ === 0 ? 0 : 100_000,
      })
    }

    const first = timedSearch()
    const fallback = chosenAction(first)
    expect(first?.depth).toBe(0)
    expect(first?.principalVariation).toEqual([fallback])
    expect(legalActions(state)).toContainEqual(fallback)
    expect(timedSearch()?.decision).toEqual(first?.decision)
  })

  it('keeps the last completed move and principal variation when a deeper iteration expires', () => {
    const state = quietPosition()
    const onePly = searchBot(state, { maxDepth: 1, timeMs: 5, now: fixedTime })
    expect(onePly?.depth).toBe(1)

    let expired = false
    const completedDepths: number[] = []
    const interrupted = searchBot(state, {
      maxDepth: 5,
      timeMs: 5,
      now: () => expired ? 100_000 : 0,
      onProgress(analysis) {
        if (analysis.depth < 1) return
        completedDepths.push(analysis.depth)
        expired = true
      },
    })

    expect(completedDepths).toEqual([1])
    expect(interrupted).toMatchObject({
      depth: 1,
      decision: onePly?.decision,
      principalVariation: onePly?.principalVariation,
      score: onePly?.score,
    })
  })

  it('returns a playable sequence starting with its chosen action without changing the input', () => {
    const state = quietPosition()
    const original = structuredClone(state)
    const analysis = searchBot(state, { maxDepth: 2, now: fixedTime })
    const action = chosenAction(analysis)
    expect(analysis?.depth).toBe(2)
    expect(analysis?.principalVariation.length).toBeGreaterThanOrEqual(2)
    expect(analysis?.principalVariation[0]).toEqual(action)
    analysis!.principalVariation.reduce(play, state)
    expect(state).toEqual(original)
  })

  it('does not choose actions after a terminal game', () => {
    const finished = startPosition(position([
      ['white', 'king', 'C3'], ['white', 'queen', 'B2'], ['black', 'king', 'A1'],
    ], 'black'))
    expect(finished.status).toEqual({ kind: 'checkmate', winner: 'white' })
    expect(searchBot(finished, { maxDepth: 3, now: fixedTime })).toBeNull()
  })
})

describe('bot tactics on the variant board', () => {
  it('finds a mate by moving a Dragon before firing, over an available draw claim', () => {
    const raw = position([
      ['white', 'king', 'A1'], ['white', 'dragon', 'H9', 'D1'],
      ['black', 'king', 'G12'], ['black', 'shielder', 'F10', 'F11'],
      ['black', 'shielder', 'G11'], ['black', 'queen', 'F12'], ['black', 'bishop', 'H12'],
    ])
    raw.halfMoveClock = 100
    const game = startPosition(raw)
    expect(claimDraw(game, 'fifty-move')).not.toBeNull()
    const mate = searchBot(game, { maxDepth: 1, now: fixedTime })
    const action = chosenAction(mate)
    expect(action).toEqual({
      kind: 'dragon', pieceId: 'white-D1', destination: sq('F10'), fireTiming: 'after',
    })
    expect(play(game, action).status).toEqual({ kind: 'checkmate', winner: 'white' })
  })

  it('uses resurrection if only a revived Shielder can stop check', () => {
    const checked = startPosition(position([
      ['white', 'king', 'A1'], ['white', 'necromancer', 'D1'], ['white', 'shielder', null, 'A2'],
      ['black', 'king', 'L12'], ['black', 'rook', 'A4'], ['black', 'rook', 'B4'],
    ]))
    const defense = { kind: 'resurrect', necromancerId: 'white-D1', revivedPieceId: 'white-A2' }
    expect(checked.status).toMatchObject({ kind: 'active', inCheck: true })
    expect(legalActions(checked)).toEqual([defense])
    expect(chosenAction(searchBot(checked, { maxDepth: 1, now: fixedTime }))).toEqual(defense)
  })

  it('sees a Queen recapture beyond a depth-one search and declines the exchange', () => {
    const state = startPosition(position([
      ['white', 'king', 'A1'], ['white', 'queen', 'D4'],
      ['black', 'king', 'L12'], ['black', 'rook', 'D8'], ['black', 'queen', 'D12'],
    ]))
    const bait = move('white-D4', 'D8')
    const capture = play(state, bait)
    expect(play(capture, move('black-D12', 'D8')).graveyard.white).toContain('white-D4')
    const result = searchBot(state, { maxDepth: 1, now: fixedTime })
    expect(result?.depth).toBe(1)
    const chosen = chosenAction(result)
    expect(chosen).not.toEqual(bait)
    expect(evaluatePosition(play(state, chosen))).toBeGreaterThan(evaluatePosition(capture))
  })

  it('claims the available fifty-move draw from a materially lost position', () => {
    const raw = position([
      ['white', 'king', 'A2'], ['black', 'queen', 'I9'], ['black', 'king', 'L12'],
    ])
    raw.halfMoveClock = 100
    const state = startPosition(raw)
    const analysis = searchBot(state, { maxDepth: 2, now: fixedTime })
    expect(analysis?.decision).toEqual({ kind: 'claim-draw', reason: 'fifty-move' })
    expect(analysis?.score).toBe(0)
    expect(analysis?.principalVariation).toEqual([])
    expect(claimDraw(state, 'fifty-move')?.status).toEqual({ kind: 'draw', reason: 'fifty-move' })
  })

  it('finds an automatic repetition draw by accounting for earlier occurrences', () => {
    const state = startPosition(position([
      ['white', 'king', 'A2'], ['black', 'queen', 'I9'], ['black', 'king', 'L12'],
    ]))
    const escape = move('white-A2', 'A3')
    const repeatedKey = positionKey(play(state, escape))
    state.repetitionHistory = [...Array<string>(4).fill(repeatedKey), ...state.repetitionHistory]

    expect(claimDraw(state, 'threefold')).toBeNull()
    expect(play(state, escape).status).toEqual({ kind: 'draw', reason: 'fivefold' })
    const result = searchBot(state, { maxDepth: 2, now: fixedTime })
    expect(chosenAction(result)).toEqual(escape)
    expect(Math.abs(result?.score ?? Number.NaN)).toBe(0)
  })
})

describe('variant-aware static evaluation', () => {
  it('credits Shielder protection for a King only behind it on the Dragon’s file', () => {
    function evaluateShield(square: string) {
      return evaluatePositionBreakdown(position([
        ['white', 'king', 'A1'], ['white', 'dragon', 'D4'],
        ['black', 'king', 'D6'], ['black', 'shielder', square],
      ])).black
    }

    const onFile = evaluateShield('D5')
    const adjacent = evaluateShield('E5')
    expect(onFile.shield).toBeGreaterThan(adjacent.shield)
    expect(adjacent.shield).toBe(0)
    expect(onFile.kingSafety).toBeGreaterThan(adjacent.kingSafety)
  })

  it('values an exposed Queen burn above a Pawn burn or an intercepted cone', () => {
    function fireOpportunity(victim: 'pawn' | 'queen' | 'shielder') {
      return evaluatePositionBreakdown(position([
        ['white', 'king', 'A1'], ['white', 'dragon', 'D4'],
        ['black', 'king', 'L12'], ['black', victim, 'D5'],
      ])).white.dragonFire
    }

    const pawn = fireOpportunity('pawn')
    expect(fireOpportunity('queen')).toBeGreaterThan(pawn)
    expect(pawn).toBeGreaterThan(fireOpportunity('shielder'))
    expect(fireOpportunity('shielder')).toBe(0)
  })

  it('counts a graveyard piece as a reserve only with a living actor and open spawn', () => {
    const roster = [
      ['white', 'king', 'A1'], ['black', 'king', 'L12'], ['white', 'rook', null, 'L1'],
    ] as const
    const open = position([...roster, ['white', 'necromancer', 'C1']])
    const occupied = position([
      ...roster, ['white', 'necromancer', 'C1'], ['white', 'knight', 'L1', 'B1', { hasMoved: true }],
    ])
    const noActor = position([...roster, ['white', 'necromancer', null, 'C1']])

    expect(evaluatePositionBreakdown(open).white.resurrection).toBeGreaterThan(0)
    expect(evaluatePositionBreakdown(occupied).white.resurrection).toBe(0)
    expect(evaluatePositionBreakdown(noActor).white.resurrection).toBe(0)
  })
})
