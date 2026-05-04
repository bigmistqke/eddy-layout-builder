import { Show, type JSX, type ParentProps } from "solid-js"
import styles from "./frame.module.css"

export function Arrow(props: { style: JSX.CSSProperties }) {
  return (
    <svg
      style={props.style}
      width="28"
      height="35"
      viewBox="0 0 28 35"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M11.9998 32.8486L11.9998 7.72461L3.42365 16.4229C2.64809 17.2091 1.38197 17.2178 0.595527 16.4424C-0.190875 15.6668 -0.199508 14.4007 0.575996 13.6143L13.9998 7.72388e-07L27.4237 13.6143C28.1992 14.4007 28.1905 15.6668 27.4041 16.4424C26.6177 17.2179 25.3516 17.2091 24.576 16.4229L15.9998 7.72461L15.9998 32.8486C15.9998 33.9532 15.1044 34.8486 13.9998 34.8486C12.8953 34.8486 11.9998 33.9532 11.9998 32.8486Z"
        fill="var(--color)"
      />
    </svg>
  )
}

function Notch(props: {
  style?: JSX.CSSProperties
  children: JSX.Element
  class: string
  onClick?(): void
}) {
  return (
    <div class={[styles.notch, props.class]} style={props.style}>
      {props.children}
      <div class={styles["notch-backdrop"]}>
        <div class={styles.root} onClick={props.onClick} />
        <div class={styles.center} onClick={props.onClick} />
        <div class={styles.edge} onClick={props.onClick} />
      </div>
    </div>
  )
}

function ArrowNotch(props: { style?: JSX.CSSProperties; class: string; onClick?(): void }) {
  return (
    <Notch style={props.style} class={props.class} onClick={props.onClick}>
      <Arrow
        style={{
          "--color": "white",
          position: "absolute",
          translate: "-50% 0",
          bottom: "calc(var(--radius) / 2)",
          "transform-origin": "center bottom",
          "z-index": 2,
        }}
      />
    </Notch>
  )
}

export function Frame(
  props: ParentProps<{
    onClick?: JSX.EventHandlersElement<HTMLDivElement>["onClick"]
    handleDirections?: ("top" | "bottom" | "left" | "right")[]
    style?: JSX.CSSProperties
    class?: string
    onAddFrame(direction: "top" | "bottom" | "left" | "right"): void
  }>,
) {
  const dirs = () => props.handleDirections ?? []
  return (
    <div onClick={props.onClick} style={props.style} class={[props.class, styles.frame]}>
      <Show when={dirs().includes("top")}>
        <ArrowNotch
          class={styles.top}
          onClick={() => {
            console.log("click top frame")
            props.onAddFrame("top")
          }}
        />
      </Show>
      <Show when={dirs().includes("bottom")}>
        <ArrowNotch class={styles.bottom} onClick={() => props.onAddFrame("bottom")} />
      </Show>
      <Show when={dirs().includes("left")}>
        <ArrowNotch class={styles.left} onClick={() => props.onAddFrame("left")} />
      </Show>
      <Show when={dirs().includes("right")}>
        <ArrowNotch class={styles.right} onClick={() => props.onAddFrame("right")} />
      </Show>
      {props.children}
    </div>
  )
}
