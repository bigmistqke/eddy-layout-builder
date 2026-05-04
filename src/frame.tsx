import { omit } from "@solidjs/signals"
import type { ComponentProps, JSX, ParentProps } from "solid-js"
import { Show } from "solid-js"
import styles from "./app.module.css"

export function Arrow(props: { style: JSX.CSSProperties }) {
  return (
    <svg
      style={props.style}
      class={styles.arrow}
      width="28"
      height="35"
      viewBox="0 0 28 35"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M15.9997 2L15.9997 27.124L24.5759 18.4258C25.3514 17.6395 26.6175 17.6308 27.404 18.4062C28.1904 19.1818 28.199 20.4479 27.4235 21.2344L13.9997 34.8486L0.575858 21.2344C-0.199647 20.4479 -0.191012 19.1818 0.595389 18.4063C1.38183 17.6308 2.64795 17.6395 3.42351 18.4258L11.9997 27.124L11.9997 2C11.9997 0.895431 12.8951 8.82197e-07 13.9997 2.70229e-07C15.1043 1.73665e-07 15.9997 0.895431 15.9997 2Z"
        fill="var(--color)"
      />
    </svg>
  )
}

export function AddHandle(props: {
  type: "right" | "left"
  onClick?: ComponentProps<"div">["onClick"]
}) {
  return (
    <svg
      style={{ transform: props.type === "right" ? "rotateY(180deg)" : undefined }}
      width="55"
      height="55"
      viewBox="0 0 55 55"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        onClick={props.onClick as ComponentProps<"path">["onClick"]}
        d="M2.22097 
        55
        C
        0 
        55
        0
        55
        0 
        55
        H
        0
        C
        11.0329 
        55
        23.6651 
        48.7678 
        26.219 
        28.3394
        C
        28.9081 
        6.82882 
        44.8187 
        0 
        55 
        0
        V
        55
        H
        0
        Z"
        fill="var(--notch-bg)"
      />
    </svg>
  )
}

export function Notch(props: Omit<ComponentProps<"div">, "class"> & { class?: string[] }) {
  const rest = omit(props, "children", "class", "onClick")
  return (
    <div class={[styles.notch, ...(props.class ?? [])]} {...rest}>
      <AddHandle type="left" onClick={props.onClick} />
      <div onClick={props.onClick}>{props.children}</div>
      <AddHandle type="right" onClick={props.onClick} />
    </div>
  )
}

export function ArrowNotch(
  props: Omit<ComponentProps<"div">, "children" | "class"> & { class?: string[] },
) {
  const rest = omit(props, "class")
  return (
    <Notch class={[styles["arrow-notch"], ...(props.class ?? [])]} {...rest}>
      <Arrow
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
          "z-index": 1,
        }}
      />
    </Notch>
  )
}

export function Frame(
  props: ParentProps<{
    onClick?: JSX.EventHandlersElement<HTMLDivElement>["onClick"]
    active?: boolean
    style?: JSX.CSSProperties
    class?: string
    onAddFrame(direction: "top" | "bottom" | "left" | "right"): void
  }>,
) {
  return (
    <div onClick={props.onClick} style={props.style} class={[props.class, styles.frame]}>
      <Show when={props.active}>
        <ArrowNotch
          onClick={event => {
            event.stopPropagation()
            props.onAddFrame("top")
          }}
          class={[styles.top]}
        />
        <ArrowNotch
          onClick={event => {
            event.stopPropagation()
            props.onAddFrame("bottom")
          }}
          class={[styles.bottom]}
        />
        <ArrowNotch
          onClick={event => {
            event.stopPropagation()
            props.onAddFrame("left")
          }}
          class={[styles.left]}
        />
        <ArrowNotch
          onClick={event => {
            event.stopPropagation()
            props.onAddFrame("right")
          }}
          class={[styles.right]}
        />
      </Show>
      {props.children}
    </div>
  )
}
