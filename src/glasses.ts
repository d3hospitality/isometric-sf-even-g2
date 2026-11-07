import {
  CreateStartUpPageContainer, EventSourceType, ImageContainerProperty, ImageRawDataUpdate,
  ImageRawDataUpdateResult, OsEventTypeList as Event, StartUpPageCreateResult,
  MenuContainerProperty, MenuItemProperty, RebuildPageContainer,
  TextContainerProperty, TextContainerUpgrade, waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { height, imageLayout, splitFrame, width, type TileCount } from './frame.ts'
import { effectMenuItem, layoutMenuItem, mapModes } from './map-controls.ts'
import { opticsMenuItem } from './optics.ts'

export async function connectGlasses(
  input: (event: Event) => void,
  status: (message: string) => void,
  chooseMode: (itemID: number) => void,
  initialCount: TileCount,
  report: (message: string) => void,
) {
  const bridge = await waitForEvenAppBridge()
  const page = (count: TileCount) => ({
    containerTotalNum: count + 2,
    menuObject: new MenuContainerProperty({
      menuItems: [...mapModes, opticsMenuItem, layoutMenuItem, effectMenuItem]
        .map(({ itemID, itemName }) => new MenuItemProperty({ itemID, itemName })),
    }),
    textObject: [
      new TextContainerProperty({
        containerID: 1, containerName: 'input', xPosition: 0, yPosition: 0,
        width, height, content: ' ', isEventCapture: 1, zOrderIndex: 0,
      }),
      new TextContainerProperty({
        containerID: 6, containerName: 'fit-cue', xPosition: 8, yPosition: 253,
        width: 360, height: 32, content: ' ', zOrderIndex: 5,
      }),
    ],
    imageObject: imageLayout(count).map((tile, index) => new ImageContainerProperty({
      ...tile, zOrderIndex: index + 1,
    })),
  })
  const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page(initialCount)))
  if (result !== StartUpPageCreateResult.success) throw new Error(`Glasses startup: ${result}`)

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  let activeCount = initialCount
  let pending: { frame: Uint8Array; cue: string; count: TileCount } | undefined
  let displayedFrame: Uint8Array | undefined
  let displayedTiles: (Uint8Array | undefined)[] = []
  let displayedCue = ' '
  let timer: ReturnType<typeof setTimeout> | undefined
  let sending = false
  let current = false
  let closed = false

  let menuOpen = false
  const unsubscribe = bridge.onEvenHubEvent(({ textEvent, listEvent, sysEvent, menuItemClickEvent }) => {
    if (menuItemClickEvent?.itemID !== undefined) {
      chooseMode(menuItemClickEvent.itemID)
      return
    }
    const event = textEvent ?? listEvent ?? sysEvent
    if (!event) return
    // Some hosts omit the zero-valued click type and send only its touch source.
    const source = sysEvent?.eventSource
    const touchClick = source === EventSourceType.TOUCH_EVENT_FROM_GLASSES_R ||
      source === EventSourceType.TOUCH_EVENT_FROM_RING ||
      source === EventSourceType.TOUCH_EVENT_FROM_GLASSES_L
    const type = event.eventType ?? (textEvent || listEvent || touchClick ? Event.CLICK_EVENT : undefined)
    if (type === Event.FOREGROUND_ENTER_EVENT) menuOpen = true
    if (type === Event.FOREGROUND_EXIT_EVENT) menuOpen = false
    if (type === undefined || menuOpen) return
    if (type === Event.LONG_PRESS_EVENT && !current) {
      status('Wait for the current preview to settle, then hold again')
      return
    }
    input(type)
  })

  window.addEventListener('pagehide', event => {
    if (event.persisted) return
    closed = true
    clearTimeout(timer)
    unsubscribe()
  })

  async function flush() {
    if (sending || !pending || closed) return
    sending = true
    status('Updating glasses…')
    try {
      frames: while (pending && !closed) {
        const { frame, cue, count } = pending
        pending = undefined
        if (count !== activeCount) {
          const updated = await bridge.rebuildPageContainer(new RebuildPageContainer(page(count)))
          if (!updated) throw new Error('Could not change image layout')
          activeCount = count
          displayedFrame = undefined
          displayedTiles = []
          displayedCue = ' '
        }
        if (frame !== displayedFrame) {
          const started = performance.now()
          let sent = 0
          let bytes = 0
          displayedFrame = undefined
          const layout = imageLayout(count)
          for (const [index, pixels] of splitFrame(frame, count).entries()) {
            if (closed) return
            if (pending) continue frames
            const previous = displayedTiles[index]
            if (previous && pixels.every((pixel, i) => pixel === previous[i])) continue
            const tile = layout[index]
            canvas.width = tile.width
            canvas.height = tile.height
            const image = ctx.createImageData(tile.width, tile.height)
            pixels.forEach((level, i) => {
              const offset = i * 4
              const shade = level * 17
              image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = shade
              image.data[offset + 3] = 255
            })
            ctx.putImageData(image, 0, 0)
            const png = canvas.toDataURL('image/png').split(',')[1]
            const imageData = Uint8Array.from(atob(png), char => char.charCodeAt(0))
            const result = await bridge.updateImageRawData(new ImageRawDataUpdate({
              containerID: tile.containerID, containerName: tile.containerName, imageData,
            }))
            if (!ImageRawDataUpdateResult.isSuccess(result)) {
              displayedTiles[index] = undefined
              throw new Error(`${tile.containerName}: ${result}`)
            }
            displayedTiles[index] = pixels
            sent++
            bytes += imageData.length
          }
          displayedFrame = frame
          report(`${sent}/${count} tiles sent · ${(bytes / 1024).toFixed(1)} KiB PNG · ${Math.round(performance.now() - started)} ms SDK update`)
        }
        if (cue !== displayedCue && !closed) {
          const updated = await bridge.textContainerUpgrade(new TextContainerUpgrade({
            containerID: 6, containerName: 'fit-cue', contentOffset: 0,
            contentLength: cue.length, content: cue,
          }))
          if (!updated) throw new Error('Could not update fitting cue')
          displayedCue = cue
        }
      }
      current = true
      status('Glasses preview ready')
    } catch (error) {
      status(`Glasses update failed · ${String(error)}`)
    } finally {
      sending = false
      if (pending && !closed) timer = setTimeout(flush, 25)
    }
  }

  return (frame: Uint8Array, cue: string, count: TileCount) => {
    pending = { frame, cue, count }
    current = false
    clearTimeout(timer)
    if (!sending) timer = setTimeout(flush, 25)
  }
}
