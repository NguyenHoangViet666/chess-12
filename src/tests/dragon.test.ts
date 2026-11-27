import { describe, expect, it } from 'vitest'
import { fireCone, fireReport } from '../engine/fire'
import { applyAction, createSession, legalActions, startPosition, undo, updateSession } from '../engine/game'
import { pieceAt, squareName, type DragonAction, type DragonFireTiming } from '../engine/model'
import { dragonPreview, isInCheck, isSquareAttacked } from '../engine/rules'
import { position, sq, type Entry } from './fixture'

const distantKings = [
  ['white', 'king', 'A1'],
  ['black', 'king', 'L12'],
] as const satisfies readonly Entry[]

function dragonTurn(destination: string, fireTiming: DragonFireTiming, pieceId = 'white-D4'): DragonAction {
  return { kind: 'dragon', pieceId, destination: sq(destination), fireTiming }
}

describe('Dragon movement and fire geometry', () => {
  it('jumps over nearby pieces, moves without firing and can capture on its destination', () => {
    const state = startPosition(position([
      ...distantKings,
      ['white', 'dragon', 'D4'],
      ['white', 'pawn', 'D5'],
      ['black', 'bishop', 'E6'],
      ['black', 'pawn', 'D6'],
    ]))
    const destinations = legalActions(state)
      .flatMap(action => action.kind === 'dragon' && action.fireTiming === 'none' ? [squareName(action.destination)] : [])
    expect(destinations.sort()).toEqual(['B3', 'B5', 'C2', 'C6', 'E2', 'E6', 'F3', 'F5'])

    const next = applyAction(state, dragonTurn('E6', 'none'))!
    expect(pieceAt(next, sq('E6'))?.id).toBe('white-D4')
    expect(next.graveyard.black).toEqual(['black-E6'])
    expect(pieceAt(next, sq('D6'))?.id).toBe('black-D6')
    expect(pieceAt(next, sq('D5'))?.id).toBe('white-D5')
  })

  it('cannot use either fire timing without a legal Knight move', () => {
    const state = startPosition(position([
      ['white', 'king', 'L1'],
      ['black', 'king', 'L12'],
      ['white', 'dragon', 'A1'],
      ['white', 'pawn', 'B3'],
      ['white', 'pawn', 'C2'],
      ['black', 'pawn', 'A2'],
    ]))
    expect(legalActions(state).some(action => action.kind === 'dragon')).toBe(false)
    for (const timing of ['before', 'after'] as const) {
      expect(applyAction(state, dragonTurn('A1', timing, 'white-A1'))).toBeNull()
      expect(applyAction(state, dragonTurn('B3', timing, 'white-A1'))).toBeNull()
    }
    expect(pieceAt(state, sq('A2'))?.id).toBe('black-A2')
  })

  it('projects four cells forward for each side and clips at both board dimensions', () => {
    const cone = (name: string, color: 'white' | 'black') => fireCone(sq(name), color).map(squareName).sort()
    expect(cone('D4', 'white')).toEqual(['C6', 'D5', 'D6', 'E6'])
    expect(cone('D4', 'black')).toEqual(['C2', 'D2', 'D3', 'E2'])
    expect(cone('A4', 'white')).toEqual(['A5', 'A6', 'B6'])
    expect(cone('L4', 'black')).toEqual(['K2', 'L2', 'L3'])
    expect(cone('L11', 'white')).toEqual(['L12'])
    expect(cone('D1', 'black')).toEqual([])
  })
})

describe('Dragon composite turns', () => {
  it('burns all four enemies at the origin before landing on a victim’s square', () => {
    const raw = position([
      ...distantKings,
      ['white', 'dragon', 'D4'],
      ['black', 'pawn', 'D5'],
      ['black', 'bishop', 'C6'],
      ['black', 'queen', 'D6'],
      ['black', 'rook', 'E6'],
    ])
    raw.halfMoveClock = 8
    const state = startPosition(raw)
    const action = dragonTurn('C6', 'before')
    expect(legalActions(state)).toContainEqual(action)

    const preview = dragonPreview(state, state.pieces['white-D4'], action)
    expect(preview.filter(cell => cell.effect === 'victim').map(cell => squareName(cell.square)).sort())
      .toEqual(['C6', 'D5', 'D6', 'E6'])
    const next = applyAction(state, action)!
    expect(next.graveyard.black.slice().sort()).toEqual(['black-C6', 'black-D5', 'black-D6', 'black-E6'])
    expect(next.graveyard.black.every(id => next.pieces[id].currentSquare === null)).toBe(true)
    expect(pieceAt(next, sq('C6'))?.id).toBe('white-D4')
    expect(next.halfMoveClock).toBe(0)
    expect(next.currentPlayer).toBe('black')
    expect(next.moveHistory).toHaveLength(1)
    expect(next.moveHistory[0]).toMatchObject({ action, from: sq('D4'), to: sq('C6') })
    expect(next.moveHistory[0].capturedIds.slice().sort()).toEqual(next.graveyard.black.slice().sort())
    expect(next.repetitionHistory).toHaveLength(2)
    expect(applyAction(next, dragonTurn('B5', 'after'))).toBeNull()

    const session = updateSession(createSession(state), next)
    expect(undo(session).game).toEqual(state)
    expect(state.graveyard.black).toEqual([])
    expect(pieceAt(state, sq('C6'))?.id).toBe('black-C6')
  })

  it('moves before burning from the destination, preserving allies and the threatened King', () => {
    const state = startPosition(position([
      ['white', 'king', 'A1'],
      ['black', 'king', 'F7'],
      ['white', 'dragon', 'D4'],
      ['white', 'pawn', 'E7'],
      ['black', 'pawn', 'D5'],
      ['black', 'rook', 'F6'],
      ['black', 'knight', 'G7'],
    ]))
    const action = dragonTurn('F5', 'after')
    const preview = dragonPreview(state, state.pieces['white-D4'], action)
    expect(Object.fromEntries(preview.map(cell => [squareName(cell.square), cell.effect])))
      .toEqual({ F6: 'victim', E7: 'ally', F7: 'king', G7: 'victim' })

    const next = applyAction(state, action)!
    expect(next.graveyard.black.slice().sort()).toEqual(['black-F6', 'black-G7'])
    expect(pieceAt(next, sq('D5'))?.id).toBe('black-D5')
    expect(pieceAt(next, sq('E7'))?.id).toBe('white-E7')
    expect(pieceAt(next, sq('F7'))?.id).toBe('black-F7')
    expect(pieceAt(next, sq('F5'))?.id).toBe('white-D4')
    expect(fireReport(next, next.pieces['white-D4']).map(cell => squareName(cell.square)).sort())
      .toEqual(['E7', 'F6', 'F7', 'G7'])
    expect(isInCheck(next, 'black')).toBe(true)
  })

  it('captures a shielded landing target normally after it survives the breath', () => {
    const state = startPosition(position([
      ...distantKings,
      ['white', 'dragon', 'D4'],
      ['black', 'shielder', 'C6'],
    ]))
    expect(fireReport(state, state.pieces['white-D4']).find(cell => cell.pieceId === 'black-C6')?.effect)
      .toBe('protected')
    const next = applyAction(state, dragonTurn('C6', 'before'))!
    expect(pieceAt(next, sq('C6'))?.id).toBe('white-D4')
    expect(next.graveyard.black).toEqual(['black-C6'])
  })

  it('keeps the no-progress clock running on fire with no victims', () => {
    const raw = position([...distantKings, ['white', 'dragon', 'D4']])
    raw.halfMoveClock = 9
    const next = applyAction(startPosition(raw), dragonTurn('F5', 'after'))!
    expect(next.halfMoveClock).toBe(10)
    expect(next.moveHistory[0].capturedIds).toEqual([])
  })
})

describe('Dragon threats against the King', () => {
  it('checks a King without a fire activation and forbids entering the cone', () => {
    const pieces = [
      ['black', 'dragon', 'D6'],
      ['black', 'king', 'L12'],
    ] as const satisfies readonly Entry[]
    const checking = startPosition(position([...pieces, ['white', 'king', 'D4']]))
    expect(checking.status).toMatchObject({ kind: 'active', inCheck: true })
    expect(isInCheck(checking, 'white')).toBe(true)
    expect(isSquareAttacked(checking, sq('D4'), 'black')).toBe(true)

    const approach = startPosition(position([...pieces, ['white', 'king', 'D3']]))
    expect(isInCheck(approach, 'white')).toBe(false)
    expect(applyAction(approach, { kind: 'move', pieceId: 'white-D3', destination: sq('D4') })).toBeNull()
  })

  it('includes the Dragon’s Knight attack outside its fire cone', () => {
    const state = position([
      ['white', 'king', 'F5'],
      ['black', 'dragon', 'D4'],
      ['black', 'king', 'L12'],
    ])
    expect(fireCone(sq('D4'), 'black').map(squareName)).not.toContain('F5')
    expect(isInCheck(state, 'white')).toBe(true)
  })

  it('accepts fire before movement as the only form of a move that removes an existing check', () => {
    const state = startPosition(position([
      ['white', 'king', 'D1'],
      ['black', 'king', 'L12'],
      ['white', 'dragon', 'C4'],
      ['black', 'rook', 'D6'],
    ]))
    expect(isInCheck(state, 'white')).toBe(true)
    expect(applyAction(state, dragonTurn('A3', 'none', 'white-C4'))).toBeNull()
    expect(applyAction(state, dragonTurn('A3', 'after', 'white-C4'))).toBeNull()
    const next = applyAction(state, dragonTurn('A3', 'before', 'white-C4'))!
    expect(next.graveyard.black).toEqual(['black-D6'])
    expect(isInCheck(next, 'white')).toBe(false)
  })

  it('evaluates final King safety after a move exposes a line and the resulting fire removes it', () => {
    const state = startPosition(position([
      ['white', 'king', 'D1'],
      ['black', 'king', 'L12'],
      ['white', 'dragon', 'D4'],
      ['black', 'rook', 'D8'],
    ]))
    expect(isInCheck(state, 'white')).toBe(false)
    expect(applyAction(state, dragonTurn('E6', 'none'))).toBeNull()
    expect(applyAction(state, dragonTurn('E6', 'before'))).toBeNull()
    const next = applyAction(state, dragonTurn('E6', 'after'))!
    expect(next.graveyard.black).toEqual(['black-D8'])
    expect(isInCheck(next, 'white')).toBe(false)
  })

  it('prevents castling through a fire-threatened transit square with safe endpoints', () => {
    const raw = position([
      ['white', 'king', 'G1'],
      ['white', 'rook', 'L1'],
      ['black', 'king', 'G12'],
      ['black', 'dragon', 'H2'],
    ])
    raw.castlingRights.white.kingSide = true
    const state = startPosition(raw)
    expect(isInCheck(state, 'white')).toBe(false)
    expect(isSquareAttacked(state, sq('H1'), 'black')).toBe(true)
    expect(isSquareAttacked(state, sq('I1'), 'black')).toBe(false)
    expect(applyAction(state, { kind: 'castle', side: 'kingSide' })).toBeNull()
  })
})
