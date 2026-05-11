import { createEffect, createSignal } from "solid-js"
import { HudButton } from "../components/hud-button"
import { HamburgerIcon } from "../components/icons"
import { logAction } from "../utils"
import styles from "./project-menu.module.css"

export function ProjectMenu() {
  const [open, setOpen] = createSignal(false)
  let dialogRef!: HTMLDialogElement

  createEffect(
    () => open(),
    isOpen => {
      if (isOpen) {
        dialogRef.showModal()
      } else if (dialogRef.open) {
        dialogRef.close()
      }
    },
  )

  function onBackdropClick(event: MouseEvent) {
    // Native <dialog> + showModal renders a backdrop pseudo-element.
    // Clicks on the backdrop bubble to the dialog itself (event.target
    // === dialogRef); clicks on dialog content target the descendant.
    if (event.target === dialogRef) {
      setOpen(false)
    }
  }

  return (
    <>
      <HudButton data-action="open-project-menu" onClick={() => setOpen(true)}>
        <HamburgerIcon />
      </HudButton>
      <dialog
        ref={dialogRef}
        class={styles.dialog}
        onClose={() => setOpen(false)}
        onClick={onBackdropClick}
        data-testid="project-menu"
      >
        <div class={styles.content}>
          <button
            class={styles.option}
            data-action="export"
            onClick={() => {
              logAction("export")
              setOpen(false)
            }}
          >
            Export
          </button>
        </div>
      </dialog>
    </>
  )
}
