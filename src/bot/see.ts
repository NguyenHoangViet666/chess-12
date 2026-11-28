import { BOARD_SIZE } from '../engine/model'
import {
  FastBoard, KING_TARGETS, KNIGHT_TARGETS, MOVE_KIND_CASTLE, MOVE_KIND_EP,
  MOVE_KIND_PROMOTE, MOVE_KIND_RESURRECT, PAWN_ATTACKER_ORIGINS, RAY_SQUARES,
  moveActorPid, moveAux, moveFromOrRevived, moveKind, moveToSq, sqFile, sqRank,
} from './fastBoard'
import { MG_VALUES } from './pst'
import {
  PT_BISHOP, PT_DRAGON, PT_KING, PT_KNIGHT, PT_NECROMANCER, PT_PAWN,
  PT_QUEEN, PT_ROOK, PT_SHIELDER, WHITE,
} from './zobrist'

// SEE value order: Pawn < Knight < Bishop < Necromancer < Shielder < Rook < Dragon < Queen < King
const SEE_VALUES = new Int32Array([
  100,   // pawn
  320,   // knight
  370,   // bishop
  550,   // rook
  1060,  // queen
  20000, // king
  385,   // necromancer
  620,   // dragon
  390,   // shielder
])

const SEE_ORDER = [
  PT_PAWN,
  PT_KNIGHT,
  PT_BISHOP,
  PT_NECROMANCER,
  PT_SHIELDER,
  PT_ROOK,
  PT_DRAGON,
  PT_QUEEN,
  PT_KING,
] as const

const usedBits = new Uint32Array(5)
const gain = new Int32Array(32)

function isUsed(sq: number): boolean {
  return (usedBits[sq >>> 5] & ((1 << (sq & 31)) >>> 0)) !== 0
}

function markUsed(sq: number): void {
  usedBits[sq >>> 5] |= (1 << (sq & 31)) >>> 0
}

function isFrontalBlocked(b: FastBoard, attackerSq: number, targetType: number, targetColor: number, toSq: number): boolean {
  if (targetType !== PT_SHIELDER) return false
  if (sqFile(attackerSq) !== sqFile(toSq)) return false
  const fwd = targetColor === WHITE ? 1 : -1
  return (sqRank(attackerSq) - sqRank(toSq)) * fwd > 0
}

function leastValuableAttacker(
  b: FastBoard, toSq: number, side: number, targetType: number, targetColor: number,
): { pid: number; sq: number; type: number } | null {
  // 1. Pawns
  const pOrigins = PAWN_ATTACKER_ORIGINS[side][toSq]
  for (let i = 0; i < pOrigins.length; i++) {
    const sq = pOrigins[i]
    if (isUsed(sq)) continue
    const pid = b.squares[sq]
    if (pid >= 0 && b.colorByPid[pid] === side && b.typeByPid[pid] === PT_PAWN) {
      return { pid, sq, type: PT_PAWN }
    }
  }

  // 2. Knights (cheaper than Dragon)
  const kTargets = KNIGHT_TARGETS[toSq]
  for (let i = 0; i < kTargets.length; i++) {
    const sq = kTargets[i]
    if (isUsed(sq)) continue
    const pid = b.squares[sq]
    if (pid >= 0 && b.colorByPid[pid] === side && b.typeByPid[pid] === PT_KNIGHT) {
      return { pid, sq, type: PT_KNIGHT }
    }
  }

  // Track ray sliders discovered along rays so we pick the lowest SEE_ORDER type
  let bestPid = -1
  let bestSq = -1
  let bestType = 99
  let bestOrderVal = 999999

  // 3. Necromancer (1-step adjacent)
  const aTargets = KING_TARGETS[toSq]
  for (let i = 0; i < aTargets.length; i++) {
    const sq = aTargets[i]
    if (isUsed(sq)) continue
    const pid = b.squares[sq]
    if (pid < 0 || b.colorByPid[pid] !== side) continue
    const t = b.typeByPid[pid]
    if (t === PT_NECROMANCER && !isFrontalBlocked(b, sq, targetType, targetColor, toSq)) {
      if (SEE_VALUES[t] < bestOrderVal) {
        bestOrderVal = SEE_VALUES[t]
        bestPid = pid
        bestSq = sq
        bestType = t
      }
    } else if (t === PT_KING && !isFrontalBlocked(b, sq, targetType, targetColor, toSq)) {
      if (SEE_VALUES[t] < bestOrderVal) {
        bestOrderVal = SEE_VALUES[t]
        bestPid = pid
        bestSq = sq
        bestType = t
      }
    }
  }

  // 4. Dragons (knight jump)
  for (let i = 0; i < kTargets.length; i++) {
    const sq = kTargets[i]
    if (isUsed(sq)) continue
    const pid = b.squares[sq]
    if (pid >= 0 && b.colorByPid[pid] === side && b.typeByPid[pid] === PT_DRAGON) {
      if (SEE_VALUES[PT_DRAGON] < bestOrderVal) {
        bestOrderVal = SEE_VALUES[PT_DRAGON]
        bestPid = pid
        bestSq = sq
        bestType = PT_DRAGON
      }
    }
  }

  // 5. Orthogonal rays (Rook, Queen, Shielder <= 3) passing through used squares (X-ray!)
  for (let dir = 0; dir < 4; dir++) {
    const ray = RAY_SQUARES[dir][toSq]
    for (let i = 0; i < ray.length; i++) {
      const sq = ray[i]
      if (isUsed(sq)) continue
      const pid = b.squares[sq]
      if (pid < 0) continue
      if (b.colorByPid[pid] === side) {
        const t = b.typeByPid[pid]
        const canHit = t === PT_ROOK || t === PT_QUEEN || (t === PT_SHIELDER && i < 3)
        if (canHit && !isFrontalBlocked(b, sq, targetType, targetColor, toSq)) {
          if (SEE_VALUES[t] < bestOrderVal) {
            bestOrderVal = SEE_VALUES[t]
            bestPid = pid
            bestSq = sq
            bestType = t
          }
        }
      }
      break
    }
  }

  // 6. Diagonal rays (Bishop, Queen) passing through used squares
  for (let dir = 4; dir < 8; dir++) {
    const ray = RAY_SQUARES[dir][toSq]
    for (let i = 0; i < ray.length; i++) {
      const sq = ray[i]
      if (isUsed(sq)) continue
      const pid = b.squares[sq]
      if (pid < 0) continue
      if (b.colorByPid[pid] === side) {
        const t = b.typeByPid[pid]
        if (t === PT_BISHOP || t === PT_QUEEN) {
          if (SEE_VALUES[t] < bestOrderVal) {
            bestOrderVal = SEE_VALUES[t]
            bestPid = pid
            bestSq = sq
            bestType = t
          }
        }
      }
      break
    }
  }

  return bestPid >= 0 ? { pid: bestPid, sq: bestSq, type: bestType } : null
}

void SEE_ORDER
void BOARD_SIZE
void MG_VALUES

export function seeScore(b: FastBoard, move: number): number {
  const kind = moveKind(move)
  if (kind === MOVE_KIND_CASTLE || kind === MOVE_KIND_RESURRECT) return 0

  const fromSq = moveFromOrRevived(move)
  const toSq = moveToSq(move)
  const actorPid = moveActorPid(move)
  const actorColor = b.colorByPid[actorPid]
  let occType = b.typeByPid[actorPid]

  let firstGain = 0
  if (kind === MOVE_KIND_EP) {
    firstGain = SEE_VALUES[PT_PAWN]
  } else {
    const target = b.squares[toSq]
    if (target >= 0) firstGain = SEE_VALUES[b.typeByPid[target]]
  }

  if (kind === MOVE_KIND_PROMOTE) {
    const promoType = moveAux(move)
    firstGain += SEE_VALUES[promoType] - SEE_VALUES[PT_PAWN]
    occType = promoType
  }

  if (firstGain === 0) return 0

  usedBits.fill(0)
  markUsed(fromSq)
  if (kind === MOVE_KIND_EP && b.epPawnPid >= 0) {
    const epSq = b.currSqByPid[b.epPawnPid]
    if (epSq >= 0) markUsed(epSq)
  }

  let d = 0
  gain[0] = firstGain
  let occColor = actorColor
  let side = actorColor ^ 1

  while (d < 30) {
    const atk = leastValuableAttacker(b, toSq, side, occType, occColor)
    if (!atk) break
    d++
    gain[d] = SEE_VALUES[occType] - gain[d - 1]
    if (Math.max(-gain[d - 1], gain[d]) < 0) {
      // Pruning when exchange cannot improve
    }
    markUsed(atk.sq)
    occType = atk.type
    occColor = side
    side ^= 1
  }

  while (d > 0) {
    gain[d - 1] = -Math.max(-gain[d - 1], gain[d])
    d--
  }

  return gain[0]
}

export function seeGe(b: FastBoard, move: number, threshold = 0): boolean {
  return seeScore(b, move) >= threshold
}
