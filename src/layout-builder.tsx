import { createSignal, onSettled } from "solid-js"
import { Canvas } from "./components/canvas"
import { Breadcrumb } from "./hud/breadcrumb"
import { Contextual } from "./hud/contextual"
import { Main } from "./hud/main"
import { Menu } from "./hud/menu"
import styles from "./layout-builder.module.css"

export function LayoutBuilder() {
  // Canvas aspect ratio (width / height) — drives Breadcrumb minimap
  // segment sizing. Defaults to 1 until the first measurement.
  const [canvasAspect, setCanvasAspect] = createSignal(1, { ownedWrite: true })
  let canvasElement!: HTMLDivElement

  onSettled(() => {
    if (!canvasElement) {
      return
    }
    const initialRect = canvasElement.getBoundingClientRect()
    setCanvasAspect(initialRect.height > 0 ? initialRect.width / initialRect.height : 1)
    const resizeObserver = new ResizeObserver(() => {
      const rect = canvasElement.getBoundingClientRect()
      if (rect.height > 0) {
        setCanvasAspect(rect.width / rect.height)
      }
    })
    resizeObserver.observe(canvasElement)
    return () => resizeObserver.disconnect()
  })

  return (
    <div class={styles.layoutBuilder}>
      <div class={styles.canvas} ref={canvasElement} data-canvas="true">
        <Canvas />
        <div class={styles.hudOverlay}>
          <Breadcrumb canvasAspect={canvasAspect} />
          <Menu />
          <Contextual />
          <Main />
        </div>
      </div>
    </div>
  )
}
