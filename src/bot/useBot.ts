import { useCallback, useEffect, useRef, useState } from 'react'
import type { GameState } from '../engine/model'
import { executeBotInWorker, resetBotEngine, type BotExecutor } from './execute'
import {
  normalizeBotTime, type BotAnalysis, type BotDecision, type BotDifficulty,
  type BotResponse, type BotThinking,
} from './protocol'

export type BotDisplay =
  | { kind: 'thinking'; position: GameState; thinking: BotThinking | null; analysis: BotAnalysis | null }
  | { kind: 'complete'; position: GameState; analysis: BotAnalysis }
  | { kind: 'failed'; position: GameState; message: string }
  | { kind: 'paused'; position: GameState }

export interface UseBotOptions {
  difficulty?: BotDifficulty
  smartTime?: boolean
  useBook?: boolean
  ponderPosition?: GameState | null
  ponderEnabled?: boolean
}

interface ActiveSearch {
  cancel: () => void
  timeout: number
}

export function useBot(
  position: GameState | null,
  paused: boolean,
  timeMs: number,
  onDecision: (position: GameState, decision: BotDecision) => boolean,
  execute: BotExecutor = executeBotInWorker,
  options: UseBotOptions = {},
) {
  const {
    difficulty = 'max',
    smartTime = true,
    useBook = true,
    ponderPosition = null,
    ponderEnabled = false,
  } = options

  const active = useRef<ActiveSearch | null>(null)
  const failedPosition = useRef<GameState | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [snapshot, setSnapshot] = useState<BotDisplay | null>(null)
  const [ponderDisplay, setPonderDisplay] = useState<{ position: GameState; thinking: BotThinking | null; analysis: BotAnalysis | null } | null>(null)

  const stop = useCallback(() => {
    const run = active.current
    active.current = null
    if (!run) return
    window.clearTimeout(run.timeout)
    run.cancel()
  }, [])

  const pause = useCallback(() => {
    stop()
    setPonderDisplay(null)
    setSnapshot(previous => previous?.kind === 'thinking' ? null : previous)
  }, [stop])

  const reset = useCallback(() => {
    stop()
    failedPosition.current = null
    setPonderDisplay(null)
    setSnapshot(null)
    if (execute === executeBotInWorker) resetBotEngine()
  }, [execute, stop])

  const retry = useCallback(() => {
    stop()
    failedPosition.current = null
    setPonderDisplay(null)
    setSnapshot(null)
    setAttempt(previous => previous + 1)
  }, [stop])

  // Primary bot move search
  useEffect(() => {
    if (!position || paused || position === failedPosition.current) return

    setPonderDisplay(null)
    const root = position
    const normalizedTime = normalizeBotTime(timeMs)
    const watchdogMs = Math.max(15_000, normalizedTime * 2.5 + 8_000)

    const run: ActiveSearch = {
      cancel: () => {},
      timeout: window.setTimeout(() => failCurrent('The AI took too long to respond.'), watchdogMs),
    }
    active.current = run

    function fail(message: string) {
      failedPosition.current = root
      setSnapshot({ kind: 'failed', position: root, message })
    }

    function failCurrent(message: string) {
      if (active.current !== run) return
      stop()
      fail(message)
    }

    function receive(data: BotResponse) {
      if (active.current !== run) return
      if (data.kind === 'thinking' || data.kind === 'progress') {
        setSnapshot(previous => {
          const latest = previous?.kind === 'thinking' && previous.position === root ? previous : null
          return {
            kind: 'thinking',
            position: root,
            thinking: data.kind === 'thinking' ? data.thinking : latest?.thinking ?? null,
            analysis: data.kind === 'progress' ? data.analysis : latest?.analysis ?? null,
          }
        })
        return
      }

      if (data.kind === 'error') {
        failCurrent(data.message)
        return
      }

      stop()
      try {
        if (onDecision(root, data.analysis.decision)) {
          setSnapshot({ kind: 'complete', position: root, analysis: data.analysis })
        } else {
          fail('The AI returned an illegal action.')
        }
      } catch {
        fail('The AI returned an invalid response.')
      }
    }

    try {
      run.cancel = execute({
        kind: 'search',
        position: root,
        timeMs: normalizedTime,
        difficulty,
        smartTime,
        useBook,
      }, receive)
    } catch (error) {
      failCurrent(error instanceof Error ? error.message : 'The AI could not start.')
    }

    return () => { if (active.current === run) stop() }
  }, [attempt, difficulty, execute, onDecision, paused, position, smartTime, stop, timeMs, useBook])

  // Background pondering during human turn
  useEffect(() => {
    if (position || paused || !ponderEnabled || !ponderPosition) {
      setPonderDisplay(null)
      return
    }
    if (typeof document !== 'undefined' && document.hidden) return

    let cancelled = false
    const target = ponderPosition
    let cancelPonder = () => {}

    try {
      cancelPonder = execute({
        kind: 'search',
        position: target,
        timeMs: 30_000,
        difficulty,
        smartTime: false,
        useBook: false,
        pondering: true,
      }, data => {
        if (cancelled) return
        if (data.kind === 'thinking') {
          setPonderDisplay(prev => ({
            position: target,
            thinking: data.thinking,
            analysis: prev?.position === target ? prev.analysis : null,
          }))
        } else if (data.kind === 'progress' || data.kind === 'done') {
          setPonderDisplay(prev => ({
            position: target,
            thinking: prev?.position === target ? prev.thinking : null,
            analysis: data.analysis,
          }))
        }
      })
    } catch {
      // Pondering is best-effort
    }

    return () => {
      cancelled = true
      cancelPonder()
    }
  }, [difficulty, execute, paused, ponderEnabled, ponderPosition, position])

  let display: BotDisplay | null = null
  if (position) {
    display = paused ? { kind: 'paused', position }
      : snapshot?.position === position ? snapshot
      : { kind: 'thinking', position, thinking: null, analysis: null }
  } else if (snapshot?.kind === 'complete') {
    display = snapshot
  }

  return { display, ponderDisplay, pause, reset, retry }
}

export function useBotHint(
  execute: BotExecutor = executeBotInWorker,
) {
  const cancelRef = useRef<(() => void) | null>(null)
  const [hint, setHint] = useState<{
    position: GameState
    status: 'thinking' | 'complete' | 'failed'
    thinking: BotThinking | null
    analysis: BotAnalysis | null
    error?: string
  } | null>(null)

  const clearHint = useCallback(() => {
    cancelRef.current?.()
    cancelRef.current = null
    setHint(null)
  }, [])

  const requestHint = useCallback((position: GameState, timeMs: number, difficulty: BotDifficulty) => {
    cancelRef.current?.()
    cancelRef.current = null
    const clampedTime = normalizeBotTime(Math.min(timeMs, 10_000))
    setHint({ position, status: 'thinking', thinking: null, analysis: null })

    try {
      cancelRef.current = execute({
        kind: 'search',
        position,
        timeMs: clampedTime,
        difficulty,
        smartTime: true,
        useBook: true,
      }, data => {
        if (data.kind === 'thinking') {
          setHint(prev => prev && prev.position === position
            ? { ...prev, thinking: data.thinking }
            : prev)
        } else if (data.kind === 'progress') {
          setHint(prev => prev && prev.position === position
            ? { ...prev, analysis: data.analysis }
            : prev)
        } else if (data.kind === 'done') {
          cancelRef.current = null
          setHint({ position, status: 'complete', thinking: null, analysis: data.analysis })
        } else if (data.kind === 'error') {
          cancelRef.current = null
          setHint({ position, status: 'failed', thinking: null, analysis: null, error: data.message })
        }
      })
    } catch (error) {
      setHint({
        position,
        status: 'failed',
        thinking: null,
        analysis: null,
        error: error instanceof Error ? error.message : 'Could not analyze position.',
      })
    }
  }, [execute])

  useEffect(() => () => cancelRef.current?.(), [])

  return { hint, requestHint, clearHint }
}
