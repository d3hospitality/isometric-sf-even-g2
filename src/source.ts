import { height, width } from './frame.ts'

const mapRoot = 'https://justinchavez.github.io/sf-isometric-demo/map/'
const tileSize = 512
const tileCacheLimit = 96

async function fetchAsset(path: string) {
  const response = await fetch(new URL(path, mapRoot), { signal: AbortSignal.timeout(8000) })
  if (!response.ok) throw new Error(`Map asset returned HTTP ${response.status}`)
  return response
}

async function loadImage(path: string) {
  const response = await fetchAsset(`${path}.webp`).catch(() => fetchAsset(`${path}.png`))
  const url = URL.createObjectURL(await response.blob())
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return image
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function loadSfMap() {
  const { bounds, quad_size } = await (await fetchAsset('manifest.json')).json()
  if (quad_size !== tileSize || !bounds || ![bounds.qx_min, bounds.qx_max, bounds.qy_min, bounds.qy_max]
    .every(Number.isInteger) || bounds.qx_min > bounds.qx_max || bounds.qy_min > bounds.qy_max) {
    throw new Error('Unexpected SF map bounds')
  }
  const mapWidth = (bounds.qx_max - bounds.qx_min + 1) * tileSize
  const mapHeight = (bounds.qy_max - bounds.qy_min + 1) * tileSize
  const tiles = new Map<string, Promise<HTMLImageElement>>()
  let overview: Promise<HTMLImageElement> | undefined

  function getTile(x: number, y: number) {
    const key = `${x + bounds.qx_min}_${y + bounds.qy_min}`
    const existing = tiles.get(key)
    const request = existing ?? loadImage(`quadrants/${key}`).catch(error => {
      if (tiles.get(key) === request) tiles.delete(key)
      throw error
    })
    tiles.delete(key)
    tiles.set(key, request)
    if (tiles.size > tileCacheLimit) tiles.delete(tiles.keys().next().value!)
    return request
  }

  return {
    width: mapWidth,
    height: mapHeight,
    homeX: (30 - bounds.qx_min) * tileSize,
    homeY: (21.5 - bounds.qy_min) * tileSize,
    async render(x: number, y: number, cropWidth: number, cropHeight: number) {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')!
      ctx.imageSmoothingQuality = 'high'
      const firstX = Math.floor(x / tileSize)
      const firstY = Math.floor(y / tileSize)
      const lastX = Math.min(Math.ceil((x + cropWidth) / tileSize), mapWidth / tileSize)
      const lastY = Math.min(Math.ceil((y + cropHeight) / tileSize), mapHeight / tileSize)
      if ((lastX - firstX) * (lastY - firstY) > 36) {
        const image = await (overview ??= loadImage('overview').catch(error => {
          overview = undefined
          throw error
        }))
        const sx = image.naturalWidth / mapWidth
        const sy = image.naturalHeight / mapHeight
        ctx.drawImage(image, x * sx, y * sy, cropWidth * sx, cropHeight * sy, 0, 0, width, height)
        return canvas
      }
      const requests = []
      for (let row = firstY; row < lastY; row++) {
        for (let col = firstX; col < lastX; col++) {
          requests.push(getTile(col, row).then(image => ({ image, row, col })))
        }
      }
      const images = await Promise.all(requests)
      // Assemble before scaling so adjacent tiles share the same pixel grid.
      const mosaic = document.createElement('canvas')
      mosaic.width = (lastX - firstX) * tileSize
      mosaic.height = (lastY - firstY) * tileSize
      const mosaicContext = mosaic.getContext('2d')!
      for (const { image, row, col } of images) {
        mosaicContext.drawImage(image, (col - firstX) * tileSize, (row - firstY) * tileSize, tileSize, tileSize)
      }
      ctx.drawImage(mosaic, x - firstX * tileSize, y - firstY * tileSize, cropWidth, cropHeight, 0, 0, width, height)
      return canvas
    },
  }
}

// Original calibration artwork with repeating street lines, rooftops and broad dark water.
export function drawSample(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = '#182c43'
  ctx.fillRect(0, 0, width, height)
  const project = (x: number, y: number, z: number) => [280 + (x - y) * 0.9, -32 + (x + y) * 0.43 - z] as const
  const face = (points: [number, number, number][], color: string) => {
    ctx.beginPath()
    points.forEach((point, i) => {
      const [x, y] = project(...point)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
  }
  face([[0, 0, 0], [380, 0, 0], [380, 308, 0], [0, 308, 0]], '#777c82')
  for (let row = 0; row < 7; row++) {
    for (let column = 0; column < 9; column++) {
      const x = column * 42 + 3
      const y = row * 43 + 3
      const park = (row + column * 3) % 11 === 2
      face([[x, y, 0], [x + 36, y, 0], [x + 36, y + 37, 0], [x, y + 37, 0]], park ? '#546f56' : '#bba98c')
      for (let building = 0; building < 2; building++) {
        const left = x + building * 17 + 3
        const top = y + 4
        const right = left + 13
        const bottom = top + 23
        const z = park ? 3 : 11 + (row * 23 + column * 11 + building * 9) % 30
        face([[left, bottom, 0], [right, bottom, 0], [right, bottom, z], [left, bottom, z]], '#758296')
        face([[right, top, 0], [right, bottom, 0], [right, bottom, z], [right, top, z]], '#454c61')
        face([[left, top, z], [right, top, z], [right, bottom, z], [left, bottom, z]],
          park ? '#8fa16d' : ['#e8ce9e', '#aebac4', '#b68072', '#e0dfd3'][(row + column + building) % 4])
        for (let floor = 5; floor < z - 2; floor += 6) {
          face([[left + 2, bottom, floor], [right - 2, bottom, floor],
            [right - 2, bottom, floor + 1], [left + 2, bottom, floor + 1]], '#c3d4d8')
        }
      }
    }
  }
}

export async function drawLocalImage(ctx: CanvasRenderingContext2D, file: File) {
  const image = await createImageBitmap(file)
  try {
    const scale = Math.max(width / image.width, height / image.height)
    ctx.imageSmoothingQuality = 'high'
    ctx.clearRect(0, 0, width, height)
    ctx.drawImage(image, (width - image.width * scale) / 2, (height - image.height * scale) / 2,
      image.width * scale, image.height * scale)
  } finally {
    image.close()
  }
}
