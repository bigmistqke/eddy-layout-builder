import { For, Show, createMemo, type JSX, type ParentProps, useContext } from "solid-js"
import { Context } from "./context"
import styles from "./frame.module.css"
import { ArrowIcon } from "./icons"
import type { Direction, HandleSpec } from "./types"

export function Notch(props: {
  ref?: (el: HTMLDivElement) => void
  style?: JSX.CSSProperties
  children: JSX.Element
  class: string
  onClick?(): void
  orientation?: "top" | "bottom" | "left" | "right"
  "data-direction"?: Direction
}) {
  const orient = () => props.orientation ?? "bottom"
  return (
    <div
      ref={props.ref}
      class={[styles.notch, styles[`hud-${orient()}`], props.class]}
      style={props.style}
      data-direction={props["data-direction"]}
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

function ArrowNotch(props: {
  style?: JSX.CSSProperties
  class: string
  icon: JSX.Element
  direction: Direction
  onClick?(): void
}) {
  return (
    <Notch
      style={props.style}
      class={props.class}
      onClick={props.onClick}
      data-direction={props.direction}
    >
      {props.icon}
    </Notch>
  )
}

export function Frame(
  props: ParentProps<{
    onClick?: JSX.EventHandlersElement<HTMLDivElement>["onClick"]
    handles?: HandleSpec[]
    style?: JSX.CSSProperties
    class?: string
    "data-path"?: string
    onAddFrame(direction: Direction, op: "append" | "split"): void
  }>,
) {
  const handles = () => props.handles ?? []
  const context = useContext(Context)!

  // True iff this frame is the currently selected one. Equivalent to
  // "we have any handles to render," since handles() is empty for any
  // frame that isn't the selection's targeted scope.
  const isSelected = createMemo(() => handles().length > 0)

  function handleStyle(dir: Direction): JSX.CSSProperties | undefined {
    if (!isSelected()) return undefined
    const state = context.selectedHandlesState()
    const e = state.extend[dir]
    const s = state.stick[dir]
    if (e === 0 && s === 0) return undefined
    const out: Record<string, string> = {}
    if (e > 0) out["--extend"] = `${e}px`
    if (s > 0) out["--stick"] = `${s}px`
    return out as JSX.CSSProperties
  }

  return (
    <div
      onClick={props.onClick}
      style={props.style}
      class={[props.class, styles.frame]}
      data-path={props["data-path"]}
    >
      <Show when={!context.isAnimating()}>
        <For each={handles()}>
          {h => (
            <ArrowNotch
              class={styles[h().dir]}
              direction={h().dir}
              icon={<ArrowIcon class={styles.arrow} />}
              style={handleStyle(h().dir)}
              onClick={() => props.onAddFrame(h().dir, h().op)}
            />
          )}
        </For>
      </Show>
      {props.children}
    </div>
  )
}
