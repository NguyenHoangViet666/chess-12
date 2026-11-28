import { BOT_MATE_SCORE } from './protocol'

export const TT_BOUND_NONE = 0
export const TT_BOUND_EXACT = 1
export const TT_BOUND_LOWER = 2
export const TT_BOUND_UPPER = 3

const MATE_THRESHOLD = BOT_MATE_SCORE - 512

export interface TTProbeResult {
  hit: boolean
  bestMove: number
  score: number
  staticEval: number
  depth: number
  bound: number
}

/**
 * Lockless XOR Transposition Table (16 bytes per slot: 4 x Uint32/Int32).
 * Supports both SharedArrayBuffer (for Lazy SMP) and regular ArrayBuffer.
 */
export class TranspositionTable {
  readonly size: number
  readonly mask: number
  readonly buffer: ArrayBuffer | SharedArrayBuffer
  private words: Int32Array
  private uwords: Uint32Array
  generation = 0

  constructor(powerOfTwo = 18, sharedBuffer?: SharedArrayBuffer, allowShared = false) {
    if (sharedBuffer) {
      this.size = sharedBuffer.byteLength / 16
      this.mask = this.size - 1
      this.buffer = sharedBuffer
    } else {
      this.size = 1 << powerOfTwo
      this.mask = this.size - 1
      const byteLength = this.size * 16
      const canShare = allowShared && typeof SharedArrayBuffer !== 'undefined' &&
        (typeof globalThis.crossOriginIsolated !== 'boolean' || globalThis.crossOriginIsolated)
      this.buffer = canShare ? new SharedArrayBuffer(byteLength) : new ArrayBuffer(byteLength)
    }
    this.words = new Int32Array(this.buffer)
    this.uwords = new Uint32Array(this.buffer)
  }

  clear(): void {
    this.words.fill(0)
    this.generation = 0
  }

  newSearch(): void {
    this.generation = (this.generation + 1) & 0x3f
  }

  private index(hashLo: number): number {
    return (hashLo & this.mask) * 4
  }

  probe(hashLo: number, hashHi: number, ply: number, out: TTProbeResult): boolean {
    const idx = this.index(hashLo)
    const d0 = this.uwords[idx + 2]
    const d1 = this.uwords[idx + 3]
    const vLo = this.uwords[idx] ^ d0
    const vHi = this.uwords[idx + 1] ^ d1

    if (vLo !== (hashLo >>> 0) || vHi !== (hashHi >>> 0)) {
      out.hit = false
      out.bestMove = 0
      out.bound = TT_BOUND_NONE
      return false
    }

    const bound = d1 & 0x03
    const depth = (d1 >>> 2) & 0x7f
    const scoreRaw = (this.words[idx + 3] >> 15) // signed 17-bit? Wait: let's pack score cleanly in signed int16 or 18-bit!
    void scoreRaw

    // Clean packing in d1:
    // bits 0..1   (2): bound (0..3)
    // bits 2..8   (7): depth (0..127)
    // bits 9..14  (6): generation (0..63)
    // bits 15..31 (17): unused? Wait: we have d0 (32 bits for move!) and d1 (32 bits).
    // Move is 30 bits! What if we store staticEval separately or use 32-bit move + pack score in d1?
    // Wait: mate score is +/-100_000, which needs 18 signed bits (-131072..+131071)!
    // 2 + 7 + 6 + 18 = 33 bits! Almost fits in 32 bits if generation is 5 bits (0..31):
    // 2 (bound) + 7 (depth) + 5 (gen) + 18 (signed score: -131072..+131071) = 32 bits!!
    // Let's verify: BOT_MATE_SCORE is 100_000, max eval < 30_000, so +/-131_071 fits 100%!
    const rawScore = this.words[idx + 3] >> 14 // arithmetic right shift of upper 18 bits!
    let score = rawScore
    if (score >= MATE_THRESHOLD) score -= ply
    else if (score <= -MATE_THRESHOLD) score += ply

    out.hit = true
    out.bestMove = d0 | 0
    out.score = score
    out.staticEval = 0
    out.depth = depth
    out.bound = bound
    return true
  }

  store(hashLo: number, hashHi: number, bestMove: number, score: number, depth: number, bound: number, ply: number): void {
    const idx = this.index(hashLo)
    const oldD0 = this.uwords[idx + 2]
    const oldD1 = this.uwords[idx + 3]
    const oldLo = this.uwords[idx] ^ oldD0
    const oldHi = this.uwords[idx + 1] ^ oldD1
    const samePos = oldLo === (hashLo >>> 0) && oldHi === (hashHi >>> 0)

    if (oldD1 !== 0 && !samePos) {
      const oldDepth = (oldD1 >>> 2) & 0x7f
      const oldGen = (oldD1 >>> 9) & 0x1f
      const currentGen = this.generation & 0x1f
      // Age + depth-preferred replacement
      if (oldGen === currentGen && oldDepth > depth + 2 && bound !== TT_BOUND_EXACT) {
        return
      }
    }

    let storeMove = bestMove | 0
    if (samePos && storeMove === 0) {
      storeMove = oldD0 | 0
    }

    let normScore = Math.round(score)
    if (normScore >= MATE_THRESHOLD) normScore += ply
    else if (normScore <= -MATE_THRESHOLD) normScore -= ply
    if (normScore > 130_000) normScore = 130_000
    else if (normScore < -130_000) normScore = -130_000

    const clampedDepth = depth < 0 ? 0 : depth > 127 ? 127 : depth
    const gen5 = this.generation & 0x1f
    const d0 = storeMove >>> 0
    const d1 = ((bound & 0x03) | ((clampedDepth & 0x7f) << 2) | (gen5 << 9) | ((normScore & 0x3ffff) << 14)) >>> 0

    this.uwords[idx] = (hashLo ^ d0) >>> 0
    this.uwords[idx + 1] = (hashHi ^ d1) >>> 0
    this.uwords[idx + 2] = d0
    this.uwords[idx + 3] = d1
  }

  hashfullPermille(): number {
    let used = 0
    const sample = Math.min(1000, this.size)
    const gen5 = this.generation & 0x1f
    for (let i = 0; i < sample; i++) {
      const d1 = this.uwords[i * 4 + 3]
      if (d1 !== 0 && ((d1 >>> 9) & 0x1f) === gen5) used++
    }
    return Math.round((used * 1000) / sample)
  }
}

export class PawnTable {
  private readonly mask: number
  private keysLo: Uint32Array
  private keysHi: Uint32Array
  private scores: Int32Array // white-relative structure score (mg << 16 | eg? Or blended? Store mg and eg!)
  private scoresEg: Int32Array

  constructor(powerOfTwo = 14) {
    const size = 1 << powerOfTwo
    this.mask = size - 1
    this.keysLo = new Uint32Array(size)
    this.keysHi = new Uint32Array(size)
    this.scores = new Int32Array(size)
    this.scoresEg = new Int32Array(size)
  }

  clear(): void {
    this.keysLo.fill(0)
    this.keysHi.fill(0)
  }

  probe(lo: number, hi: number): { hit: boolean; mg: number; eg: number } {
    const idx = lo & this.mask
    if (this.keysLo[idx] === (lo >>> 0) && this.keysHi[idx] === (hi >>> 0) && (lo !== 0 || hi !== 0)) {
      return { hit: true, mg: this.scores[idx], eg: this.scoresEg[idx] }
    }
    return { hit: false, mg: 0, eg: 0 }
  }

  store(lo: number, hi: number, mg: number, eg: number): void {
    const idx = lo & this.mask
    this.keysLo[idx] = lo >>> 0
    this.keysHi[idx] = hi >>> 0
    this.scores[idx] = mg | 0
    this.scoresEg[idx] = eg | 0
  }
}

const CORR_SIZE = 16384
const CORR_MASK = CORR_SIZE - 1
const CORR_SCALE = 256
const CORR_MAX = 64 * 16

export class CorrectionHistory {
  private table = new Int16Array(2 * CORR_SIZE)

  clear(): void {
    this.table.fill(0)
  }

  correct(side: number, pawnHashLo: number, staticEval: number): number {
    const entry = this.table[side * CORR_SIZE + (pawnHashLo & CORR_MASK)]
    return staticEval + ((entry / CORR_SCALE) | 0)
  }

  update(side: number, pawnHashLo: number, diff: number, depth: number): void {
    const idx = side * CORR_SIZE + (pawnHashLo & CORR_MASK)
    const weight = Math.min(depth * depth + 1, 64)
    const scaledDiff = Math.max(-CORR_MAX, Math.min(CORR_MAX, diff * 16))
    const cur = this.table[idx]
    const next = ((cur * (CORR_SCALE - weight) + scaledDiff * weight) / CORR_SCALE) | 0
    this.table[idx] = Math.max(-CORR_MAX * 4, Math.min(CORR_MAX * 4, next))
  }
}
