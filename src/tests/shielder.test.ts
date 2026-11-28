import { describe, expect, it } from 'vitest'
import { igniteFire, shielderAxis, type FirePreview } from '../engine/fire'
import { applyAction, legalActions, startPosition } from '../engine/game'
import { pieceAt, squareName, type Action, type PieceType } from '../engine/model'
import { attacksSquare } from '../engine/movement'
import { dragonPreview, isInCheck } from '../engine/rules'
import { position, sq, type Entry } from './fixture'

const distantKings = [
  ['white', 'king', 'A1'],
  ['black', 'king', 'L12'],
] as const satisfies readonly Entry[]

function move(pieceId: string, destination: string): Action {
  return { kind: 'move', pieceId, destination: sq(destination) }
}

describe('Shielder movement', () => {
  it('moves up to three squares on a file or rank and stops at the first piece', () => {
    const state = startPosition(position([
      ...distantKings,
      ['white', 'shielder', 'D5'],
      ['white', 'pawn', 'D7'],
      ['black', 'pawn', 'D3'],
    ]))
    const destinations = legalActions(state).flatMap(action =>
      action.kind === 'move' && action.pieceId === 'white-D5' ? [squareName(action.destination)] : [],
    )
    expect(destinations.sort()).toEqual(['A5', 'B5', 'C5', 'D3', 'D4', 'D6', 'E5', 'F5', 'G5'])
    for (const illegal of ['E6', 'D8', 'H5', 'D2']) {
      expect(applyAction(state, move('white-D5', illegal))).toBeNull()
    }
    const next = applyAction(state, move('white-D5', 'D3'))!
    expect(pieceAt(next, sq('D3'))?.id).toBe('white-D5')
    expect(next.graveyard.black).toEqual(['black-D3'])
  })

  it('can capture an enemy in front of itself', () => {
    const state = startPosition(position([
      ...distantKings,
      ['white', 'shielder', 'D5'],
      ['black', 'rook', 'D7'],
    ]))
    const next = applyAction(state, move('white-D5', 'D7'))!
    expect(pieceAt(next, sq('D7'))?.id).toBe('white-D5')
    expect(next.graveyard.black).toEqual(['black-D7'])
  })
})

describe('Shielder frontal guard', () => {
  const frontalAttackers = [
    ['rook', 'D9'],
    ['queen', 'D9'],
    ['shielder', 'D8'],
    ['king', 'D6'],
  ] as const satisfies readonly (readonly [PieceType, string])[]

  it.each(frontalAttackers)('stops a frontal %s from %s', (attacker, from) => {
    const pieces: Entry[] = [
      ['white', 'king', 'A1'],
      ['white', 'shielder', 'D5'],
      ['black', attacker, from],
    ]
    if (attacker !== 'king') pieces.push(['black', 'king', 'L12'])
    const state = startPosition(position(pieces, 'black'))
    expect(attacksSquare(state, state.pieces['black-' + from], sq('D5'))).toBe(false)
    expect(applyAction(state, move('black-' + from, 'D5'))).toBeNull()
  })

  const validAttackers = [
    ['rook', 'F5'],
    ['rook', 'D2'],
    ['bishop', 'F7'],
    ['pawn', 'E6'],
    ['knight', 'F6'],
    ['dragon', 'F6'],
  ] as const satisfies readonly (readonly [PieceType, string])[]

  it.each(validAttackers)('can be captured by a %s from %s', (attacker, from) => {
    const id = 'black-' + from
    const state = startPosition(position([
      ...distantKings,
      ['white', 'shielder', 'D5'],
      ['black', attacker, from],
    ], 'black'))
    expect(attacksSquare(state, state.pieces[id], sq('D5'))).toBe(true)
    const action = attacker === 'dragon'
      ? { kind: 'dragon', pieceId: id, destination: sq('D5'), fireTiming: 'none' } as const
      : move(id, 'D5')
    const next = applyAction(state, action)!
    expect(next.graveyard.white).toEqual(['white-D5'])
    expect(pieceAt(next, sq('D5'))?.id).toBe(id)
  })

  it('uses the Black Shielder’s downward facing and still allows a direct capture from behind', () => {
    const state = startPosition(position([
      ...distantKings,
      ['black', 'shielder', 'D8'],
      ['white', 'rook', 'D4'],
      ['white', 'rook', 'D11'],
    ]))
    expect(applyAction(state, move('white-D4', 'D8'))).toBeNull()
    expect(applyAction(state, move('white-D11', 'D8'))?.graveyard.black).toEqual(['black-D8'])
  })

  it('does not protect a King from a direct sliding check just because it faces the attacker', () => {
    const state = position([
      ['white', 'king', 'D5'],
      ['white', 'shielder', 'E5'],
      ['black', 'rook', 'D9'],
      ['black', 'king', 'L12'],
    ])
    expect(isInCheck(state, 'white')).toBe(true)
  })
})

describe('Shielder fire cancellation', () => {
  it.each(['white', 'black'] as const)('cancels the entire destination cone at its outer cell for a %s Shielder', color => {
    const state = startPosition(position([
      ...distantKings,
      ['white', 'dragon', 'D4'],
      ['black', 'pawn', 'F6'],
      [color, 'shielder', 'G7'],
    ]))
    const action = { kind: 'dragon', pieceId: 'white-D4', destination: sq('F5'), fireTiming: 'after' } as const
    const preview = dragonPreview(state, state.pieces[action.pieceId], action)
    expect(preview.canceledBy).toEqual([color + '-G7'])
    expect(preview.cells.find(cell => cell.pieceId === 'black-F6')?.effect).toBe('threatened')

    const next = applyAction(state, action)!
    expect(pieceAt(next, sq('F5'))?.id).toBe('white-D4')
    expect(pieceAt(next, sq('G7'))?.id).toBe(color + '-G7')
    expect(pieceAt(next, sq('F6'))?.id).toBe('black-F6')
    expect(next.fireState.effects).toEqual([])
    expect(next.moveHistory.at(-1)?.fire).toEqual({
      created: [], expired: [], captures: [], canceledBy: [color + '-G7'],
    })
    expect(next.currentPlayer).toBe('black')
  })

  it('recognizes every Shielder in the cone and leaves ordinary pieces unharmed', () => {
    const state = startPosition(position([
      ...distantKings,
      ['white', 'dragon', 'D4'],
      ['white', 'shielder', 'D5'],
      ['black', 'shielder', 'E6'],
      ['black', 'knight', 'D6'],
    ]))
    const next = applyAction(state, {
      kind: 'dragon', pieceId: 'white-D4', destination: sq('F3'), fireTiming: 'before',
    })!
    expect(next.moveHistory.at(-1)?.fire.canceledBy).toEqual(['white-D5', 'black-E6'])
    expect(next.fireState.effects).toEqual([])
    expect(next.graveyard).toEqual({ white: [], black: [] })
    expect(pieceAt(next, sq('D6'))?.id).toBe('black-D6')
    expect(pieceAt(next, sq('F3'))?.id).toBe('white-D4')
  })

  it('lets the Dragon capture the canceling Shielder as its subsequent Knight move', () => {
    const state = startPosition(position([
      ...distantKings,
      ['white', 'dragon', 'D4'],
      ['black', 'shielder', 'C6'],
      ['black', 'pawn', 'D5'],
    ]))
    const next = applyAction(state, {
      kind: 'dragon', pieceId: 'white-D4', destination: sq('C6'), fireTiming: 'before',
    })!
    expect(next.graveyard.black).toEqual(['black-C6'])
    expect(next.moveHistory.at(-1)?.fire).toMatchObject({
      created: [], captures: [], canceledBy: ['black-C6'],
    })
    expect(pieceAt(next, sq('D5'))?.id).toBe('black-D5')
  })

  it('retains already-burning squares entered by a Shielder and never burns it', () => {
    const raw = position([
      ...distantKings,
      ['black', 'shielder', 'C7'],
    ], 'black')
    const preview: FirePreview = {
      cells: [{ square: sq('C6'), pieceId: null, effect: 'empty', refresh: false }], canceledBy: [],
    }
    raw.fireState = igniteFire(raw.fireState, 'white', preview).fireState
    const active = applyAction(startPosition(raw), move('black-C7', 'C6'))!
    expect(active.fireState.effects).toEqual(raw.fireState.effects)
    expect(active.moveHistory.at(-1)?.fire.expired).toEqual([])
    expect(pieceAt(active, sq('C6'))?.id).toBe('black-C7')

    const resolved = applyAction(active, move('white-A1', 'A2'))!
    expect(resolved.fireState.effects).toEqual([])
    expect(resolved.moveHistory.at(-1)?.fire.expired).toEqual(raw.fireState.effects)
    expect(resolved.moveHistory.at(-1)?.fire.captures).toEqual([])
    expect(pieceAt(resolved, sq('C6'))?.id).toBe('black-C7')
  })

  it('cancels only new fire even when existing fire burns another piece in the same turn', () => {
    const raw = position([
      ...distantKings,
      ['white', 'dragon', 'D4'],
      ['black', 'shielder', 'C6'],
      ['black', 'pawn', 'D5'],
    ])
    const preview: FirePreview = {
      cells: [{ square: sq('D5'), pieceId: 'black-D5', effect: 'threatened', refresh: false }], canceledBy: [],
    }
    raw.fireState = { ...igniteFire(raw.fireState, 'white', preview).fireState, currentTurnIndex: 1 }
    const next = applyAction(startPosition(raw), {
      kind: 'dragon', pieceId: 'white-D4', destination: sq('F3'), fireTiming: 'before',
    })!
    expect(next.moveHistory.at(-1)?.fire).toEqual({
      created: [], expired: raw.fireState.effects,
      captures: [{ pieceId: 'black-D5', owner: 'white', square: sq('D5') }], canceledBy: ['black-C6'],
    })
    expect(next.graveyard.black).toEqual(['black-D5'])
  })

  it('prevents a fire check when a Shielder cancels the cone away from the King', () => {
    const state = startPosition(position([
      ['white', 'king', 'A1'],
      ['white', 'dragon', 'D4'],
      ['black', 'king', 'D6'],
      ['black', 'shielder', 'C6'],
    ]))
    const next = applyAction(state, {
      kind: 'dragon', pieceId: 'white-D4', destination: sq('F3'), fireTiming: 'before',
    })!
    expect(isInCheck(next, 'black')).toBe(false)
    expect(next.moveHistory.at(-1)?.fire.canceledBy).toEqual(['black-C6'])
  })
})

describe('Shielder and King safety', () => {
  it('shows only the precise forward axis and cannot expose its King to a sliding piece', () => {
    const state = startPosition(position([
      ['white', 'king', 'D4'],
      ['white', 'shielder', 'D5'],
      ['black', 'rook', 'D9'],
      ['black', 'king', 'L12'],
    ]))
    expect(shielderAxis(state.pieces['white-D5']).map(squareName))
      .toEqual(['D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12'])
    expect(isInCheck(state, 'white')).toBe(false)
    expect(applyAction(state, move('white-D5', 'C5'))).toBeNull()
    expect(applyAction(state, move('white-D5', 'D6'))).not.toBeNull()
  })
})
