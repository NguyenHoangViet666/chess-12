import { describe, expect, it } from 'vitest'
import { applyAction, startPosition } from '../engine/game'
import { type Action, type GameState } from '../engine/model'
import { createMatchStats, recordAction, summarizeMatches, type MatchStats } from '../selfPlay/stats'
import { position, sq } from './fixture'

function observe(stats: MatchStats, before: GameState, action: Action): GameState {
  const after = applyAction(before, action)
  if (!after) throw new Error('Illegal test turn')
  recordAction(stats, before, after)
  return after
}

describe('self-play action telemetry', () => {
  it('credits delayed multi-burns to the activating side even on an opponent resurrection turn', () => {
    const state = startPosition(position([
      ['white', 'king', 'A1'],
      ['black', 'king', 'L12'],
      ['white', 'dragon', 'D8'],
      ['black', 'rook', 'F7'],
      ['black', 'pawn', 'D9'],
      ['black', 'bishop', 'D10'],
      ['black', 'knight', 'E10'],
      ['black', 'pawn', null, 'A10'],
      ['black', 'necromancer', 'C12'],
    ]))
    const stats = createMatchStats()
    const active = observe(stats, state, {
      kind: 'dragon', pieceId: 'white-D8', destination: sq('F7'), fireTiming: 'before',
    })
    expect(stats.white).toMatchObject({
      plies: 1,
      movesByType: { dragon: 1 },
      normalCaptures: 1,
      normalCapturesByType: { dragon: 1 },
      normalVictimsByType: { rook: 1 },
      dragon: {
        fireBefore: 1, fireAfter: 0, moveOnly: 0, fireIgnitions: 1,
        fireCanceled: 0, fireHits: 0, multiBurns: 0, burnCaptures: 0,
      },
    })

    observe(stats, active, {
      kind: 'resurrect', necromancerId: 'black-C12', revivedPieceId: 'black-A10',
    })
    expect(stats.white.dragon).toMatchObject({
      fireHits: 1, multiBurns: 1, burnCaptures: 3, burnVictimsByType: { pawn: 1, bishop: 1, knight: 1 },
    })
    expect(stats.black).toMatchObject({
      plies: 1, normalCaptures: 0, dragon: { burnCaptures: 0 }, resurrections: 1, revivedByType: { pawn: 1 },
    })
  })

  it('records the post-landing cancellation once and tracks potential King cover separately', () => {
    const state = startPosition(position([
      ['white', 'king', 'E2'],
      ['white', 'shielder', 'E3'],
      ['white', 'shielder', 'F2'],
      ['white', 'rook', 'D2'],
      ['white', 'pawn', 'E4'],
      ['white', 'pawn', 'A3'],
      ['black', 'king', 'L12'],
      ['black', 'dragon', 'D6'],
    ], 'black'))
    const stats = createMatchStats()
    const afterFire = observe(stats, state, {
      kind: 'dragon', pieceId: 'black-D6', destination: sq('E4'), fireTiming: 'after',
    })
    expect(stats.black.normalVictimsByType).toEqual({ pawn: 1 })
    expect(stats.black.dragon).toMatchObject({
      fireAfter: 1, fireIgnitions: 0, fireCanceled: 1, fireHits: 0, multiBurns: 0, burnCaptures: 0,
    })
    expect(stats.white.shielder).toEqual({
      interceptedActivations: 1, cancelingShielders: 2, kingCoveredTurns: 0,
    })
    observe(stats, afterFire, { kind: 'move', pieceId: 'white-A3', destination: sq('A4') })
    expect(stats.white.shielder.kingCoveredTurns).toBe(1)
    expect(stats.white.shielder.interceptedActivations).toBe(1)
    expect(stats.black.dragon.burnCaptures).toBe(0)
    expect(summarizeMatches([{ outcome: { kind: 'capped' }, plies: 2, stats }])
      .totals.rates.fireCanceledPercentOfActivations).toBe(100)
  })

  it('counts en passant as a Pawn movement capture and revival by base type', () => {
    const raw = position([
      ['white', 'king', 'A1'],
      ['black', 'king', 'L12'],
      ['white', 'pawn', 'D8', 'D3', { hasMoved: true }],
      ['black', 'pawn', 'E8', 'E10', { hasMoved: true }],
      ['black', 'pawn', null, 'A10', { type: 'queen', promoted: true, hasMoved: true }],
      ['black', 'necromancer', 'C12'],
    ])
    raw.enPassant = { target: sq('E9'), pawnId: 'black-E10' }
    const stats = createMatchStats()
    const afterCapture = observe(stats, startPosition(raw), {
      kind: 'move', pieceId: 'white-D3', destination: sq('E9'),
    })
    observe(stats, afterCapture, {
      kind: 'resurrect', necromancerId: 'black-C12', revivedPieceId: 'black-A10',
    })
    expect(stats.white).toMatchObject({
      normalCapturesByType: { pawn: 1 }, normalVictimsByType: { pawn: 1 },
    })
    expect(stats.black).toMatchObject({
      plies: 1, turnsByType: { necromancer: 1 }, movesByType: {},
      resurrections: 1, revivedByType: { pawn: 1 }, normalCaptures: 0,
    })
  })
})

describe('self-play match aggregation', () => {
  it('separates capped and actual draws, counts observed turns, and aggregates profile seats', () => {
    const wonStats = createMatchStats()
    const won = startPosition(position([
      ['white', 'king', 'A1'],
      ['black', 'king', 'L12'],
      ['white', 'dragon', 'D4'],
      ['black', 'pawn', 'C6'],
      ['black', 'rook', 'D6'],
    ]))
    const active = observe(wonStats, won, {
      kind: 'dragon', pieceId: 'white-D4', destination: sq('F3'), fireTiming: 'before',
    })
    observe(wonStats, active, { kind: 'move', pieceId: 'black-L12', destination: sq('L11') })
    const report = summarizeMatches([
      { outcome: { kind: 'win', winner: 'white' }, plies: 9, stats: wonStats,
        depthCounts: { 1: 1 }, profiles: { white: 'learned', black: 'baseline' } },
      { outcome: { kind: 'draw', reason: 'threefold' }, plies: 12, stats: createMatchStats(),
        depthCounts: { 2: 2 }, profiles: { white: 'baseline', black: 'learned' } },
      { outcome: { kind: 'capped' }, plies: 15, stats: createMatchStats(),
        profiles: { white: 'learned', black: 'baseline' } },
    ])
    expect(report.outcomes).toEqual({
      whiteWins: 1, blackWins: 0, draws: 1, capped: 1, drawsByReason: { threefold: 1 },
    })
    expect(report.lengths).toEqual({ totalPlies: 36, averagePlies: 12, minPlies: 9, maxPlies: 15 })
    expect(report.search).toEqual({ searches: 3, depthCounts: { 1: 1, 2: 2 }, averageDepth: 1.67 })
    expect(report.totals).toMatchObject({
      plies: 2, captures: 2, capturesByType: { dragon: 2 },
      rates: { fireHitPercentOfActivations: 100, burnCapturesPerActivation: 2,
        capturesPer100TurnsByType: { dragon: 200 } },
    })
    expect(report.byColor.black.rates.fireHitPercentOfActivations).toBeNull()
    expect(report.byProfile).toMatchObject([
      { name: 'learned', seats: 3, wins: 1, losses: 0, draws: 1, capped: 1, stats: { plies: 1 } },
      { name: 'baseline', seats: 3, wins: 0, losses: 1, draws: 1, capped: 1, stats: { plies: 1 } },
    ])
    expect(wonStats.white.dragon.burnCaptures).toBe(2)
  })
})
