import { mkdir, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const scriptUrl = new URL(import.meta.url)
const help = `Usage: npm run selfplay -- [options]

  --games N          Number of matches (default 4)
  --max-plies N      Full match limit, including seeded opening plies (default 120)
  --opening-plies N  Seeded quiet moves before bot searches begin (default 4)
  --nodes N          Deterministic node budget per bot turn (default 1000)
  --max-depth N      Search depth limit per bot turn (default 3)
  --time-ms N        Time budget per turn in ms (overrides --nodes when set)
  --white-profile P  Profile for White: easy | medium | hard | max | classic
  --black-profile P  Profile for Black: easy | medium | hard | max | classic
  --swap-colors      Swap White/Black profiles on odd-indexed games (paired A/B)
  --book             Enable opening book for profiled matches
  --seed N           Base seed, an unsigned 32-bit integer (default 12012)
  --workers N        Number of independent match workers (default up to 4)
  --output FILE      Write summary and match traces as JSON; use - for stdout
  --history          Also include human-readable turn records in JSON
  --quiet            Hide match progress
  --help             Show this help

A match that reaches the ply limit remains capped, separate from actual draws.
Opening moves are replayable but excluded from bot telemetry.
`

const validProfiles = new Set(['easy', 'medium', 'hard', 'max', 'classic'])

function readArgs(args) {
  const result = {
    games: 4,
    maxPlies: 120,
    openingPlies: 4,
    maxNodes: 1000,
    maxDepth: undefined,
    timeMs: undefined,
    whiteProfile: undefined,
    blackProfile: undefined,
    swapColors: false,
    useBook: false,
    seed: 12012,
    workers: Math.min(4, availableParallelism()),
    includeHistory: false,
    quiet: false,
    output: null,
  }
  const numbers = {
    '--games': ['games', 1, Number.MAX_SAFE_INTEGER],
    '--max-plies': ['maxPlies', 1, Number.MAX_SAFE_INTEGER],
    '--opening-plies': ['openingPlies', 0, Number.MAX_SAFE_INTEGER],
    '--nodes': ['maxNodes', 1, Number.MAX_SAFE_INTEGER],
    '--max-depth': ['maxDepth', 1, 64],
    '--time-ms': ['timeMs', 10, 60000],
    '--seed': ['seed', 0, 0xffffffff],
    '--workers': ['workers', 1, Number.MAX_SAFE_INTEGER],
  }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--help' || flag === '-h') return null
    if (flag === '--history') { result.includeHistory = true; continue }
    if (flag === '--quiet') { result.quiet = true; continue }
    if (flag === '--swap-colors') { result.swapColors = true; continue }
    if (flag === '--book') { result.useBook = true; continue }
    if (flag === '--white-profile' || flag === '--black-profile') {
      const p = args[++index]
      if (!validProfiles.has(p)) throw new Error(`${flag} must be one of ${[...validProfiles].join(', ')}`)
      if (flag === '--white-profile') result.whiteProfile = p
      else result.blackProfile = p
      continue
    }
    if (flag === '--output') {
      result.output = args[++index]
      if (!result.output || result.output.startsWith('--')) throw new Error('--output needs a file path or -')
      continue
    }
    const field = numbers[flag]
    if (!field) throw new Error(`Unknown option ${flag}; use --help to see available options`)
    const [key, minimum, maximum] = field
    const raw = args[++index]
    const value = Number(raw)
    if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${flag} needs an integer between ${minimum} and ${maximum}`)
    }
    result[key] = value
  }
  if (result.maxDepth === undefined) {
    result.maxDepth = result.timeMs !== undefined ? 64 : 3
  }
  return result
}

async function withRunner(run) {
  const { createServer } = await import('vite')
  const vite = await createServer({
    root: projectRoot,
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null },
  })
  try {
    return await run(await vite.ssrLoadModule('/src/selfPlay/run.ts'))
  } finally {
    await vite.close()
  }
}

function runJobs(runner, indexes, seed, matchOptions, complete) {
  const { swapColors, ...baseOpts } = matchOptions
  for (const index of indexes) {
    const pairIndex = swapColors ? Math.floor(index / 2) : index
    const matchSeed = runner.deriveMatchSeed(seed, pairIndex)
    const swapped = swapColors && (index % 2 === 1)
    const opts = swapped
      ? { ...baseOpts, whiteProfile: baseOpts.blackProfile, blackProfile: baseOpts.whiteProfile }
      : baseOpts
    complete(index, runner.runMatch(matchSeed, opts))
  }
}

function waitForWorker(worker, expectedCount, receive) {
  return new Promise((resolve, reject) => {
    let received = 0
    worker.on('message', ({ index, match }) => {
      receive(index, match)
      received++
    })
    worker.on('error', reject)
    worker.on('exit', code => {
      if (code !== 0 || received !== expectedCount) {
        reject(new Error(`Self-play worker exited with code ${code} after ${received}/${expectedCount} matches`))
      } else {
        resolve()
      }
    })
  })
}

async function runParallel(indexes, workerCount, seed, matchOptions, receive) {
  const groups = Array.from({ length: workerCount }, () => [])
  indexes.forEach((index, turn) => groups[turn % workerCount].push(index))
  const workers = []
  try {
    await Promise.all(groups.map(group => {
      const worker = new Worker(scriptUrl, { workerData: { indexes: group, seed, matchOptions } })
      workers.push(worker)
      return waitForWorker(worker, group.length, receive)
    }))
  } catch (error) {
    await Promise.allSettled(workers.map(worker => worker.terminate()))
    throw error
  }
}

async function main() {
  const options = readArgs(process.argv.slice(2))
  if (!options) { process.stdout.write(help); return }

  const { games, seed, workers, output, quiet, ...matchOptions } = options
  const indexes = Array.from({ length: games }, (_, index) => index)
  const matches = new Array(games)
  const workerCount = Math.min(games, workers)
  const interval = Math.max(1, Math.ceil(games / 10))
  const start = performance.now()
  let completed = 0
  function receive(index, match) {
    matches[index] = match
    completed++
    if (!quiet && (completed === 1 || completed % interval === 0 || completed === games)) {
      process.stderr.write(`Completed ${completed}/${games} matches.\n`)
    }
  }
  const { rulesetVersion, summary } = await withRunner(async runner => {
    if (workerCount === 1) runJobs(runner, indexes, seed, matchOptions, receive)
    else await runParallel(indexes, workerCount, seed, matchOptions, receive)
    return { rulesetVersion: runner.RULESET_VERSION, summary: runner.summarizeMatches(matches) }
  })
  const report = { config: { rulesetVersion, games, seed, ...matchOptions }, summary, matches }
  if (output) {
    const json = JSON.stringify(report, null, 2) + '\n'
    if (output === '-') process.stdout.write(json)
    else {
      const path = resolve(output)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, json, 'utf8')
      if (!quiet) process.stderr.write(`Wrote ${path}\n`)
    }
  }
  if (output !== '-') process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
  if (!quiet) process.stderr.write(`Finished in ${((performance.now() - start) / 1000).toFixed(1)} s.\n`)
}

if (isMainThread) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`Self-play failed: ${error.message}\n`)
    process.exitCode = 1
  }
} else {
  const { indexes, seed, matchOptions } = workerData
  await withRunner(runner =>
    runJobs(runner, indexes, seed, matchOptions, (index, match) => parentPort.postMessage({ index, match })))
}
