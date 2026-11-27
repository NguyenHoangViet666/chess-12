import { useRef, useState, type KeyboardEvent } from 'react'
import { BOARD_SIZE, FILES, pieceAt, sameSquare, squareName, type GameState, type Square } from '../engine/model'
import type { FireCell } from '../engine/fire'
import { kingOf } from '../engine/rules'
import { PieceGlyph } from './PieceGlyph'

const ranks = Array.from({ length: BOARD_SIZE }, (_, index) => BOARD_SIZE - 1 - index)
const files = [...FILES]

interface Props {
  game: GameState
  selected?: Square | null
  destinations: Map<string, { captures: boolean }>
  cone: FireCell[]
  armed: boolean
  axis: Square[]
  protectedLine: Square[]
  pending?: Square
  onSquare: (square: Square) => void
  onHover: (square: Square | null) => void
}

export function Board({
  game, selected, destinations, cone, armed, axis, protectedLine, pending, onSquare, onHover,
}: Props) {
  const [focusSquare, setFocusSquare] = useState('A12')
  const squares = useRef(new Map<string, HTMLButtonElement>())
  const currentKing = game.status.kind === 'checkmate' || (game.status.kind === 'active' && game.status.inCheck)
    ? kingOf(game, game.currentPlayer)?.currentSquare : null
  const last = game.moveHistory.at(-1)
  const effects = new Map(cone.map(cell => [squareName(cell.square), cell.effect]))
  const axisNames = new Set(axis.map(squareName))
  const lineNames = new Set(protectedLine.map(squareName))

  function navigate(event: KeyboardEvent<HTMLButtonElement>, square: Square) {
    let { file, rank } = square
    switch (event.key) {
      case 'ArrowLeft': file--; break
      case 'ArrowRight': file++; break
      case 'ArrowUp': rank++; break
      case 'ArrowDown': rank--; break
      case 'Home': file = 0; break
      case 'End': file = BOARD_SIZE - 1; break
      default: return
    }
    event.preventDefault()
    const next = squareName({
      file: Math.max(0, Math.min(BOARD_SIZE - 1, file)),
      rank: Math.max(0, Math.min(BOARD_SIZE - 1, rank)),
    })
    setFocusSquare(next)
    squares.current.get(next)?.focus()
  }

  return <div className="board-layout">
    <div className="rank-labels" aria-hidden="true">{ranks.map(rank => <span key={rank}>{rank + 1}</span>)}</div>
    <div className="board" role="group" aria-label="12 by 12 chessboard" onPointerLeave={() => onHover(null)}
      onBlur={event => {
        if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget)) onHover(null)
      }}>
      {ranks.flatMap(rank => files.map((_, file) => {
        const square = { file, rank }
        const name = squareName(square)
        const piece = pieceAt(game, square)
        const legal = destinations.get(name)
        const fire = effects.get(name)
        const isSelected = sameSquare(selected, square)
        const isChecked = sameSquare(currentKing, square)
        const isLast = sameSquare(last?.from, square) || sameSquare(last?.to, square)
        const className = [
          'square', (file + rank) % 2 === 0 ? 'square-dark' : 'square-light',
          isSelected && 'square-selected', isLast && 'square-last', isChecked && 'square-checked',
          fire && (armed ? `fire-${fire}` : 'fire-outline'), axisNames.has(name) && 'guard-axis',
          lineNames.has(name) && 'guard-line', sameSquare(pending, square) && 'square-pending',
        ].filter(Boolean).join(' ')
        const label = [
          name, piece && `${piece.color} ${piece.type}`, isChecked && 'in check',
          legal && (legal.captures ? 'legal capture' : 'legal move'),
          armed && fire === 'victim' && 'fire victim',
          armed && (fire === 'protected' || fire === 'protected-king') && 'protected from fire',
          armed && fire === 'king' && 'threatened by fire',
        ].filter(Boolean).join(', ')

        return <button key={name} type="button" className={className} aria-label={label} aria-pressed={isSelected}
          tabIndex={name === focusSquare ? 0 : -1} data-square={name}
          ref={element => {
            if (element) squares.current.set(name, element)
            else squares.current.delete(name)
          }}
          onFocus={() => { setFocusSquare(name); onHover(square) }}
          onPointerEnter={() => onHover(square)}
          onKeyDown={event => navigate(event, square)}
          onClick={() => onSquare(square)}>
          {piece && <span className="board-piece"><PieceGlyph type={piece.type} color={piece.color} /></span>}
          {legal && <span className={legal.captures ? 'capture-marker' : 'move-marker'} aria-hidden="true" />}
          {armed && (fire === 'protected' || fire === 'protected-king') && <span className="square-annotation" aria-hidden="true">◆</span>}
          {armed && fire === 'king' && <span className="square-annotation" aria-hidden="true">!</span>}
        </button>
      }))}
    </div>
    <div className="file-labels" aria-hidden="true">{files.map(file => <span key={file}>{file}</span>)}</div>
  </div>
}
