import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultProfile, height, renderFrame, splitFrame, tiles, tileHeight, tileWidth, width } from './src/frame.ts'

test('clockwise tiles reassemble the full frame with exactly one write per pixel', () => {
  assert.deepEqual(tiles.map(tile => [tile.xPosition, tile.yPosition]), [[0, 0], [288, 0], [288, 144], [0, 144]])
  const frame = Uint8Array.from({ length: width * height }, (_, i) => (i ^ (i >>> 6) ^ (i >>> 9)) & 15)
  const assembled = new Uint8Array(frame.length)
  const coverage = new Uint8Array(frame.length)
  splitFrame(frame).forEach((pixels, index) => {
    const tile = tiles[index]
    assert.equal(pixels.length, tileWidth * tileHeight)
    pixels.forEach((pixel, i) => {
      const target = (tile.yPosition + Math.floor(i / tileWidth)) * width + tile.xPosition + i % tileWidth
      assembled[target] = pixel
      coverage[target]++
    })
  })
  assert.ok(coverage.every(count => count === 1))
  assert.deepEqual(assembled, frame)
})

test('each dither renders a deterministic 16-level frame with black and white endpoints', () => {
  const source = Float32Array.from({ length: width * height }, (_, i) => (i % width) / (width - 1))
  for (const dither of [0, 1, 2, 3]) {
    const profile = { ...defaultProfile, dither }
    const pixels = renderFrame(source, profile)
    assert.equal(pixels.length, width * height)
    assert.equal(pixels[0], 0)
    assert.equal(pixels[width - 1], 15)
    assert.ok(pixels.every(pixel => pixel <= 15))
    assert.deepEqual(pixels, renderFrame(source, profile))
  }
})
