import {
  BOARD_SIZE, COLORS, RESURRECTION_LIMIT,
  type Action, type Color, type GameState,
} from '../engine/model'
import { automaticDraw, claimableDraws } from '../engine/game'
import {
  DRAGON_TIMING_NONE, FastBoard, MAX_SEARCH_PLY, MOVE_KIND_CASTLE,
  MOVE_KIND_DRAGON, MOVE_KIND_PROMOTE, MOVE_KIND_RESURRECT,
  moveActorPid, moveAux, moveFromOrRevived, moveIsCaptureHint, moveKind, moveToSq,
  sqIndex,
} from './fastBoard'
import { evaluateFast, evaluateFastBreakdown, type EvaluationTerms } from './evaluation'
import {
  SearchHeuristics, collectImminentVictims, dragonConeBurnGain,
  isTacticalMove, pickNextMove, scoreMoves,
} from './moveOrder'
import { lookupOpeningBook } from './openingBook'
import { BOT_PROFILES } from './profiles'
import {
  BOT_MATE_SCORE, BOT_TURN_MS, type BotAnalysis, type BotDifficulty,
  type BotThinking, type SearchProfileId,
} from './protocol'
import { MG_VALUES } from './pst'
import { seeGe } from './see'
import {
  CorrectionHistory, PawnTable, TT_BOUND_EXACT, TT_BOUND_LOWER,
  TT_BOUND_UPPER, TranspositionTable, type TTProbeResult,
} from './tt'
import {
  CASTLING_KEY_HI, CASTLING_KEY_LO, CODE_FROM_PIECE_TYPE, EP_PAWN_KEY_HI,
  EP_PAWN_KEY_LO, EP_SQ_KEY_HI, EP_SQ_KEY_LO, FIRE_KEY_HI, FIRE_KEY_LO,
  GRAVEYARD_SLOT, MAX_FIRE_TURNS, NUM_PIECE_TYPES, NUM_SQUARES, PT_PAWN,
  QUOTA_KEY_HI, QUOTA_KEY_LO, SIDE_KEY_HI, SIDE_KEY_LO, colorToCode,
  getPieceHi, getPieceLo, pieceZobristIndex,
} from './zobrist'

const THINKING_INTERVAL_MS = 100
const MAX_QUIESCENCE_PLIES = 5
const MAX_FORCED_QPLIES = 3
const MAX_FIRE_REPLIES = 6
const INF = 1_000_000_000
const searchStopped = Symbol('search budget exhausted')

export interface SearchOptions {
  timeMs?: number
  maxDepth?: number
  maxNodes?: number
  now?: () => number
  onProgress?: (analysis: BotAnalysis) => void
  onThinking?: (thinking: BotThinking) => void
  difficulty?: SearchProfileId
  smartTime?: boolean
  useBook?: boolean
  pondering?: boolean
  tt?: TranspositionTable
  pawnTable?: PawnTable
  corrHist?: CorrectionHistory
  heuristics?: SearchHeuristics
  abortView?: Int32Array
  helperId?: number
  seed?: number
}

interface PreRootHistory {
  byLo: Map<number, { hi: number; count: number }[]>
  fallbackStrings: Map<string, number>
  hasMultiple: boolean
}

function buildPreRootHistory(state: GameState, board: FastBoard): PreRootHistory {
  const byLo = new Map<number, { hi: number; count: number }[]>()
  const fallbackStrings = new Map<string, number>()
  const pidById = new Map<string, number>()
  for (let pid = 0; pid < board.pieceCount; pid++) pidById.set(board.idByPid[pid], pid)

  const stringCounts = new Map<string, number>()
  for (const key of state.repetitionHistory) {
    stringCounts.set(key, (stringCounts.get(key) ?? 0) + 1)
  }

  let hasMultiple = false
  for (const [key, count] of stringCounts) {
    if (count > 1) hasMultiple = true
    try {
      const parsed = JSON.parse(key) as [
        Color,
        [[boolean, boolean], [boolean, boolean]],
        [number, number, string] | null,
        [string, Color, string, string, number, number, [number, number] | null, boolean][],
        [string[], string[]],
        number[],
        [Color, number, number, number][],
      ]
      const [player, castlingArr, epArr, piecesArr, , quotasArr, fireArr] = parsed
      if (!Array.isArray(piecesArr) || piecesArr.length !== board.pieceCount) {
        fallbackStrings.set(key, count)
        continue
      }
      let lo = 0
      let hi = 0
      if (player === 'black') {
        lo = (lo ^ SIDE_KEY_LO) >>> 0
        hi = (hi ^ SIDE_KEY_HI) >>> 0
      }
      let cMask = 0
      if (castlingArr[0][0]) cMask |= 1
      if (castlingArr[0][1]) cMask |= 2
      if (castlingArr[1][0]) cMask |= 4
      if (castlingArr[1][1]) cMask |= 8
      lo = (lo ^ CASTLING_KEY_LO[cMask]) >>> 0
      hi = (hi ^ CASTLING_KEY_HI[cMask]) >>> 0

      if (epArr) {
        const epSq = sqIndex(epArr[0], epArr[1])
        const epPid = pidById.get(epArr[2])
        if (epPid === undefined) {
          fallbackStrings.set(key, count)
          continue
        }
        lo = (lo ^ EP_SQ_KEY_LO[epSq] ^ EP_PAWN_KEY_LO[epPid]) >>> 0
        hi = (hi ^ EP_SQ_KEY_HI[epSq] ^ EP_PAWN_KEY_HI[epPid]) >>> 0
      }

      let mismatch = false
      for (let i = 0; i < piecesArr.length; i++) {
        const p = piecesArr[i]
        const pid = pidById.get(p[0])
        if (pid === undefined) { mismatch = true; break }
        const baseType = CODE_FROM_PIECE_TYPE[p[2] as keyof typeof CODE_FROM_PIECE_TYPE]
        const currType = CODE_FROM_PIECE_TYPE[p[3] as keyof typeof CODE_FROM_PIECE_TYPE]
        const slot = p[6] ? sqIndex(p[6][0], p[6][1]) : GRAVEYARD_SLOT
        const hasMoved = p[7] ? 1 : 0
        const zIdx = pieceZobristIndex(pid, slot, baseType, currType, hasMoved)
        lo = (lo ^ getPieceLo(zIdx)) >>> 0
        hi = (hi ^ getPieceHi(zIdx)) >>> 0
      }
      if (mismatch) {
        fallbackStrings.set(key, count)
        continue
      }

      const quotaOrder = ['queen', 'rook', 'bishop', 'knight', 'necromancer', 'dragon', 'shielder', 'pawn'] as const
      const qFlat = quotasArr as unknown as [number[], number[]]
      for (let c = 0; c < 2; c++) {
        for (let qi = 0; qi < quotaOrder.length; qi++) {
          const t = CODE_FROM_PIECE_TYPE[quotaOrder[qi]]
          const used = qFlat[c][qi] ?? 0
          const qIdx = (c * NUM_PIECE_TYPES + t) * 4 + used
          lo = (lo ^ QUOTA_KEY_LO[qIdx]) >>> 0
          hi = (hi ^ QUOTA_KEY_HI[qIdx]) >>> 0
        }
      }

      for (const [ownerName, f, r, rem] of fireArr) {
        if (rem <= 0) continue
        const owner = colorToCode(ownerName)
        const sq = sqIndex(f, r)
        const fk = ((owner * NUM_SQUARES + sq) * MAX_FIRE_TURNS) + Math.min(rem, MAX_FIRE_TURNS - 1)
        lo = (lo ^ FIRE_KEY_LO[fk]) >>> 0
        hi = (hi ^ FIRE_KEY_HI[fk]) >>> 0
      }

      const bucket = byLo.get(lo)
      if (bucket) bucket.push({ hi, count })
      else byLo.set(lo, [{ hi, count }])
    } catch {
      fallbackStrings.set(key, count)
    }
  }

  return { byLo, fallbackStrings, hasMultiple }
}

function getPreRootCount(hist: PreRootHistory, board: FastBoard): number {
  const bucket = hist.byLo.get(board.hashLo)
  if (bucket) {
    for (let i = 0; i < bucket.length; i++) {
      if (bucket[i].hi === board.hashHi) return bucket[i].count
    }
  }
  if (hist.fallbackStrings.size > 0) {
    return hist.fallbackStrings.get(board.toPositionKeyString()) ?? 0
  }
  return 0
}

function splitMixPrng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x9e3779b9) >>> 0
    let z = s
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0
    return ((z ^ (z >>> 16)) >>> 0) / 0x100000000
  }
}

function lmrReduction(depth: number, moveIndex: number, isPv: boolean, improving: boolean): number {
  if (depth < 3 || moveIndex < 3) return 0
  let r = Math.floor(0.75 + Math.log(depth) * Math.log(moveIndex) / 2.15)
  if (isPv && r > 0) r--
  if (!improving && depth >= 4) r++
  return Math.max(0, Math.min(depth - 2, r))
}

export function searchBot(position: GameState, options: SearchOptions = {}): BotAnalysis | null {
  if (position.status.kind !== 'active') return null

  const customClock = options.now !== undefined
  const now = options.now ?? (() => performance.now())
  const start = now()

  const profileId: SearchProfileId = options.difficulty ?? 'max'
  const profile = BOT_PROFILES[profileId]
  const helperId = options.helperId ?? 0

  const timeMs = options.timeMs ?? BOT_TURN_MS
  const maxNodes = Number.isFinite(options.maxNodes) ? Math.max(0, Math.floor(options.maxNodes!)) : Infinity
  const timeBudget = Number.isFinite(timeMs)
    ? Math.max(0, timeMs)
    : timeMs === Infinity && maxNodes !== Infinity ? Infinity : BOT_TURN_MS
  const hardDeadline = start + timeBudget
  const maxDepth = Math.min(MAX_SEARCH_PLY - 8, options.maxDepth ?? profile.maxDepth)
  const useBook = options.useBook ?? false
  const smartTime = options.smartTime ?? false

  // Opening Book shortcut (only when explicitly enabled and not in deterministic test mode)
  if (useBook && helperId === 0 && !options.pondering) {
    const bookAction = lookupOpeningBook(position, profileId === 'max' || profileId === 'hard')
    if (bookAction) {
      const breakdown = evaluateFastBreakdown(FastBoard.fromGameState(position))
      const elapsedMs = Math.round(now() - start)
      return {
        decision: { kind: 'play', action: bookAction },
        depth: 1,
        selDepth: 1,
        principalVariation: [bookAction],
        score: 0,
        nodes: 1,
        elapsedMs,
        nps: 0,
        ttHitRate: 0,
        bookMove: true,
        pondering: false,
        evalBreakdown: breakdown,
      }
    }
  }

  const board = FastBoard.fromGameState(position)
  const preRoot = buildPreRootHistory(position, board)
  const rootRepCount = Math.max(1, getPreRootCount(preRoot, board))
  if (automaticDraw(position, rootRepCount)) return null
  const rootClaim = claimableDraws(position, rootRepCount)[0]

  // Generate legal root moves BEFORE touching node budget so depth-0 emergency fallback is always ready
  const rootBuf = new Int32Array(256)
  const rootScores = new Int32Array(256)
  const pseudoCount = board.generatePseudoMoves(rootBuf, true, false)
  const rootMover = board.sideToMove
  const rootMovesArr: number[] = []
  for (let i = 0; i < pseudoCount; i++) {
    const m = rootBuf[i]
    board.makeMove(m)
    const ok = !board.isInCheck(rootMover)
    board.unmakeMove()
    if (ok) rootMovesArr.push(m)
  }
  if (rootMovesArr.length === 0) return null

  const heuristics = options.heuristics ?? new SearchHeuristics()
  if (options.heuristics) heuristics.decayForNewSearch()
  const tt = options.tt ?? new TranspositionTable(16)
  if (!options.tt) tt.clear()
  else tt.newSearch()
  const pawnTable = options.pawnTable ?? new PawnTable(14)
  const corrHist = options.corrHist ?? new CorrectionHistory()

  const rootImminent = new Uint8Array(64)
  const rootImminentCount = collectImminentVictims(board, rootImminent)
  const rootPacked = new Int32Array(rootMovesArr)
  const rootProbe: TTProbeResult = { hit: false, bestMove: 0, score: 0, staticEval: 0, depth: 0, bound: 0 }
  tt.probe(board.hashLo, board.hashHi, 0, rootProbe)
  scoreMoves(
    board,
    rootPacked,
    rootScores,
    rootPacked.length,
    rootProbe.hit ? rootProbe.bestMove : 0,
    0,
    heuristics,
    rootImminent,
    rootImminentCount,
    -1,
    -1,
  )
  for (let i = 0; i < rootPacked.length; i++) pickNextMove(rootPacked, rootScores, i, rootPacked.length)

  const fallbackAction = board.decodeAction(rootPacked[0])
  const rootBreakdown = evaluateFastBreakdown(board, pawnTable)

  let nodes = 0
  let selDepth = 0
  let ttProbes = 0
  let ttHits = 0
  let currentDepth = 0
  let lastThinkingAt = start
  const abortView = options.abortView

  let best: BotAnalysis = {
    decision: { kind: 'play', action: fallbackAction },
    depth: 0,
    selDepth: 0,
    principalVariation: [fallbackAction],
    score: 0,
    nodes: 0,
    elapsedMs: 0,
    nps: 0,
    ttHitRate: 0,
    pondering: options.pondering,
    evalBreakdown: rootBreakdown,
  }

  // Per-ply search stacks (zero-allocation during search)
  const moveBufs = Array.from({ length: MAX_SEARCH_PLY + 4 }, () => new Int32Array(256))
  const scoreBufs = Array.from({ length: MAX_SEARCH_PLY + 4 }, () => new Int32Array(256))
  const quietBufs = Array.from({ length: MAX_SEARCH_PLY + 4 }, () => new Int32Array(256))
  const imminentBufs = Array.from({ length: MAX_SEARCH_PLY + 4 }, () => new Uint8Array(64))
  const pvTable = Array.from({ length: MAX_SEARCH_PLY + 4 }, () => new Int32Array(MAX_SEARCH_PLY + 4))
  const pvLen = new Int32Array(MAX_SEARCH_PLY + 4)
  const hashStackLo = new Uint32Array(MAX_SEARCH_PLY + 4)
  const hashStackHi = new Uint32Array(MAX_SEARCH_PLY + 4)
  const staticEvalStack = new Int32Array(MAX_SEARCH_PLY + 4)
  const prevTypeStack = new Int32Array(MAX_SEARCH_PLY + 4).fill(-1)
  const prevToStack = new Int32Array(MAX_SEARCH_PLY + 4).fill(-1)

  hashStackLo[0] = board.hashLo
  hashStackHi[0] = board.hashHi

  const probeRes: TTProbeResult = { hit: false, bestMove: 0, score: 0, staticEval: 0, depth: 0, bound: 0 }
  const rng = profile.evalNoiseCp > 0 ? splitMixPrng((options.seed ?? 12012) ^ board.hashLo) : null
  const isClassic = profileId === 'classic'

  function publishThinking(sampled: number) {
    if (helperId > 0) return
    lastThinkingAt = sampled
    const elapsedMs = Math.max(0, Math.round(sampled - start))
    options.onThinking?.({
      currentDepth,
      selDepth,
      nodes,
      elapsedMs,
      nps: elapsedMs > 0 ? Math.round((nodes * 1000) / elapsedMs) : 0,
      pondering: options.pondering,
    })
  }

  function checkBudget(forceClock = false) {
    if (abortView && Atomics.load(abortView, 0) !== 0) {
      throw searchStopped
    }
    if (nodes >= maxNodes) throw searchStopped
    if (customClock || forceClock || (nodes & 127) === 0) {
      const needClock = hardDeadline !== Infinity || options.onThinking !== undefined
      const sampled = needClock ? now() : start
      if (sampled >= hardDeadline) throw searchStopped
      if (options.onThinking && currentDepth > 0 && sampled - lastThinkingAt >= THINKING_INTERVAL_MS) {
        publishThinking(sampled)
      }
    }
  }

  function countRepetitions(ply: number): { total: number; inTree: number } {
    const lo = board.hashLo
    const hi = board.hashHi
    let inTree = 0
    const minPly = Math.max(0, ply - board.halfMoveClock)
    for (let p = ply - 2; p >= minPly; p -= 2) {
      if (hashStackLo[p] === lo && hashStackHi[p] === hi) inTree++
    }
    const pre = getPreRootCount(preRoot, board)
    return { total: 1 + inTree + pre, inTree }
  }

  function extractPv(ply: number): Action[] {
    const len = pvLen[ply]
    const actions: Action[] = []
    for (let i = 0; i < len; i++) {
      actions.push(board.decodeAction(pvTable[ply][i]))
    }
    return actions
  }

  function quiescence(ply: number, qPly: number, inCheck: boolean, alpha: number, beta: number): number {
    checkBudget()
    nodes++
    if (ply > selDepth) selDepth = ply
    pvLen[ply] = 0

    if (ply >= MAX_SEARCH_PLY - 2) {
      return evaluateFast(board, pawnTable)
    }

    const reps = countRepetitions(ply)
    if (reps.total >= 5 || board.halfMoveClock >= 150 || board.isBareKings()) return 0
    if (ply > 0 && reps.inTree >= 1) return 0

    const claimable = reps.total >= 3 || board.halfMoveClock >= 100
    const imm = imminentBufs[ply]
    const immCount = collectImminentVictims(board, imm)
    const forced = inCheck || immCount > 0
    const atLimit = qPly >= (forced ? MAX_FORCED_QPLIES : MAX_QUIESCENCE_PLIES)

    let bestScore = -INF
    if (!forced || atLimit) {
      const rawEval = evaluateFast(board, pawnTable)
      bestScore = corrHist.correct(board.sideToMove, board.pawnHashLo, rawEval)
      if (claimable && bestScore < 0) bestScore = 0
      if (bestScore >= beta || atLimit) return bestScore
      if (bestScore > alpha) alpha = bestScore
    } else if (claimable) {
      bestScore = 0
      if (bestScore >= beta) return bestScore
      if (bestScore > alpha) alpha = bestScore
    }

    const moves = moveBufs[ply]
    const scores = scoreBufs[ply]
    // When forced (in check or imminent friendly fire) or qPly === 0, generate all pseudo moves and filter;
    // otherwise use tacticalOnly generation for huge speedup!
    const tacticalOnly = !forced
    const pCount = board.generatePseudoMoves(moves, true, tacticalOnly)
    const allowFire = !forced && qPly === 0

    let candCount = 0
    for (let i = 0; i < pCount; i++) {
      const m = moves[i]
      if (forced) {
        if (!inCheck) {
          const kind = moveKind(m)
          const pid = moveActorPid(m)
          const keep = kind === MOVE_KIND_CASTLE ||
            (kind !== MOVE_KIND_RESURRECT && imm[pid] !== 0) ||
            isTacticalMove(board, m, false)
          if (!keep) continue
        }
      } else {
        if (!isTacticalMove(board, m, allowFire)) continue
        // Delta & SEE pruning for quiet tactical captures (not promotions, not Dragon fire)
        const kind = moveKind(m)
        if (kind !== MOVE_KIND_PROMOTE && !(kind === MOVE_KIND_DRAGON && moveAux(m) !== DRAGON_TIMING_NONE)) {
          if (!seeGe(board, m, 0)) continue
          const toSq = moveToSq(m)
          const vicPid = board.squares[toSq]
          const vicVal = vicPid >= 0 ? MG_VALUES[board.typeByPid[vicPid]] : MG_VALUES[PT_PAWN]
          if (bestScore + vicVal + 180 < alpha) continue
        }
      }
      moves[candCount++] = m
    }

    // If forced by fire (not check) and all threatened pieces are trapped with no tactical moves,
    // ensure we still try a few quiet moves so we never return -INF on a non-mate board!
    if (forced && !inCheck && candCount === 0) {
      for (let i = 0; i < pCount && candCount < MAX_FIRE_REPLIES; i++) {
        moves[candCount++] = moves[i]
      }
    }

    const prevType = prevTypeStack[ply]
    const prevTo = prevToStack[ply]
    scoreMoves(board, moves, scores, candCount, 0, ply, heuristics, imm, immCount, prevType, prevTo)

    const mover = board.sideToMove
    const limit = forced && !inCheck ? Math.min(candCount, MAX_FIRE_REPLIES) : candCount
    let legalCount = 0

    for (let i = 0; i < limit; i++) {
      const m = pickNextMove(moves, scores, i, candCount)
      board.makeMove(m)
      if (board.isInCheck(mover)) {
        board.unmakeMove()
        continue
      }
      legalCount++
      const childInCheck = board.isInCheck(board.sideToMove)
      hashStackLo[ply + 1] = board.hashLo
      hashStackHi[ply + 1] = board.hashHi
      const mKind = moveKind(m)
      prevTypeStack[ply + 1] = mKind === MOVE_KIND_RESURRECT || mKind === MOVE_KIND_CASTLE ? -1 : board.typeByPid[moveActorPid(m)]
      prevToStack[ply + 1] = moveToSq(m)

      const score = -quiescence(ply + 1, qPly + 1, childInCheck, -beta, -alpha)
      board.unmakeMove()

      if (score > bestScore) {
        bestScore = score
        if (score > alpha) {
          alpha = score
          pvTable[ply][0] = m
          const cLen = pvLen[ply + 1]
          for (let k = 0; k < cLen; k++) pvTable[ply][1 + k] = pvTable[ply + 1][k]
          pvLen[ply] = 1 + cLen
          if (alpha >= beta) return beta
        }
      }
    }

    // If forced by check/fire, check if any legal move exists at all (e.g., if fire forced checkmate or all filtered moves were illegal)
    if (forced && legalCount === 0) {
      if (inCheck) return ply - BOT_MATE_SCORE
      // Imminent fire had no legal move among filtered moves -> check all pseudo moves for mate/stalemate
      for (let i = 0; i < pCount; i++) {
        const m = moves[i]
        board.makeMove(m)
        const ok = !board.isInCheck(mover)
        if (ok) {
          const childCheck = board.isInCheck(board.sideToMove)
          hashStackLo[ply + 1] = board.hashLo
          hashStackHi[ply + 1] = board.hashHi
          const score = -quiescence(ply + 1, qPly + 1, childCheck, -beta, -alpha)
          board.unmakeMove()
          if (score > bestScore) {
            bestScore = score
            if (score > alpha) {
              alpha = score
              pvTable[ply][0] = m
              const cLen = pvLen[ply + 1]
              for (let k = 0; k < cLen; k++) pvTable[ply][1 + k] = pvTable[ply + 1][k]
              pvLen[ply] = 1 + cLen
            }
          }
          legalCount++
          if (alpha >= beta) return beta
          break
        }
        board.unmakeMove()
      }
      if (legalCount === 0) return 0
    }

    return bestScore
  }

  function negamax(
    depth: number,
    ply: number,
    alpha: number,
    beta: number,
    inCheck: boolean,
    allowNull: boolean,
    excludedMove: number,
  ): number {
    if (depth <= 0) {
      return quiescence(ply, 0, inCheck, alpha, beta)
    }

    checkBudget()
    nodes++
    if (ply > selDepth) selDepth = ply
    pvLen[ply] = 0

    if (ply >= MAX_SEARCH_PLY - 2) {
      return evaluateFast(board, pawnTable)
    }

    const isRoot = ply === 0
    const isPv = beta - alpha > 1

    if (!isRoot) {
      const reps = countRepetitions(ply)
      if (reps.total >= 5 || board.halfMoveClock >= 150 || board.isBareKings()) return 0
      if (reps.inTree >= 1) return 0

      // Mate distance pruning
      const mateAlpha = Math.max(alpha, ply - BOT_MATE_SCORE)
      const mateBeta = Math.min(beta, BOT_MATE_SCORE - ply - 1)
      if (mateAlpha >= mateBeta) return mateAlpha
    }

    // TT probe (disabled when searching with an excludedMove for Singular Extension)
    let ttHit = false
    let ttMove = 0
    let ttScore = 0
    let ttDepth = -1
    let ttBound = 0
    if (excludedMove === 0) {
      ttProbes++
      if (tt.probe(board.hashLo, board.hashHi, ply, probeRes)) {
        ttHits++
        ttHit = true
        ttMove = probeRes.bestMove
        ttScore = probeRes.score
        ttDepth = probeRes.depth
        ttBound = probeRes.bound
        if (!isRoot && !isPv && ttDepth >= depth && board.halfMoveClock < 90) {
          if (
            ttBound === TT_BOUND_EXACT ||
            (ttBound === TT_BOUND_LOWER && ttScore >= beta) ||
            (ttBound === TT_BOUND_UPPER && ttScore <= alpha)
          ) {
            return ttScore
          }
        }
      }
    }

    // Static eval + Correction History
    const rawEval = evaluateFast(board, pawnTable)
    const staticEval = corrHist.correct(board.sideToMove, board.pawnHashLo, rawEval)
    staticEvalStack[ply] = staticEval
    const improving = ply >= 2 && !inCheck && staticEval > staticEvalStack[ply - 2]

    // Internal Iterative Reduction (IIR)
    if (depth >= 4 && ttMove === 0 && excludedMove === 0 && !isRoot) {
      depth--
    }

    // Reverse Futility Pruning (RFP) — skipped if fire is active or inCheck
    if (!isRoot && !isPv && !inCheck && excludedMove === 0 && board.activeFireCount === 0 && depth <= 4) {
      const rfpMargin = (improving ? 85 : 120) * depth
      if (staticEval - rfpMargin >= beta) {
        return staticEval - rfpMargin
      }
    }

    // Fire-Safe Null Move Pruning
    if (
      profile.useNmp &&
      !isRoot &&
      !isPv &&
      !inCheck &&
      allowNull &&
      excludedMove === 0 &&
      board.activeFireCount === 0 &&
      depth >= 3 &&
      staticEval >= beta &&
      board.nonPawnMaterialValue(board.sideToMove) >= 850
    ) {
      const R = 3 + Math.floor(depth / 4) + (staticEval - beta >= 220 ? 1 : 0)
      board.makeNullMove()
      hashStackLo[ply + 1] = board.hashLo
      hashStackHi[ply + 1] = board.hashHi
      prevTypeStack[ply + 1] = -1
      prevToStack[ply + 1] = -1
      const nullScore = -negamax(depth - 1 - R, ply + 1, -beta, -beta + 1, false, false, 0)
      board.unmakeNullMove()

      if (nullScore >= beta) {
        if (nullScore >= BOT_MATE_SCORE - 512) return beta
        if (depth <= 8) return nullScore
        // Verification search at high depth
        const verif = negamax(depth - R, ply, beta - 1, beta, false, false, 0)
        if (verif >= beta) return nullScore
      }
    }

    // Move generation (or reuse ordered root moves at ply === 0)
    const moves = moveBufs[ply]
    const scores = scoreBufs[ply]
    let candCount = 0
    const imm = imminentBufs[ply]
    const immCount = isRoot ? rootImminentCount : collectImminentVictims(board, imm)
    const prevType = prevTypeStack[ply]
    const prevTo = prevToStack[ply]

    if (isRoot) {
      candCount = rootPacked.length
      for (let i = 0; i < candCount; i++) moves[i] = rootPacked[i]
      scoreMoves(board, moves, scores, candCount, ttMove, 0, heuristics, rootImminent, rootImminentCount, -1, -1)
    } else {
      candCount = board.generatePseudoMoves(moves, true, false)
      scoreMoves(board, moves, scores, candCount, ttMove, ply, heuristics, imm, immCount, prevType, prevTo)
    }

    const mover = board.sideToMove
    const initialAlpha = alpha
    let bestScore = isRoot && rootClaim ? 0 : -INF
    let bestMove = 0
    let legalCount = 0
    let quietCount = 0
    const searchedQuiets = quietBufs[ply]

    if (bestScore > alpha) alpha = bestScore

    for (let i = 0; i < candCount; i++) {
      const m = pickNextMove(moves, scores, i, candCount)
      if (m === excludedMove && excludedMove !== 0) continue

      const kind = moveKind(m)
      const actorPid = moveActorPid(m)
      const isCapOrPromo = moveIsCaptureHint(m) || kind === MOVE_KIND_PROMOTE
      const isEvac = immCount > 0 && kind !== MOVE_KIND_RESURRECT && kind !== MOVE_KIND_CASTLE && imm[actorPid] !== 0
      const isFireAtk = kind === MOVE_KIND_DRAGON && moveAux(m) !== DRAGON_TIMING_NONE && dragonConeBurnGain(board, m) > 0
      const isQuiet = !isCapOrPromo && !isEvac && !isFireAtk

      // Late Move Pruning & Futility Pruning for late quiet moves at shallow depths
      if (!isRoot && !isPv && !inCheck && legalCount >= 1 && isQuiet && bestScore > -BOT_MATE_SCORE + 512) {
        if (depth <= 3 && quietCount >= (5 + depth * depth * (improving ? 2 : 1))) {
          continue
        }
        if (depth <= 2 && board.activeFireCount === 0 && staticEval + 135 * depth + 100 <= alpha) {
          continue
        }
      }

      // Check legality
      if (!isRoot) {
        board.makeMove(m)
        if (board.isInCheck(mover)) {
          board.unmakeMove()
          continue
        }
      } else {
        board.makeMove(m)
      }

      legalCount++
      if (isQuiet) searchedQuiets[quietCount++] = m

      const childInCheck = board.isInCheck(board.sideToMove)
      hashStackLo[ply + 1] = board.hashLo
      hashStackHi[ply + 1] = board.hashHi
      prevTypeStack[ply + 1] = kind === MOVE_KIND_RESURRECT || kind === MOVE_KIND_CASTLE ? -1 : board.typeByPid[actorPid]
      prevToStack[ply + 1] = moveToSq(m)

      // Extensions: Check extension & Singular Extension on TT move
      let extension = 0
      if (childInCheck && !isClassic) extension = 1
      else if (
        profile.useSingular &&
        !isRoot &&
        excludedMove === 0 &&
        m === ttMove &&
        depth >= 6 &&
        ttDepth >= depth - 3 &&
        (ttBound === TT_BOUND_LOWER || ttBound === TT_BOUND_EXACT) &&
        Math.abs(ttScore) < BOT_MATE_SCORE - 512
      ) {
        board.unmakeMove()
        const singularBeta = ttScore - depth * 2
        const sScore = negamax(Math.floor((depth - 1) / 2), ply, singularBeta - 1, singularBeta, inCheck, false, m)
        if (sScore < singularBeta) extension = 1
        board.makeMove(m)
        hashStackLo[ply + 1] = board.hashLo
        hashStackHi[ply + 1] = board.hashHi
        prevTypeStack[ply + 1] = kind === MOVE_KIND_RESURRECT || kind === MOVE_KIND_CASTLE ? -1 : board.typeByPid[actorPid]
        prevToStack[ply + 1] = moveToSq(m)
      }

      const newDepth = depth - 1 + extension
      let score: number

      if (legalCount === 1) {
        score = -negamax(newDepth, ply + 1, -beta, -alpha, childInCheck, true, 0)
      } else {
        // LMR for late quiet moves (protect checks, evacuations, fire attacks, and good captures)
        let R = 0
        if (profile.useLmr && isQuiet && !childInCheck && depth >= 3 && legalCount >= 4) {
          R = lmrReduction(depth, legalCount, isPv, improving)
          const hist = heuristics.getQuietHistory(mover, board.typeByPid[actorPid], moveToSq(m), prevType, prevTo)
          if (hist > 2000 && R > 0) R--
          else if (hist < -2000) R++
          R = Math.max(0, Math.min(newDepth - 1, R))
        }

        // Zero-window PVS probe
        score = -negamax(newDepth - R, ply + 1, -alpha - 1, -alpha, childInCheck, true, 0)
        if (R > 0 && score > alpha) {
          score = -negamax(newDepth, ply + 1, -alpha - 1, -alpha, childInCheck, true, 0)
        }
        if (score > alpha && score < beta) {
          score = -negamax(newDepth, ply + 1, -beta, -alpha, childInCheck, true, 0)
        }
      }

      board.unmakeMove()

      if (score > bestScore) {
        bestScore = score
        bestMove = m
        if (score > alpha) {
          alpha = score
          pvTable[ply][0] = m
          const cLen = pvLen[ply + 1]
          for (let k = 0; k < cLen; k++) pvTable[ply][1 + k] = pvTable[ply + 1][k]
          pvLen[ply] = 1 + cLen

          if (alpha >= beta) {
            if (isQuiet && !isClassic) {
              heuristics.recordKiller(ply, m)
              heuristics.recordCounter(mover, prevType, prevTo, m)
              const bonus = depth * depth
              heuristics.updateQuietStats(mover, board.typeByPid[actorPid], moveToSq(m), prevType, prevTo, bonus)
              for (let q = 0; q < quietCount - 1; q++) {
                const qm = searchedQuiets[q]
                heuristics.updateQuietStats(mover, board.typeByPid[moveActorPid(qm)], moveToSq(qm), prevType, prevTo, -bonus)
              }
            }
            break
          }
        }
      }
    }

    if (legalCount === 0) {
      if (excludedMove !== 0) return alpha
      return inCheck ? ply - BOT_MATE_SCORE : 0
    }

    if (excludedMove === 0 && bestMove !== 0) {
      const bound = bestScore >= beta ? TT_BOUND_LOWER : bestScore <= initialAlpha ? TT_BOUND_UPPER : TT_BOUND_EXACT
      tt.store(board.hashLo, board.hashHi, bestMove, bestScore, depth, bound, ply)

      if (!inCheck && !isRoot && Math.abs(bestScore) < BOT_MATE_SCORE - 512) {
        const bestKind = moveKind(bestMove)
        if (!moveIsCaptureHint(bestMove) && bestKind !== MOVE_KIND_PROMOTE) {
          if (bound === TT_BOUND_EXACT || (bound === TT_BOUND_LOWER && bestScore > staticEval) || (bound === TT_BOUND_UPPER && bestScore < staticEval)) {
            corrHist.update(mover, board.pawnHashLo, bestScore - staticEval, depth)
          }
        }
      }
    }

    // Small bounded noise for lower difficulty levels at root
    if (isRoot && rng && profile.evalNoiseCp > 0 && Math.abs(bestScore) < BOT_MATE_SCORE - 512) {
      bestScore += Math.round((rng() * 2 - 1) * profile.evalNoiseCp)
    }

    return bestScore
  }

  // Iterative Deepening + Aspiration Windows + Smart Time Control
  try {
    const inCheck = board.isInCheck(board.sideToMove)
    let prevScore = 0
    let prevBestMove = rootPacked[0]
    let stableDepths = 0

    for (let depth = 1; depth <= maxDepth; depth++) {
      checkBudget(true)
      const searchDepth = helperId > 0 && depth > 1 ? depth + (helperId % 2) : depth
      currentDepth = depth
      if (options.onThinking && helperId === 0) publishThinking(now())

      let score: number
      if (depth >= 4 && Math.abs(prevScore) < BOT_MATE_SCORE - 512 && !isClassic) {
        let delta = 38
        let aspAlpha = Math.max(-INF, prevScore - delta)
        let aspBeta = Math.min(INF, prevScore + delta)
        while (true) {
          score = negamax(searchDepth, 0, aspAlpha, aspBeta, inCheck, true, 0)
          if (score <= aspAlpha) {
            aspAlpha = Math.max(-INF, aspAlpha - delta)
            delta *= 3
            if (delta > 1500) aspAlpha = -INF
          } else if (score >= aspBeta) {
            aspBeta = Math.min(INF, aspBeta + delta)
            delta *= 3
            if (delta > 1500) aspBeta = INF
          } else {
            break
          }
        }
      } else {
        score = negamax(searchDepth, 0, -INF, INF, inCheck, true, 0)
      }

      const pv = extractPv(0)
      const chosenPacked = pvLen[0] > 0 ? pvTable[0][0] : 0
      const chosenAction = pv[0]

      // Keep top-K randomized selection for Easy difficulty
      let finalDecision: BotAnalysis['decision'] = chosenAction
        ? { kind: 'play', action: chosenAction }
        : rootClaim
          ? { kind: 'claim-draw', reason: rootClaim }
          : best.decision

      if (profile.topKChoice > 1 && chosenAction && rootPacked.length > 1 && depth === maxDepth && Math.abs(score) < BOT_MATE_SCORE - 512 && rng) {
        // Pick among top few moves that don't blunder horribly
        const k = Math.min(profile.topKChoice, rootPacked.length)
        const idx = Math.floor(rng() * k)
        if (idx > 0 && rootScores[0] - rootScores[idx] < 150_000) {
          const alt = board.decodeAction(rootPacked[idx])
          finalDecision = { kind: 'play', action: alt }
          pv[0] = alt
        }
      }

      const elapsedMs = Math.max(0, Math.round(now() - start))
      const nps = elapsedMs > 0 ? Math.round((nodes * 1000) / elapsedMs) : 0
      const ttHitRate = ttProbes > 0 ? Math.round((ttHits * 1000) / ttProbes) / 10 : 0

      best = {
        decision: finalDecision,
        depth,
        selDepth,
        principalVariation: chosenAction ? pv : [],
        score,
        nodes,
        elapsedMs,
        nps,
        ttHitRate,
        pondering: options.pondering,
        evalBreakdown: rootBreakdown,
      }

      // Move best root move to index 0 for next iteration
      if (chosenPacked !== 0) {
        const idx = rootPacked.indexOf(chosenPacked)
        if (idx > 0) {
          rootPacked.copyWithin(1, 0, idx)
          rootPacked[0] = chosenPacked
        }
      }

      if (chosenPacked === prevBestMove) stableDepths++
      else {
        prevBestMove = chosenPacked
        stableDepths = 0
      }

      const scoreDropped = depth >= 3 && score < prevScore - 60
      prevScore = score

      currentDepth = 0
      if (helperId === 0) options.onProgress?.(best)

      if (Math.abs(score) >= BOT_MATE_SCORE - 256) break

      // Smart time management (disabled when smartTime === false or pondering)
      if (smartTime && !options.pondering && timeBudget !== Infinity) {
        if (rootPacked.length === 1 && !rootClaim) break
        const elapsed = now() - start
        let softRatio = 0.72
        if (stableDepths >= 3 && !scoreDropped) softRatio = 0.52
        else if (scoreDropped) softRatio = 0.94
        if (elapsed >= timeBudget * softRatio) break
      }
    }
  } catch (error) {
    if (error !== searchStopped) throw error
  }

  const totalElapsed = Math.max(0, Math.round(now() - start))
  return {
    ...best,
    nodes,
    elapsedMs: totalElapsed,
    nps: totalElapsed > 0 ? Math.round((nodes * 1000) / totalElapsed) : best.nps ?? 0,
    ttHitRate: ttProbes > 0 ? Math.round((ttHits * 1000) / ttProbes) / 10 : best.ttHitRate ?? 0,
  }
}
