import {
  BOARD_SIZE, COLORS, PROMOTION_TYPES, RESURRECTION_LIMIT,
  type Action, type CastleSide, type DragonFireTiming, type GameState, type PromotionType,
} from '../engine/model'
import {
  BLACK, CASTLING_KEY_HI, CASTLING_KEY_LO, CODE_FROM_PIECE_TYPE, EP_PAWN_KEY_HI,
  EP_PAWN_KEY_LO, EP_SQ_KEY_HI, EP_SQ_KEY_LO, FIRE_KEY_HI, FIRE_KEY_LO,
  GRAVEYARD_SLOT, MAX_FIRE_TURNS, MAX_ZOBRIST_PIECES, NUM_PIECE_TYPES,
  NUM_SQUARES, PIECE_TYPE_FROM_CODE, PT_BISHOP, PT_DRAGON, PT_KING, PT_KNIGHT,
  PT_NECROMANCER, PT_PAWN, PT_QUEEN, PT_ROOK, PT_SHIELDER, QUOTA_KEY_HI,
  QUOTA_KEY_LO, SIDE_KEY_HI, SIDE_KEY_LO, WHITE, colorToCode, getPawnStructHi,
  getPawnStructLo, getPieceHi, getPieceLo, isStructuralType, pawnStructIndex,
  pieceZobristIndex,
} from './zobrist'
import { EG_VALUES, MG_VALUES, PHASE_WEIGHTS, pstEg, pstMg } from './pst'

export const MOVE_KIND_NORMAL = 0
export const MOVE_KIND_PROMOTE = 1
export const MOVE_KIND_DRAGON = 2
export const MOVE_KIND_CASTLE = 3
export const MOVE_KIND_RESURRECT = 4
export const MOVE_KIND_EP = 5

export const DRAGON_TIMING_NONE = 0
export const DRAGON_TIMING_AFTER = 1
export const DRAGON_TIMING_BEFORE = 2

const TIMING_NAMES: readonly DragonFireTiming[] = ['none', 'after', 'before']
const PROMO_CODES = [PT_QUEEN, PT_ROOK, PT_BISHOP, PT_KNIGHT] as const

export const CASTLE_KINGSIDE = 0
export const CASTLE_QUEENSIDE = 1

export const CASTLE_WHITE_KING = 1
export const CASTLE_WHITE_QUEEN = 2
export const CASTLE_BLACK_KING = 4
export const CASTLE_BLACK_QUEEN = 8

// Packed 32-bit move layout:
// bits 0..7   (8): fromSq (or revivedPid for RESURRECT, or 0/1 side for CASTLE)
// bits 8..15  (8): toSq   (or spawnSq for RESURRECT, or kingToSq for CASTLE)
// bits 16..21 (6): actorPid (0..63)
// bits 22..24 (3): moveKind (0..5)
// bits 25..28 (4): aux (promoTypeCode or dragonTiming or castleSide)
// bit 29      (1): isCaptureHint (set for direct/EP capture during generation)
export function packMove(
  kind: number,
  actorPid: number,
  fromOrRevived: number,
  toSq: number,
  aux = 0,
  captureHint = 0,
): number {
  return (
    (fromOrRevived & 0xff) |
    ((toSq & 0xff) << 8) |
    ((actorPid & 0x3f) << 16) |
    ((kind & 0x07) << 22) |
    ((aux & 0x0f) << 25) |
    ((captureHint & 1) << 29)
  ) | 0
}

export function moveKind(m: number): number { return (m >>> 22) & 0x07 }
export function moveActorPid(m: number): number { return (m >>> 16) & 0x3f }
export function moveFromOrRevived(m: number): number { return m & 0xff }
export function moveToSq(m: number): number { return (m >>> 8) & 0xff }
export function moveAux(m: number): number { return (m >>> 25) & 0x0f }
export function moveIsCaptureHint(m: number): boolean { return ((m >>> 29) & 1) !== 0 }

export function sqIndex(file: number, rank: number): number {
  return rank * BOARD_SIZE + file
}

export function sqFile(sq: number): number {
  return sq % BOARD_SIZE
}

export function sqRank(sq: number): number {
  return (sq / BOARD_SIZE) | 0
}

// Precomputed 144-square geometry tables
const KNIGHT_DELTAS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]] as const
const KING_DELTAS = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [1, -1], [-1, -1], [-1, 1]] as const
// Ray directions: 0..3 orthogonal (N, E, S, W), 4..7 diagonal (NE, SE, SW, NW)
export const RAY_DELTAS = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [1, -1], [-1, -1], [-1, 1]] as const

export const KNIGHT_TARGETS: readonly Int16Array[] = []
export const KING_TARGETS: readonly Int16Array[] = []
export const PAWN_CAP_TARGETS: readonly [Int16Array[], Int16Array[]] = [[], []]
export const PAWN_ATTACKER_ORIGINS: readonly [Int16Array[], Int16Array[]] = [[], []]
export const FIRE_CONE_SQUARES: readonly [Int16Array[], Int16Array[]] = [[], []]
export const RAY_SQUARES: readonly Int16Array[][] = Array.from({ length: 8 }, () => [])

// 5x32-bit bitmasks (160 bits for 144 squares)
export const CONE_MASK = new Uint32Array(2 * NUM_SQUARES * 5)
export const KING_ZONE_MASK = new Uint32Array(NUM_SQUARES * 5)

function setBit(arr: Uint32Array, base: number, sq: number) {
  arr[base + (sq >>> 5)] |= (1 << (sq & 31)) >>> 0
}

function initGeometry() {
  for (let sq = 0; sq < NUM_SQUARES; sq++) {
    const f = sq % BOARD_SIZE
    const r = (sq / BOARD_SIZE) | 0

    const kMoves: number[] = []
    for (const [df, dr] of KNIGHT_DELTAS) {
      const nf = f + df, nr = r + dr
      if (nf >= 0 && nf < BOARD_SIZE && nr >= 0 && nr < BOARD_SIZE) kMoves.push(nr * BOARD_SIZE + nf)
    }
    ;(KNIGHT_TARGETS as Int16Array[]).push(Int16Array.from(kMoves))

    const aMoves: number[] = []
    for (const [df, dr] of KING_DELTAS) {
      const nf = f + df, nr = r + dr
      if (nf >= 0 && nf < BOARD_SIZE && nr >= 0 && nr < BOARD_SIZE) {
        const t = nr * BOARD_SIZE + nf
        aMoves.push(t)
        setBit(KING_ZONE_MASK, sq * 5, t)
      }
    }
    setBit(KING_ZONE_MASK, sq * 5, sq)
    ;(KING_TARGETS as Int16Array[]).push(Int16Array.from(aMoves))

    for (let color = 0; color < 2; color++) {
      const fwd = color === WHITE ? 1 : -1
      const caps: number[] = []
      const atks: number[] = []
      for (const df of [-1, 1]) {
        const nf = f + df
        const nrCap = r + fwd
        if (nf >= 0 && nf < BOARD_SIZE && nrCap >= 0 && nrCap < BOARD_SIZE) caps.push(nrCap * BOARD_SIZE + nf)
        const nrAtk = r - fwd
        if (nf >= 0 && nf < BOARD_SIZE && nrAtk >= 0 && nrAtk < BOARD_SIZE) atks.push(nrAtk * BOARD_SIZE + nf)
      }
      ;(PAWN_CAP_TARGETS[color] as Int16Array[]).push(Int16Array.from(caps))
      ;(PAWN_ATTACKER_ORIGINS[color] as Int16Array[]).push(Int16Array.from(atks))

      const cone: number[] = []
      const coneDefs = [
        [f, r + fwd],
        [f - 1, r + 2 * fwd],
        [f, r + 2 * fwd],
        [f + 1, r + 2 * fwd],
      ]
      for (const [cf, cr] of coneDefs) {
        if (cf >= 0 && cf < BOARD_SIZE && cr >= 0 && cr < BOARD_SIZE) {
          const csq = cr * BOARD_SIZE + cf
          cone.push(csq)
          setBit(CONE_MASK, (color * NUM_SQUARES + sq) * 5, csq)
        }
      }
      ;(FIRE_CONE_SQUARES[color] as Int16Array[]).push(Int16Array.from(cone))
    }

    for (let dir = 0; dir < 8; dir++) {
      const [df, dr] = RAY_DELTAS[dir]
      const ray: number[] = []
      let nf = f + df, nr = r + dr
      while (nf >= 0 && nf < BOARD_SIZE && nr >= 0 && nr < BOARD_SIZE) {
        ray.push(nr * BOARD_SIZE + nf)
        nf += df
        nr += dr
      }
      ;(RAY_SQUARES[dir] as Int16Array[]).push(Int16Array.from(ray))
    }
  }
}

initGeometry()

const CASTLE_CFG = [
  { rookFile: 11, transitSqWhite: 7, kingToWhite: 8, clearWhite: [7, 8, 9, 10], transitSqBlack: 139, kingToBlack: 140, clearBlack: [139, 140, 141, 142] },
  { rookFile: 0, transitSqWhite: 5, kingToWhite: 4, clearWhite: [1, 2, 3, 4, 5], transitSqBlack: 137, kingToBlack: 136, clearBlack: [133, 134, 135, 136, 137] },
] as const

const QUOTA_LIMITS = new Uint8Array([3, 1, 1, 1, 1, 0, 1, 1, 1]) // indexed by PT_*

export const MAX_SEARCH_PLY = 160

interface FireDelta {
  idx: number
  prevRem: number
}

interface BurnDelta {
  pid: number
  sq: number
}

interface UndoRecord {
  move: number
  castling: number
  epTargetSq: number
  epPawnPid: number
  epHashActive: number
  halfMoveClock: number
  hashLo: number
  hashHi: number
  pawnHashLo: number
  pawnHashHi: number
  mgWhite: number
  mgBlack: number
  egWhite: number
  egBlack: number
  phase: number
  capturedPid: number
  capturedSq: number
  actorPrevHasMoved: number
  actorPrevType: number
  actorPrevPromoted: number
  revivedPrevHasMoved: number
  revivedPrevType: number
  revivedPrevPromoted: number
  rookPid: number
  rookPrevHasMoved: number
  fireDeltaCount: number
  fireDeltas: FireDelta[]
  burnCount: number
  burns: BurnDelta[]
}

function makeUndoRecord(): UndoRecord {
  return {
    move: 0,
    castling: 0,
    epTargetSq: -1,
    epPawnPid: -1,
    epHashActive: 0,
    halfMoveClock: 0,
    hashLo: 0,
    hashHi: 0,
    pawnHashLo: 0,
    pawnHashHi: 0,
    mgWhite: 0,
    mgBlack: 0,
    egWhite: 0,
    egBlack: 0,
    phase: 0,
    capturedPid: -1,
    capturedSq: -1,
    actorPrevHasMoved: 0,
    actorPrevType: 0,
    actorPrevPromoted: 0,
    revivedPrevHasMoved: 0,
    revivedPrevType: 0,
    revivedPrevPromoted: 0,
    rookPid: -1,
    rookPrevHasMoved: 0,
    fireDeltaCount: 0,
    fireDeltas: Array.from({ length: 16 }, () => ({ idx: 0, prevRem: 0 })),
    burnCount: 0,
    burns: Array.from({ length: 12 }, () => ({ pid: 0, sq: 0 })),
  }
}

export function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

export class FastBoard {
  squares = new Int16Array(NUM_SQUARES).fill(-1)
  pieceCount = 0
  idByPid: string[] = []
  colorByPid = new Uint8Array(MAX_ZOBRIST_PIECES)
  baseTypeByPid = new Uint8Array(MAX_ZOBRIST_PIECES)
  typeByPid = new Uint8Array(MAX_ZOBRIST_PIECES)
  spawnSqByPid = new Uint8Array(MAX_ZOBRIST_PIECES)
  currSqByPid = new Int16Array(MAX_ZOBRIST_PIECES).fill(-1)
  hasMovedByPid = new Uint8Array(MAX_ZOBRIST_PIECES)
  promotedByPid = new Uint8Array(MAX_ZOBRIST_PIECES)
  kingPid = new Int16Array(2).fill(-1)

  // Bitboards: 5 words per color/type
  occAll = new Uint32Array(5)
  occColor = new Uint32Array(2 * 5)
  occType = new Uint32Array(2 * NUM_PIECE_TYPES * 5)
  allShielders = new Uint32Array(5)

  // Fire state: remaining turns at current turn index (0 = none)
  fireRem = new Uint8Array(2 * NUM_SQUARES)
  fireMask = new Uint32Array(2 * 5)
  activeFireCount = 0
  imminentFireCount = 0

  quotasUsed = new Uint8Array(2 * NUM_PIECE_TYPES)
  castling = 0
  epTargetSq = -1
  epPawnPid = -1
  epHashActive = 0
  halfMoveClock = 0
  sideToMove: 0 | 1 = WHITE

  hashLo = 0
  hashHi = 0
  pawnHashLo = 0
  pawnHashHi = 0

  mgScore = new Int32Array(2)
  egScore = new Int32Array(2)
  phase = 0

  private undoStack: UndoRecord[] = Array.from({ length: MAX_SEARCH_PLY }, makeUndoRecord)
  ply = 0

  // Scratch buffer for fast legality check without heap alloc
  private epScratchChecked = false

  static fromGameState(state: GameState): FastBoard {
    const b = new FastBoard()
    const sortedPieces = Object.values(state.pieces).sort((a, bPiece) => a.id.localeCompare(bPiece.id))
    b.pieceCount = sortedPieces.length
    if (b.pieceCount > MAX_ZOBRIST_PIECES) {
      throw new Error(`Position exceeds MAX_ZOBRIST_PIECES (${MAX_ZOBRIST_PIECES})`)
    }

    b.sideToMove = colorToCode(state.currentPlayer)
    if (state.castlingRights.white.kingSide) b.castling |= CASTLE_WHITE_KING
    if (state.castlingRights.white.queenSide) b.castling |= CASTLE_WHITE_QUEEN
    if (state.castlingRights.black.kingSide) b.castling |= CASTLE_BLACK_KING
    if (state.castlingRights.black.queenSide) b.castling |= CASTLE_BLACK_QUEEN
    b.halfMoveClock = state.halfMoveClock

    const pidById = new Map<string, number>()
    for (let pid = 0; pid < sortedPieces.length; pid++) {
      const p = sortedPieces[pid]
      pidById.set(p.id, pid)
      b.idByPid[pid] = p.id
      const color = colorToCode(p.color)
      const baseType = CODE_FROM_PIECE_TYPE[p.baseType]
      const currType = CODE_FROM_PIECE_TYPE[p.type]
      const spawnSq = sqIndex(p.spawnSquare.file, p.spawnSquare.rank)
      const currSq = p.currentSquare ? sqIndex(p.currentSquare.file, p.currentSquare.rank) : -1

      b.colorByPid[pid] = color
      b.baseTypeByPid[pid] = baseType
      b.typeByPid[pid] = currType
      b.spawnSqByPid[pid] = spawnSq
      b.currSqByPid[pid] = currSq
      b.hasMovedByPid[pid] = p.hasMoved ? 1 : 0
      b.promotedByPid[pid] = p.promoted ? 1 : 0

      if (currSq >= 0) {
        b.squares[currSq] = pid
        b.setOccupantBits(color, currType, currSq)
        if (currType === PT_KING) b.kingPid[color] = pid
        b.mgScore[color] += MG_VALUES[currType] + pstMg(color, currType, currSq)
        b.egScore[color] += EG_VALUES[currType] + pstEg(color, currType, currSq)
        b.phase += PHASE_WEIGHTS[currType]
        if (isStructuralType(currType)) {
          const pIdx = pawnStructIndex(color, currType, currSq)
          b.pawnHashLo = (b.pawnHashLo ^ getPawnStructLo(pIdx)) >>> 0
          b.pawnHashHi = (b.pawnHashHi ^ getPawnStructHi(pIdx)) >>> 0
        }
      }
      const slot = currSq >= 0 ? currSq : GRAVEYARD_SLOT
      const zIdx = pieceZobristIndex(pid, slot, baseType, currType, b.hasMovedByPid[pid])
      b.hashLo = (b.hashLo ^ getPieceLo(zIdx)) >>> 0
      b.hashHi = (b.hashHi ^ getPieceHi(zIdx)) >>> 0
    }

    for (const colorName of COLORS) {
      const c = colorToCode(colorName)
      const quota = state.resurrectionState[colorName]
      for (const typeName of Object.keys(RESURRECTION_LIMIT) as (keyof typeof RESURRECTION_LIMIT)[]) {
        const t = CODE_FROM_PIECE_TYPE[typeName]
        const used = quota[typeName]
        b.quotasUsed[c * NUM_PIECE_TYPES + t] = used
        const qIdx = (c * NUM_PIECE_TYPES + t) * 4 + used
        b.hashLo = (b.hashLo ^ QUOTA_KEY_LO[qIdx]) >>> 0
        b.hashHi = (b.hashHi ^ QUOTA_KEY_HI[qIdx]) >>> 0
        if (t === PT_NECROMANCER || t === PT_PAWN) {
          const psIdx = (c * NUM_PIECE_TYPES + t) * 4 + used
          b.pawnHashLo = (b.pawnHashLo ^ QUOTA_KEY_LO[psIdx]) >>> 0
          b.pawnHashHi = (b.pawnHashHi ^ QUOTA_KEY_HI[psIdx]) >>> 0
        }
      }
    }

    // Fire effects (if duplicate effects exist on same square for same owner, keep max remaining)
    const curTurn = state.fireState.currentTurnIndex
    for (const eff of state.fireState.effects) {
      if (curTurn < eff.createdAtTurn) continue
      const rem = Math.max(0, eff.expiresAfterTurn - curTurn + 1)
      if (rem <= 0) continue
      const owner = colorToCode(eff.owner)
      const sq = sqIndex(eff.square.file, eff.square.rank)
      const fIdx = owner * NUM_SQUARES + sq
      if (rem > b.fireRem[fIdx]) {
        if (b.fireRem[fIdx] === 0) {
          b.activeFireCount++
          if (rem === 1) b.imminentFireCount++
        } else if (b.fireRem[fIdx] !== 1 && rem === 1) {
          b.imminentFireCount++
        }
        b.fireRem[fIdx] = rem
        b.fireMask[owner * 5 + (sq >>> 5)] |= (1 << (sq & 31)) >>> 0
      }
    }
    for (let owner = 0; owner < 2; owner++) {
      for (let sq = 0; sq < NUM_SQUARES; sq++) {
        const rem = b.fireRem[owner * NUM_SQUARES + sq]
        if (rem > 0) {
          const clampRem = Math.min(rem, MAX_FIRE_TURNS - 1)
          const fk = ((owner * NUM_SQUARES + sq) * MAX_FIRE_TURNS) + clampRem
          b.hashLo = (b.hashLo ^ FIRE_KEY_LO[fk]) >>> 0
          b.hashHi = (b.hashHi ^ FIRE_KEY_HI[fk]) >>> 0
        }
      }
    }

    if (state.enPassant) {
      b.epTargetSq = sqIndex(state.enPassant.target.file, state.enPassant.target.rank)
      b.epPawnPid = pidById.get(state.enPassant.pawnId) ?? -1
    }

    if (b.sideToMove === BLACK) {
      b.hashLo = (b.hashLo ^ SIDE_KEY_LO) >>> 0
      b.hashHi = (b.hashHi ^ SIDE_KEY_HI) >>> 0
    }
    b.hashLo = (b.hashLo ^ CASTLING_KEY_LO[b.castling]) >>> 0
    b.hashHi = (b.hashHi ^ CASTLING_KEY_HI[b.castling]) >>> 0

    b.refreshEpHash()
    return b
  }

  private setOccupantBits(color: number, type: number, sq: number) {
    const word = sq >>> 5
    const bit = (1 << (sq & 31)) >>> 0
    this.occAll[word] |= bit
    this.occColor[color * 5 + word] |= bit
    this.occType[(color * NUM_PIECE_TYPES + type) * 5 + word] |= bit
    if (type === PT_SHIELDER) this.allShielders[word] |= bit
  }

  private clearOccupantBits(color: number, type: number, sq: number) {
    const word = sq >>> 5
    const inv = ~((1 << (sq & 31)) >>> 0)
    this.occAll[word] &= inv
    this.occColor[color * 5 + word] &= inv
    this.occType[(color * NUM_PIECE_TYPES + type) * 5 + word] &= inv
    if (type === PT_SHIELDER) this.allShielders[word] &= inv
  }

  hasAnyShielderInCone(dragonColor: number, sq: number): boolean {
    const base = (dragonColor * NUM_SQUARES + sq) * 5
    return (
      ((CONE_MASK[base] & this.allShielders[0]) !== 0) ||
      ((CONE_MASK[base + 1] & this.allShielders[1]) !== 0) ||
      ((CONE_MASK[base + 2] & this.allShielders[2]) !== 0) ||
      ((CONE_MASK[base + 3] & this.allShielders[3]) !== 0) ||
      ((CONE_MASK[base + 4] & this.allShielders[4]) !== 0)
    )
  }

  isHostileFire(sq: number, victimColor: number): boolean {
    return this.fireRem[(victimColor ^ 1) * NUM_SQUARES + sq] > 0
  }

  isSquareAttackedByPieces(sq: number, byColor: number, ignoreShielderFront = false): boolean {
    const targetPid = this.squares[sq]
    const targetIsEnemyShielder = !ignoreShielderFront && targetPid >= 0 &&
      this.colorByPid[targetPid] !== byColor && this.typeByPid[targetPid] === PT_SHIELDER

    // 1. Pawns
    const pawnOrigins = PAWN_ATTACKER_ORIGINS[byColor][sq]
    for (let i = 0; i < pawnOrigins.length; i++) {
      const p = this.squares[pawnOrigins[i]]
      if (p >= 0 && this.colorByPid[p] === byColor && this.typeByPid[p] === PT_PAWN) return true
    }

    // 2. Knights & Dragons
    const kTargets = KNIGHT_TARGETS[sq]
    for (let i = 0; i < kTargets.length; i++) {
      const p = this.squares[kTargets[i]]
      if (p >= 0 && this.colorByPid[p] === byColor) {
        const t = this.typeByPid[p]
        if (t === PT_KNIGHT || t === PT_DRAGON) return true
      }
    }

    // 3. King & Necromancer
    const aTargets = KING_TARGETS[sq]
    for (let i = 0; i < aTargets.length; i++) {
      const p = this.squares[aTargets[i]]
      if (p >= 0 && this.colorByPid[p] === byColor) {
        const t = this.typeByPid[p]
        if (t === PT_KING || t === PT_NECROMANCER) {
          if (targetIsEnemyShielder) {
            const pSq = aTargets[i]
            if (sqFile(pSq) === sqFile(sq)) {
              const targetFwd = this.colorByPid[targetPid] === WHITE ? 1 : -1
              if ((sqRank(pSq) - sqRank(sq)) * targetFwd > 0) continue
            }
          }
          return true
        }
      }
    }

    // 4. Orthogonal rays (0: N, 1: E, 2: S, 3: W)
    for (let dir = 0; dir < 4; dir++) {
      const ray = RAY_SQUARES[dir][sq]
      for (let i = 0; i < ray.length; i++) {
        const rSq = ray[i]
        const p = this.squares[rSq]
        if (p < 0) continue
        if (this.colorByPid[p] === byColor) {
          const t = this.typeByPid[p]
          if (t === PT_ROOK || t === PT_QUEEN || (t === PT_SHIELDER && i < 3)) {
            if (targetIsEnemyShielder && (dir === 0 || dir === 2)) {
              const targetFwd = this.colorByPid[targetPid] === WHITE ? 1 : -1
              // dir 0 is +rank, dir 2 is -rank
              const delta = dir === 0 ? 1 : -1
              if (delta * targetFwd > 0) break
            }
            return true
          }
        }
        break
      }
    }

    // 5. Diagonal rays (4: NE, 5: SE, 6: SW, 7: NW)
    for (let dir = 4; dir < 8; dir++) {
      const ray = RAY_SQUARES[dir][sq]
      for (let i = 0; i < ray.length; i++) {
        const p = this.squares[ray[i]]
        if (p < 0) continue
        if (this.colorByPid[p] === byColor) {
          const t = this.typeByPid[p]
          if (t === PT_BISHOP || t === PT_QUEEN) return true
        }
        break
      }
    }

    return false
  }

  isSquareAttacked(sq: number, byColor: number): boolean {
    if (this.fireRem[byColor * NUM_SQUARES + sq] > 0) return true
    return this.isSquareAttackedByPieces(sq, byColor)
  }

  isInCheck(color: number): boolean {
    const kp = this.kingPid[color]
    if (kp < 0) return true
    const kSq = this.currSqByPid[kp]
    if (kSq < 0) return true
    return this.isSquareAttacked(kSq, color ^ 1)
  }

  /** Compute bitmask (5 words) of friendly pieces currently pinned to their King by enemy sliders. */
  computePinnedMask(color: number, outMask: Uint32Array): void {
    outMask.fill(0)
    const kp = this.kingPid[color]
    if (kp < 0) return
    const kSq = this.currSqByPid[kp]
    if (kSq < 0) return
    const enemy = color ^ 1

    for (let dir = 0; dir < 8; dir++) {
      const ray = RAY_SQUARES[dir][kSq]
      let allySq = -1
      for (let i = 0; i < ray.length; i++) {
        const rSq = ray[i]
        const p = this.squares[rSq]
        if (p < 0) continue
        if (this.colorByPid[p] === color) {
          if (allySq >= 0) break // 2 allies block ray
          allySq = rSq
        } else {
          if (allySq < 0) break // enemy first, no pin
          const t = this.typeByPid[p]
          const isOrtho = dir < 4
          const pins = isOrtho
            ? (t === PT_ROOK || t === PT_QUEEN || (t === PT_SHIELDER && i < 3))
            : (t === PT_BISHOP || t === PT_QUEEN)
          if (pins) {
            outMask[allySq >>> 5] |= (1 << (allySq & 31)) >>> 0
          }
          break
        }
      }
    }
  }

  private enPassantVictimPid(pawnPid: number, targetSq: number): number {
    if (this.epTargetSq !== targetSq || this.epPawnPid < 0) return -1
    if (this.typeByPid[pawnPid] !== PT_PAWN) return -1
    const fromSq = this.currSqByPid[pawnPid]
    if (fromSq < 0 || this.squares[targetSq] >= 0) return -1
    const fwd = this.colorByPid[pawnPid] === WHITE ? 1 : -1
    if (Math.abs(sqFile(targetSq) - sqFile(fromSq)) !== 1 || sqRank(targetSq) - sqRank(fromSq) !== fwd) return -1
    const adjSq = sqIndex(sqFile(targetSq), sqRank(fromSq))
    const adjPid = this.squares[adjSq]
    if (adjPid === this.epPawnPid && this.typeByPid[adjPid] === PT_PAWN && this.colorByPid[adjPid] !== this.colorByPid[pawnPid]) {
      return adjPid
    }
    return -1
  }

  private canCastle(color: number, side: number): boolean {
    const rightBit = color === WHITE
      ? (side === CASTLE_KINGSIDE ? CASTLE_WHITE_KING : CASTLE_WHITE_QUEEN)
      : (side === CASTLE_KINGSIDE ? CASTLE_BLACK_KING : CASTLE_BLACK_QUEEN)
    if ((this.castling & rightBit) === 0) return false

    const rank = color === WHITE ? 0 : BOARD_SIZE - 1
    const cfg = CASTLE_CFG[side]
    const kSq = sqIndex(6, rank)
    const rSq = sqIndex(cfg.rookFile, rank)
    const kingPid = this.squares[kSq]
    const rookPid = this.squares[rSq]
    if (kingPid < 0 || this.colorByPid[kingPid] !== color || this.typeByPid[kingPid] !== PT_KING || this.hasMovedByPid[kingPid]) return false
    if (rookPid < 0 || this.colorByPid[rookPid] !== color || this.typeByPid[rookPid] !== PT_ROOK ||
        this.baseTypeByPid[rookPid] !== PT_ROOK || this.hasMovedByPid[rookPid] || this.spawnSqByPid[rookPid] !== rSq) return false

    const clear = color === WHITE ? cfg.clearWhite : cfg.clearBlack
    for (let i = 0; i < clear.length; i++) {
      if (this.squares[clear[i]] >= 0) return false
    }
    const kingToSq = color === WHITE ? cfg.kingToWhite : cfg.kingToBlack
    if (this.isInCheck(color) || this.isHostileFire(kingToSq, color)) return false

    const transitSq = color === WHITE ? cfg.transitSqWhite : cfg.transitSqBlack
    // Simulate King temporarily on transitSq matching rules.ts lines 101-103
    this.squares[kSq] = -1
    this.squares[transitSq] = kingPid
    const transitSafe = !this.isSquareAttacked(transitSq, color ^ 1)
    this.squares[transitSq] = -1
    this.squares[kSq] = kingPid
    return transitSafe
  }

  /**
   * Generate pseudo-legal moves (or fully legal when checking EP/castling; caller verifies King safety after makeMove).
   * When `dedupeEquivalent` is true:
   * - Emits resurrections via only the first living Necromancer.
   * - Skips Dragon `before`/`after` timings that are canceled by a Shielder or have empty cones.
   */
  generatePseudoMoves(out: Int32Array, dedupeEquivalent = true, tacticalOnly = false): number {
    let count = 0
    const color = this.sideToMove
    const enemy = color ^ 1
    const fwd = color === WHITE ? 1 : -1
    const promoRank = color === WHITE ? BOARD_SIZE - 1 : 0
    let firstNecroUsed = false

    for (let pid = 0; pid < this.pieceCount; pid++) {
      if (this.colorByPid[pid] !== color) continue
      const sq = this.currSqByPid[pid]
      if (sq < 0) continue

      const type = this.typeByPid[pid]
      const f = sq % BOARD_SIZE
      const r = (sq / BOARD_SIZE) | 0

      if (type === PT_PAWN) {
        const oneRank = r + fwd
        if (oneRank >= 0 && oneRank < BOARD_SIZE) {
          const oneSq = oneRank * BOARD_SIZE + f
          if (this.squares[oneSq] < 0) {
            if (oneRank === promoRank) {
              for (let p = 0; p < 4; p++) {
                out[count++] = packMove(MOVE_KIND_PROMOTE, pid, sq, oneSq, PROMO_CODES[p], 0)
              }
            } else if (!tacticalOnly) {
              out[count++] = packMove(MOVE_KIND_NORMAL, pid, sq, oneSq, 0, 0)
              if (!this.hasMovedByPid[pid] && sq === this.spawnSqByPid[pid]) {
                const twoRank = oneRank + fwd
                if (twoRank >= 0 && twoRank < BOARD_SIZE) {
                  const twoSq = twoRank * BOARD_SIZE + f
                  if (this.squares[twoSq] < 0) {
                    out[count++] = packMove(MOVE_KIND_NORMAL, pid, sq, twoSq, 0, 0)
                  }
                }
              }
            }
          }

          // Captures
          const caps = PAWN_CAP_TARGETS[color][sq]
          for (let i = 0; i < caps.length; i++) {
            const cSq = caps[i]
            const target = this.squares[cSq]
            if (target >= 0) {
              if (this.colorByPid[target] !== color && this.typeByPid[target] !== PT_KING &&
                  !this.isFrontalShielderHit(sq, target)) {
                if (oneRank === promoRank) {
                  for (let p = 0; p < 4; p++) {
                    out[count++] = packMove(MOVE_KIND_PROMOTE, pid, sq, cSq, PROMO_CODES[p], 1)
                  }
                } else {
                  out[count++] = packMove(MOVE_KIND_NORMAL, pid, sq, cSq, 0, 1)
                }
              }
            } else if (this.epTargetSq === cSq && this.enPassantVictimPid(pid, cSq) >= 0) {
              out[count++] = packMove(MOVE_KIND_EP, pid, sq, cSq, 0, 1)
            }
          }
        }
        continue
      }

      if (type === PT_KNIGHT || type === PT_DRAGON) {
        const targets = KNIGHT_TARGETS[sq]
        const beforeHasEffect = type === PT_DRAGON && (!dedupeEquivalent ||
          (FIRE_CONE_SQUARES[color][sq].length > 0 && !this.hasAnyShielderInCone(color, sq) &&
           this.coneChangesFire(color, sq)))

        for (let i = 0; i < targets.length; i++) {
          const toSq = targets[i]
          const target = this.squares[toSq]
          if (target >= 0 && (this.colorByPid[target] === color || this.typeByPid[target] === PT_KING ||
              this.isFrontalShielderHit(sq, target))) continue

          const isCap = target >= 0 ? 1 : 0
          if (type === PT_KNIGHT) {
            if (!tacticalOnly || isCap) {
              out[count++] = packMove(MOVE_KIND_NORMAL, pid, sq, toSq, 0, isCap)
            }
          } else {
            // Dragon
            const afterHasEffect = !dedupeEquivalent ||
              (FIRE_CONE_SQUARES[color][toSq].length > 0 && !this.hasAnyShielderInCone(color, toSq))
            if (!tacticalOnly || isCap) {
              out[count++] = packMove(MOVE_KIND_DRAGON, pid, sq, toSq, DRAGON_TIMING_NONE, isCap)
            }
            if (afterHasEffect) {
              out[count++] = packMove(MOVE_KIND_DRAGON, pid, sq, toSq, DRAGON_TIMING_AFTER, isCap)
            }
            if (beforeHasEffect) {
              out[count++] = packMove(MOVE_KIND_DRAGON, pid, sq, toSq, DRAGON_TIMING_BEFORE, isCap)
            }
          }
        }
        continue
      }

      if (type === PT_KING || type === PT_NECROMANCER) {
        const targets = KING_TARGETS[sq]
        for (let i = 0; i < targets.length; i++) {
          const toSq = targets[i]
          const target = this.squares[toSq]
          if (target >= 0 && (this.colorByPid[target] === color || this.typeByPid[target] === PT_KING ||
              this.isFrontalShielderHit(sq, target))) continue
          const isCap = target >= 0 ? 1 : 0
          if (!tacticalOnly || isCap) {
            out[count++] = packMove(MOVE_KIND_NORMAL, pid, sq, toSq, 0, isCap)
          }
        }

        if (type === PT_NECROMANCER && (!dedupeEquivalent || !firstNecroUsed)) {
          firstNecroUsed = true
          if (!tacticalOnly) {
            for (let rPid = 0; rPid < this.pieceCount; rPid++) {
              if (this.colorByPid[rPid] !== color || this.currSqByPid[rPid] >= 0) continue
              const bType = this.baseTypeByPid[rPid]
              if (bType === PT_KING) continue
              if (this.quotasUsed[color * NUM_PIECE_TYPES + bType] >= QUOTA_LIMITS[bType]) continue
              const sSq = this.spawnSqByPid[rPid]
              if (this.squares[sSq] >= 0) continue
              out[count++] = packMove(MOVE_KIND_RESURRECT, pid, rPid, sSq, 0, 0)
            }
          }
        }
        continue
      }

      // Sliding pieces: Bishop, Rook, Queen, Shielder
      const startDir = type === PT_BISHOP ? 4 : 0
      const endDir = type === PT_ROOK || type === PT_SHIELDER ? 4 : 8
      const maxRange = type === PT_SHIELDER ? 3 : BOARD_SIZE - 1

      for (let dir = startDir; dir < endDir; dir++) {
        const ray = RAY_SQUARES[dir][sq]
        const limit = ray.length < maxRange ? ray.length : maxRange
        for (let i = 0; i < limit; i++) {
          const toSq = ray[i]
          const target = this.squares[toSq]
          if (target < 0) {
            if (!tacticalOnly) {
              out[count++] = packMove(MOVE_KIND_NORMAL, pid, sq, toSq, 0, 0)
            }
          } else {
            if (this.colorByPid[target] === enemy && this.typeByPid[target] !== PT_KING &&
                !this.isFrontalShielderHit(sq, target)) {
              out[count++] = packMove(MOVE_KIND_NORMAL, pid, sq, toSq, 0, 1)
            }
            break
          }
        }
      }
    }

    if (!tacticalOnly) {
      if (this.canCastle(color, CASTLE_KINGSIDE)) {
        const kSq = color === WHITE ? 6 : 138
        const kPid = this.squares[kSq]
        const toSq = color === WHITE ? 8 : 140
        out[count++] = packMove(MOVE_KIND_CASTLE, kPid, CASTLE_KINGSIDE, toSq, CASTLE_KINGSIDE, 0)
      }
      if (this.canCastle(color, CASTLE_QUEENSIDE)) {
        const kSq = color === WHITE ? 6 : 138
        const kPid = this.squares[kSq]
        const toSq = color === WHITE ? 4 : 136
        out[count++] = packMove(MOVE_KIND_CASTLE, kPid, CASTLE_QUEENSIDE, toSq, CASTLE_QUEENSIDE, 0)
      }
    }

    return count
  }

  private coneChangesFire(color: number, sq: number): boolean {
    const cone = FIRE_CONE_SQUARES[color][sq]
    const base = color * NUM_SQUARES
    for (let i = 0; i < cone.length; i++) {
      if (this.fireRem[base + cone[i]] < 2) return true
    }
    return false
  }

  private isFrontalShielderHit(attackerSq: number, targetPid: number): boolean {
    if (this.typeByPid[targetPid] !== PT_SHIELDER) return false
    const tSq = this.currSqByPid[targetPid]
    if ((attackerSq % BOARD_SIZE) !== (tSq % BOARD_SIZE)) return false
    const fwd = this.colorByPid[targetPid] === WHITE ? 1 : -1
    return (((attackerSq / BOARD_SIZE) | 0) - ((tSq / BOARD_SIZE) | 0)) * fwd > 0
  }

  private togglePieceHash(pid: number) {
    const sq = this.currSqByPid[pid]
    const slot = sq >= 0 ? sq : GRAVEYARD_SLOT
    const zIdx = pieceZobristIndex(pid, slot, this.baseTypeByPid[pid], this.typeByPid[pid], this.hasMovedByPid[pid])
    this.hashLo = (this.hashLo ^ getPieceLo(zIdx)) >>> 0
    this.hashHi = (this.hashHi ^ getPieceHi(zIdx)) >>> 0
  }

  private toggleStructHash(color: number, type: number, sq: number) {
    if (!isStructuralType(type)) return
    const pIdx = pawnStructIndex(color, type, sq)
    this.pawnHashLo = (this.pawnHashLo ^ getPawnStructLo(pIdx)) >>> 0
    this.pawnHashHi = (this.pawnHashHi ^ getPawnStructHi(pIdx)) >>> 0
  }

  private loseRookCastling(pid: number) {
    if (this.baseTypeByPid[pid] !== PT_ROOK) return
    const c = this.colorByPid[pid]
    const sSq = this.spawnSqByPid[pid]
    const homeRank = c === WHITE ? 0 : BOARD_SIZE - 1
    if (((sSq / BOARD_SIZE) | 0) !== homeRank) return
    const file = sSq % BOARD_SIZE
    if (file === 0) this.castling &= ~(c === WHITE ? CASTLE_WHITE_QUEEN : CASTLE_BLACK_QUEEN)
    else if (file === 11) this.castling &= ~(c === WHITE ? CASTLE_WHITE_KING : CASTLE_BLACK_KING)
  }

  private removePiece(pid: number) {
    const sq = this.currSqByPid[pid]
    const c = this.colorByPid[pid]
    const t = this.typeByPid[pid]
    this.togglePieceHash(pid)
    this.toggleStructHash(c, t, sq)
    this.clearOccupantBits(c, t, sq)
    this.squares[sq] = -1
    this.currSqByPid[pid] = -1
    this.mgScore[c] -= MG_VALUES[t] + pstMg(c, t, sq)
    this.egScore[c] -= EG_VALUES[t] + pstEg(c, t, sq)
    this.phase -= PHASE_WEIGHTS[t]
    this.togglePieceHash(pid) // now in graveyard slot
    if (this.epPawnPid === pid) {
      this.epTargetSq = -1
      this.epPawnPid = -1
    }
    this.loseRookCastling(pid)
  }

  private restoreCapturedPiece(pid: number, sq: number) {
    const c = this.colorByPid[pid]
    const t = this.typeByPid[pid]
    this.squares[sq] = pid
    this.currSqByPid[pid] = sq
    this.setOccupantBits(c, t, sq)
    this.mgScore[c] += MG_VALUES[t] + pstMg(c, t, sq)
    this.egScore[c] += EG_VALUES[t] + pstEg(c, t, sq)
    this.phase += PHASE_WEIGHTS[t]
  }

  private moveAlivePiece(pid: number, toSq: number, newType?: number, setPromoted?: boolean) {
    const fromSq = this.currSqByPid[pid]
    const c = this.colorByPid[pid]
    const oldType = this.typeByPid[pid]
    const nextType = newType ?? oldType

    this.togglePieceHash(pid)
    this.toggleStructHash(c, oldType, fromSq)
    this.clearOccupantBits(c, oldType, fromSq)
    this.mgScore[c] -= MG_VALUES[oldType] + pstMg(c, oldType, fromSq)
    this.egScore[c] -= EG_VALUES[oldType] + pstEg(c, oldType, fromSq)
    this.phase -= PHASE_WEIGHTS[oldType]

    this.squares[fromSq] = -1
    this.squares[toSq] = pid
    this.currSqByPid[pid] = toSq
    this.hasMovedByPid[pid] = 1
    if (newType !== undefined) this.typeByPid[pid] = nextType
    if (setPromoted) this.promotedByPid[pid] = 1

    this.setOccupantBits(c, nextType, toSq)
    this.mgScore[c] += MG_VALUES[nextType] + pstMg(c, nextType, toSq)
    this.egScore[c] += EG_VALUES[nextType] + pstEg(c, nextType, toSq)
    this.phase += PHASE_WEIGHTS[nextType]
    this.toggleStructHash(c, nextType, toSq)
    this.togglePieceHash(pid)

    this.loseRookCastling(pid)
    if (oldType === PT_KING) {
      this.castling &= ~(c === WHITE ? (CASTLE_WHITE_KING | CASTLE_WHITE_QUEEN) : (CASTLE_BLACK_KING | CASTLE_BLACK_QUEEN))
    }
  }

  private setFireCell(owner: number, sq: number, newRem: number, undo: UndoRecord) {
    const idx = owner * NUM_SQUARES + sq
    const prevRem = this.fireRem[idx]
    if (prevRem === newRem) return

    // Record only first modification of this idx in this turn
    let seen = false
    for (let i = 0; i < undo.fireDeltaCount; i++) {
      if (undo.fireDeltas[i].idx === idx) { seen = true; break }
    }
    if (!seen) {
      const slot = undo.fireDeltas[undo.fireDeltaCount++]
      slot.idx = idx
      slot.prevRem = prevRem
    }

    if (prevRem > 0) {
      const fkOld = idx * MAX_FIRE_TURNS + Math.min(prevRem, MAX_FIRE_TURNS - 1)
      this.hashLo = (this.hashLo ^ FIRE_KEY_LO[fkOld]) >>> 0
      this.hashHi = (this.hashHi ^ FIRE_KEY_HI[fkOld]) >>> 0
      this.activeFireCount--
      if (prevRem === 1) this.imminentFireCount--
    }
    this.fireRem[idx] = newRem
    const word = owner * 5 + (sq >>> 5)
    const bit = (1 << (sq & 31)) >>> 0
    if (newRem > 0) {
      const fkNew = idx * MAX_FIRE_TURNS + Math.min(newRem, MAX_FIRE_TURNS - 1)
      this.hashLo = (this.hashLo ^ FIRE_KEY_LO[fkNew]) >>> 0
      this.hashHi = (this.hashHi ^ FIRE_KEY_HI[fkNew]) >>> 0
      this.fireMask[word] |= bit
      this.activeFireCount++
      if (newRem === 1) this.imminentFireCount++
    } else {
      this.fireMask[word] &= ~bit
    }
  }

  private igniteFrom(dragonColor: number, originSq: number, undo: UndoRecord) {
    if (this.hasAnyShielderInCone(dragonColor, originSq)) return
    const cone = FIRE_CONE_SQUARES[dragonColor][originSq]
    for (let i = 0; i < cone.length; i++) {
      this.setFireCell(dragonColor, cone[i], 2, undo)
    }
  }

  private expireAllFire(undo: UndoRecord): boolean {
    if (this.activeFireCount === 0) return false
    let burnedAny = false

    for (let owner = 0; owner < 2; owner++) {
      const baseWord = owner * 5
      for (let w = 0; w < 5; w++) {
        let mask = this.fireMask[baseWord + w]
        while (mask !== 0) {
          const lsb = mask & -mask
          const bitIdx = 31 - Math.clz32(lsb)
          mask ^= lsb
          const sq = (w << 5) + bitIdx
          const idx = owner * NUM_SQUARES + sq
          const rem = this.fireRem[idx]
          if (rem === 1) {
            this.setFireCell(owner, sq, 0, undo)
            const pid = this.squares[sq]
            if (pid >= 0 && this.colorByPid[pid] !== owner) {
              const t = this.typeByPid[pid]
              if (t !== PT_KING && t !== PT_SHIELDER) {
                const b = undo.burns[undo.burnCount++]
                b.pid = pid
                b.sq = sq
                this.removePiece(pid)
                burnedAny = true
              }
            }
          } else if (rem > 1) {
            this.setFireCell(owner, sq, rem - 1, undo)
          }
        }
      }
    }
    return burnedAny
  }

  private refreshEpHash() {
    this.epHashActive = 0
    if (this.epTargetSq < 0 || this.epPawnPid < 0) return
    if (this.epScratchChecked) return

    const color = this.sideToMove
    const enemy = color ^ 1
    const orig = PAWN_ATTACKER_ORIGINS[color][this.epTargetSq]
    let hasLegal = false

    this.epScratchChecked = true
    for (let i = 0; i < orig.length; i++) {
      const sq = orig[i]
      const pawnPid = this.squares[sq]
      if (pawnPid < 0 || this.colorByPid[pawnPid] !== color || this.typeByPid[pawnPid] !== PT_PAWN) continue
      const victimPid = this.enPassantVictimPid(pawnPid, this.epTargetSq)
      if (victimPid < 0) continue

      const epMove = packMove(MOVE_KIND_EP, pawnPid, sq, this.epTargetSq, 0, 1)
      this.makeMove(epMove)
      const ok = !this.isInCheck(color)
      this.unmakeMove()
      if (ok) {
        hasLegal = true
        break
      }
    }
    this.epScratchChecked = false

    // Also satisfy unused warning if enemy check needed
    void enemy
    if (hasLegal) {
      this.epHashActive = 1
      this.hashLo = (this.hashLo ^ EP_SQ_KEY_LO[this.epTargetSq] ^ EP_PAWN_KEY_LO[this.epPawnPid]) >>> 0
      this.hashHi = (this.hashHi ^ EP_SQ_KEY_HI[this.epTargetSq] ^ EP_PAWN_KEY_HI[this.epPawnPid]) >>> 0
    }
  }

  /** Execute move on FastBoard. Does NOT verify post-move King safety (caller checks !board.isInCheck(moverColor)). */
  makeMove(move: number): void {
    const undo = this.undoStack[this.ply++]
    undo.move = move
    undo.castling = this.castling
    undo.epTargetSq = this.epTargetSq
    undo.epPawnPid = this.epPawnPid
    undo.epHashActive = this.epHashActive
    undo.halfMoveClock = this.halfMoveClock
    undo.hashLo = this.hashLo
    undo.hashHi = this.hashHi
    undo.pawnHashLo = this.pawnHashLo
    undo.pawnHashHi = this.pawnHashHi
    undo.mgWhite = this.mgScore[0]
    undo.mgBlack = this.mgScore[1]
    undo.egWhite = this.egScore[0]
    undo.egBlack = this.egScore[1]
    undo.phase = this.phase
    undo.capturedPid = -1
    undo.capturedSq = -1
    undo.rookPid = -1
    undo.fireDeltaCount = 0
    undo.burnCount = 0

    // Remove old EP and castling hashes
    if (this.epHashActive) {
      this.hashLo = (this.hashLo ^ EP_SQ_KEY_LO[this.epTargetSq] ^ EP_PAWN_KEY_LO[this.epPawnPid]) >>> 0
      this.hashHi = (this.hashHi ^ EP_SQ_KEY_HI[this.epTargetSq] ^ EP_PAWN_KEY_HI[this.epPawnPid]) >>> 0
    }
    this.hashLo = (this.hashLo ^ CASTLING_KEY_LO[this.castling]) >>> 0
    this.hashHi = (this.hashHi ^ CASTLING_KEY_HI[this.castling]) >>> 0
    const prevEpPawnPid = this.epPawnPid
    const prevEpTarget = this.epTargetSq
    this.epTargetSq = -1
    this.epPawnPid = -1
    this.epHashActive = 0

    const kind = moveKind(move)
    const color = this.sideToMove
    const actorPid = moveActorPid(move)
    let resetsHalfMove = false

    if (kind === MOVE_KIND_RESURRECT) {
      const revivedPid = moveFromOrRevived(move)
      const spawnSq = this.spawnSqByPid[revivedPid]
      const bType = this.baseTypeByPid[revivedPid]
      undo.revivedPrevHasMoved = this.hasMovedByPid[revivedPid]
      undo.revivedPrevType = this.typeByPid[revivedPid]
      undo.revivedPrevPromoted = this.promotedByPid[revivedPid]

      this.togglePieceHash(revivedPid) // remove from graveyard
      this.squares[spawnSq] = revivedPid
      this.currSqByPid[revivedPid] = spawnSq
      this.typeByPid[revivedPid] = bType
      this.promotedByPid[revivedPid] = 0
      this.setOccupantBits(color, bType, spawnSq)
      this.mgScore[color] += MG_VALUES[bType] + pstMg(color, bType, spawnSq)
      this.egScore[color] += EG_VALUES[bType] + pstEg(color, bType, spawnSq)
      this.phase += PHASE_WEIGHTS[bType]
      this.toggleStructHash(color, bType, spawnSq)
      this.togglePieceHash(revivedPid) // add at spawnSq

      const qIdx = color * NUM_PIECE_TYPES + bType
      const prevUsed = this.quotasUsed[qIdx]
      const kOld = qIdx * 4 + prevUsed
      const kNew = qIdx * 4 + prevUsed + 1
      this.quotasUsed[qIdx] = prevUsed + 1
      this.hashLo = (this.hashLo ^ QUOTA_KEY_LO[kOld] ^ QUOTA_KEY_LO[kNew]) >>> 0
      this.hashHi = (this.hashHi ^ QUOTA_KEY_HI[kOld] ^ QUOTA_KEY_HI[kNew]) >>> 0
      if (bType === PT_NECROMANCER || bType === PT_PAWN) {
        this.pawnHashLo = (this.pawnHashLo ^ QUOTA_KEY_LO[kOld] ^ QUOTA_KEY_LO[kNew]) >>> 0
        this.pawnHashHi = (this.pawnHashHi ^ QUOTA_KEY_HI[kOld] ^ QUOTA_KEY_HI[kNew]) >>> 0
      }
      resetsHalfMove = true
    } else if (kind === MOVE_KIND_CASTLE) {
      const side = moveAux(move)
      const rank = color === WHITE ? 0 : BOARD_SIZE - 1
      const cfg = CASTLE_CFG[side]
      const rookSq = sqIndex(cfg.rookFile, rank)
      const rookPid = this.squares[rookSq]
      const kingToSq = color === WHITE ? cfg.kingToWhite : cfg.kingToBlack
      const rookToSq = color === WHITE ? cfg.transitSqWhite : cfg.transitSqBlack

      undo.actorPrevHasMoved = this.hasMovedByPid[actorPid]
      undo.actorPrevType = PT_KING
      undo.actorPrevPromoted = this.promotedByPid[actorPid]
      undo.rookPid = rookPid
      undo.rookPrevHasMoved = this.hasMovedByPid[rookPid]

      this.moveAlivePiece(actorPid, kingToSq)
      this.moveAlivePiece(rookPid, rookToSq)
    } else {
      const fromSq = moveFromOrRevived(move)
      const toSq = moveToSq(move)
      const aux = moveAux(move)

      undo.actorPrevHasMoved = this.hasMovedByPid[actorPid]
      undo.actorPrevType = this.typeByPid[actorPid]
      undo.actorPrevPromoted = this.promotedByPid[actorPid]
      if (undo.actorPrevType === PT_PAWN) resetsHalfMove = true

      if (kind === MOVE_KIND_DRAGON && aux === DRAGON_TIMING_BEFORE) {
        this.igniteFrom(color, fromSq, undo)
      }

      if (kind === MOVE_KIND_EP) {
        const victimSq = sqIndex(sqFile(toSq), sqRank(fromSq))
        undo.capturedPid = prevEpPawnPid
        undo.capturedSq = victimSq
        this.removePiece(prevEpPawnPid)
        resetsHalfMove = true
      } else {
        const target = this.squares[toSq]
        if (target >= 0) {
          undo.capturedPid = target
          undo.capturedSq = toSq
          this.removePiece(target)
          resetsHalfMove = true
        }
      }

      if (kind === MOVE_KIND_PROMOTE) {
        this.moveAlivePiece(actorPid, toSq, aux, true)
      } else {
        this.moveAlivePiece(actorPid, toSq)
      }

      if (undo.actorPrevType === PT_PAWN && Math.abs(sqRank(toSq) - sqRank(fromSq)) === 2) {
        const fwd = color === WHITE ? 1 : -1
        this.epTargetSq = sqIndex(sqFile(toSq), sqRank(toSq) - fwd)
        this.epPawnPid = actorPid
      }

      if (kind === MOVE_KIND_DRAGON && aux === DRAGON_TIMING_AFTER) {
        this.igniteFrom(color, toSq, undo)
      }
    }

    // Silence unused prevEpTarget lint
    void prevEpTarget

    if (this.expireAllFire(undo)) {
      resetsHalfMove = true
    }

    this.halfMoveClock = resetsHalfMove ? 0 : this.halfMoveClock + 1
    this.sideToMove = (color ^ 1) as 0 | 1
    this.hashLo = (this.hashLo ^ SIDE_KEY_LO ^ CASTLING_KEY_LO[this.castling]) >>> 0
    this.hashHi = (this.hashHi ^ SIDE_KEY_HI ^ CASTLING_KEY_HI[this.castling]) >>> 0
    if (!this.epScratchChecked) this.refreshEpHash()
  }

  unmakeMove(): void {
    const undo = this.undoStack[--this.ply]
    const move = undo.move
    const kind = moveKind(move)
    const color = (this.sideToMove ^ 1) as 0 | 1

    // 1. Restore fire cells first
    for (let i = undo.fireDeltaCount - 1; i >= 0; i--) {
      const { idx, prevRem } = undo.fireDeltas[i]
      const owner = (idx / NUM_SQUARES) | 0
      const sq = idx % NUM_SQUARES
      const currRem = this.fireRem[idx]
      if (currRem > 0) {
        this.activeFireCount--
        if (currRem === 1) this.imminentFireCount--
      }
      this.fireRem[idx] = prevRem
      const word = owner * 5 + (sq >>> 5)
      const bit = (1 << (sq & 31)) >>> 0
      if (prevRem > 0) {
        this.fireMask[word] |= bit
        this.activeFireCount++
        if (prevRem === 1) this.imminentFireCount++
      } else {
        this.fireMask[word] &= ~bit
      }
    }

    // 2. Restore fire-burned pieces
    for (let i = undo.burnCount - 1; i >= 0; i--) {
      const { pid, sq } = undo.burns[i]
      this.restoreCapturedPiece(pid, sq)
    }

    // 3. Reverse action
    const actorPid = moveActorPid(move)
    if (kind === MOVE_KIND_RESURRECT) {
      const revivedPid = moveFromOrRevived(move)
      const spawnSq = this.spawnSqByPid[revivedPid]
      const bType = this.baseTypeByPid[revivedPid]
      this.clearOccupantBits(color, bType, spawnSq)
      this.squares[spawnSq] = -1
      this.currSqByPid[revivedPid] = -1
      this.hasMovedByPid[revivedPid] = undo.revivedPrevHasMoved
      this.typeByPid[revivedPid] = undo.revivedPrevType
      this.promotedByPid[revivedPid] = undo.revivedPrevPromoted
      this.quotasUsed[color * NUM_PIECE_TYPES + bType]--
    } else if (kind === MOVE_KIND_CASTLE) {
      const side = moveAux(move)
      const rank = color === WHITE ? 0 : BOARD_SIZE - 1
      const cfg = CASTLE_CFG[side]
      const kingFromSq = sqIndex(6, rank)
      const rookFromSq = sqIndex(cfg.rookFile, rank)
      const kingToSq = color === WHITE ? cfg.kingToWhite : cfg.kingToBlack
      const rookToSq = color === WHITE ? cfg.transitSqWhite : cfg.transitSqBlack

      this.clearOccupantBits(color, PT_KING, kingToSq)
      this.squares[kingToSq] = -1
      this.squares[kingFromSq] = actorPid
      this.currSqByPid[actorPid] = kingFromSq
      this.hasMovedByPid[actorPid] = undo.actorPrevHasMoved
      this.setOccupantBits(color, PT_KING, kingFromSq)

      const rookPid = undo.rookPid
      this.clearOccupantBits(color, PT_ROOK, rookToSq)
      this.squares[rookToSq] = -1
      this.squares[rookFromSq] = rookPid
      this.currSqByPid[rookPid] = rookFromSq
      this.hasMovedByPid[rookPid] = undo.rookPrevHasMoved
      this.setOccupantBits(color, PT_ROOK, rookFromSq)
    } else {
      const fromSq = moveFromOrRevived(move)
      const toSq = moveToSq(move)
      const curType = this.typeByPid[actorPid]

      this.clearOccupantBits(color, curType, toSq)
      this.squares[toSq] = -1
      this.squares[fromSq] = actorPid
      this.currSqByPid[actorPid] = fromSq
      this.hasMovedByPid[actorPid] = undo.actorPrevHasMoved
      this.typeByPid[actorPid] = undo.actorPrevType
      this.promotedByPid[actorPid] = undo.actorPrevPromoted
      this.setOccupantBits(color, undo.actorPrevType, fromSq)

      if (undo.capturedPid >= 0) {
        this.restoreCapturedPiece(undo.capturedPid, undo.capturedSq)
      }
    }

    // 4. Restore scalars & accumulators
    this.sideToMove = color
    this.castling = undo.castling
    this.epTargetSq = undo.epTargetSq
    this.epPawnPid = undo.epPawnPid
    this.epHashActive = undo.epHashActive
    this.halfMoveClock = undo.halfMoveClock
    this.hashLo = undo.hashLo
    this.hashHi = undo.hashHi
    this.pawnHashLo = undo.pawnHashLo
    this.pawnHashHi = undo.pawnHashHi
    this.mgScore[0] = undo.mgWhite
    this.mgScore[1] = undo.mgBlack
    this.egScore[0] = undo.egWhite
    this.egScore[1] = undo.egBlack
    this.phase = undo.phase
  }

  /** Null move ONLY safe when activeFireCount === 0! */
  makeNullMove(): void {
    const undo = this.undoStack[this.ply++]
    undo.epTargetSq = this.epTargetSq
    undo.epPawnPid = this.epPawnPid
    undo.epHashActive = this.epHashActive
    undo.halfMoveClock = this.halfMoveClock
    undo.hashLo = this.hashLo
    undo.hashHi = this.hashHi

    if (this.epHashActive) {
      this.hashLo = (this.hashLo ^ EP_SQ_KEY_LO[this.epTargetSq] ^ EP_PAWN_KEY_LO[this.epPawnPid]) >>> 0
      this.hashHi = (this.hashHi ^ EP_SQ_KEY_HI[this.epTargetSq] ^ EP_PAWN_KEY_HI[this.epPawnPid]) >>> 0
    }
    this.epTargetSq = -1
    this.epPawnPid = -1
    this.epHashActive = 0
    this.halfMoveClock++
    this.sideToMove = (this.sideToMove ^ 1) as 0 | 1
    this.hashLo = (this.hashLo ^ SIDE_KEY_LO) >>> 0
    this.hashHi = (this.hashHi ^ SIDE_KEY_HI) >>> 0
  }

  unmakeNullMove(): void {
    const undo = this.undoStack[--this.ply]
    this.sideToMove = (this.sideToMove ^ 1) as 0 | 1
    this.epTargetSq = undo.epTargetSq
    this.epPawnPid = undo.epPawnPid
    this.epHashActive = undo.epHashActive
    this.halfMoveClock = undo.halfMoveClock
    this.hashLo = undo.hashLo
    this.hashHi = undo.hashHi
  }

  isBareKings(): boolean {
    for (let pid = 0; pid < this.pieceCount; pid++) {
      if (this.currSqByPid[pid] >= 0 && this.typeByPid[pid] !== PT_KING) return false
    }
    return true
  }

  hasNonPawnMaterial(color: number): boolean {
    const base = color * NUM_PIECE_TYPES * 5
    for (let t = 0; t < NUM_PIECE_TYPES; t++) {
      if (t === PT_PAWN || t === PT_KING) continue
      const off = base + t * 5
      if (this.occType[off] | this.occType[off + 1] | this.occType[off + 2] | this.occType[off + 3] | this.occType[off + 4]) {
        return true
      }
    }
    return false
  }

  nonPawnMaterialValue(color: number): number {
    let total = 0
    for (let pid = 0; pid < this.pieceCount; pid++) {
      if (this.colorByPid[pid] === color && this.currSqByPid[pid] >= 0) {
        const t = this.typeByPid[pid]
        if (t !== PT_PAWN && t !== PT_KING) total += MG_VALUES[t]
      }
    }
    return total
  }

  /** Produce the exact same string format as `positionKey(state)` in `src/engine/rules.ts` for exact pre-root repetition matching. */
  toPositionKeyString(): string {
    const player = this.sideToMove === WHITE ? 'white' : 'black'
    const castling = [
      [(this.castling & CASTLE_WHITE_KING) !== 0, (this.castling & CASTLE_WHITE_QUEEN) !== 0],
      [(this.castling & CASTLE_BLACK_KING) !== 0, (this.castling & CASTLE_BLACK_QUEEN) !== 0],
    ]
    const ep = this.epHashActive && this.epTargetSq >= 0 && this.epPawnPid >= 0
      ? [sqFile(this.epTargetSq), sqRank(this.epTargetSq), this.idByPid[this.epPawnPid]]
      : null

    const pieces = new Array(this.pieceCount)
    const graveWhite: string[] = []
    const graveBlack: string[] = []
    for (let pid = 0; pid < this.pieceCount; pid++) {
      const c = this.colorByPid[pid]
      const cName = c === WHITE ? 'white' : 'black'
      const sq = this.currSqByPid[pid]
      const sSq = this.spawnSqByPid[pid]
      if (sq < 0) {
        if (c === WHITE) graveWhite.push(this.idByPid[pid])
        else graveBlack.push(this.idByPid[pid])
      }
      pieces[pid] = [
        this.idByPid[pid],
        cName,
        PIECE_TYPE_FROM_CODE[this.baseTypeByPid[pid]],
        PIECE_TYPE_FROM_CODE[this.typeByPid[pid]],
        sqFile(sSq),
        sqRank(sSq),
        sq >= 0 ? [sqFile(sq), sqRank(sq)] : null,
        this.baseTypeByPid[pid] === PT_PAWN && this.hasMovedByPid[pid] !== 0,
      ]
    }
    graveWhite.sort()
    graveBlack.sort()

    const quotaOrder = [PT_QUEEN, PT_ROOK, PT_BISHOP, PT_KNIGHT, PT_NECROMANCER, PT_DRAGON, PT_SHIELDER, PT_PAWN]
    const quotas = [
      quotaOrder.map(t => this.quotasUsed[WHITE * NUM_PIECE_TYPES + t]),
      quotaOrder.map(t => this.quotasUsed[BLACK * NUM_PIECE_TYPES + t]),
    ]

    const activeFire: [string, number, number, number][] = []
    for (let owner = 0; owner < 2; owner++) {
      const ownerName = owner === WHITE ? 'white' : 'black'
      for (let sq = 0; sq < NUM_SQUARES; sq++) {
        const rem = this.fireRem[owner * NUM_SQUARES + sq]
        if (rem > 0) activeFire.push([ownerName, sqFile(sq), sqRank(sq), rem])
      }
    }
    activeFire.sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0].localeCompare(b[0]))

    return JSON.stringify([player, castling, ep, pieces, [graveWhite, graveBlack], quotas, activeFire])
  }

  decodeAction(move: number): Action {
    const kind = moveKind(move)
    const actorPid = moveActorPid(move)
    if (kind === MOVE_KIND_CASTLE) {
      const side: CastleSide = moveAux(move) === CASTLE_KINGSIDE ? 'kingSide' : 'queenSide'
      return { kind: 'castle', side }
    }
    if (kind === MOVE_KIND_RESURRECT) {
      return {
        kind: 'resurrect',
        necromancerId: this.idByPid[actorPid],
        revivedPieceId: this.idByPid[moveFromOrRevived(move)],
      }
    }
    const toSq = moveToSq(move)
    const destination = { file: sqFile(toSq), rank: sqRank(toSq) }
    if (kind === MOVE_KIND_DRAGON) {
      return {
        kind: 'dragon',
        pieceId: this.idByPid[actorPid],
        destination,
        fireTiming: TIMING_NAMES[moveAux(move)],
      }
    }
    if (kind === MOVE_KIND_PROMOTE) {
      return {
        kind: 'move',
        pieceId: this.idByPid[actorPid],
        destination,
        promotion: PIECE_TYPE_FROM_CODE[moveAux(move)] as PromotionType,
      }
    }
    return {
      kind: 'move',
      pieceId: this.idByPid[actorPid],
      destination,
    }
  }

  encodeAction(action: Action): number {
    if (action.kind === 'castle') {
      const side = action.side === 'kingSide' ? CASTLE_KINGSIDE : CASTLE_QUEENSIDE
      const kPid = this.kingPid[this.sideToMove]
      const toSq = this.sideToMove === WHITE
        ? (side === CASTLE_KINGSIDE ? 8 : 4)
        : (side === CASTLE_KINGSIDE ? 140 : 136)
      return packMove(MOVE_KIND_CASTLE, kPid, side, toSq, side, 0)
    }
    if (action.kind === 'resurrect') {
      const actorPid = this.idByPid.indexOf(action.necromancerId)
      const revPid = this.idByPid.indexOf(action.revivedPieceId)
      if (actorPid < 0 || revPid < 0) return 0
      return packMove(MOVE_KIND_RESURRECT, actorPid, revPid, this.spawnSqByPid[revPid], 0, 0)
    }
    const actorPid = this.idByPid.indexOf(action.pieceId)
    if (actorPid < 0) return 0
    const fromSq = this.currSqByPid[actorPid]
    const toSq = sqIndex(action.destination.file, action.destination.rank)
    if (fromSq < 0) return 0
    if (action.kind === 'dragon') {
      const timing = action.fireTiming === 'none' ? DRAGON_TIMING_NONE
        : action.fireTiming === 'after' ? DRAGON_TIMING_AFTER : DRAGON_TIMING_BEFORE
      const isCap = this.squares[toSq] >= 0 ? 1 : 0
      return packMove(MOVE_KIND_DRAGON, actorPid, fromSq, toSq, timing, isCap)
    }
    if (action.promotion) {
      const promoCode = CODE_FROM_PIECE_TYPE[action.promotion]
      const isCap = this.squares[toSq] >= 0 ? 1 : 0
      return packMove(MOVE_KIND_PROMOTE, actorPid, fromSq, toSq, promoCode, isCap)
    }
    if (this.typeByPid[actorPid] === PT_PAWN && this.epTargetSq === toSq && this.squares[toSq] < 0) {
      return packMove(MOVE_KIND_EP, actorPid, fromSq, toSq, 0, 1)
    }
    const isCap = this.squares[toSq] >= 0 ? 1 : 0
    return packMove(MOVE_KIND_NORMAL, actorPid, fromSq, toSq, 0, isCap)
  }

  hasLegalMoves(): boolean {
    const buf = new Int32Array(256)
    const n = this.generatePseudoMoves(buf, true, false)
    const mover = this.sideToMove
    for (let i = 0; i < n; i++) {
      this.makeMove(buf[i])
      const ok = !this.isInCheck(mover)
      this.unmakeMove()
      if (ok) return true
    }
    return false
  }
}

export { PROMOTION_TYPES }
