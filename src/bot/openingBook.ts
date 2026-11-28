import { applyAction, createGame } from '../engine/game'
import { parseSquare, type Action, type GameState } from '../engine/model'
import { positionKey } from '../engine/rules'

interface BookEntry {
  action: Action
  weight: number
}

type LineStep = [action: Action, weight: number]

const mv = (pieceId: string, to: string): Action => ({
  kind: 'move',
  pieceId,
  destination: parseSquare(to)!,
})

const drg = (pieceId: string, to: string, fireTiming: 'none' | 'before' | 'after' = 'none'): Action => ({
  kind: 'dragon',
  pieceId,
  destination: parseSquare(to)!,
  fireTiming,
})

const castle = (side: 'kingSide' | 'queenSide'): Action => ({ kind: 'castle', side })

// Principled 12x12 opening lines:
// - Control central files (E-H)
// - Develop Knights & Dragons to active central outposts (C3/J3, E3/H3)
// - Advance Shielders safely to guard the center/King without clogging Dragon cones
// - Prepare Kingside (I1/I12) or Queenside (E1/E12) castling
const OPENING_LINES: readonly (readonly LineStep[])[] = [
  // Line 1: Classical King-side Pawn + Knight + Bishop + Castle setup
  [
    [mv('white-G3', 'G5'), 40],
    [mv('black-G10', 'G8'), 40],
    [mv('white-K1', 'J3'), 35],
    [mv('black-K12', 'J10'), 35],
    [mv('white-F3', 'F5'), 30],
    [mv('black-F10', 'F8'), 30],
    [mv('white-H1', 'J3'), 0], // fallback skipped if occupied; handled cleanly below
  ],
  [
    [mv('white-G3', 'G5'), 40],
    [mv('black-G10', 'G8'), 40],
    [mv('white-K1', 'J3'), 35],
    [mv('black-B12', 'C10'), 35],
    [mv('white-H1', 'F3'), 30],
    [mv('black-F10', 'F8'), 30],
    [mv('white-I1', 'H3'), 28],
    [mv('black-I12', 'H10'), 28],
    [castle('kingSide'), 35],
  ],
  // Line 2: Queen-side Central Expansion (F3-F5, E3-E5, B1-C3, D1-E3)
  [
    [mv('white-F3', 'F5'), 38],
    [mv('black-F10', 'F8'), 38],
    [mv('white-B1', 'C3'), 34],
    [mv('black-B12', 'C10'), 34],
    [mv('white-E3', 'E5'), 30],
    [mv('black-G10', 'G8'), 30],
    [mv('white-E1', 'G3'), 28],
    [mv('black-E12', 'G10'), 28],
    [drg('white-D1', 'E3', 'none'), 26],
    [drg('black-D12', 'E10', 'none'), 26],
  ],
  // Line 3: Symmetrical Double-Center + Shielder Anchor
  [
    [mv('white-F3', 'F5'), 38],
    [mv('black-G10', 'G8'), 38],
    [mv('white-G3', 'G5'), 35],
    [mv('black-F10', 'F8'), 35],
    [mv('white-F2', 'F4'), 25],
    [mv('black-G11', 'G9'), 25],
    [mv('white-K1', 'J3'), 30],
    [mv('black-K12', 'J10'), 30],
  ],
  // Line 4: Hyper-active Dragon & Knight flank
  [
    [mv('white-E3', 'E5'), 22],
    [mv('black-E10', 'E8'), 24],
    [mv('white-B1', 'C3'), 28],
    [mv('black-K12', 'J10'), 28],
    [mv('white-G3', 'G5'), 30],
    [mv('black-G10', 'G8'), 30],
    [mv('white-H3', 'H5'), 24],
    [mv('black-H10', 'H8'), 24],
  ],
  // Line 5: Sicilian-style asymmetric counter against G5
  [
    [mv('white-G3', 'G5'), 40],
    [mv('black-E10', 'E8'), 26],
    [mv('white-F3', 'F5'), 34],
    [mv('black-B12', 'C10'), 30],
    [mv('white-K1', 'J3'), 30],
    [mv('black-D12', 'E10'), 26],
    [mv('white-H3', 'H5'), 24],
    [mv('black-G10', 'G8'), 28],
  ],
  // Line 6: H3-H5 + Dragon I1-H3 wing thrust
  [
    [mv('white-H3', 'H5'), 22],
    [mv('black-H10', 'H8'), 22],
    [mv('white-K1', 'J3'), 30],
    [mv('black-K12', 'J10'), 30],
    [mv('white-F3', 'F5'), 32],
    [mv('black-F10', 'F8'), 32],
    [drg('white-I1', 'H3', 'none'), 26],
    [drg('black-I12', 'H10', 'none'), 26],
  ],
]

let bookCache: Map<string, BookEntry[]> | null = null

function getBook(): Map<string, BookEntry[]> {
  if (bookCache) return bookCache
  const map = new Map<string, BookEntry[]>()
  const root = createGame()

  for (const line of OPENING_LINES) {
    let state: GameState | null = root
    for (const [action, weight] of line) {
      if (!state || weight <= 0) break
      const next = applyAction(state, action)
      if (!next) break
      const key = positionKey(state)
      const list = map.get(key) ?? []
      if (!list.some(e => JSON.stringify(e.action) === JSON.stringify(action))) {
        list.push({ action, weight })
        map.set(key, list)
      }
      state = next
    }
  }

  bookCache = map
  return map
}

export function lookupOpeningBook(state: GameState, preferBest = false): Action | null {
  if (state.moveHistory.length >= 10) return null
  const entries = getBook().get(positionKey(state))
  if (!entries?.length) return null

  if (preferBest) {
    let best = entries[0]
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].weight > best.weight) best = entries[i]
    }
    return best.action
  }

  let total = 0
  for (const e of entries) total += e.weight
  let r = Math.random() * total
  for (const e of entries) {
    r -= e.weight
    if (r <= 0) return e.action
  }
  return entries[0].action
}
