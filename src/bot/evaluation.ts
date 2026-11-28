import { BOARD_SIZE, type Color, type GameState, type PieceType } from '../engine/model'
import {
  CONE_MASK, FIRE_CONE_SQUARES, FastBoard, KING_TARGETS, KING_ZONE_MASK,
  KNIGHT_TARGETS, PAWN_CAP_TARGETS, RAY_SQUARES, popcount32, sqFile, sqIndex, sqRank,
} from './fastBoard'
import { EG_VALUES, MAX_GAME_PHASE, MG_VALUES } from './pst'
import type { PawnTable } from './tt'
import {
  BLACK, CODE_FROM_PIECE_TYPE, NUM_PIECE_TYPES, NUM_SQUARES, PT_BISHOP,
  PT_DRAGON, PT_KING, PT_KNIGHT, PT_NECROMANCER, PT_PAWN, PT_QUEEN, PT_ROOK,
  PT_SHIELDER, WHITE,
} from './zobrist'

const values: Record<PieceType, number> = {
  king: 0,
  pawn: 100,
  knight: 320,
  bishop: 370,
  rook: 555,
  queen: 1060,
  necromancer: 390,
  dragon: 620,
  shielder: 390,
}

export function pieceValue(type: PieceType): number {
  return values[type]
}

export function codePieceValue(typeCode: number): number {
  return MG_VALUES[typeCode]
}

export interface EvaluationTerms {
  material: number
  placement: number
  dragonFire: number
  shield: number
  resurrection: number
  kingSafety: number
}

const QUOTA_MAX = new Uint8Array([3, 1, 1, 1, 1, 0, 1, 1, 1])
const LAST_RANK = BOARD_SIZE - 1

// Scratch buffers reused across fast evaluations (single-threaded inside a worker)
const pawnCountByFile = new Int32Array(2 * BOARD_SIZE)
const frontPawnRank = new Int32Array(2 * BOARD_SIZE)
const backPawnRank = new Int32Array(2 * BOARD_SIZE)
const pinnedScratch = new Uint32Array(5)

const pieceList = new Int16Array(64)
const dragonList = new Int16Array(8)
const shielderList = new Int16Array(8)
const necroList = new Int16Array(8)
const deadList = new Int16Array(64)
const deadCount = new Int32Array(2)
const minRankByColor = new Int32Array(2)
const maxRankByColor = new Int32Array(2)
// Flat evaluation accumulators: [wMat, wPlace, wFire, wShield, wRes, wKing, bMat, bPlace, bFire, bShield, bRes, bKing]
const flatTerms = new Int32Array(12)

function chebyshev(sqA: number, sqB: number): number {
  return Math.max(Math.abs(sqFile(sqA) - sqFile(sqB)), Math.abs(sqRank(sqA) - sqRank(sqB)))
}

function relRank(color: number, rank: number): number {
  return color === WHITE ? rank : LAST_RANK - rank
}

function centrality(sq: number): number {
  return LAST_RANK - Math.abs(sqFile(sq) - 5.5) - Math.abs(sqRank(sq) - 5.5)
}

function windowTouches(minR: number, maxR: number, rA: number, rB: number): boolean {
  return Math.min(rA, rB) <= maxR && Math.max(rA, rB) >= minR
}

function hasAnyBit(maskA: Uint32Array, offA: number, maskB: Uint32Array, offB: number): boolean {
  return (
    ((maskA[offA] & maskB[offB]) !== 0) ||
    ((maskA[offA + 1] & maskB[offB + 1]) !== 0) ||
    ((maskA[offA + 2] & maskB[offB + 2]) !== 0) ||
    ((maskA[offA + 3] & maskB[offB + 3]) !== 0) ||
    ((maskA[offA + 4] & maskB[offB + 4]) !== 0)
  )
}

function isPinnedAt(pinnedMask: Uint32Array, sq: number): boolean {
  return (pinnedMask[sq >>> 5] & ((1 << (sq & 31)) >>> 0)) !== 0
}

function countSafeEscapeSquares(b: FastBoard, pid: number): number {
  const sq = b.currSqByPid[pid]
  const color = b.colorByPid[pid]
  const type = b.typeByPid[pid]
  let safe = 0

  if (type === PT_PAWN) {
    const fwd = color === WHITE ? 1 : -1
    const r = sqRank(sq) + fwd
    const f = sqFile(sq)
    if (r >= 0 && r < BOARD_SIZE) {
      const oneSq = r * BOARD_SIZE + f
      if (b.squares[oneSq] < 0 && !b.isHostileFire(oneSq, color)) safe++
      const caps = PAWN_CAP_TARGETS[color][sq]
      for (let i = 0; i < caps.length; i++) {
        const cSq = caps[i]
        const t = b.squares[cSq]
        if (t >= 0 && b.colorByPid[t] !== color && b.typeByPid[t] !== PT_KING && !b.isHostileFire(cSq, color)) safe++
      }
    }
    return safe
  }

  if (type === PT_KNIGHT || type === PT_DRAGON) {
    const targets = KNIGHT_TARGETS[sq]
    for (let i = 0; i < targets.length; i++) {
      const d = targets[i]
      const t = b.squares[d]
      if ((t < 0 || (b.colorByPid[t] !== color && b.typeByPid[t] !== PT_KING)) && !b.isHostileFire(d, color)) {
        return 1
      }
    }
    return 0
  }

  if (type === PT_NECROMANCER || type === PT_KING) {
    const targets = KING_TARGETS[sq]
    for (let i = 0; i < targets.length; i++) {
      const d = targets[i]
      const t = b.squares[d]
      if ((t < 0 || (b.colorByPid[t] !== color && b.typeByPid[t] !== PT_KING)) && !b.isHostileFire(d, color)) {
        return 1
      }
    }
    return 0
  }

  const startDir = type === PT_BISHOP ? 4 : 0
  const endDir = type === PT_ROOK || type === PT_SHIELDER ? 4 : 8
  const maxR = type === PT_SHIELDER ? 3 : BOARD_SIZE - 1
  for (let dir = startDir; dir < endDir; dir++) {
    const ray = RAY_SQUARES[dir][sq]
    const lim = ray.length < maxR ? ray.length : maxR
    for (let i = 0; i < lim; i++) {
      const d = ray[i]
      const t = b.squares[d]
      if (t < 0) {
        if (!b.isHostileFire(d, color)) return 1
      } else {
        if (b.colorByPid[t] !== color && b.typeByPid[t] !== PT_KING && !b.isHostileFire(d, color)) return 1
        break
      }
    }
  }
  return 0
}

function coneStats(b: FastBoard, dragonColor: number, originSq: number, minEnemyR: number, maxEnemyR: number) {
  const rank = sqRank(originSq)
  const fwd = dragonColor === WHITE ? 1 : -1
  if (!windowTouches(minEnemyR, maxEnemyR, rank + fwd, rank + 2 * fwd)) {
    return { value: 0, protectedValue: 0, friendlyShielderClash: false }
  }
  const cone = FIRE_CONE_SQUARES[dragonColor][originSq]
  const enemy = dragonColor ^ 1
  let canceled = false
  let friendlyShielder = false
  let value = 0
  let protectedValue = 0

  for (let i = 0; i < cone.length; i++) {
    const cSq = cone[i]
    const pid = b.squares[cSq]
    if (pid < 0) continue
    const t = b.typeByPid[pid]
    if (t === PT_SHIELDER) {
      canceled = true
      if (b.colorByPid[pid] === dragonColor) friendlyShielder = true
      continue
    }
    if (b.colorByPid[pid] === dragonColor) continue
    if (t === PT_KING) {
      value += 90
      protectedValue += 52
    } else {
      const v = MG_VALUES[t]
      const refresh = b.fireRem[dragonColor * NUM_SQUARES + cSq] > 0 ? 12 : 0
      value += v + refresh
      protectedValue += Math.min(36, v * 0.08)
    }
  }
  if (canceled) {
    return { value: 0, protectedValue, friendlyShielderClash: friendlyShielder }
  }
  return { value, protectedValue: 0, friendlyShielderClash: false }
}

function computePawnAndKingStructure(b: FastBoard, color: number): { mg: number; eg: number } {
  let mg = 0
  let eg = 0
  const enemy = color ^ 1
  const cOff = color * BOARD_SIZE
  const eOff = enemy * BOARD_SIZE
  const fwd = color === WHITE ? 1 : -1

  for (let pid = 0; pid < b.pieceCount; pid++) {
    if (b.colorByPid[pid] !== color || b.typeByPid[pid] !== PT_PAWN) continue
    const sq = b.currSqByPid[pid]
    if (sq < 0) continue
    const f = sqFile(sq)
    const r = sqRank(sq)
    const adv = relRank(color, r)
    const enemyRelR = relRank(enemy, r)

    const leftEnemy = f > 0 ? backPawnRank[eOff + f - 1] : BOARD_SIZE
    const sameEnemy = backPawnRank[eOff + f]
    const rightEnemy = f < LAST_RANK ? backPawnRank[eOff + f + 1] : BOARD_SIZE
    const isPassed = Math.min(leftEnemy, sameEnemy, rightEnemy) >= enemyRelR

    const hasFriendlyNeighbor =
      (f > 0 && pawnCountByFile[cOff + f - 1] > 0) ||
      (f < LAST_RANK && pawnCountByFile[cOff + f + 1] > 0)

    if (!hasFriendlyNeighbor) {
      mg -= 10
      eg -= 14
    }

    // Connected / phalanx support
    const supportRank = r - fwd
    let supported = false
    if (supportRank >= 0 && supportRank < BOARD_SIZE) {
      if (f > 0) {
        const lp = b.squares[supportRank * BOARD_SIZE + f - 1]
        if (lp >= 0 && b.colorByPid[lp] === color && b.typeByPid[lp] === PT_PAWN) supported = true
      }
      if (!supported && f < LAST_RANK) {
        const rp = b.squares[supportRank * BOARD_SIZE + f + 1]
        if (rp >= 0 && b.colorByPid[rp] === color && b.typeByPid[rp] === PT_PAWN) supported = true
      }
    }
    if (supported) {
      mg += 8 + Math.max(0, adv - 3) * 2
      eg += 10 + Math.max(0, adv - 3) * 3
    }

    // Blocked forward
    const aheadRank = r + fwd
    const blocked = aheadRank >= 0 && aheadRank < BOARD_SIZE && b.squares[aheadRank * BOARD_SIZE + f] >= 0
    if (blocked) {
      mg -= 6
      eg -= 8
    }

    if (isPassed) {
      const steps = Math.max(0, adv - 2)
      const bonusBase = 12 + steps * 4 + Math.max(0, adv - 7) ** 2 * 7
      mg += Math.round(bonusBase * 0.7) + (supported ? 12 : 0)
      eg += Math.round(bonusBase * 1.45) + (supported ? 22 : 0) - (blocked ? 14 : 0)
    }
  }

  // Doubled pawns penalty
  for (let f = 0; f < BOARD_SIZE; f++) {
    const doubled = Math.max(0, pawnCountByFile[cOff + f] - 1)
    if (doubled > 0) {
      mg -= doubled * 13
      eg -= doubled * 18
    }
  }

  // King Pawn Shield in MG
  const kp = b.kingPid[color]
  if (kp >= 0) {
    const kSq = b.currSqByPid[kp]
    if (kSq >= 0) {
      const kf = sqFile(kSq)
      const kr = sqRank(kSq)
      if (relRank(color, kr) <= 2) {
        for (let df = -1; df <= 1; df++) {
          const nf = kf + df
          if (nf < 0 || nf >= BOARD_SIZE) continue
          const fPawnRel = frontPawnRank[cOff + nf]
          if (fPawnRel <= 3) mg += 11
          else if (fPawnRel === 4) mg += 5
          else if (pawnCountByFile[cOff + nf] === 0) mg -= 14
        }
      }
    }
  }

  return { mg, eg }
}

function computeFastTerms(b: FastBoard, pawnTable?: PawnTable): void {
  const clampedPhase = Math.max(0, Math.min(MAX_GAME_PHASE, b.phase))
  const mgWeight = clampedPhase / MAX_GAME_PHASE
  const egWeight = 1 - mgWeight
  const endgame = egWeight

  pawnCountByFile.fill(0)
  frontPawnRank.fill(BOARD_SIZE)
  backPawnRank.fill(BOARD_SIZE)
  minRankByColor[0] = BOARD_SIZE
  minRankByColor[1] = BOARD_SIZE
  maxRankByColor[0] = -1
  maxRankByColor[1] = -1
  deadCount[0] = 0
  deadCount[1] = 0

  const sideCount = [0, 0]
  const dragonCount = [0, 0]
  const shielderCount = [0, 0]
  const necroCount = [0, 0]
  const bishopCount = [0, 0]
  const dragonPair = [0, 0]
  const nonPawnMat = [0, 0]
  const rawMatMg = [0, 0]
  const rawMatEg = [0, 0]

  for (let pid = 0; pid < b.pieceCount; pid++) {
    const c = b.colorByPid[pid]
    const sq = b.currSqByPid[pid]
    if (sq < 0) {
      deadList[c * 32 + deadCount[c]++] = pid
      continue
    }
    const t = b.typeByPid[pid]
    const f = sqFile(sq)
    const r = sqRank(sq)

    if (r < minRankByColor[c]) minRankByColor[c] = r
    if (r > maxRankByColor[c]) maxRankByColor[c] = r

    pieceList[c * 32 + sideCount[c]++] = pid
    rawMatMg[c] += MG_VALUES[t]
    rawMatEg[c] += EG_VALUES[t]

    if (t === PT_PAWN) {
      const fIdx = c * BOARD_SIZE + f
      pawnCountByFile[fIdx]++
      const rr = relRank(c, r)
      if (rr < backPawnRank[fIdx]) backPawnRank[fIdx] = rr
      if (rr < frontPawnRank[fIdx]) frontPawnRank[fIdx] = rr
    } else {
      nonPawnMat[c] += MG_VALUES[t]
      if (t === PT_DRAGON) {
        dragonList[c * 4 + dragonCount[c]++] = pid
        dragonPair[c]++
      } else if (t === PT_SHIELDER) {
        shielderList[c * 4 + shielderCount[c]++] = pid
      } else if (t === PT_NECROMANCER) {
        necroList[c * 4 + necroCount[c]++] = pid
      } else if (t === PT_BISHOP) {
        bishopCount[c]++
      }
    }
  }

  // 1. Material + Tapered PST from incremental FastBoard accumulators
  const matScore = [0, 0]
  const pstScore = [0, 0]
  for (let c = 0; c < 2; c++) {
    const blendedMat = rawMatMg[c] * mgWeight + rawMatEg[c] * egWeight
    const pairBonus = (bishopCount[c] >= 2 ? 28 : 0) + (dragonPair[c] >= 2 ? 22 : 0)
    matScore[c] = Math.round(blendedMat + pairBonus)

    const onlyPstMg = b.mgScore[c] - rawMatMg[c]
    const onlyPstEg = b.egScore[c] - rawMatEg[c]
    pstScore[c] = Math.round(onlyPstMg * mgWeight + onlyPstEg * egWeight)
  }

  // 2. Pawn & King Shield Structure (cached in PawnTable when available)
  const structScore = [0, 0]
  if (pawnTable) {
    const cached = pawnTable.probe(b.pawnHashLo, b.pawnHashHi)
    if (cached.hit) {
      structScore[WHITE] = Math.round(cached.mg * mgWeight + cached.eg * egWeight)
    } else {
      const wStruct = computePawnAndKingStructure(b, WHITE)
      const bStruct = computePawnAndKingStructure(b, BLACK)
      const diffMg = wStruct.mg - bStruct.mg
      const diffEg = wStruct.eg - bStruct.eg
      pawnTable.store(b.pawnHashLo, b.pawnHashHi, diffMg, diffEg)
      structScore[WHITE] = Math.round(diffMg * mgWeight + diffEg * egWeight)
    }
  } else {
    const wStruct = computePawnAndKingStructure(b, WHITE)
    const bStruct = computePawnAndKingStructure(b, BLACK)
    structScore[WHITE] = Math.round(wStruct.mg * mgWeight + wStruct.eg * egWeight)
    structScore[BLACK] = Math.round(bStruct.mg * mgWeight + bStruct.eg * egWeight)
  }

  // 3. Placement extras
  const placeScore = [pstScore[0] + structScore[0], pstScore[1] + structScore[1]]
  for (let c = 0; c < 2; c++) {
    const enemy = c ^ 1
    const cOff = c * BOARD_SIZE
    const eOff = enemy * BOARD_SIZE

    const canK = c === WHITE ? (b.castling & 1) : (b.castling & 4)
    const canQ = c === WHITE ? (b.castling & 2) : (b.castling & 8)
    if (canK) placeScore[c] += Math.round(14 * mgWeight)
    if (canQ) placeScore[c] += Math.round(12 * mgWeight)

    for (let i = 0; i < sideCount[c]; i++) {
      const pid = pieceList[c * 32 + i]
      const t = b.typeByPid[pid]
      const sq = b.currSqByPid[pid]
      const f = sqFile(sq)

      if (t === PT_ROOK) {
        if (pawnCountByFile[cOff + f] === 0) {
          placeScore[c] += pawnCountByFile[eOff + f] === 0 ? 18 : 9
        }
      } else if (t === PT_BISHOP) {
        if (sq !== b.spawnSqByPid[pid]) placeScore[c] += Math.round(8 * mgWeight)
      }
    }

    const nCount = necroCount[c]
    if (nCount > 0) {
      let futureQuotaPotential = 0
      for (let i = 0; i < sideCount[c]; i++) {
        const pid = pieceList[c * 32 + i]
        const bt = b.baseTypeByPid[pid]
        if (bt === PT_KING || bt === PT_PAWN) continue
        if (b.quotasUsed[c * NUM_PIECE_TYPES + bt] < QUOTA_MAX[bt]) {
          futureQuotaPotential += MG_VALUES[bt]
        }
      }
      const insurance = Math.min(185, Math.round(futureQuotaPotential * 0.045))
      placeScore[c] += nCount === 1 ? insurance : Math.round(insurance * 1.15)
      if (nCount === 1) {
        const nSq = b.currSqByPid[necroList[c * 4]]
        if (b.isHostileFire(nSq, c) || b.isSquareAttackedByPieces(nSq, enemy)) {
          placeScore[c] -= 48
        }
      }
    }
  }

  // 4. Necromancer Reserve & Spawn-Camping (iterate only dead pieces!)
  const resScore = [0, 0]
  for (let c = 0; c < 2; c++) {
    const enemy = c ^ 1
    const nCount = necroCount[c]
    const dLen = deadCount[c]
    if (nCount === 0 || dLen === 0) continue

    const counted = new Uint8Array(NUM_PIECE_TYPES)
    let bestReady = 0
    let altReady = 0
    let blockedAllyReserve = 0
    let spawnCampedReserve = 0

    for (let i = 0; i < dLen; i++) {
      const pid = deadList[c * 32 + i]
      const bt = b.baseTypeByPid[pid]
      if (bt === PT_KING) continue
      const remQuota = QUOTA_MAX[bt] - b.quotasUsed[c * NUM_PIECE_TYPES + bt]
      if (counted[bt] >= remQuota) continue

      const sSq = b.spawnSqByPid[pid]
      const occ = b.squares[sSq]
      const val = MG_VALUES[bt]
      const tempoAdjVal = bt === PT_PAWN ? Math.round(val * (0.45 + 0.4 * endgame)) : val

      if (occ >= 0) {
        counted[bt]++
        if (b.colorByPid[occ] === c) {
          blockedAllyReserve = Math.max(blockedAllyReserve, Math.round(tempoAdjVal * 0.34))
        } else {
          const campBonus = Math.min(135, Math.round(tempoAdjVal * 0.14))
          spawnCampedReserve = Math.max(spawnCampedReserve, campBonus)
        }
        continue
      }

      if (b.sideToMove === c && bt !== PT_SHIELDER && b.isHostileFire(sSq, c)) continue
      counted[bt]++
      if (tempoAdjVal > bestReady) {
        altReady += bestReady
        bestReady = tempoAdjVal
      } else {
        altReady += tempoAdjVal
      }
    }

    placeScore[c] += blockedAllyReserve
    placeScore[enemy] += spawnCampedReserve

    if (bestReady > 0) {
      let hasSafeActor = false
      for (let i = 0; i < nCount; i++) {
        const nSq = b.currSqByPid[necroList[c * 4 + i]]
        if (!b.isHostileFire(nSq, c) && !b.isSquareAttackedByPieces(nSq, enemy)) {
          hasSafeActor = true
          break
        }
      }
      const val = bestReady * 0.52 + Math.min(85, altReady * 0.09) + (nCount > 1 ? 24 : 0)
      resScore[c] = Math.round(hasSafeActor ? val : val * 0.72)
    }
  }

  // 5. Active Fire Pressure
  const fireScore = [0, 0]
  if (b.activeFireCount > 0) {
    const pinnedReady = [false, false]
    const escapableSum = [0, 0]
    const highestEscape = [0, 0]
    const countedVictim = new Uint8Array(b.pieceCount)

    for (let owner = 0; owner < 2; owner++) {
      const victimColor = owner ^ 1
      const baseWord = owner * 5
      for (let w = 0; w < 5; w++) {
        let mask = b.fireMask[baseWord + w]
        while (mask !== 0) {
          const lsb = mask & -mask
          const bit = 31 - Math.clz32(lsb)
          mask ^= lsb
          const sq = (w << 5) + bit
          const rem = b.fireRem[owner * NUM_SQUARES + sq]
          if (rem === 0) continue

          const pid = b.squares[sq]
          if (pid < 0) {
            const r = sqRank(sq)
            if (windowTouches(minRankByColor[victimColor], maxRankByColor[victimColor], r - 1, r + 1)) {
              fireScore[owner] += (0.5 + centrality(sq) * 0.075) / rem
            }
            continue
          }
          if (b.colorByPid[pid] === owner || countedVictim[pid]) continue
          countedVictim[pid] = 1

          const t = b.typeByPid[pid]
          if (t === PT_KING) {
            fireScore[owner] += 26
            continue
          }
          if (t === PT_SHIELDER) continue

          const v = MG_VALUES[t]
          if (!pinnedReady[victimColor]) {
            b.computePinnedMask(victimColor, pinnedScratch)
            pinnedReady[victimColor] = true
          }
          const pinned = isPinnedAt(pinnedScratch, sq)
          const canEscape = !pinned && countSafeEscapeSquares(b, pid) > 0
          const dueNow = rem === 1 && victimColor === b.sideToMove

          if (dueNow) {
            fireScore[owner] += v * (canEscape ? 0.14 : 0.84)
            if (canEscape) {
              escapableSum[owner] += v
              if (v > highestEscape[owner]) highestEscape[owner] = v
            }
          } else {
            fireScore[owner] += v * (canEscape ? 0.065 : 0.34)
          }
        }
      }
    }
    for (let owner = 0; owner < 2; owner++) {
      fireScore[owner] += (escapableSum[owner] - highestEscape[owner]) * 0.62
    }
  }

  // 6. Dragon Cone Opportunities (lazy exposure check ONLY when cone has value!)
  const dragonAttack = [0, 0]
  const shieldScore = [0, 0]
  for (let c = 0; c < 2; c++) {
    const enemy = c ^ 1
    const fwd = c === WHITE ? 1 : -1
    const dCount = dragonCount[c]
    for (let i = 0; i < dCount; i++) {
      const dPid = dragonList[c * 4 + i]
      const sq = b.currSqByPid[dPid]
      const r = sqRank(sq)
      if (!windowTouches(minRankByColor[enemy], maxRankByColor[enemy], r - fwd, r + 4 * fwd)) continue

      const currCone = coneStats(b, c, sq, minRankByColor[enemy], maxRankByColor[enemy])
      if (currCone.friendlyShielderClash) placeScore[c] -= 10

      const targets = KNIGHT_TARGETS[sq]
      let hasSafeLanding = false
      let checkedLanding = false
      let afterVal = 0
      let protection = currCone.protectedValue

      for (let j = 0; j < targets.length; j++) {
        const dest = targets[j]
        const occ = b.squares[dest]
        if (occ >= 0 && (b.colorByPid[occ] === c || b.typeByPid[occ] === PT_KING)) continue

        const destCone = coneStats(b, c, dest, minRankByColor[enemy], maxRankByColor[enemy])
        if (destCone.protectedValue * 0.35 > protection) protection = destCone.protectedValue * 0.35
        if (destCone.value * 0.08 > afterVal) {
          const exposed = b.isSquareAttackedByPieces(dest, enemy)
          if (!exposed) { hasSafeLanding = true; checkedLanding = true }
          const exchangeCost = exposed ? MG_VALUES[PT_DRAGON] * 0.45 : 0
          const score = (destCone.value - exchangeCost) * 0.08
          if (score > afterVal) afterVal = score
        }
      }

      let beforeVal = 0
      if (currCone.value > 0) {
        if (!checkedLanding) {
          for (let j = 0; j < targets.length; j++) {
            const dest = targets[j]
            const occ = b.squares[dest]
            if (occ >= 0 && (b.colorByPid[occ] === c || b.typeByPid[occ] === PT_KING)) continue
            if (!b.isSquareAttackedByPieces(dest, enemy)) { hasSafeLanding = true; break }
          }
        }
        const exchangeCost = MG_VALUES[PT_DRAGON] * 0.45
        beforeVal = Math.max(0, currCone.value - (hasSafeLanding ? 0 : exchangeCost)) * 0.14
      }

      const oppVal = Math.min(165, Math.max(beforeVal, afterVal))
      if (oppVal > dragonAttack[c]) dragonAttack[c] = oppVal
      if (Math.min(90, protection) > shieldScore[enemy]) shieldScore[enemy] = Math.min(90, protection)
    }
  }

  // Shielder positioning & Frontal Blockade
  for (let c = 0; c < 2; c++) {
    const enemy = c ^ 1
    const sCount = shielderCount[c]
    const kp = b.kingPid[c]
    const kSq = kp >= 0 ? b.currSqByPid[kp] : -1
    const fwd = c === WHITE ? 1 : -1

    for (let i = 0; i < sCount; i++) {
      const sPid = shielderList[c * 4 + i]
      const sq = b.currSqByPid[sPid]
      if (kSq >= 0 && chebyshev(sq, kSq) <= 2) shieldScore[c] += 9
      if (b.isSquareAttackedByPieces(sq, enemy)) shieldScore[c] -= 15

      const file = sqFile(sq)
      const rank = sqRank(sq)
      for (let rr = rank + fwd; rr >= 0 && rr < BOARD_SIZE; rr += fwd) {
        const blocker = b.squares[rr * BOARD_SIZE + file]
        if (blocker >= 0) {
          if (b.colorByPid[blocker] === enemy) {
            const bt = b.typeByPid[blocker]
            if (bt === PT_ROOK || bt === PT_QUEEN) shieldScore[c] += 24
          }
          break
        }
      }
    }
  }

  // 7. King Safety & Endgame Mop-Up
  const kingSafety = [0, 0]
  for (let c = 0; c < 2; c++) {
    const enemy = c ^ 1
    const kp = b.kingPid[c]
    if (kp < 0) continue
    const kSq = b.currSqByPid[kp]
    if (kSq < 0) continue

    let atkWeight = 0
    let atkCount = 0
    if (endgame < 0.8) {
      const kzOff = kSq * 5
      for (let i = 0; i < sideCount[enemy]; i++) {
        const ePid = pieceList[enemy * 32 + i]
        const et = b.typeByPid[ePid]
        if (et === PT_PAWN || et === PT_KING) continue
        const eSq = b.currSqByPid[ePid]
        const dist = chebyshev(eSq, kSq)
        if (dist <= 3 || (et === PT_QUEEN && dist <= 5) || (et === PT_ROOK && (sqFile(eSq) === sqFile(kSq) || sqRank(eSq) === sqRank(kSq)))) {
          atkCount++
          atkWeight += et === PT_QUEEN ? 5 : et === PT_DRAGON ? 4 : et === PT_ROOK ? 3 : 2
        } else if (et === PT_DRAGON && hasAnyBit(CONE_MASK, (enemy * NUM_SQUARES + eSq) * 5, KING_ZONE_MASK, kzOff)) {
          atkCount++
          atkWeight += 3
        }
      }
    }

    const inCheck = b.isSquareAttacked(kSq, enemy)
    const onFire = b.activeFireCount > 0 && b.isHostileFire(kSq, c)
    let danger = inCheck ? 36 : onFire ? 22 : 0

    if (inCheck || onFire || atkCount >= 1 || b.activeFireCount > 0) {
      if (inCheck) b.squares[kSq] = -1
      let safeEsc = 0
      let covered = 0
      const kTargets = KING_TARGETS[kSq]
      for (let i = 0; i < kTargets.length; i++) {
        const d = kTargets[i]
        const occ = b.squares[d]
        if (occ >= 0 && b.colorByPid[occ] === c) continue
        const fireRemains = b.fireRem[enemy * NUM_SQUARES + d] > (b.sideToMove === c ? 1 : 0)
        if (fireRemains || b.isSquareAttackedByPieces(d, enemy)) covered++
        else safeEsc++
      }
      if (inCheck) b.squares[kSq] = kp
      if (inCheck || covered > 0) danger += covered * 8 + Math.max(0, 3 - safeEsc) * 10
    }

    if (atkCount >= 2) {
      danger += Math.round((1 - endgame) * Math.min(180, atkWeight * atkCount * 2.2))
    }

    const ekp = b.kingPid[enemy]
    if (ekp >= 0 && nonPawnMat[enemy] >= nonPawnMat[c] + 300 && endgame > 0.45) {
      const ekSq = b.currSqByPid[ekp]
      if (ekSq >= 0) {
        const edge = Math.min(sqFile(kSq), LAST_RANK - sqFile(kSq), sqRank(kSq), LAST_RANK - sqRank(kSq))
        const pursuit = LAST_RANK - chebyshev(kSq, ekSq)
        let closestForce = LAST_RANK
        for (let i = 0; i < sideCount[enemy]; i++) {
          const ePid = pieceList[enemy * 32 + i]
          if (MG_VALUES[b.typeByPid[ePid]] >= MG_VALUES[PT_KNIGHT]) {
            const d = chebyshev(kSq, b.currSqByPid[ePid])
            if (d < closestForce) closestForce = d
          }
        }
        danger += endgame * ((5 - edge) * 9 + pursuit * 4 + (LAST_RANK - closestForce) * 3)
      }
    }

    kingSafety[c] = -Math.round(danger)
  }

  flatTerms[0] = matScore[WHITE]
  flatTerms[1] = Math.round(placeScore[WHITE])
  flatTerms[2] = Math.round(fireScore[WHITE] + dragonAttack[WHITE])
  flatTerms[3] = Math.round(shieldScore[WHITE])
  flatTerms[4] = resScore[WHITE]
  flatTerms[5] = kingSafety[WHITE]

  flatTerms[6] = matScore[BLACK]
  flatTerms[7] = Math.round(placeScore[BLACK])
  flatTerms[8] = Math.round(fireScore[BLACK] + dragonAttack[BLACK])
  flatTerms[9] = Math.round(shieldScore[BLACK])
  flatTerms[10] = resScore[BLACK]
  flatTerms[11] = kingSafety[BLACK]
}

export function evaluateFastBreakdown(b: FastBoard, pawnTable?: PawnTable): Record<Color, EvaluationTerms> {
  computeFastTerms(b, pawnTable)
  return {
    white: {
      material: flatTerms[0],
      placement: flatTerms[1],
      dragonFire: flatTerms[2],
      shield: flatTerms[3],
      resurrection: flatTerms[4],
      kingSafety: flatTerms[5],
    },
    black: {
      material: flatTerms[6],
      placement: flatTerms[7],
      dragonFire: flatTerms[8],
      shield: flatTerms[9],
      resurrection: flatTerms[10],
      kingSafety: flatTerms[11],
    },
  }
}

export function evaluateFast(b: FastBoard, pawnTable?: PawnTable): number {
  computeFastTerms(b, pawnTable)
  const w = flatTerms[0] + flatTerms[1] + flatTerms[2] + flatTerms[3] + flatTerms[4] + flatTerms[5]
  const bl = flatTerms[6] + flatTerms[7] + flatTerms[8] + flatTerms[9] + flatTerms[10] + flatTerms[11]
  let diff = b.sideToMove === WHITE ? w - bl : bl - w

  if (b.halfMoveClock > 64) {
    const scale = Math.max(0.25, (112 - b.halfMoveClock) / 48)
    diff = Math.round(diff * scale)
  }
  return diff
}

export function evaluatePositionBreakdown(state: GameState): Record<Color, EvaluationTerms> {
  return evaluateFastBreakdown(FastBoard.fromGameState(state))
}

function sumTerms(terms: EvaluationTerms): number {
  return terms.material + terms.placement + terms.dragonFire + terms.shield + terms.resurrection + terms.kingSafety
}

export function evaluatePosition(state: GameState): number {
  const scores = evaluatePositionBreakdown(state)
  return sumTerms(scores[state.currentPlayer]) - sumTerms(scores[state.currentPlayer === 'white' ? 'black' : 'white'])
}

export { CODE_FROM_PIECE_TYPE, sqIndex }
