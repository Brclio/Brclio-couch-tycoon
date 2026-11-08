import { SQUARES } from '../shared/board.js';
import { rentFor } from '../shared/engine.js';

export function rentPreview(game, square) {
  const rent = rentFor(game, square, 1);
  if (SQUARES[square].type === 'utility' && rent) return `骰子点数 × ${rent}`;
  return '$' + rent.toLocaleString('en-US');
}
