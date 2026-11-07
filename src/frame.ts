export const width = 576
export const height = 288
export const tileWidth = 288
export const tileHeight = 144
export const tiles = [
  { containerID: 2, containerName: 'top-left', xPosition: 0, yPosition: 0 },
  { containerID: 3, containerName: 'top-right', xPosition: tileWidth, yPosition: 0 },
  { containerID: 4, containerName: 'bottom-right', xPosition: tileWidth, yPosition: tileHeight },
  { containerID: 5, containerName: 'bottom-left', xPosition: 0, yPosition: tileHeight },
]

export type TileCount = 1 | 2 | 3 | 4

export function imageLayout(count: TileCount) {
  if (count === 4) return tiles.map(tile => ({ ...tile, width: tileWidth, height: tileHeight }))
  const tileW = count === 1 ? 288 : count === 2 ? 216 : 192
  const left = (width - count * tileW) / 2
  return Array.from({ length: count }, (_, index) => ({
    containerID: index + 2, containerName: `strip-${index + 1}`,
    xPosition: left + index * tileW, yPosition: (height - tileHeight) / 2,
    width: tileW, height: tileHeight,
  }))
}

export function splitFrame(frame: Uint8Array, count: TileCount = 4) {
  if (frame.length !== width * height) throw new Error('Expected a 576 × 288 frame')
  return imageLayout(count).map(tile => {
    const pixels = new Uint8Array(tile.width * tile.height)
    for (let y = 0; y < tile.height; y++) {
      const offset = (tile.yPosition + y) * width + tile.xPosition
      pixels.set(frame.subarray(offset, offset + tile.width), y * tile.width)
    }
    return pixels
  })
}

export const refreshEffects = ['Fitted', 'No dither', 'Flat 8 tones'] as const
export type RefreshEffect = typeof refreshEffects[number]

export const opacityOptions = [0.45, 0.6, 0.8, 1]
export const levelsOptions = [
  { label: 'Neutral', black: 0, white: 1, gamma: 1 },
  { label: 'Lift shadows', black: 0.025, white: 0.92, gamma: 1.25 },
  { label: 'Strong contrast', black: 0.12, white: 0.76, gamma: 1 },
  { label: 'Preserve highlights', black: 0.015, white: 1, gamma: 0.8 },
]
export const ditherOptions = ['None', 'Ordered 2 × 2', 'Ordered 4 × 4', 'Floyd–Steinberg']
export const stages = ['Opacity', 'Levels', 'Dither'] as const
export const labels = [opacityOptions.map(value => `${value * 100}%`),
  levelsOptions.map(option => option.label), ditherOptions]
export const defaultProfile: Profile = { opacity: 1, ...levelsOptions[0], dither: 0 }
export type Profile = { opacity: number; black: number; white: number; gamma: number; dither: number; ditherStrength?: number }

const bayer2 = [0, 2, 3, 1]
const bayer4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
const clamp = (value: number) => Math.max(0, Math.min(1, value))

export function luminance(rgba: Uint8ClampedArray) {
  const output = new Float32Array(rgba.length / 4)
  for (let i = 0; i < output.length; i++) {
    const p = i * 4
    output[i] = (0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2]) * rgba[p + 3] / 65025
  }
  return output
}

export function renderFrame(source: Float32Array, profile: Profile, effect: RefreshEffect = 'Fitted') {
  const dither = effect === 'Fitted' ? profile.dither : 0
  const values = source.map(value => 15 * Math.pow(
    clamp((value * profile.opacity - profile.black) / (profile.white - profile.black)),
    1 / profile.gamma,
  ))
  const output = new Uint8Array(values.length)
  const matrix = dither === 1 ? bayer2 : bayer4
  const size = dither === 1 ? 2 : 4
  const strength = profile.ditherStrength ?? 1
  for (let i = 0; i < values.length; i++) {
    const x = i % width
    const y = Math.floor(i / width)
    let value = values[i]
    if (dither === 1 || dither === 2) {
      value += ((matrix[(y % size) * size + x % size] + 0.5) / matrix.length - 0.5) * strength
    }
    const level = Math.max(0, Math.min(15, Math.round(value)))
    output[i] = effect === 'Flat 8 tones' ? Math.round(Math.round(level * 7 / 15) * 15 / 7) : level
    if (dither === 3) {
      const error = (value - level) * strength / 16
      if (x + 1 < width) values[i + 1] += error * 7
      if (i + width >= values.length) continue
      if (x > 0) values[i + width - 1] += error * 3
      values[i + width] += error * 5
      if (x + 1 < width) values[i + width + 1] += error
    }
  }
  return output
}
