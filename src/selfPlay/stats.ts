import { firePreview } from '../engine/fire'
import { COLORS, type Color, type DrawReason, type GameState, type PieceType } from '../engine/model'


type Counts<Key extends string | number> = Partial<Record<Key, number>>
type PieceCounts = Counts<PieceType>

export interface SideStats {
  /** Observed turns, including resurrection. Opening prefixes need not be observed. */
  plies: number
  turnsByType: PieceCounts
  /** Movement turns by acting piece. Castling is a King turn. */
  movesByType: PieceCounts
  /** Movement captures, including en passant and Dragon landing captures. */
  normalCaptures: number
  normalCapturesByType: PieceCounts
  normalVictimsByType: PieceCounts
  dragon: {
    moveOnly: number
    fireBefore: number
    fireAfter: number
    fireIgnitions: number
    fireCanceled: number
    fireHits: number
    multiBurns: number
    burnCaptures: number
    burnVictimsByType: PieceCounts
  }
  /** Observed protection events while this side was the defender. */
  shielder: {
    interceptedActivations: number
    cancelingShielders: number
    /** Turns that start with this King covered from an opposing Dragon cone. */
    kingCoveredTurns: number
  }
  resurrections: number
  revivedByType: PieceCounts
}

export type MatchStats = Record<Color, SideStats>

export type MatchOutcome =
  | { kind: 'win'; winner: Color }
  | { kind: 'draw'; reason: DrawReason }
  | { kind: 'capped' }

export interface MatchSummaryInput {
  outcome: MatchOutcome
  /** Total game length in plies, including any unobserved opening prefix. */
  plies: number
  stats: MatchStats
  /** Depth completed by each observed search. Fallback without search depth is depth zero. */
  depthCounts?: Counts<number>
  profiles?: Record<Color, string>
}

function makeSideStats(): SideStats {
  return {
    plies: 0,
    turnsByType: {},
    movesByType: {},
    normalCaptures: 0,
    normalCapturesByType: {},
    normalVictimsByType: {},
    dragon: {
      moveOnly: 0, fireBefore: 0, fireAfter: 0,
      fireIgnitions: 0, fireCanceled: 0, fireHits: 0, multiBurns: 0, burnCaptures: 0, burnVictimsByType: {},
    },
    shielder: {
      interceptedActivations: 0, cancelingShielders: 0, kingCoveredTurns: 0,
    },
    resurrections: 0,
    revivedByType: {},
  }
}

export function createMatchStats(): MatchStats {
  return { white: makeSideStats(), black: makeSideStats() }
}

function increment<Key extends string | number>(counts: Counts<Key>, key: Key, amount = 1) {
  counts[key] = (counts[key] ?? 0) + amount
}

/** Observes one successfully applied turn. Draw claims and opening history are separate. */
export function recordAction(stats: MatchStats, before: GameState, after: GameState): void {
  if (after.moveHistory.length !== before.moveHistory.length + 1) return
  const turn = after.moveHistory.at(-1)!
  const { action, color, pieceType } = turn
  const side = stats[color]
  side.plies++
  increment(side.turnsByType, pieceType)
  const kingCovered = Object.values(before.pieces).some(piece => {
    if (piece.type !== 'dragon' || piece.color === color || !piece.currentSquare) return false
    const preview = firePreview(before, piece)
    return preview.canceledBy.length > 0 && preview.cells.some(cell => cell.effect === 'king')
  })
  if (kingCovered) side.shielder.kingCoveredTurns++

  if (action.kind === 'resurrect') {
    side.resurrections++
    increment(side.revivedByType, before.pieces[action.revivedPieceId].baseType)
  } else {
    increment(side.movesByType, pieceType)
  }

  if (action.kind === 'dragon') {
    if (action.fireTiming === 'none') side.dragon.moveOnly++
    else {
      if (action.fireTiming === 'before') side.dragon.fireBefore++
      else side.dragon.fireAfter++
      if (turn.fire.created.length) side.dragon.fireIgnitions++
      if (turn.fire.canceledBy.length) side.dragon.fireCanceled++
      for (const shieldColor of COLORS) {
        const shieldCount = turn.fire.canceledBy.filter(id => before.pieces[id].color === shieldColor).length
        if (!shieldCount) continue
        stats[shieldColor].shielder.interceptedActivations++
        stats[shieldColor].shielder.cancelingShielders += shieldCount
      }
    }
  }

  const burned = new Set<string>()
  const burnCounts = { white: 0, black: 0 }
  for (const { pieceId, owner } of turn.fire.captures) {
    burned.add(pieceId)
    burnCounts[owner]++
    increment(stats[owner].dragon.burnVictimsByType, after.pieces[pieceId].type)
  }
  for (const owner of COLORS) {
    if (burnCounts[owner] > 0) stats[owner].dragon.fireHits++
    if (burnCounts[owner] > 1) stats[owner].dragon.multiBurns++
    stats[owner].dragon.burnCaptures += burnCounts[owner]
  }
  for (const captureId of turn.capturedIds) {
    if (burned.has(captureId)) continue
    side.normalCaptures++
    increment(side.normalCapturesByType, pieceType)
    increment(side.normalVictimsByType, before.pieces[captureId].type)
  }
}


function mergeCounts<Key extends string | number>(target: Counts<Key>, source: Counts<Key>) {
  for (const key of Object.keys(source) as Key[]) {
    const count = source[key]
    if (count !== undefined) increment(target, key, count)
  }
}

function mergeSide(target: SideStats, source: SideStats) {
  target.plies += source.plies
  mergeCounts(target.turnsByType, source.turnsByType)
  mergeCounts(target.movesByType, source.movesByType)
  target.normalCaptures += source.normalCaptures
  mergeCounts(target.normalCapturesByType, source.normalCapturesByType)
  mergeCounts(target.normalVictimsByType, source.normalVictimsByType)
  target.dragon.moveOnly += source.dragon.moveOnly
  target.dragon.fireBefore += source.dragon.fireBefore
  target.dragon.fireAfter += source.dragon.fireAfter
  target.dragon.fireIgnitions += source.dragon.fireIgnitions
  target.dragon.fireCanceled += source.dragon.fireCanceled
  target.dragon.fireHits += source.dragon.fireHits
  target.dragon.multiBurns += source.dragon.multiBurns
  target.dragon.burnCaptures += source.dragon.burnCaptures
  mergeCounts(target.dragon.burnVictimsByType, source.dragon.burnVictimsByType)
  target.shielder.interceptedActivations += source.shielder.interceptedActivations
  target.shielder.cancelingShielders += source.shielder.cancelingShielders
  target.shielder.kingCoveredTurns += source.shielder.kingCoveredTurns
  target.resurrections += source.resurrections
  mergeCounts(target.revivedByType, source.revivedByType)
}

function ratio(numerator: number, denominator: number, scale = 1): number | null {
  return denominator ? Math.round(100 * scale * numerator / denominator) / 100 : null
}

function sideSummary(stats: SideStats) {
  const fireActivations = stats.dragon.fireBefore + stats.dragon.fireAfter
  const dragonTurns = fireActivations + stats.dragon.moveOnly
  const captures = stats.normalCaptures + stats.dragon.burnCaptures
  const capturesByType = { ...stats.normalCapturesByType }
  if (stats.dragon.burnCaptures) increment(capturesByType, 'dragon', stats.dragon.burnCaptures)

  const capturesPer100TurnsByType: PieceCounts = {}
  for (const type of Object.keys(stats.turnsByType) as PieceType[]) {
    const rate = ratio(capturesByType[type] ?? 0, stats.turnsByType[type] ?? 0, 100)
    if (rate !== null) capturesPer100TurnsByType[type] = rate
  }
  return {
    ...stats,
    captures,
    capturesByType,
    dragon: { ...stats.dragon, turns: dragonTurns, fireActivations },
    rates: {
      normalCapturesPer100Plies: ratio(stats.normalCaptures, stats.plies, 100),
      burnCapturesPer100Plies: ratio(stats.dragon.burnCaptures, stats.plies, 100),
      resurrectionsPer100Plies: ratio(stats.resurrections, stats.plies, 100),
      fireActivationsPercentOfDragonTurns: ratio(fireActivations, dragonTurns, 100),
      fireCanceledPercentOfActivations: ratio(stats.dragon.fireCanceled, fireActivations, 100),
      fireHitPercentOfActivations: ratio(stats.dragon.fireHits, fireActivations, 100),
      multiBurnPercentOfActivations: ratio(stats.dragon.multiBurns, fireActivations, 100),
      burnCapturesPerActivation: ratio(stats.dragon.burnCaptures, fireActivations),
      kingCoveredPercentOfTurns: ratio(stats.shielder.kingCoveredTurns, stats.plies, 100),
      capturesPer100TurnsByType,
    },
  }
}

interface ProfileAccumulator {
  seats: number
  wins: number
  losses: number
  draws: number
  capped: number
  stats: SideStats
}

export function summarizeMatches(matches: readonly MatchSummaryInput[]) {
  const totals = makeSideStats()
  const byColor = createMatchStats()
  const profiles = new Map<string, ProfileAccumulator>()
  const outcomes = {
    whiteWins: 0, blackWins: 0, draws: 0, capped: 0,
    drawsByReason: {} as Counts<DrawReason>,
  }
  const depthCounts: Counts<number> = {}
  let totalPlies = 0
  let minPlies = Infinity
  let maxPlies = 0

  for (const match of matches) {
    totalPlies += match.plies
    minPlies = Math.min(minPlies, match.plies)
    maxPlies = Math.max(maxPlies, match.plies)
    const outcome = match.outcome
    if (outcome.kind === 'win') {
      if (outcome.winner === 'white') outcomes.whiteWins++
      else outcomes.blackWins++
    } else if (outcome.kind === 'draw') {
      outcomes.draws++
      increment(outcomes.drawsByReason, outcome.reason)
    } else {
      outcomes.capped++
    }
    if (match.depthCounts) mergeCounts(depthCounts, match.depthCounts)

    for (const color of COLORS) {
      const side = match.stats[color]
      mergeSide(totals, side)
      mergeSide(byColor[color], side)
      const name = match.profiles?.[color]
      if (name === undefined) continue
      let profile = profiles.get(name)
      if (!profile) {
        profile = { seats: 0, wins: 0, losses: 0, draws: 0, capped: 0, stats: makeSideStats() }
        profiles.set(name, profile)
      }
      profile.seats++
      if (outcome.kind === 'win') {
        if (outcome.winner === color) profile.wins++
        else profile.losses++
      } else if (outcome.kind === 'draw') profile.draws++
      else profile.capped++
      mergeSide(profile.stats, side)
    }
  }

  let searches = 0
  let depthSum = 0
  for (const [depth, count] of Object.entries(depthCounts)) {
    if (count === undefined) continue
    searches += count
    depthSum += Number(depth) * count
  }

  const profileSummaries = Array.from(profiles, ([name, { stats, ...results }]) => {
    const decided = results.wins + results.losses + results.draws
    const score = decided > 0 ? (results.wins + 0.5 * results.draws) / decided : null
    let eloDiff: number | null = null
    if (score !== null && profiles.size === 2) {
      const clamped = Math.max(0.01, Math.min(0.99, score))
      eloDiff = Math.round(-400 * Math.log10(1 / clamped - 1))
    }
    return {
      name,
      ...results,
      scorePercent: score !== null ? Math.round(score * 1000) / 10 : null,
      eloDiff,
      stats: sideSummary(stats),
    }
  })

  return {
    matches: matches.length,
    outcomes,
    lengths: {
      totalPlies,
      averagePlies: ratio(totalPlies, matches.length),
      minPlies: matches.length ? minPlies : null,
      maxPlies: matches.length ? maxPlies : null,
    },
    search: { searches, depthCounts, averageDepth: ratio(depthSum, searches) },
    totals: sideSummary(totals),
    byColor: { white: sideSummary(byColor.white), black: sideSummary(byColor.black) },
    byProfile: profileSummaries,
  }
}
