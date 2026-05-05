import { createEffect, createSignal, Show, useContext, type JSX, type ParentProps } from "solid-js"
import { Context } from "./app"
import styles from "./frame.module.css"

export function Arrow(props: { style?: JSX.CSSProperties; class?: string }) {
  return (
    <svg
      style={props.style}
      class={props.class}
      width="28"
      height="35"
      viewBox="0 0 28 35"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M11.9998 32.8486L11.9998 7.72461L3.42365 16.4229C2.64809 17.2091 1.38197 17.2178 0.595527 16.4424C-0.190875 15.6668 -0.199508 14.4007 0.575996 13.6143L13.9998 7.72388e-07L27.4237 13.6143C28.1992 14.4007 28.1905 15.6668 27.4041 16.4424C26.6177 17.2179 25.3516 17.2091 24.576 16.4229L15.9998 7.72461L15.9998 32.8486C15.9998 33.9532 15.1044 34.8486 13.9998 34.8486C12.8953 34.8486 11.9998 33.9532 11.9998 32.8486Z"
        fill="var(--color-front)"
      />
    </svg>
  )
}

export function Notch(props: {
  ref?: (el: HTMLDivElement) => void
  style?: JSX.CSSProperties
  children: JSX.Element
  class: string
  onClick?(): void
}) {
  return (
    <div
      ref={props.ref}
      class={[styles.notch, props.class]}
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

function ArrowNotch(props: { style?: JSX.CSSProperties; class: string; onClick?(): void }) {
  return (
    <Notch style={props.style} class={props.class} onClick={props.onClick}>
      <Arrow class={styles.arrow} />
    </Notch>
  )
}

function EdgeButton(props: { class: string; onClick?(): void }) {
  return (
    <button
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
    onAddFrame(direction: "top" | "bottom" | "left" | "right"): void
  }>,
) {
  const dirs = () => props.handleDirections ?? []
  const buttonDirs = () => props.buttonDirections ?? []
  const context = useContext(Context)
  const [bottomExtend, setBottomExtend] = createSignal(0)
  let frameRef!: HTMLDivElement

  function checkOverlap(bar: HTMLElement | undefined) {
    if (!bar || !frameRef) {
      setBottomExtend(0)
      return
    }
    const frameRect = frameRef.getBoundingClientRect()
    const barRect = bar.getBoundingClientRect()
    const verticalOverlap = frameRect.bottom > barRect.top + 1
    const notchCenterX = (frameRect.left + frameRect.right) / 2
    const horizontalOverlap = notchCenterX + 50 > barRect.left && notchCenterX - 50 < barRect.right
    setBottomExtend(verticalOverlap && horizontalOverlap ? barRect.height : 0)
  }

  // Set up frame ResizeObserver once after mount (no tracked signals — runs once)
  // Re-run whenever the bottom bar element changes
  createEffect(
    () => context?.bottomBarEl(),
    bar => {
      checkOverlap(bar)
      const controller = new AbortController()
      const observer = new ResizeObserver(() => checkOverlap(bar))
      observer.observe(frameRef)

      window.addEventListener("resize", () => checkOverlap(bar), controller)

      if (!bar) {
        return () => {
          controller.abort()
          observer.disconnect()
        }
      }

      observer.observe(bar)

      return () => {
        observer.disconnect()
        controller.abort()
      }
    },
  )

  return (
    <div
      ref={frameRef}
      onClick={props.onClick}
      style={props.style}
      class={[props.class, styles.frame]}
    >
      <Show when={dirs().includes("top")}>
        <Show
          when={buttonDirs().includes("top")}
          fallback={<ArrowNotch class={styles.top} onClick={() => props.onAddFrame("top")} />}
        >
          <EdgeButton class={styles.top} onClick={() => props.onAddFrame("top")} />
        </Show>
      </Show>
      <Show when={dirs().includes("bottom")}>
        <Show
          when={buttonDirs().includes("bottom")}
          fallback={
            <ArrowNotch
              class={styles.bottom}
              style={bottomExtend() > 0 ? { "--extend": `${bottomExtend()}px` } : undefined}
              onClick={() => props.onAddFrame("bottom")}
            />
          }
        >
          <EdgeButton class={styles.bottom} onClick={() => props.onAddFrame("bottom")} />
        </Show>
      </Show>
      <Show when={dirs().includes("left")}>
        <Show
          when={buttonDirs().includes("left")}
          fallback={<ArrowNotch class={styles.left} onClick={() => props.onAddFrame("left")} />}
        >
          <EdgeButton class={styles.left} onClick={() => props.onAddFrame("left")} />
        </Show>
      </Show>
      <Show when={dirs().includes("right")}>
        <Show
          when={buttonDirs().includes("right")}
          fallback={<ArrowNotch class={styles.right} onClick={() => props.onAddFrame("right")} />}
        >
          <EdgeButton class={styles.right} onClick={() => props.onAddFrame("right")} />
        </Show>
      </Show>
      {props.children}
    </div>
  )
}
