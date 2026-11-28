import { BOARD_SIZE, type Color, type PieceType } from '../engine/model'

export const WHITE = 0
export const BLACK = 1

export const PT_PAWN = 0
export const PT_KNIGHT = 1
export const PT_BISHOP = 2
export const PT_ROOK = 3
export const PT_QUEEN = 4
export const PT_KING = 5
export const PT_NECROMANCER = 6
export const PT_DRAGON = 7
export const PT_SHIELDER = 8
export const NUM_PIECE_TYPES = 9

export const PIECE_TYPE_FROM_CODE: readonly PieceType[] = [
  'pawn',
  'knight',
  'bishop',
  'rook',
  'queen',
  'king',
  'necromancer',
  'dragon',
  'shielder',
]

export const CODE_FROM_PIECE_TYPE: Record<PieceType, number> = {
  pawn: PT_PAWN,
  knight: PT_KNIGHT,
  bishop: PT_BISHOP,
  rook: PT_ROOK,
  queen: PT_QUEEN,
  king: PT_KING,
  necromancer: PT_NECROMANCER,
  dragon: PT_DRAGON,
  shielder: PT_SHIELDER,
}

export const NUM_SQUARES = BOARD_SIZE * BOARD_SIZE // 144
export const GRAVEYARD_SLOT = NUM_SQUARES // 144
export const NUM_SLOTS = NUM_SQUARES + 1 // 145 (0..143 on board, 144 in graveyard)
export const MAX_ZOBRIST_PIECES = 64
export const MAX_FIRE_TURNS = 8

// State codes per piece:
// For non-pawn baseType: current type (0..8), pawnMoved always 0 -> 9 variants.
// For pawn baseType: if type===PT_PAWN -> pawnMoved 0 or 1 (variants 0..1);
// if promoted (knight=1, bishop=2, rook=3, queen=4) -> variants 2..5.
// Total <= 10 distinct (type, pawnMoved) states per pid. We allocate 16 states * 145 slots per pid.
export const PIECE_STATE_STRIDE = NUM_SLOTS * 16

function splitMix32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x9e3779b9) >>> 0
    let z = state
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0
    return (z ^ (z >>> 16)) >>> 0
  }
}

const nextRand = splitMix32(0x1201204b)

const pieceLo = new Uint32Array(MAX_ZOBRIST_PIECES * PIECE_STATE_STRIDE)
const pieceHi = new Uint32Array(MAX_ZOBRIST_PIECES * PIECE_STATE_STRIDE)
for (let i = 0; i < pieceLo.length; i++) {
  pieceLo[i] = nextRand()
  pieceHi[i] = nextRand()
}

// Separate structural hash for Pawn + Shielder + Necromancer + King (by color, type, square)
const pawnStructLo = new Uint32Array(2 * NUM_PIECE_TYPES * NUM_SLOTS)
const pawnStructHi = new Uint32Array(2 * NUM_PIECE_TYPES * NUM_SLOTS)
for (let i = 0; i < pawnStructLo.length; i++) {
  pawnStructLo[i] = nextRand()
  pawnStructHi[i] = nextRand()
}

export const SIDE_KEY_LO = nextRand()
export const SIDE_KEY_HI = nextRand()

export const CASTLING_KEY_LO = new Uint32Array(16)
export const CASTLING_KEY_HI = new Uint32Array(16)
for (let i = 1; i < 16; i++) {
  CASTLING_KEY_LO[i] = nextRand()
  CASTLING_KEY_HI[i] = nextRand()
}

// EP key indexed by (epTargetSq * 64 + epPawnPid) or simplified by epTargetSq (144) + epPawnPid (64)
export const EP_SQ_KEY_LO = new Uint32Array(NUM_SQUARES)
export const EP_SQ_KEY_HI = new Uint32Array(NUM_SQUARES)
for (let i = 0; i < NUM_SQUARES; i++) {
  EP_SQ_KEY_LO[i] = nextRand()
  EP_SQ_KEY_HI[i] = nextRand()
}
export const EP_PAWN_KEY_LO = new Uint32Array(MAX_ZOBRIST_PIECES)
export const EP_PAWN_KEY_HI = new Uint32Array(MAX_ZOBRIST_PIECES)
for (let i = 0; i < MAX_ZOBRIST_PIECES; i++) {
  EP_PAWN_KEY_LO[i] = nextRand()
  EP_PAWN_KEY_HI[i] = nextRand()
}

// Quota key: [color (0..1)][typeCode (0..8)][used (0..3)]
export const QUOTA_KEY_LO = new Uint32Array(2 * NUM_PIECE_TYPES * 4)
export const QUOTA_KEY_HI = new Uint32Array(2 * NUM_PIECE_TYPES * 4)
for (let i = 0; i < QUOTA_KEY_LO.length; i++) {
  QUOTA_KEY_LO[i] = nextRand()
  QUOTA_KEY_HI[i] = nextRand()
}

// Fire key: [owner (0..1)][sq (0..143)][turnsRemaining (0..7)] -> 0 is 0 (no fire)
export const FIRE_KEY_LO = new Uint32Array(2 * NUM_SQUARES * MAX_FIRE_TURNS)
export const FIRE_KEY_HI = new Uint32Array(2 * NUM_SQUARES * MAX_FIRE_TURNS)
for (let owner = 0; owner < 2; owner++) {
  for (let sq = 0; sq < NUM_SQUARES; sq++) {
    for (let rem = 1; rem < MAX_FIRE_TURNS; rem++) {
      const idx = ((owner * NUM_SQUARES + sq) * MAX_FIRE_TURNS) + rem
      FIRE_KEY_LO[idx] = nextRand()
      FIRE_KEY_HI[idx] = nextRand()
    }
  }
}

export function pieceStateVariant(baseType: number, currType: number, hasMoved: number): number {
  const pawnMoved = baseType === PT_PAWN && hasMoved ? 1 : 0
  return (currType & 0x0f) | (pawnMoved << 3)
}

export function pieceZobristIndex(pid: number, slot: number, baseType: number, currType: number, hasMoved: number): number {
  // Note: variant fits in 0..15? Wait: currType is 0..8, if pawnMoved=1 then currType can be 0..4, so (currType | (pawnMoved<<3)) -> 8..12;
  // wait: 8 is PT_SHIELDER (never baseType==PT_PAWN), and pawnMoved is ONLY 1 when baseType===PT_PAWN (so currType is 0..4 -> 8..12)!
  // Just to be 100% collision-free even in weird custom fixtures, only set bit 3 when baseType === PT_PAWN && hasMoved, and note shielder has baseType === PT_SHIELDER (not pawn)!
  // Since pieceZobristIndex is ALREADY scoped per pid (and pid fixes baseType!), baseType is constant per pid!
  // So for a fixed pid: if baseType===PT_PAWN, currType is in {0,1,2,3,4}, so currType + pawnMoved*5 is 0..9 (<16)!
  const variant = baseType === PT_PAWN ? currType + (hasMoved ? 5 : 0) : currType
  return pid * PIECE_STATE_STRIDE + slot * 16 + variant
}

export function getPieceLo(idx: number): number {
  return pieceLo[idx]
}

export function getPieceHi(idx: number): number {
  return pieceHi[idx]
}

export function pawnStructIndex(color: number, type: number, slot: number): number {
  return (color * NUM_PIECE_TYPES + type) * NUM_SLOTS + slot
}

export function getPawnStructLo(idx: number): number {
  return pawnStructLo[idx]
}

export function getPawnStructHi(idx: number): number {
  return pawnStructHi[idx]
}

export function colorToCode(color: Color): 0 | 1 {
  return color === 'white' ? WHITE : BLACK
}

export function isStructuralType(type: number): boolean {
  return type === PT_PAWN || type === PT_SHIELDER || type === PT_NECROMANCER || type === PT_KING
}
