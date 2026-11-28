import { useEffect, useMemo, useRef } from 'react'
import { fireCone, turnsRemaining, type FirePreview } from '../engine/fire'
import { BOARD_SIZE, type Color, type GameState, type Square } from '../engine/model'

const BLEED = 20

interface ActiveFireCell {
  file: number
  rank: number
  hasWhite: boolean
  hasBlack: boolean
  minRemaining: number
}

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  size: number
  life: number
  maxLife: number
  kind: 'ember' | 'breath' | 'ash' | 'arcane' | 'shield' | 'impact'
  color: Color | 'neutral'
  seed: number
}

interface ShockRing {
  x: number
  y: number
  maxRadius: number
  life: number
  maxLife: number
  kind: 'shield' | 'summon' | 'burn' | 'capture'
  fromX?: number
  fromY?: number
}

interface PendingBurst {
  triggerAt: number
  run: (cw: number, ch: number) => void
}

interface Props {
  game: GameState
  preview?: FirePreview
}

function sqCenter(sq: Square, cw: number, ch: number) {
  return {
    x: BLEED + (sq.file + 0.5) * cw,
    y: BLEED + (BOARD_SIZE - 1 - sq.rank + 0.5) * ch,
  }
}

export function BoardVfxCanvas({ game, preview }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sizeRef = useRef({ w: 600, h: 600, dpr: 1 })
  const particlesRef = useRef<Particle[]>([])
  const ringsRef = useRef<ShockRing[]>([])
  const pendingRef = useRef<PendingBurst[]>([])
  const lastHistoryLenRef = useRef(game.moveHistory.length)
  const lastGameRef = useRef(game)
  const rafRef = useRef<number | null>(null)
  const lastTickRef = useRef<number>(0)

  const activeFireCells = useMemo(() => {
    const map = new Map<number, ActiveFireCell>()
    const curTurn = game.fireState.currentTurnIndex
    for (const eff of game.fireState.effects) {
      const rem = turnsRemaining(eff, curTurn)
      if (rem <= 0) continue
      const key = eff.square.rank * BOARD_SIZE + eff.square.file
      const existing = map.get(key)
      if (!existing) {
        map.set(key, {
          file: eff.square.file,
          rank: eff.square.rank,
          hasWhite: eff.owner === 'white',
          hasBlack: eff.owner === 'black',
          minRemaining: rem,
        })
      } else {
        if (eff.owner === 'white') existing.hasWhite = true
        else existing.hasBlack = true
        if (rem < existing.minRemaining) existing.minRemaining = rem
      }
    }
    return [...map.values()]
  }, [game.fireState])

  const fireRef = useRef(activeFireCells)
  fireRef.current = activeFireCells

  const previewRef = useRef(preview)
  previewRef.current = preview

  const wakeLoopRef = useRef<() => void>(() => {})

  // Detect new turn events and queue cinematic bursts
  useEffect(() => {
    const prevLen = lastHistoryLenRef.current
    const currLen = game.moveHistory.length
    const prevGame = lastGameRef.current
    lastHistoryLenRef.current = currLen
    lastGameRef.current = game

    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      return
    }

    if (currLen !== prevLen + 1 || currLen === 0) return
    const turn = game.moveHistory[currLen - 1]
    const now = performance.now()

    // 1. Dragon Fire Breath Stream
    if (turn.action.kind === 'dragon' && turn.action.fireTiming !== 'none') {
      const delay = turn.action.fireTiming === 'after' ? 165 : 0
      const originSq = turn.action.fireTiming === 'after' ? turn.to : turn.from!
      const cone = fireCone(originSq, turn.color)

      pendingRef.current.push({
        triggerAt: now + delay,
        run: (cw, ch) => {
          const origin = sqCenter(originSq, cw, ch)
          for (const targetSq of cone) {
            const dst = sqCenter(targetSq, cw, ch)
            const dx = dst.x - origin.x
            const dy = dst.y - origin.y
            for (let i = 0; i < 14; i++) {
              const speed = 1.6 + Math.random() * 1.6
              const spread = (Math.random() - 0.5) * cw * 0.45
              particlesRef.current.push({
                x: origin.x + (Math.random() - 0.5) * cw * 0.2,
                y: origin.y + (Math.random() - 0.5) * ch * 0.2,
                vx: (dx + spread) * speed * 1.4,
                vy: (dy + spread) * speed * 1.4,
                size: Math.max(3, cw * (0.09 + Math.random() * 0.1)),
                life: 0,
                maxLife: 0.28 + Math.random() * 0.18,
                kind: 'breath',
                color: turn.color,
                seed: Math.random() * 100,
              })
            }
          }
        },
      })

      if (turn.fire.canceledBy.length > 0) {
        for (const shielderId of turn.fire.canceledBy) {
          const sSq = prevGame.pieces[shielderId]?.currentSquare ?? game.pieces[shielderId]?.currentSquare
          if (!sSq) continue
          pendingRef.current.push({
            triggerAt: now + delay + 80,
            run: (cw, ch) => {
              const c = sqCenter(sSq, cw, ch)
              ringsRef.current.push({
                x: c.x,
                y: c.y,
                maxRadius: cw * 1.65,
                life: 0,
                maxLife: 0.52,
                kind: 'shield',
              })
              for (let i = 0; i < 24; i++) {
                const ang = (Math.PI * 2 * i) / 24 + Math.random() * 0.2
                const spd = cw * (1.8 + Math.random() * 1.9)
                particlesRef.current.push({
                  x: c.x,
                  y: c.y,
                  vx: Math.cos(ang) * spd,
                  vy: Math.sin(ang) * spd,
                  size: Math.max(2, cw * 0.065),
                  life: 0,
                  maxLife: 0.36 + Math.random() * 0.16,
                  kind: 'shield',
                  color: 'neutral',
                  seed: Math.random() * 100,
                })
              }
            },
          })
        }
      }
    }

    // 2. Necromancer Summoning Ritual
    if (turn.action.kind === 'resurrect' && turn.from) {
      const fromSq = turn.from
      const toSq = turn.to
      pendingRef.current.push({
        triggerAt: now,
        run: (cw, ch) => {
          const from = sqCenter(fromSq, cw, ch)
          const to = sqCenter(toSq, cw, ch)
          ringsRef.current.push({
            x: to.x,
            y: to.y,
            fromX: from.x,
            fromY: from.y,
            maxRadius: cw * 0.85,
            life: 0,
            maxLife: 0.72,
            kind: 'summon',
          })
          for (let i = 0; i < 28; i++) {
            const ang = Math.random() * Math.PI * 2
            const r = Math.random() * cw * 0.35
            particlesRef.current.push({
              x: to.x + Math.cos(ang) * r,
              y: to.y + Math.sin(ang) * r + ch * 0.15,
              vx: (Math.random() - 0.5) * cw * 0.6,
              vy: -ch * (0.9 + Math.random() * 1.3),
              size: Math.max(2.2, cw * 0.065),
              life: 0,
              maxLife: 0.5 + Math.random() * 0.28,
              kind: 'arcane',
              color: 'neutral',
              seed: Math.random() * 100,
            })
          }
        },
      })
    }

    // 3. Fire Expiration Ash Incineration
    if (turn.fire.captures.length > 0) {
      for (const cap of turn.fire.captures) {
        pendingRef.current.push({
          triggerAt: now,
          run: (cw, ch) => {
            const c = sqCenter(cap.square, cw, ch)
            ringsRef.current.push({
              x: c.x,
              y: c.y,
              maxRadius: cw * 1.05,
              life: 0,
              maxLife: 0.48,
              kind: 'burn',
            })
            for (let i = 0; i < 34; i++) {
              const ang = Math.random() * Math.PI * 2
              const spd = cw * (0.4 + Math.random() * 1.4)
              particlesRef.current.push({
                x: c.x + (Math.random() - 0.5) * cw * 0.45,
                y: c.y + (Math.random() - 0.5) * ch * 0.45,
                vx: Math.cos(ang) * spd * 0.65,
                vy: -ch * (0.9 + Math.random() * 1.8) + Math.sin(ang) * spd * 0.25,
                size: Math.max(2, cw * (0.045 + Math.random() * 0.06)),
                life: 0,
                maxLife: 0.45 + Math.random() * 0.35,
                kind: 'ash',
                color: cap.owner,
                seed: Math.random() * 100,
              })
            }
          },
        })
      }
    }

    // 4. Direct / EP Capture Impact
    const burnedIds = new Set(turn.fire.captures.map(c => c.pieceId))
    const directCaptures = turn.capturedIds.filter(id => !burnedIds.has(id))
    if (directCaptures.length > 0) {
      const capSq = turn.to
      pendingRef.current.push({
        triggerAt: now + 175,
        run: (cw, ch) => {
          const c = sqCenter(capSq, cw, ch)
          ringsRef.current.push({
            x: c.x,
            y: c.y,
            maxRadius: cw * 0.72,
            life: 0,
            maxLife: 0.3,
            kind: 'capture',
          })
          for (let i = 0; i < 16; i++) {
            const ang = (Math.PI * 2 * i) / 16 + Math.random() * 0.25
            const spd = cw * (1.2 + Math.random() * 1.2)
            particlesRef.current.push({
              x: c.x,
              y: c.y,
              vx: Math.cos(ang) * spd,
              vy: Math.sin(ang) * spd,
              size: Math.max(2, cw * 0.055),
              life: 0,
              maxLife: 0.26 + Math.random() * 0.14,
              kind: 'impact',
              color: turn.color,
              seed: Math.random() * 100,
            })
          }
        },
      })
    }

    wakeLoopRef.current()
  }, [game])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reducedMotion = typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

    function syncSize() {
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      sizeRef.current = { w: rect.width, h: rect.height, dpr }
      const targetW = Math.round(rect.width * dpr)
      const targetH = Math.round(rect.height * dpr)
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW
        canvas.height = targetH
      }
    }

    const observer = new ResizeObserver(() => {
      syncSize()
      wakeLoop()
    })
    observer.observe(canvas)
    syncSize()

    function drawFlameTongue(
      c: CanvasRenderingContext2D,
      bx: number,
      by: number,
      width: number,
      height: number,
      sway: number,
      paletteStops: readonly [string, string, string, string],
    ) {
      const grad = c.createLinearGradient(bx, by, bx + sway * 0.6, by - height)
      grad.addColorStop(0, paletteStops[0])
      grad.addColorStop(0.32, paletteStops[1])
      grad.addColorStop(0.7, paletteStops[2])
      grad.addColorStop(1, paletteStops[3])

      c.fillStyle = grad
      c.beginPath()
      c.moveTo(bx - width * 0.5, by)
      c.bezierCurveTo(
        bx - width * 0.68,
        by - height * 0.34,
        bx - width * 0.24 + sway * 0.5,
        by - height * 0.72,
        bx + sway,
        by - height,
      )
      c.bezierCurveTo(
        bx + width * 0.24 + sway * 0.5,
        by - height * 0.68,
        bx + width * 0.68,
        by - height * 0.32,
        bx + width * 0.5,
        by,
      )
      c.closePath()
      c.fill()
    }

    function renderFrame(now: number) {
      if (!ctx) return
      const { w, h, dpr } = sizeRef.current
      const cw = (w - 2 * BLEED) / BOARD_SIZE
      const ch = (h - 2 * BLEED) / BOARD_SIZE
      if (cw <= 0 || ch <= 0) {
        rafRef.current = null
        return
      }

      const dt = lastTickRef.current ? Math.min(0.05, (now - lastTickRef.current) / 1000) : 0.016
      lastTickRef.current = now
      const t = now / 1000

      // Flush pending delayed bursts
      if (pendingRef.current.length > 0) {
        const remaining: PendingBurst[] = []
        for (const b of pendingRef.current) {
          if (now >= b.triggerAt) b.run(cw, ch)
          else remaining.push(b)
        }
        pendingRef.current = remaining
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      const fires = fireRef.current
      const prev = previewRef.current

      // 1. Render Active Roaring Fires
      for (const cell of fires) {
        const x = BLEED + cell.file * cw
        const y = BLEED + (BOARD_SIZE - 1 - cell.rank) * ch
        const cx = x + cw * 0.5
        const baseY = y + ch * 0.94
        const imminent = cell.minRemaining === 1
        const overlap = cell.hasWhite && cell.hasBlack
        const seedBase = cell.file * 41 + cell.rank * 97
        const intensity = imminent ? 1.24 : 0.94
        const speed = imminent ? 10.5 : 7.2

        // Molten floor glow
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        const glowPulse = 0.72 + 0.28 * Math.sin(t * speed + seedBase)
        const glow = ctx.createRadialGradient(cx, y + ch * 0.76, cw * 0.05, cx, y + ch * 0.72, cw * 0.68)
        if (overlap) {
          glow.addColorStop(0, `rgba(255, 225, 160, ${0.42 * glowPulse})`)
          glow.addColorStop(0.5, `rgba(255, 70, 120, ${0.28 * glowPulse})`)
          glow.addColorStop(1, 'rgba(0, 0, 0, 0)')
        } else if (cell.hasWhite) {
          glow.addColorStop(0, `rgba(255, 210, 110, ${0.38 * glowPulse})`)
          glow.addColorStop(0.55, `rgba(255, 100, 15, ${0.24 * glowPulse})`)
          glow.addColorStop(1, 'rgba(0, 0, 0, 0)')
        } else {
          glow.addColorStop(0, `rgba(255, 160, 180, ${0.36 * glowPulse})`)
          glow.addColorStop(0.55, `rgba(215, 25, 110, ${0.24 * glowPulse})`)
          glow.addColorStop(1, 'rgba(0, 0, 0, 0)')
        }
        ctx.fillStyle = glow
        ctx.fillRect(x - cw * 0.15, y - ch * 0.15, cw * 1.3, ch * 1.3)

        // 6 Writhing Outer/Mid Flame Tongues
        const tongues = 6
        for (let i = 0; i < tongues; i++) {
          const norm = (i + 0.5) / tongues // 0..1 across width
          const bell = 1 - Math.abs(norm - 0.5) * 1.55 // taller in center
          const s = seedBase + i * 67
          const flicker = 0.82 + 0.24 * Math.sin(t * speed + s) + 0.1 * Math.cos(t * 14.3 - s)
          const fH = ch * (0.48 + 0.48 * Math.max(0.25, bell)) * intensity * flicker
          const fW = cw * (0.28 + 0.12 * Math.max(0, bell))
          const sway = cw * 0.15 * (Math.sin(t * 6.4 + s) + 0.45 * Math.cos(t * 11.8 + s * 0.7))
          const bx = x + cw * (0.14 + 0.72 * norm)

          const useWhitePalette = overlap ? i % 2 === 0 : cell.hasWhite
          const stops: readonly [string, string, string, string] = useWhitePalette
            ? [
                'rgba(255, 248, 200, 0.72)',
                'rgba(255, 148, 18, 0.62)',
                'rgba(232, 42, 8, 0.36)',
                'rgba(120, 8, 0, 0)',
              ]
            : [
                'rgba(255, 224, 195, 0.72)',
                'rgba(255, 52, 92, 0.62)',
                'rgba(170, 18, 130, 0.38)',
                'rgba(60, 0, 85, 0)',
              ]
          drawFlameTongue(ctx, bx, baseY, fW, fH, sway, stops)
        }

        // 3 Incandescent Inner Core Tongues
        for (let i = 0; i < 3; i++) {
          const s = seedBase + i * 113 + 9
          const flicker = 0.85 + 0.2 * Math.sin(t * (speed + 3) + s)
          const fH = ch * (0.28 + (i === 1 ? 0.14 : 0.04)) * intensity * flicker
          const fW = cw * 0.24
          const sway = cw * 0.08 * Math.sin(t * 8.1 + s)
          const bx = x + cw * (0.28 + i * 0.22)
          drawFlameTongue(ctx, bx, baseY + 1, fW, fH, sway, [
            'rgba(255, 255, 240, 0.82)',
            overlap ? 'rgba(255, 210, 140, 0.55)' : cell.hasWhite ? 'rgba(255, 225, 110, 0.55)' : 'rgba(255, 165, 190, 0.55)',
            'rgba(255, 120, 40, 0.16)',
            'rgba(255, 80, 0, 0)',
          ])
        }
        ctx.restore()

        // Spawn continuous rising ember sparks
        if (!reducedMotion && particlesRef.current.length < 280) {
          const spawnChance = imminent ? 0.42 : 0.22
          if (Math.random() < spawnChance) {
            particlesRef.current.push({
              x: x + cw * (0.18 + Math.random() * 0.64),
              y: baseY - Math.random() * ch * 0.25,
              vx: (Math.random() - 0.5) * cw * 0.4,
              vy: -ch * ((imminent ? 1.1 : 0.75) + Math.random() * 0.9),
              size: Math.max(1.4, cw * (0.032 + Math.random() * 0.035)),
              life: 0,
              maxLife: 0.45 + Math.random() * 0.45,
              kind: 'ember',
              color: overlap ? (Math.random() < 0.5 ? 'white' : 'black') : cell.hasWhite ? 'white' : 'black',
              seed: Math.random() * 100,
            })
          }
        }
      }

      // 2. Preview Cone Shimmer (Dragon hover / Shielder ward)
      if (prev && prev.cells.length > 0) {
        const canceled = prev.canceledBy.length > 0
        const pulse = 0.55 + 0.45 * Math.sin(t * 6.5)
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        for (const cell of prev.cells) {
          const x = BLEED + cell.square.file * cw
          const y = BLEED + (BOARD_SIZE - 1 - cell.square.rank) * ch
          const cx = x + cw * 0.5
          const cy = y + ch * 0.5
          if (canceled) {
            const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, cw * 0.52)
            g.addColorStop(0, `rgba(114, 239, 221, ${0.24 * pulse})`)
            g.addColorStop(1, 'rgba(46, 196, 182, 0)')
            ctx.fillStyle = g
            ctx.fillRect(x, y, cw, ch)
          } else {
            const g = ctx.createRadialGradient(cx, y + ch * 0.78, 2, cx, y + ch * 0.6, cw * 0.55)
            g.addColorStop(0, `rgba(255, 175, 65, ${0.3 * pulse})`)
            g.addColorStop(1, 'rgba(255, 60, 10, 0)')
            ctx.fillStyle = g
            ctx.fillRect(x, y, cw, ch)
          }
        }
        ctx.restore()
      }

      // 3. Shockwave & Summoning Rings
      if (ringsRef.current.length > 0) {
        const aliveRings: ShockRing[] = []
        ctx.save()
        for (const ring of ringsRef.current) {
          ring.life += dt
          if (ring.life >= ring.maxLife) continue
          aliveRings.push(ring)
          const p = ring.life / ring.maxLife
          const ease = 1 - Math.pow(1 - p, 3)

          if (ring.kind === 'shield') {
            ctx.globalCompositeOperation = 'lighter'
            ctx.strokeStyle = `rgba(114, 239, 221, ${(1 - p) * 0.9})`
            ctx.lineWidth = Math.max(2, cw * 0.08 * (1 - p * 0.6))
            ctx.beginPath()
            ctx.arc(ring.x, ring.y, ring.maxRadius * ease, 0, Math.PI * 2)
            ctx.stroke()

            ctx.fillStyle = `rgba(46, 196, 182, ${(1 - p) * 0.2})`
            ctx.fill()
          } else if (ring.kind === 'summon') {
            ctx.globalCompositeOperation = 'lighter'
            const alpha = Math.sin(p * Math.PI)
            // Soul tether arc from Necromancer to revived square
            if (ring.fromX !== undefined && ring.fromY !== undefined && p < 0.65) {
              const arcP = p / 0.65
              const grad = ctx.createLinearGradient(ring.fromX, ring.fromY, ring.x, ring.y)
              grad.addColorStop(0, `rgba(168, 85, 247, ${0.85 * (1 - arcP)})`)
              grad.addColorStop(1, `rgba(82, 225, 165, ${0.95 * (1 - arcP)})`)
              ctx.strokeStyle = grad
              ctx.lineWidth = Math.max(2, cw * 0.07)
              ctx.beginPath()
              const mx = (ring.fromX + ring.x) * 0.5
              const my = (ring.fromY + ring.y) * 0.5 - ch * 0.85
              ctx.moveTo(ring.fromX, ring.fromY)
              ctx.quadraticCurveTo(mx, my, ring.x, ring.y)
              ctx.stroke()
            }
            // Rotating double arcane sigil
            const rad = ring.maxRadius * (0.45 + 0.35 * ease)
            ctx.save()
            ctx.translate(ring.x, ring.y)
            ctx.rotate(t * 3.4)
            ctx.strokeStyle = `rgba(92, 235, 175, ${alpha * 0.9})`
            ctx.lineWidth = 2.2
            ctx.beginPath()
            ctx.arc(0, 0, rad, 0, Math.PI * 2)
            ctx.stroke()
            ctx.strokeStyle = `rgba(180, 110, 255, ${alpha * 0.85})`
            ctx.beginPath()
            for (let k = 0; k < 4; k++) {
              const a = (Math.PI / 2) * k
              const px = Math.cos(a) * rad * 0.85
              const py = Math.sin(a) * rad * 0.85
              if (k === 0) ctx.moveTo(px, py)
              else ctx.lineTo(px, py)
            }
            ctx.closePath()
            ctx.stroke()
            ctx.restore()
          } else if (ring.kind === 'burn') {
            ctx.globalCompositeOperation = 'lighter'
            ctx.strokeStyle = `rgba(255, 130, 35, ${(1 - p) * 0.95})`
            ctx.lineWidth = Math.max(2, cw * 0.09 * (1 - p))
            ctx.beginPath()
            ctx.arc(ring.x, ring.y, ring.maxRadius * ease, 0, Math.PI * 2)
            ctx.stroke()
          } else {
            ctx.strokeStyle = `rgba(255, 224, 155, ${(1 - p) * 0.85})`
            ctx.lineWidth = 2.4 * (1 - p)
            ctx.beginPath()
            ctx.arc(ring.x, ring.y, ring.maxRadius * ease, 0, Math.PI * 2)
            ctx.stroke()
          }
        }
        ctx.restore()
        ringsRef.current = aliveRings
      }

      // 4. Update & Render Particles
      if (particlesRef.current.length > 0) {
        const aliveParticles: Particle[] = []
        ctx.save()
        for (const pt of particlesRef.current) {
          pt.life += dt
          if (pt.life >= pt.maxLife) continue
          aliveParticles.push(pt)

          const p = pt.life / pt.maxLife
          const alpha = 1 - p * p
          pt.x += pt.vx * dt + Math.sin(t * 9 + pt.seed) * dt * cw * 0.16
          pt.y += pt.vy * dt

          if (pt.kind === 'ash') {
            ctx.globalCompositeOperation = p < 0.45 ? 'lighter' : 'source-over'
            ctx.fillStyle = p < 0.35
              ? `rgba(255, 150, 45, ${alpha})`
              : p < 0.7
                ? `rgba(180, 55, 20, ${alpha})`
                : `rgba(55, 42, 46, ${alpha * 0.85})`
            ctx.save()
            ctx.translate(pt.x, pt.y)
            ctx.rotate(pt.seed + t * 5)
            const s = pt.size * (1 - p * 0.4)
            ctx.fillRect(-s * 0.7, -s * 0.4, s * 1.4, s * 0.8)
            ctx.restore()
            continue
          }

          ctx.globalCompositeOperation = 'lighter'
          if (pt.kind === 'shield') {
            ctx.fillStyle = `rgba(114, 239, 221, ${alpha * 0.9})`
          } else if (pt.kind === 'arcane') {
            ctx.fillStyle = pt.seed % 2 > 1
              ? `rgba(185, 120, 255, ${alpha * 0.9})`
              : `rgba(90, 235, 175, ${alpha * 0.9})`
          } else if (pt.kind === 'impact') {
            ctx.fillStyle = `rgba(255, 215, 130, ${alpha * 0.9})`
          } else if (pt.color === 'black') {
            ctx.fillStyle = p < 0.3
              ? `rgba(255, 225, 200, ${alpha})`
              : `rgba(255, 50, 105, ${alpha * 0.88})`
          } else {
            ctx.fillStyle = p < 0.3
              ? `rgba(255, 245, 195, ${alpha})`
              : `rgba(255, 125, 20, ${alpha * 0.88})`
          }

          const radius = pt.size * (pt.kind === 'breath' ? 1 - p * 0.5 : 1 - p * 0.3)
          ctx.beginPath()
          ctx.arc(pt.x, pt.y, Math.max(0.8, radius), 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.restore()
        particlesRef.current = aliveParticles
      }

      const stillActive =
        !reducedMotion &&
        (fires.length > 0 ||
          Boolean(prev?.cells.length) ||
          particlesRef.current.length > 0 ||
          ringsRef.current.length > 0 ||
          pendingRef.current.length > 0)

      if (stillActive) {
        rafRef.current = requestAnimationFrame(renderFrame)
      } else {
        rafRef.current = null
        lastTickRef.current = 0
      }
    }

    function wakeLoop() {
      if (rafRef.current !== null) return
      const hasWork =
        fireRef.current.length > 0 ||
        Boolean(previewRef.current?.cells.length) ||
        particlesRef.current.length > 0 ||
        ringsRef.current.length > 0 ||
        pendingRef.current.length > 0
      if (!hasWork) {
        // Clear any leftover frame
        const { w, h, dpr } = sizeRef.current
        ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx?.clearRect(0, 0, w, h)
        return
      }
      lastTickRef.current = performance.now()
      rafRef.current = requestAnimationFrame(renderFrame)
    }

    wakeLoopRef.current = wakeLoop
    wakeLoop()

    return () => {
      observer.disconnect()
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  // Wake animation loop whenever fire state or preview changes
  useEffect(() => {
    wakeLoopRef.current()
  }, [activeFireCells, preview])

  return <canvas ref={canvasRef} className="board-vfx-canvas" aria-hidden="true" />
}
