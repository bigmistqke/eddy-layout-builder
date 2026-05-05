import {
  createEffect,
  createSignal,
  onSettled,
  Show,
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
      <ArrowIcon class={styles.arrow} />
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

  function checkOverlap() {
    const bar = context.bottomBarEl()
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

  createEffect(context.bottomBarEl, checkOverlap)
  onSettled(() => context.observeFrame(frameRef, checkOverlap))

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
