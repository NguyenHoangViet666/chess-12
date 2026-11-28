import type { BotDifficulty, SearchProfileId } from './protocol'

export interface BotProfile {
  id: SearchProfileId
  label: string
  maxDepth: number
  defaultTimeMs: number
  evalNoiseCp: number
  topKChoice: number
  useBook: boolean
  ponder: boolean
  smartTime: boolean
  useLmr: boolean
  useNmp: boolean
  useSingular: boolean
  smpHelpers: number
}

export const BOT_PROFILES: Record<SearchProfileId, BotProfile> = {
  easy: {
    id: 'easy',
    label: 'Easy · Beginner',
    maxDepth: 2,
    defaultTimeMs: 500,
    evalNoiseCp: 75,
    topKChoice: 3,
    useBook: true,
    ponder: false,
    smartTime: true,
    useLmr: false,
    useNmp: false,
    useSingular: false,
    smpHelpers: 0,
  },
  medium: {
    id: 'medium',
    label: 'Medium · Tactical',
    maxDepth: 4,
    defaultTimeMs: 1200,
    evalNoiseCp: 18,
    topKChoice: 1,
    useBook: true,
    ponder: false,
    smartTime: true,
    useLmr: true,
    useNmp: true,
    useSingular: false,
    smpHelpers: 0,
  },
  hard: {
    id: 'hard',
    label: 'Hard · Master',
    maxDepth: 64,
    defaultTimeMs: 2500,
    evalNoiseCp: 0,
    topKChoice: 1,
    useBook: true,
    ponder: true,
    smartTime: true,
    useLmr: true,
    useNmp: true,
    useSingular: true,
    smpHelpers: 0,
  },
  max: {
    id: 'max',
    label: 'Max · Grandmaster',
    maxDepth: 64,
    defaultTimeMs: 5000,
    evalNoiseCp: 0,
    topKChoice: 1,
    useBook: true,
    ponder: true,
    smartTime: true,
    useLmr: true,
    useNmp: true,
    useSingular: true,
    smpHelpers: 2,
  },
  classic: {
    id: 'classic',
    label: 'Classic · Baseline',
    maxDepth: 2,
    defaultTimeMs: 1500,
    evalNoiseCp: 12,
    topKChoice: 1,
    useBook: false,
    ponder: false,
    smartTime: false,
    useLmr: false,
    useNmp: false,
    useSingular: false,
    smpHelpers: 0,
  },
}

export const UI_DIFFICULTIES: readonly BotDifficulty[] = ['easy', 'medium', 'hard', 'max']
