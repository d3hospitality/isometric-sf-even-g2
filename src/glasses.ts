import {
  CreateStartUpPageContainer, EventSourceType, ImageContainerProperty, ImageRawDataUpdate,
  ImageRawDataUpdateResult, OsEventTypeList as Event, StartUpPageCreateResult,
  MenuContainerProperty, MenuItemProperty,
  TextContainerProperty, TextContainerUpgrade, waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { height, splitFrame, tiles, tileHeight, tileWidth, width } from './frame.ts'
import { mapModes } from './map-controls.ts'
import { opticsMenuItem } from './optics.ts'

export async function connectGlasses(
  input: (event: Event) => void,
  status: (message: string) => void,
  chooseMode: (itemID: number) => void,
) {
  const bridge = await waitForEvenAppBridge()
  const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: 6,
    menuObject: new MenuContainerProperty({
      menuItems: [...mapModes, opticsMenuItem].map(({ itemID, itemName }) => new MenuItemProperty({ itemID, itemName })),
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
    imageObject: tiles.map((tile, index) => new ImageContainerProperty({
      ...tile, width: tileWidth, height: tileHeight, zOrderIndex: index + 1,
    })),
  }))
  if (result !== StartUpPageCreateResult.success) throw new Error(`Glasses startup: ${result}`)

  const canvas = document.createElement('canvas')
  canvas.width = tileWidth
  canvas.height = tileHeight
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(tileWidth, tileHeight)
  let pending: { frame: Uint8Array; cue: string } | undefined
  let displayedFrame: Uint8Array | undefined
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
    status('Updating four tiles…')
    try {
      while (pending && !closed) {
        const { frame, cue } = pending
        pending = undefined
        if (frame !== displayedFrame) {
          displayedFrame = undefined
          for (const [index, pixels] of splitFrame(frame).entries()) {
            if (closed) return
            pixels.forEach((level, i) => {
              const offset = i * 4
              const shade = level * 17
              image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = shade
              image.data[offset + 3] = 255
            })
            ctx.putImageData(image, 0, 0)
            const png = canvas.toDataURL('image/png').split(',')[1]
            const result = await bridge.updateImageRawData(new ImageRawDataUpdate({
              containerID: tiles[index].containerID,
              containerName: tiles[index].containerName,
              imageData: Uint8Array.from(atob(png), char => char.charCodeAt(0)),
            }))
            if (!ImageRawDataUpdateResult.isSuccess(result)) throw new Error(`${tiles[index].containerName}: ${result}`)
          }
          displayedFrame = frame
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
      if (pending && !closed) timer = setTimeout(flush, 80)
    }
  }

  return (frame: Uint8Array, cue: string) => {
    pending = { frame, cue }
    current = false
    clearTimeout(timer)
    if (!sending) timer = setTimeout(flush, 80)
  }
}
