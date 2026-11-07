import { OsEventTypeList as Event } from '@evenrealities/even_hub_sdk'
import { defaultProfile, height, labels, levelsOptions, luminance, opacityOptions, renderFrame,
  stages, width, type Profile } from './frame.ts'
import { connectGlasses } from './glasses.ts'
import { drawLocalImage, drawSample, loadSfMap } from './source.ts'
import { mapModes } from './map-controls.ts'
import './style.css'

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const preview = byId<HTMLCanvasElement>('preview')
const original = byId<HTMLInputElement>('original')
const fileInput = byId<HTMLInputElement>('source')
const choices = byId('choices')
const dial = byId<HTMLInputElement>('dial')
const confirm = byId<HTMLButtonElement>('confirm')
const back = byId<HTMLButtonElement>('back')
const storageKey = 'g2-isometric-sf-fit-v1'
const defaults = [2, 2, 2]
const comparisonDefaults = [2, 0, 0]
const pointsPerSwipe = 2.5
const dialSteps = 100 / pointsPerSwipe
const adjustments: (number | null)[] = [null, null, null]
const source = document.createElement('canvas')
source.width = width
source.height = height
const sourceContext = source.getContext('2d', { willReadFrequently: true })!
let mapImage = document.createElement('canvas')
let sfMap: Awaited<ReturnType<typeof loadSfMap>> | undefined
let viewportRevision = 0
let viewportTimer: ReturnType<typeof setTimeout> | undefined
let loadingDefaultMap = true
mapImage.width = width
mapImage.height = height
drawSample(mapImage.getContext('2d')!)
let sourcePixels: Float32Array
let baseWidth = width
let centerX = width / 2
let centerY = height / 2
let zoom = 1
let mapMode: typeof mapModes[number] = mapModes[0]
let mapCue = ' '
let cueTimer: ReturnType<typeof setTimeout> | undefined
let selected = [...defaults]
let stage = 3
let saved = true
let submitToGlasses: ((frame: Uint8Array, cue: string) => void) | undefined
let activeFrame: Uint8Array
let activeCue = ' '

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

function readSourcePixels() {
  sourcePixels = luminance(sourceContext.getImageData(0, 0, width, height).data)
}

async function renderViewport(revision = ++viewportRevision) {
  const mapWidth = sfMap?.width ?? mapImage.width
  const mapHeight = sfMap?.height ?? mapImage.height
  const cropWidth = baseWidth / zoom
  const cropHeight = cropWidth * height / width
  centerX = clamp(centerX, cropWidth / 2, mapWidth - cropWidth / 2)
  centerY = clamp(centerY, cropHeight / 2, mapHeight - cropHeight / 2)
  const x = centerX - cropWidth / 2
  const y = centerY - cropHeight / 2
  const frame = sfMap ? await sfMap.render(x, y, cropWidth, cropHeight) : undefined
  if (revision !== viewportRevision) return false
  sourceContext.clearRect(0, 0, width, height)
  sourceContext.imageSmoothingQuality = 'high'
  if (frame) sourceContext.drawImage(frame, 0, 0)
  else sourceContext.drawImage(mapImage, x, y, cropWidth, cropHeight, 0, 0, width, height)
  readSourcePixels()
  return true
}

function queueViewport() {
  const revision = ++viewportRevision
  clearTimeout(viewportTimer)
  viewportTimer = setTimeout(async () => {
    const message = byId('map-load-status')
    message.textContent = 'Loading map view…'
    try {
      if (!await renderViewport(revision)) return
      message.textContent = ''
      refreshPreview()
    } catch {
      if (revision === viewportRevision) message.textContent = 'Map tiles could not load. Move again to retry.'
    }
  }, 75)
}

function resetView() {
  zoom = 1
  centerX = sfMap?.homeX ?? mapImage.width / 2
  centerY = sfMap?.homeY ?? mapImage.height / 2
}

function moveMap(direction: 1 | -1) {
  if (loadingDefaultMap || stage !== 3 || !saved) return
  const cropWidth = baseWidth / zoom
  if (mapMode.itemName === 'Zoom') {
    const minZoom = baseWidth / Math.min(sfMap?.width ?? mapImage.width,
      (sfMap?.height ?? mapImage.height) * width / height)
    zoom = clamp(zoom * 1.25 ** direction, minZoom, 4)
  } else if (mapMode.itemName === 'Pan') {
    centerX += direction * cropWidth * 0.15
  } else {
    centerY -= direction * cropWidth * height / width * 0.15
  }
  queueViewport()
}

function chooseMapMode(id: number) {
  if (stage !== 3 || !saved) return
  const mode = mapModes.find(item => item.itemID === id)
  if (!mode) return
  mapMode = mode
  mapCue = `${mode.itemName}  |  ${mode.up} / ${mode.down}`
  clearTimeout(cueTimer)
  cueTimer = setTimeout(() => {
    mapCue = ' '
    refreshPreview()
  }, 2400)
  updateMapControls()
  refreshPreview()
}
const opacityPresets = [...opacityOptions]
const levelsPresets = levelsOptions.map(option => ({ ...option }))
const within = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

function validLevels(black: unknown, white: unknown, gamma: unknown) {
  return within(black, 0, 1) && within(white, 0, 1) && white - black >= 0.0099 && within(gamma, 0.1, 4)
}

try {
  const stored = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
  const indices: unknown = stored?.selected ?? stored
  if (Array.isArray(indices) && indices.length === 3 && indices.every(i => Number.isInteger(i) && i >= 0 && i < 4)) {
    selected = indices
    adjustments.forEach((_, i) => {
      const value = stored.adjustments?.[i]
      const savedSteps = stored.dialSteps ?? 50
      if (within(savedSteps, 1, 100) && Number.isInteger(value) && within(value, 0, savedSteps)) {
        adjustments[i] = Math.round(value * dialSteps / savedSteps)
      }
    })
    opacityPresets.forEach((_, i) => {
      if (within(stored.opacity?.[i], 0, 1)) opacityPresets[i] = stored.opacity[i]
    })
    levelsPresets.forEach((preset, i) => {
      const option = stored.levels?.[i]
      if (option && validLevels(option.black, option.white, option.gamma)) {
        levelsPresets[i] = { ...preset, black: option.black, white: option.white, gamma: option.gamma }
      }
    })
    stage = 3
    saved = true
  }
} catch {
  // A malformed or inaccessible profile leaves the defaults available.
}

function profile(option: number, useAdjustment = true): Profile {
  const picks = selected.map((index, step) => step === stage ? option : step < stage ? index : comparisonDefaults[step])
  const result = {
    ...defaultProfile,
    ...(stage === 0 ? levelsOptions[0] : levelsPresets[picks[1]]),
    opacity: opacityPresets[picks[0]],
    dither: picks[2],
    ditherStrength: 1,
  }
  const [opacity, levels, dither] = adjustments.map((value, i) =>
    i < stage || (i === stage && useAdjustment) ? value : null)
  if (opacity !== null) result.opacity = opacity / dialSteps
  if (levels !== null) result.gamma = Math.max(0.1, levels / dialSteps * 2.5)
  if (dither !== null) {
    result.ditherStrength = dither / dialSteps
    if (dither > 0 && result.dither === 0) result.dither = 2
  }
  return result
}

function dialPosition() {
  return adjustments[stage] ?? [
    Math.round(opacityPresets[selected[0]] * dialSteps),
    Math.min(dialSteps, Math.round(levelsPresets[selected[1]].gamma / 2.5 * dialSteps)),
    selected[2] === 0 ? 0 : dialSteps,
  ][stage]
}

const scaleValue = (position: number) => String(position * pointsPerSwipe)

function setDial(position: number) {
  if (stage === 3) return
  const clamped = Math.max(0, Math.min(dialSteps, position))
  if (clamped === dialPosition()) return
  adjustments[stage] = clamped
  refreshPreview()
}

function labelFor(step: number, index: number) {
  if (step === 0) return `${Math.round(opacityPresets[index] * 100)}%`
  return labels[step][index]
}

function showTuning() {
  const form = byId<HTMLFormElement>('tuning-form')
  const error = byId('tuning-error')
  byId('tuning').hidden = stage > 1
  error.hidden = true
  form.replaceChildren()
  if (stage > 1) return
  const index = selected[stage]
  const { black, white, gamma } = levelsPresets[index]
  const fields = stage === 0
    ? [{ name: 'Opacity %', value: Math.round(opacityPresets[index] * 100), min: 0, max: 100, step: 1 }]
    : [
        { name: 'Black point', value: black, min: 0, max: 1, step: 0.005 },
        { name: 'White point', value: white, min: 0, max: 1, step: 0.005 },
        { name: 'Gamma', value: gamma, min: 0.1, max: 4, step: 0.05 },
      ]
  const inputs = fields.map(field => {
    const label = document.createElement('label')
    label.textContent = field.name
    const input = document.createElement('input')
    input.type = 'number'
    input.required = true
    for (const key of ['value', 'min', 'max', 'step'] as const) input[key] = String(field[key])
    label.append(input)
    form.append(label)
    return input
  })
  const apply = document.createElement('button')
  apply.textContent = 'Apply'
  form.append(apply)
  form.onsubmit = event => {
    event.preventDefault()
    const [first, second, third] = inputs.map(input => input.valueAsNumber)
    if (stage === 0) opacityPresets[index] = first / 100
    else if (validLevels(first, second, third)) {
      levelsPresets[index] = { ...levelsPresets[index], black: first, white: second, gamma: third }
    } else {
      error.textContent = 'Set the white point at least 0.01 above the black point.'
      error.hidden = false
      return
    }
    adjustments[stage] = null
    refresh()
    form.querySelector('button')?.focus()
  }
}

function paint(canvas: HTMLCanvasElement, frame: Uint8Array) {
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(width, height)
  frame.forEach((level, index) => {
    const p = index * 4
    image.data[p] = level * 7
    image.data[p + 1] = level * 17
    image.data[p + 2] = level * 8
    image.data[p + 3] = 255
  })
  ctx.putImageData(image, 0, 0)
}

function showPreview() {
  if (original.checked) preview.getContext('2d')!.drawImage(source, 0, 0)
  else paint(preview, activeFrame)
}

function refreshPreview() {
  const previous = activeFrame
  const previousCue = activeCue
  activeCue = stage === 3 && saved ? mapCue : ' '
  if (stage < 3) {
    const value = dialPosition()
    dial.value = scaleValue(value)
    dial.setAttribute('aria-valuetext', `${scaleValue(value)} out of 100`)
    byId('dial-value').textContent = scaleValue(value)
    byId('scale-label').textContent = ['Opacity', 'Levels gamma', 'Dither strength'][stage]
    activeCue = `${stages[stage]}  ${scaleValue(value)}/100  |  Hold to lock`
  }
  activeFrame = renderFrame(sourcePixels, profile(selected[stage] ?? 0))
  if (previous && activeFrame.every((pixel, index) => pixel === previous[index])) activeFrame = previous
  showPreview()
  if (activeFrame !== previous || activeCue !== previousCue) submitToGlasses?.(activeFrame, activeCue)
}

function refresh(focusChoice = false) {
  choices.replaceChildren()
  byId('stepper').textContent = [...stages, 'Review'].map((name, index) =>
    index === stage ? `[${name}]` : name).join('  →  ')
  byId('heading').textContent = stage < 3 ? `${stages[stage]} · ${stage + 1} of 3` : saved ? 'View locked' : 'Review your fit'
  byId('hint').textContent = stage < 3
    ? 'Swipe up or down to adjust by 2.5 points. Hold to lock this setting.'
    : selected.map((value, index) =>
      `${stages[index]} · ${adjustments[index] === null ? labelFor(index, value) : scaleValue(adjustments[index]!)}`).join('  /  ')
  byId('scale').hidden = stage === 3
  byId('map-controls').hidden = stage !== 3 || !saved
  updateMapControls()
  back.disabled = stage === 0
  confirm.textContent = stage < 3 ? 'Confirm choice' : saved ? 'Fit again' : 'Save profile'
  if (stage < 3) {
    labels[stage].forEach((_, index) => {
      const frame = renderFrame(sourcePixels, profile(index, false))
      const button = document.createElement('button')
      button.className = 'choice'
      button.setAttribute('aria-pressed', String(index === selected[stage]))
      const canvas = document.createElement('canvas')
      canvas.setAttribute('aria-hidden', 'true')
      paint(canvas, frame)
      const caption = document.createElement('span')
      caption.textContent = `${'ABCD'[index]} · ${labelFor(stage, index)}`
      button.append(canvas, caption)
      button.onclick = () => choose(index, true)
      choices.append(button)
      if (index === selected[stage]) {
        if (focusChoice) button.focus()
      }
    })
  }
  showTuning()
  refreshPreview()
}

function choose(index: number, focusChoice = false) {
  if (stage === 3) return
  selected[stage] = index
  adjustments[stage] = null
  refresh(focusChoice)
}

function goBack() {
  if (stage === 0) return
  saved = false
  stage--
  refresh()
}

function advance(fromHold = false) {
  if (stage < 3) {
    stage++
    if (stage === 3 && fromHold) {
      advance(true)
      return
    }
  } else if (saved) {
    if (fromHold) return
    stage = 0
    saved = false
  } else {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ selected, opacity: opacityPresets, levels: levelsPresets, adjustments, dialSteps }))
      saved = true
    } catch {
      byId('source-error').hidden = false
      byId('source-error').textContent = 'This browser could not save the profile.'
    }
  }
  refresh()
}

function input(event: Event) {
  if (event === Event.LONG_PRESS_EVENT) advance(true)
  if (event === Event.DOUBLE_CLICK_EVENT) goBack()
  if (stage === 3) {
    if (event === Event.SCROLL_TOP_EVENT) moveMap(1)
    if (event === Event.SCROLL_BOTTOM_EVENT) moveMap(-1)
    return
  }
  if (event === Event.SCROLL_TOP_EVENT) setDial(dialPosition() + 1)
  if (event === Event.SCROLL_BOTTOM_EVENT) setDial(dialPosition() - 1)
}

const modeButtons = mapModes.map(mode => {
  const button = document.createElement('button')
  button.textContent = mode.itemName
  button.onclick = () => chooseMapMode(mode.itemID)
  byId('map-modes').append(button)
  return button
})

function updateMapControls() {
  modeButtons.forEach((button, i) => button.setAttribute('aria-pressed', String(mapModes[i] === mapMode)))
  byId('map-up').textContent = mapMode.up
  byId('map-down').textContent = mapMode.down
}

byId('map-up').onclick = () => moveMap(1)
byId('map-down').onclick = () => moveMap(-1)
byId('map-home').onclick = () => {
  if (loadingDefaultMap) return
  resetView()
  queueViewport()
}
confirm.onclick = () => advance()
dial.oninput = () => setDial(dial.valueAsNumber / pointsPerSwipe)
back.onclick = goBack
byId('reset').onclick = () => {
  try { localStorage.removeItem(storageKey) } catch { /* session reset still works */ }
  selected = [...defaults]
  adjustments.fill(null)
  opacityPresets.splice(0, 4, ...opacityOptions)
  levelsPresets.splice(0, 4, ...levelsOptions.map(option => ({ ...option })))
  stage = 0
  saved = false
  refresh()
}
original.onchange = showPreview
byId<HTMLInputElement>('seams').onchange = event => {
  byId('screen').classList.toggle('seams', (event.target as HTMLInputElement).checked)
}
fileInput.onchange = async () => {
  const file = fileInput.files?.[0]
  if (!file) return
  const error = byId('source-error')
  error.hidden = true
  fileInput.disabled = true
  try {
    const localImage = document.createElement('canvas')
    localImage.width = width
    localImage.height = height
    await drawLocalImage(localImage.getContext('2d')!, file)
    clearTimeout(viewportTimer)
    sfMap = undefined
    mapImage = localImage
    baseWidth = width
    resetView()
    await renderViewport()
    byId('source-label').textContent = file.name
    stage = 0
    saved = false
    refresh()
  } catch {
    error.textContent = 'Could not open that image. Try a PNG, JPEG, or WebP file.'
    error.hidden = false
  } finally {
    fileInput.disabled = false
    fileInput.value = ''
  }
}
document.addEventListener('keydown', event => {
  if (event.target instanceof HTMLInputElement) return
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'Escape') return
  event.preventDefault()
  if (event.key === 'Escape') goBack()
  else if (stage < 3) setDial(dialPosition() + (event.key === 'ArrowUp' ? 1 : -1))
  else moveMap(event.key === 'ArrowUp' ? 1 : -1)
})

resetView()
void renderViewport()
refresh()
async function loadDefaultMap() {
  const label = byId('source-label')
  label.textContent = 'Loading Isometric SF…'
  fileInput.disabled = true
  try {
    sfMap = await loadSfMap()
    baseWidth = 1024
    resetView()
    await renderViewport()
    label.textContent = 'Isometric SF · Live map'
    refresh()
  } catch {
    sfMap = undefined
    baseWidth = width
    resetView()
    await renderViewport()
    refresh()
    label.textContent = 'Original isometric sample'
    const error = byId('source-error')
    error.textContent = 'Could not load Isometric SF. Showing the sample. Reload to retry or load a map image.'
    error.hidden = false
  } finally {
    loadingDefaultMap = false
    fileInput.disabled = false
  }
}
const sourceReady = loadDefaultMap()
const status = (message: string) => { byId('device').textContent = message }
void Promise.all([connectGlasses(input, status, chooseMapMode), sourceReady]).then(([send]) => {
  submitToGlasses = send
  send(activeFrame, activeCue)
}).catch(error => status(String(error)))
