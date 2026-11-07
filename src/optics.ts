import { height, width } from './frame.ts'

export const opticsMenuItem = { itemID: 4, itemName: 'Optics check' }

export function makeOpticsTarget() {
  const pixels = new Uint8Array(width * height)
  function rect(x: number, y: number, w: number, h: number, level: number) {
    for (let row = y; row < y + h; row++) {
      pixels.fill(level, row * width + x, row * width + x + w)
    }
  }
  // Known intensities with black gaps for checking visible steps and light bleed.
  for (let level = 0; level < 16; level++) rect(16 + level * 34, 20, 30, 44, level)
  rect(24, 88, 104, 94, 15)
  rect(57, 112, 38, 46, 0)
  rect(143, 88, 104, 94, 8)
  rect(176, 112, 38, 46, 0)
  for (const [index, pitch] of [1, 2, 4].entries()) {
    for (let x = 0; x < 72; x += pitch * 2) rect(320 + index * 80 + x, 88, pitch, 94, 15)
  }
  // Lines cross the vertical join. The blocks and bars above span the horizontal join.
  for (let x = 24; x < width - 24; x++) rect(x, 193 + Math.floor((x - 24) / 8), 1, 1, 15)
  rect(24, 267, width - 48, 1, 12)
  return pixels
}
