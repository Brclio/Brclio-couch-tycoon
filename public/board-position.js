import { LONG_SIDE, SHORT_SIDE } from '/shared/board.js';

export function boardPosition(i, portrait = false) {
  const width = LONG_SIDE + 2, height = SHORT_SIDE + 2;
  let row, col;
  if (i < width) [row, col] = [height, width - i];
  else if (i < width + height - 1) [row, col] = [height - (i - width + 1), 1];
  else if (i < 2 * width + height - 2) [row, col] = [1, i - width - height + 3];
  else [row, col] = [i - 2 * width - height + 4, width];
  return portrait ? [col, row] : [row, col];
}
