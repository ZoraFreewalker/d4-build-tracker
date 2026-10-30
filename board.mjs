// Paragon board geometry, shared by the overlay renderer and the tests.

// cell index -> [col, row] after `rotation` quarter turns clockwise
export function rotatedCell(index, width, rotation = 0) {
  let x = index % width, y = Math.floor(index / width);
  for (let r = 0; r < ((rotation % 4) + 4) % 4; r++) [x, y] = [width - 1 - y, x];
  return [x, y];
}

// which side of the board a cell sits on (only meaningful for edge cells such as gates)
export function sideOf([x, y], width) {
  const last = width - 1;
  return y === 0 ? 'top' : y === last ? 'bottom' : x === 0 ? 'left' : x === last ? 'right' : null;
}
