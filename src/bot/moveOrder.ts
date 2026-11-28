import {
  DRAGON_TIMING_NONE, FIRE_CONE_SQUARES, FastBoard, MOVE_KIND_CASTLE,
  MOVE_KIND_DRAGON, MOVE_KIND_EP, MOVE_KIND_PROMOTE, MOVE_KIND_RESURRECT,
  moveActorPid, moveAux, moveFromOrRevived, moveIsCaptureHint, moveKind, moveToSq,
} from './fastBoard'
import { MG_VALUES } from './pst'
import { seeScore } from './see'
import { MAX_SEARCH_PLY } from './fastBoard'
import { NUM_PIECE_TYPES, NUM_SQUARES, PT_KING, PT_PAWN, PT_SHIELDER } from './zobrist'

export const HASH_MOVE_SCORE = 10_000_000
export const GOOD_CAPTURE_BASE = 5_000_000
export const EVACUATION_BASE = 3_500_000
export const KILLER_1_SCORE = 2_000_000
export const KILLER_2_SCORE = 1_900_000
export const COUNTERMOVE_SCORE = 1_800_000
export const FIRE_ATTACK_BASE = 1_500_000
export const STRATEGIC_RESURRECT_BASE = 1_100_000
export const BAD_CAPTURE_BASE = -5_000_000

const MAX_HISTORY = 16_384

export class SearchHeuristics {
  killers = new Int32Array(MAX_SEARCH_PLY * 2)
  counterMoves = new Int32Array(2 * NUM_PIECE_TYPES * NUM_SQUARES)
  history = new Int32Array(2 * NUM_PIECE_TYPES * NUM_SQUARES)
  // Continuation history indexed by [prevType * 144 + prevTo] -> simplified flat [9 * 144] -> hashed or direct 1296?
  // 1296 * 1296 * 2 bytes = 3.3MB. Use Int16Array for compact L2 cache footprint!
  contHistory = new Int16Array(NUM_PIECE_TYPES * NUM_SQUARES * NUM_PIECE_TYPES * NUM_SQUARES)

  clear(): void {
    this.killers.fill(0)
    this.counterMoves.fill(0)
    this.history.fill(0)
    this.contHistory.fill(0)
  }

  decayForNewSearch(): void {
    for (let i = 0; i < this.history.length; i++) this.history[i] = (this.history[i] * 3) >> 2
    for (let i = 0; i < this.contHistory.length; i++) this.contHistory[i] = (this.contHistory[i] * 3) >> 2
  }

  recordKiller(ply: number, move: number): void {
    const base = ply * 2
    if (this.killers[base] !== move) {
      this.killers[base + 1] = this.killers[base]
      this.killers[base] = move
    }
  }

  recordCounter(side: number, prevType: number, prevTo: number, move: number): void {
    if (prevTo < 0 || prevType < 0) return
    this.counterMoves[(side * NUM_PIECE_TYPES + prevType) * NUM_SQUARES + prevTo] = move
  }

  getCounter(side: number, prevType: number, prevTo: number): number {
    if (prevTo < 0 || prevType < 0) return 0
    return this.counterMoves[(side * NUM_PIECE_TYPES + prevType) * NUM_SQUARES + prevTo]
  }

  getQuietHistory(side: number, actorType: number, toSq: number, prevType: number, prevTo: number): number {
    let score = this.history[(side * NUM_PIECE_TYPES + actorType) * NUM_SQUARES + toSq]
    if (prevType >= 0 && prevTo >= 0) {
      const idx = (prevType * NUM_SQUARES + prevTo) * (NUM_PIECE_TYPES * NUM_SQUARES) + (actorType * NUM_SQUARES + toSq)
      score += this.contHistory[idx]
    }
    return score
  }

  updateQuietStats(
    side: number,
    actorType: number,
    toSq: number,
    prevType: number,
    prevTo: number,
    bonus: number,
  ): void {
    const hIdx = (side * NUM_PIECE_TYPES + actorType) * NUM_SQUARES + toSq
    const cur = this.history[hIdx]
    const clampedBonus = Math.max(-4000, Math.min(4000, bonus))
    this.history[hIdx] = cur + clampedBonus - Math.trunc((cur * Math.abs(clampedBonus)) / MAX_HISTORY)

    if (prevType >= 0 && prevTo >= 0) {
      const cIdx = (prevType * NUM_SQUARES + prevTo) * (NUM_PIECE_TYPES * NUM_SQUARES) + (actorType * NUM_SQUARES + toSq)
      const cCur = this.contHistory[cIdx]
      this.contHistory[cIdx] = cCur + clampedBonus - Math.trunc((cCur * Math.abs(clampedBonus)) / MAX_HISTORY)
    }
  }
}

export function dragonConeBurnGain(b: FastBoard, move: number): number {
  if (moveKind(move) !== MOVE_KIND_DRAGON) return 0
  const timing = moveAux(move)
  if (timing === DRAGON_TIMING_NONE) return 0

  const pid = moveActorPid(move)
  const color = b.colorByPid[pid]
  const originSq = timing === 2 ? moveFromOrRevived(move) : moveToSq(move) // 2 = BEFORE, 1 = AFTER
  if (b.hasAnyShielderInCone(color, originSq)) return 0

  const cone = FIRE_CONE_SQUARES[color][originSq]
  const destSq = moveToSq(move)
  let total = 0
  for (let i = 0; i < cone.length; i++) {
    const sq = cone[i]
    if (timing === 2 && sq === destSq) continue // captured directly by landing
    const occ = b.squares[sq]
    if (occ >= 0 && b.colorByPid[occ] !== color) {
      const t = b.typeByPid[occ]
      if (t === PT_KING) total += 160
      else if (t !== PT_SHIELDER) total += MG_VALUES[t]
    }
  }
  return total
}

export function collectImminentVictims(b: FastBoard, outMask: Uint8Array): number {
  outMask.fill(0)
  if (b.imminentFireCount === 0) return 0
  let count = 0
  const mover = b.sideToMove
  const enemy = mover ^ 1
  const baseWord = enemy * 5
  for (let w = 0; w < 5; w++) {
    let mask = b.fireMask[baseWord + w]
    while (mask !== 0) {
      const lsb = mask & -mask
      const bit = 31 - Math.clz32(lsb)
      mask ^= lsb
      const sq = (w << 5) + bit
      if (b.fireRem[enemy * NUM_SQUARES + sq] !== 1) continue
      const pid = b.squares[sq]
      if (pid >= 0 && b.colorByPid[pid] === mover) {
        const t = b.typeByPid[pid]
        if (t !== PT_KING && t !== PT_SHIELDER && outMask[pid] === 0) {
          outMask[pid] = 1
          count++
        }
      }
    }
  }
  return count
}

export function isTacticalMove(b: FastBoard, move: number, allowFire: boolean): boolean {
  if (moveIsCaptureHint(move)) return true
  const kind = moveKind(move)
  if (kind === MOVE_KIND_PROMOTE || kind === MOVE_KIND_EP) return true
  if (allowFire && kind === MOVE_KIND_DRAGON && moveAux(move) !== DRAGON_TIMING_NONE) {
    return dragonConeBurnGain(b, move) > 0
  }
  return false
}

export function scoreMoves(
  b: FastBoard,
  moves: Int32Array,
  scores: Int32Array,
  count: number,
  ttMove: number,
  ply: number,
  heuristics: SearchHeuristics,
  imminentVictims: Uint8Array,
  imminentCount: number,
  prevType: number,
  prevTo: number,
): void {
  const side = b.sideToMove
  const k1 = ply < MAX_SEARCH_PLY ? heuristics.killers[ply * 2] : 0
  const k2 = ply < MAX_SEARCH_PLY ? heuristics.killers[ply * 2 + 1] : 0
  const counter = heuristics.getCounter(side, prevType, prevTo)

  for (let i = 0; i < count; i++) {
    const m = moves[i]
    if (m === ttMove && ttMove !== 0) {
      scores[i] = HASH_MOVE_SCORE
      continue
    }

    const kind = moveKind(m)
    const actorPid = moveActorPid(m)
    const actorType = b.typeByPid[actorPid]
    const toSq = moveToSq(m)
    const isCap = moveIsCaptureHint(m)

    if (kind === MOVE_KIND_PROMOTE || isCap) {
      const see = seeScore(b, m)
      const fireGain = kind === MOVE_KIND_DRAGON ? dragonConeBurnGain(b, m) : 0
      const victimPid = kind === MOVE_KIND_EP ? b.epPawnPid : b.squares[toSq]
      const victimVal = victimPid >= 0 ? MG_VALUES[b.typeByPid[victimPid]] : 0
      const promoBonus = kind === MOVE_KIND_PROMOTE ? MG_VALUES[moveAux(m)] : 0

      if (see >= 0) {
        scores[i] = GOOD_CAPTURE_BASE + see * 4 + victimVal * 2 + promoBonus + fireGain - Math.trunc(MG_VALUES[actorType] / 10)
      } else {
        scores[i] = BAD_CAPTURE_BASE + see + fireGain
      }
      continue
    }

    // Imminent fire evacuation boost for quiet moves of threatened pieces
    if (imminentCount > 0 && kind !== MOVE_KIND_RESURRECT && kind !== MOVE_KIND_CASTLE && imminentVictims[actorPid]) {
      const destSafe = !b.isHostileFire(toSq, side)
      if (destSafe) {
        scores[i] = EVACUATION_BASE + MG_VALUES[actorType] * 8 + (kind === MOVE_KIND_DRAGON ? dragonConeBurnGain(b, m) : 0)
        continue
      }
    }

    // Non-capturing Dragon fire ignition threatening material
    if (kind === MOVE_KIND_DRAGON && moveAux(m) !== DRAGON_TIMING_NONE) {
      const fireGain = dragonConeBurnGain(b, m)
      if (fireGain > 0) {
        const landingExposed = b.isSquareAttackedByPieces(toSq, side ^ 1) ? MG_VALUES[actorType] : 0
        if (fireGain > landingExposed) {
          scores[i] = FIRE_ATTACK_BASE + fireGain * 2 - landingExposed
          continue
        }
      }
    }

    if (m === k1 && k1 !== 0) {
      scores[i] = KILLER_1_SCORE
      continue
    }
    if (m === k2 && k2 !== 0) {
      scores[i] = KILLER_2_SCORE
      continue
    }
    if (m === counter && counter !== 0) {
      scores[i] = COUNTERMOVE_SCORE
      continue
    }

    if (kind === MOVE_KIND_RESURRECT) {
      const revPid = moveFromOrRevived(m)
      const bType = b.baseTypeByPid[revPid]
      const destHot = b.isHostileFire(toSq, side) && bType !== PT_SHIELDER
      if (destHot) {
        scores[i] = BAD_CAPTURE_BASE - MG_VALUES[bType]
      } else {
        // High-value non-pawn revivals are strong; Pawn revival gets mild negative offset vs piece development
        const base = bType === PT_PAWN ? -400 : STRATEGIC_RESURRECT_BASE + MG_VALUES[bType] * 2
        scores[i] = base
      }
      continue
    }

    if (kind === MOVE_KIND_CASTLE) {
      scores[i] = 1500
      continue
    }

    const hist = heuristics.getQuietHistory(side, actorType, toSq, prevType, prevTo)
    const centerBias = 12 - Math.abs((toSq % 12) - 5.5) - Math.abs(((toSq / 12) | 0) - 5.5)
    scores[i] = hist + Math.round(centerBias * 2)
  }
}

export function pickNextMove(moves: Int32Array, scores: Int32Array, startIdx: number, count: number): number {
  let bestIdx = startIdx
  let bestScore = scores[startIdx]
  for (let i = startIdx + 1; i < count; i++) {
    if (scores[i] > bestScore) {
      bestScore = scores[i]
      bestIdx = i
    }
  }
  if (bestIdx !== startIdx) {
    const tmpM = moves[startIdx]
    moves[startIdx] = moves[bestIdx]
    moves[bestIdx] = tmpM
    const tmpS = scores[startIdx]
    scores[startIdx] = scores[bestIdx]
    scores[bestIdx] = tmpS
  }
  return moves[startIdx]
}
