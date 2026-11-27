import { useCallback, useEffect, useRef, useState } from 'react'
import type { GameState } from '../engine/model'
import { BOT_TURN_MS, type BotAnalysis, type BotDecision, type BotRequest, type BotResponse } from './protocol'

const workerTimeoutMs = 15_000

export type BotDisplay =
  | { kind: 'thinking'; position: GameState; analysis: BotAnalysis | null }
  | { kind: 'complete'; position: GameState; analysis: BotAnalysis }
  | { kind: 'failed'; position: GameState; message: string }
  | { kind: 'paused'; position: GameState }

interface ActiveWorker {
  worker: Worker
  timeout: number
}

export function useBot(
  position: GameState | null,
  paused: boolean,
  onDecision: (position: GameState, decision: BotDecision) => boolean,
) {
  const active = useRef<ActiveWorker | null>(null)
  const failedPosition = useRef<GameState | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [snapshot, setSnapshot] = useState<BotDisplay | null>(null)

  const stop = useCallback(() => {
    const run = active.current
    active.current = null
    if (!run) return
    window.clearTimeout(run.timeout)
    run.worker.terminate()
  }, [])

  const pause = useCallback(() => {
    stop()
    setSnapshot(previous => previous?.kind === 'thinking' ? null : previous)
  }, [stop])

  const reset = useCallback(() => {
    stop()
    failedPosition.current = null
    setSnapshot(null)
  }, [stop])

  const retry = useCallback(() => {
    reset()
    setAttempt(previous => previous + 1)
  }, [reset])

  useEffect(() => {
    if (!position || paused || position === failedPosition.current) return

    const root = position
    function fail(message: string) {
      failedPosition.current = root
      setSnapshot({ kind: 'failed', position: root, message })
    }

    let worker: Worker
    try {
      worker = new Worker(new URL('./bot.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      fail('The bot could not start.')
      return
    }

    const isCurrent = () => active.current?.worker === worker
    function failCurrent(message: string) {
      if (!isCurrent()) return
      stop()
      fail(message)
    }

    active.current = {
      worker,
      timeout: window.setTimeout(() => failCurrent('The bot took too long to respond.'), workerTimeoutMs),
    }

    worker.onmessage = ({ data }: MessageEvent<BotResponse>) => {
      if (!isCurrent()) return
      if (data.kind === 'progress') {
        setSnapshot({ kind: 'thinking', position: root, analysis: data.analysis })
      } else if (data.kind === 'error') {
        failCurrent(data.message)
      } else {
        stop()
        try {
          if (onDecision(root, data.analysis.decision)) {
            setSnapshot({ kind: 'complete', position: root, analysis: data.analysis })
          } else {
            fail('The bot returned an illegal action.')
          }
        } catch {
          fail('The bot returned an invalid response.')
        }
      }
    }
    worker.onerror = event => {
      event.preventDefault()
      failCurrent('The bot could not complete its search.')
    }
    worker.onmessageerror = () => failCurrent('The bot sent an unreadable response.')

    try {
      const request: BotRequest = { position: root, timeMs: BOT_TURN_MS }
      worker.postMessage(request)
    } catch {
      failCurrent('The position could not be sent to the bot.')
    }

    return () => { if (isCurrent()) stop() }
  }, [attempt, onDecision, paused, position, stop])

  let display: BotDisplay | null = null
  if (position) {
    display = paused ? { kind: 'paused', position }
      : snapshot?.position === position ? snapshot
      : { kind: 'thinking', position, analysis: null }
  } else if (snapshot?.kind === 'complete') {
    display = snapshot
  }

  return { display, pause, reset, retry }
}