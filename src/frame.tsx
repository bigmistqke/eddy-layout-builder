import {
  createEffect,
  createSignal,
  onSettled,
  Show,
  untrack,
  useContext,
  type JSX,
  type ParentProps,
} from "solid-js"
import { Context } from "./context"
import styles from "./frame.module.css"
import { ArrowIcon } from "./icons"

export function Notch(props: {
  ref?: (el: HTMLDivElement) => void
  style?: JSX.CSSProperties
  children: JSX.Element
  class: string
  onClick?(): void
  orientation?: "top" | "bottom" | "left" | "right"
}) {
  const orient = () => props.orientation ?? "bottom"
  return (
    <div
      ref={props.ref}
      class={[styles.notch, styles[`hud-${orient()}`], props.class]}
      style={props.style}
      onClick={e => e.stopPropagation()}
    >
      <div class={styles["notch-backdrop"]}>
        <div class={styles.edge} onClick={props.onClick} />
        <div class={styles.center} onClick={props.onClick} />
        <div class={styles.root} onClick={props.onClick} />
      </div>
      {props.children}
    </div>
  )
}

function ArrowNotch(props: { ref?: (el: HTMLDivElement) => void; style?: JSX.CSSProperties; class: string; onClick?(): void }) {
  return (
    <Notch ref={props.ref} style={props.style} class={props.class} onClick={props.onClick}>
      <ArrowIcon class={styles.arrow} />
    </Notch>
  )
}

function EdgeButton(props: { ref?: (el: HTMLButtonElement) => void; class: string; onClick?(): void }) {
  return (
    <button
      ref={props.ref}
      class={[styles["edge-button"], props.class]}
      onClick={e => {
        e.stopPropagation()
        props.onClick?.()
      }}
    >
      <svg
        width="35"
        height="35"
        viewBox="0 0 35 35"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M33 19L19.5 19L19.5 33C19.5 34.1046 18.6046 35 17.5 35C16.3954 35 15.5 34.1046 15.5 33L15.5 19L2 19C0.895431 19 -8.69891e-07 18.1046 -8.16818e-07 17C-7.63746e-07 15.8954 0.895431 15 2 15L15.5 15L15.5 2C15.5 0.89543 16.3954 -7.39833e-07 17.5 -6.95908e-07C18.6046 -6.51984e-07 19.5 0.89543 19.5 2L19.5 15L33 15C34.1046 15 35 15.8954 35 17C35 18.1046 34.1046 19 33 19Z"
          fill="var(--color-front)"
        />
      </svg>
    </button>
  )
}

export function Frame(
  props: ParentProps<{
    onClick?: JSX.EventHandlersElement<HTMLDivElement>["onClick"]
    handleDirections?: ("top" | "bottom" | "left" | "right")[]
    buttonDirections?: ("top" | "bottom" | "left" | "right")[]
    style?: JSX.CSSProperties
    class?: string
    "data-path"?: string
    onAddFrame(direction: "top" | "bottom" | "left" | "right"): void
  }>,
) {
  const dirs = () => props.handleDirections ?? []
  const buttonDirs = () => props.buttonDirections ?? []
  const context = useContext(Context)
  type Direction = "top" | "bottom" | "left" | "right"

  // ownedWrite: true allows writing these from inside owned scopes —
  // checkAllHandles is invoked synchronously from registerCollidable's
  // notify path, which fires from within the registry's owned cleanup.
  // (Plain createStore doesn't expose ownedWrite, so extendByDir is a
  // signal of the whole record rather than a store.)
  const [extendByDir, setExtendByDir] = createSignal<Record<Direction, number>>(
    { top: 0, bottom: 0, left: 0, right: 0 },
    { ownedWrite: true },
  )
  const [handlesHidden, setHandlesHidden] = createSignal(false, { ownedWrite: true })
  let frameRef!: HTMLDivElement

  // Per-direction signal-driven handle registration. Each ref just calls a
  // setter; a createEffect at component scope owns the lifecycle (registering
  // when the element appears, unregistering when it changes or the component
  // disposes). Replaces the previous runWithOwner+onCleanup-in-ref dance.
  const [topEl, setTopEl] = createSignal<HTMLElement>()
  const [bottomEl, setBottomEl] = createSignal<HTMLElement>()
  const [leftEl, setLeftEl] = createSignal<HTMLElement>()
  const [rightEl, setRightEl] = createSignal<HTMLElement>()
  const handleEls: Record<Direction, () => HTMLElement | undefined> = {
    top: topEl,
    bottom: bottomEl,
    left: leftEl,
    right: rightEl,
  }

  // ArrowNotch's wrapper has zero in-flow width (both children are absolute-
  // positioned). Use the visible .notch-backdrop child for collision so its
  // rect actually overlaps with HUDs and other handles. EdgeButton has an
  // explicit CSS size, so the button itself is correct.
  function visibleCollidable(el: HTMLElement): HTMLElement {
    return el.tagName === "BUTTON"
      ? el
      : ((el.firstElementChild as HTMLElement) ?? el)
  }

  function registerDirection(dir: Direction) {
    createEffect(handleEls[dir], el => {
      if (!el) return
      const collidableEl = visibleCollidable(el)
      return context.registerCollidable(collidableEl, "handle")
    })
  }
  registerDirection("top")
  registerDirection("bottom")
  registerDirection("left")
  registerDirection("right")

  function overlapAmount(handle: DOMRect, hud: DOMRect, dir: Direction): number {
    switch (dir) {
      case "bottom":
        return Math.max(0, handle.bottom - hud.top)
      case "top":
        return Math.max(0, hud.bottom - handle.top)
      case "right":
        return Math.max(0, handle.right - hud.left)
      case "left":
        return Math.max(0, hud.right - handle.left)
    }
  }

  function checkAllHandles() {
    const directions: Direction[] = ["top", "bottom", "left", "right"]
    let anyStillCollides = false
    const newExtends: Record<Direction, number> = { top: 0, bottom: 0, left: 0, right: 0 }

    for (const dir of directions) {
      // checkAllHandles runs from outside Solid's tracking scope (called via
      // registerUpdateCollision, observeFrame, etc.), so untrack the signal
      // read to silence the STRICT_READ_UNTRACKED dev warning.
      const wrapper = untrack(() => handleEls[dir]())
      if (!wrapper) continue
      const handle = visibleCollidable(wrapper)

      const hits = context.findCollisions(handle)
      if (hits.length === 0) continue

      const handleRect = handle.getBoundingClientRect()
      let extend = 0
      for (const hit of hits) {
        if (hit.kind === "hud") {
          extend = Math.max(extend, overlapAmount(handleRect, hit.rect, dir))
        }
      }
      newExtends[dir] = extend

      // Only count handle-vs-handle as "this frame's UI doesn't fit" when
      // the other handle is on the *same* frame. Cross-frame handle overlaps
      // (adjacent frames whose 100px-wide handles meet across an 8px gap)
      // shouldn't hide either frame's handles.
      const stillCollidesWithHandle = hits.some(
        h => h.kind === "handle" && h.el.closest("[data-path]") === frameRef,
      )
      if (stillCollidesWithHandle) anyStillCollides = true
    }

    if (anyStillCollides) {
      setHandlesHidden(true)
      setExtendByDir(() => ({ top: 0, bottom: 0, left: 0, right: 0 }))
    } else {
      setHandlesHidden(false)
      setExtendByDir(() => newExtends)
    }
  }

  // Subscribe to "registry changed" notifications so checkAllHandles re-runs
  // whenever any handle / HUD mounts or unmounts (including HUD el changes
  // since those go through registerCollidable too).
  onSettled(() => context.registerUpdateCollision(checkAllHandles))
  onSettled(() => context.observeFrame(frameRef, checkAllHandles))

  return (
    <div
      ref={frameRef}
      onClick={props.onClick}
      style={props.style}
      class={[props.class, styles.frame]}
      data-path={props["data-path"]}
    >
      <Show when={!handlesHidden()}>
        <Show when={dirs().includes("top")}>
          <Show
            when={buttonDirs().includes("top")}
            fallback={
              <ArrowNotch
                ref={setTopEl}
                class={styles.top}
                style={extendByDir().top > 0 ? { "--extend": `${extendByDir().top}px` } : undefined}
                onClick={() => props.onAddFrame("top")}
              />
            }
          >
            <EdgeButton
              ref={setTopEl}
              class={styles.top}
              onClick={() => props.onAddFrame("top")}
            />
          </Show>
        </Show>
        <Show when={dirs().includes("bottom")}>
          <Show
            when={buttonDirs().includes("bottom")}
            fallback={
              <ArrowNotch
                ref={setBottomEl}
                class={styles.bottom}
                style={extendByDir().bottom > 0 ? { "--extend": `${extendByDir().bottom}px` } : undefined}
                onClick={() => props.onAddFrame("bottom")}
              />
            }
          >
            <EdgeButton
              ref={setBottomEl}
              class={styles.bottom}
              onClick={() => props.onAddFrame("bottom")}
            />
          </Show>
        </Show>
        <Show when={dirs().includes("left")}>
          <Show
            when={buttonDirs().includes("left")}
            fallback={
              <ArrowNotch
                ref={setLeftEl}
                class={styles.left}
                style={extendByDir().left > 0 ? { "--extend": `${extendByDir().left}px` } : undefined}
                onClick={() => props.onAddFrame("left")}
              />
            }
          >
            <EdgeButton
              ref={setLeftEl}
              class={styles.left}
              onClick={() => props.onAddFrame("left")}
            />
          </Show>
        </Show>
        <Show when={dirs().includes("right")}>
          <Show
            when={buttonDirs().includes("right")}
            fallback={
              <ArrowNotch
                ref={setRightEl}
                class={styles.right}
                style={extendByDir().right > 0 ? { "--extend": `${extendByDir().right}px` } : undefined}
                onClick={() => props.onAddFrame("right")}
              />
            }
          >
            <EdgeButton
              ref={setRightEl}
              class={styles.right}
              onClick={() => props.onAddFrame("right")}
            />
          </Show>
        </Show>
      </Show>
      {props.children}
    </div>
  )
}
