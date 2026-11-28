import { BOT_PROFILES } from './profiles'
import type { BotRequest, BotResponse } from './protocol'
import type { WorkerOutgoing, WorkerSearchMessage } from './bot.worker'

/** A search transport delivers protocol messages asynchronously and exposes cancellation. */
export type BotExecutor = (request: BotRequest, receive: (response: BotResponse) => void) => () => void

let primaryWorker: Worker | null = null
let helperWorkers: Worker[] = []
let sharedTTBuffer: SharedArrayBuffer | undefined
let currentSearchId = 0
let activeSearchRunning = false
let activeReceiver: ((response: BotResponse) => void) | null = null
let activeSearchId = 0

function canUseSharedMemory(): boolean {
  return typeof SharedArrayBuffer !== 'undefined' &&
    typeof Atomics !== 'undefined' &&
    Boolean((globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated)
}

function getSharedTT(): SharedArrayBuffer | undefined {
  if (!canUseSharedMemory()) return undefined
  if (!sharedTTBuffer) {
    // 2^20 entries * 16 bytes = 16 MB shared lockless TT
    sharedTTBuffer = new SharedArrayBuffer((1 << 20) * 16)
  }
  return sharedTTBuffer
}

function ensurePrimaryWorker(): Worker {
  if (primaryWorker) return primaryWorker
  const worker = new Worker(new URL('./bot.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = ({ data }: MessageEvent<WorkerOutgoing>) => {
    if (data.searchId !== activeSearchId || !activeReceiver) return
    if (data.kind === 'done' || data.kind === 'error') {
      activeSearchRunning = false
      const receiver = activeReceiver
      activeReceiver = null
      receiver(data)
      return
    }
    activeReceiver(data)
  }
  worker.onerror = event => {
    event.preventDefault()
    const receiver = activeReceiver
    activeSearchRunning = false
    activeReceiver = null
    primaryWorker = null
    worker.terminate()
    receiver?.({ kind: 'error', message: 'The AI could not complete its search.' })
  }
  worker.onmessageerror = () => {
    const receiver = activeReceiver
    activeSearchRunning = false
    activeReceiver = null
    receiver?.({ kind: 'error', message: 'The AI sent an unreadable response.' })
  }
  primaryWorker = worker
  return worker
}

function ensureHelpers(count: number): Worker[] {
  while (helperWorkers.length < count) {
    const helper = new Worker(new URL('./bot.worker.ts', import.meta.url), { type: 'module' })
    helper.onerror = event => event.preventDefault()
    helperWorkers.push(helper)
  }
  return helperWorkers.slice(0, count)
}

export function resetBotEngine(): void {
  activeSearchRunning = false
  activeReceiver = null
  if (sharedTTBuffer) {
    new Int32Array(sharedTTBuffer).fill(0)
  }
  if (primaryWorker) {
    try {
      primaryWorker.postMessage({ kind: 'reset' })
    } catch {
      primaryWorker.terminate()
      primaryWorker = null
    }
  }
  for (const helper of helperWorkers) {
    try {
      helper.postMessage({ kind: 'reset' })
    } catch {
      helper.terminate()
    }
  }
}

export const executeBotInWorker: BotExecutor = (request, receive) => {
  const searchId = ++currentSearchId
  const worker = ensurePrimaryWorker()

  const difficulty = request.difficulty ?? 'max'
  const profile = BOT_PROFILES[difficulty]
  const sharedTT = getSharedTT()
  const abortBuffer = canUseSharedMemory() ? new SharedArrayBuffer(4) : undefined
  const abortView = abortBuffer ? new Int32Array(abortBuffer) : undefined
  if (abortView) Atomics.store(abortView, 0, 0)

  activeSearchId = searchId
  activeReceiver = receive
  activeSearchRunning = true

  const message: WorkerSearchMessage = {
    ...request,
    kind: 'search',
    searchId,
    helperId: 0,
    abortBuffer,
    sharedTTBuffer: sharedTT,
  }

  try {
    worker.postMessage(message)
  } catch {
    activeSearchRunning = false
    activeReceiver = null
    worker.terminate()
    primaryWorker = null
    throw new Error('The position could not be sent to the AI.')
  }

  // Launch Lazy SMP helpers in Max mode when SharedArrayBuffer + multi-core are available
  const hwCores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 2) : 2
  const desiredHelpers = sharedTT && abortBuffer && !request.pondering && request.timeMs >= 800
    ? Math.min(profile.smpHelpers, Math.max(0, hwCores - 2))
    : 0
  const activeHelpers = desiredHelpers > 0 ? ensureHelpers(desiredHelpers) : []

  for (let i = 0; i < activeHelpers.length; i++) {
    try {
      activeHelpers[i].postMessage({
        ...message,
        helperId: i + 1,
      })
    } catch {
      // Ignore helper launch failure; primary worker still finishes the search
    }
  }

  return () => {
    if (activeSearchId !== searchId) return
    const wasRunning = activeSearchRunning
    activeSearchRunning = false
    activeReceiver = null

    if (abortView) {
      Atomics.store(abortView, 0, 1)
    } else if (wasRunning) {
      // Fallback when SharedArrayBuffer is unavailable: terminate busy worker so CPU stops immediately
      worker.terminate()
      if (primaryWorker === worker) primaryWorker = null
      for (const h of activeHelpers) h.terminate()
      helperWorkers = []
    }
  }
}
