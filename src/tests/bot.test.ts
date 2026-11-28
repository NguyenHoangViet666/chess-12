import { describe, expect, it } from 'vitest'
import { evaluatePosition, evaluatePositionBreakdown } from '../bot/evaluation'
import type { BotAnalysis, BotThinking } from '../bot/protocol'
import { searchBot } from '../bot/search'
import { applyAction, claimDraw, createGame, legalActions, startPosition } from '../engine/game'
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

function busyFirePosition() {
  const jump = (to: string, fireTiming: 'none' | 'after' = 'none'): Action =>
    ({ kind: 'dragon', pieceId: 'white-D1', destination: sq(to), fireTiming })
  return [
    jump('B2'), move('black-C10', 'C8'), jump('C4'), move('black-B10', 'B8'),
    jump('D6'), move('black-A10', 'A8'), jump('E8', 'after'),
  ].reduce(play, createGame())
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

  it('publishes in-progress depth and rate-limited live node counts separately from completed results', () => {
    const state = quietPosition()
    const idle: BotThinking[] = []
    const finished: number[] = []
    searchBot(state, {
      maxDepth: 2,
      now: fixedTime,
      onThinking: tick => idle.push(tick),
      onProgress: record => finished.push(record.depth),
    })
    expect(idle.map(tick => tick.currentDepth)).toEqual([1, 2])
    expect(finished).toEqual([1, 2])

    let elapsed = -25
    const live: BotThinking[] = []
    searchBot(state, {
      maxDepth: 1, timeMs: 260, now: () => elapsed += 25,
      onThinking: tick => live.push(tick),
    })
    expect(live.length).toBeGreaterThanOrEqual(2)
    expect(live.every(tick => tick.currentDepth === 1)).toBe(true)
    for (const [index, tick] of live.slice(1).entries()) {
      expect(tick.elapsedMs - live[index].elapsedMs).toBeGreaterThanOrEqual(100)
      expect(tick.nodes).toBeGreaterThanOrEqual(live[index].nodes)
    }
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

  it('completes a depth-one search on a crowded board with several imminent fire victims', () => {
    const game = busyFirePosition()
    expect(play(game, move('black-A12', 'A11')).moveHistory.at(-1)?.fire.captures).toHaveLength(3)
    expect(play(game, move('black-D10', 'D9')).moveHistory.at(-1)?.fire.captures).toHaveLength(2)
    expect(legalActions(game).length).toBeGreaterThan(40)

    const analysis = searchBot(game, { maxDepth: 1, maxNodes: 2500, timeMs: Infinity })
    const action = chosenAction(analysis)
    expect(analysis?.depth).toBe(1)
    expect(analysis?.nodes).toBeLessThanOrEqual(2500)
    expect(analysis?.principalVariation[0]).toEqual(action)
    analysis!.principalVariation.reduce(play, game)
  })

  it('saves an endangered piece with the emergency fallback when the node budget cannot search a full depth', () => {
    const game = busyFirePosition()
    const analysis = searchBot(game, { maxDepth: 3, maxNodes: 2, timeMs: Infinity })
    const action = chosenAction(analysis)
    expect(analysis?.depth).toBe(0)
    expect(analysis?.principalVariation).toEqual([action])
    expect(play(game, action).moveHistory.at(-1)?.fire.captures).toHaveLength(2)
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
  it('finds a mate that needs actual Dragon ignition and prefers it to a draw claim', () => {
    const raw = position([
      ['white', 'king', 'C10'], ['white', 'queen', 'B10'], ['white', 'knight', 'B11'],
      ['white', 'knight', 'D11'], ['white', 'dragon', 'A11'], ['black', 'king', 'A12'],
    ])
    raw.halfMoveClock = 100
    const game = startPosition(raw)
    expect(claimDraw(game, 'fifty-move')).not.toBeNull()
    const mate = searchBot(game, { maxDepth: 1, now: fixedTime })
    const action = chosenAction(mate)
    expect(action).toMatchObject({ kind: 'dragon', pieceId: 'white-A11', fireTiming: 'before' })
    if (action.kind !== 'dragon') throw new Error('Expected a Dragon turn')
    expect(play(game, { ...action, fireTiming: 'none' }).status).toEqual({ kind: 'draw', reason: 'stalemate' })
    expect(play(game, action).status).toEqual({ kind: 'checkmate', winner: 'white' })
  })

  it('searches through ignition and the opponent response to delayed multi-piece fire', () => {
    const game = startPosition(position([
      ['white', 'king', 'A1'], ['white', 'dragon', 'D4'], ['black', 'king', 'L12'],
      ['black', 'queen', 'C6'], ['black', 'rook', 'E6'], ['black', 'bishop', 'D6'], ['black', 'knight', 'D5'],
    ]))
    const analysis = searchBot(game, { maxDepth: 1, now: fixedTime })
    const choice = chosenAction(analysis)
    expect(choice).toMatchObject({ kind: 'dragon', pieceId: 'white-D4', fireTiming: 'before' })
    const burning = play(game, choice)
    expect(burning.fireState.effects).toHaveLength(4)
    expect(burning.moveHistory.at(-1)?.fire.captures).toEqual([])
    const reply = analysis?.principalVariation[1]
    expect(reply).toBeDefined()
    const resolved = play(burning, reply!)
    expect(resolved.moveHistory.at(-1)?.fire.captures.length).toBeGreaterThan(1)
  })

  it('evacuates a Queen from hostile fire before expiration', () => {
    const game = startPosition(position([
      ['white', 'king', 'A1'], ['white', 'queen', 'E5'],
      ['black', 'king', 'L11'], ['black', 'dragon', 'E7'],
    ], 'black'))
    const burning = play(game, { kind: 'dragon', pieceId: 'black-E7', destination: sq('G8'), fireTiming: 'before' })
    expect(play(burning, move('white-A1', 'B1')).graveyard.white).toContain('white-E5')
    const action = chosenAction(searchBot(burning, { maxDepth: 1, now: fixedTime }))
    expect(action).toMatchObject({ kind: 'move', pieceId: 'white-E5' })
    const evacuated = play(burning, action)
    expect(evacuated.pieces['white-E5'].currentSquare).not.toBeNull()
    expect(evacuated.fireState.effects).toEqual([])
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
    const exhausted = structuredClone(checked)
    exhausted.resurrectionState.white.shielder = 1
    expect(searchBot(startPosition(exhausted), { maxDepth: 1, now: fixedTime })).toBeNull()
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
  it('credits a Shielder anywhere in the cone for canceling the whole attack', () => {
    function evaluateShield(square: string) {
      return evaluatePositionBreakdown(position([
        ['white', 'king', 'A1'], ['white', 'dragon', 'D4'],
        ['black', 'king', 'D6'], ['black', 'shielder', square],
      ]))
    }

    const front = evaluateShield('D5')
    const outer = evaluateShield('C6')
    const outside = evaluateShield('E5')
    expect(front.black.shield).toBeGreaterThan(outside.black.shield)
    expect(outer.black.shield).toBeGreaterThan(outside.black.shield)
    expect(front.white.dragonFire).toBeLessThan(outside.white.dragonFire)
    expect(outer.white.dragonFire).toBeLessThan(outside.white.dragonFire)
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

  it('values imminent threatened material more than identical fire that expires later', () => {
    const state = position([
      ['white', 'king', 'A1'], ['black', 'king', 'L11'], ['black', 'queen', 'D5'],
    ], 'black')
    function timedPressure(expiresAfterTurn: number) {
      return evaluatePositionBreakdown({
        ...state,
        fireState: {
          currentTurnIndex: 4,
          effects: [{ id: 'zone-D5', owner: 'white', square: sq('D5'), createdAtTurn: 3, expiresAfterTurn }],
        },
      }).white.dragonFire
    }

    expect(timedPressure(4)).toBeGreaterThan(timedPressure(5))
    expect(timedPressure(5)).toBeGreaterThan(evaluatePositionBreakdown(state).white.dragonFire)
  })

  it('counts a graveyard piece as a reserve only with a living actor, open spawn, and unused quota', () => {
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
    open.resurrectionState.white.rook = 1
    expect(evaluatePositionBreakdown(open).white.resurrection).toBe(0)
  })
})
