import { createEffect, createMemo, createSignal, For, Show, untrack, useContext } from "solid-js"
import { Context } from "../context"
import { Hud } from "../hud/hud"
import { exportSong } from "../media/export"
import { formatTimeAgo, logAction } from "../utils"
import { HamburgerIcon, TrashIcon } from "./icons"
import styles from "./project-menu.module.css"

export function ProjectMenu() {
  const context = useContext(Context)!
  const [open, setOpen] = createSignal(false)
  /** null = not exporting; 0..1 = export progress. One signal stands
   *  in for both pending state and percentage. */
  const [progress, setProgress] = createSignal<number | null>(null)
  const exporting = () => progress() !== null
  /** Two-step confirm for the active project. Resets on dialog open. */
  const [confirmingDelete, setConfirmingDelete] = createSignal(false)
  /** Id of the project queued for deletion via the row trash, or null
   *  if the confirm dialog is closed. Distinct from the active-project
   *  inline two-step above. */
  const [deleteCandidateId, setDeleteCandidateId] = createSignal<string | null>(null)
  const deleteCandidate = createMemo(() => {
    const id = deleteCandidateId()
    if (id === null) {
      return null
    }
    return context.projects.list().find(p => p.id === id) ?? null
  })
  /** Title sits as a static h2 by default and only swaps to an input
   *  when the user taps EDIT. Avoids auto-focusing on dialog open,
   *  which would summon the on-screen keyboard on mobile. */
  const [editingTitle, setEditingTitle] = createSignal(false)
  /** Sub-screen routing. The main view is the default; switching to
   *  "open-project" reveals the saved-projects list. */
  const [screen, setScreen] = createSignal<"main" | "open-project">("main")
  const otherProjects = createMemo(() =>
    context.projects.list().filter(p => p.id !== context.projects.activeId()),
  )
  let dialogRef!: HTMLDialogElement
  let confirmDeleteRef!: HTMLDialogElement
  let titleInputRef: HTMLInputElement | undefined

  createEffect(
    () => open(),
    isOpen => {
      if (isOpen) {
        dialogRef.showModal()
        setConfirmingDelete(false)
        setEditingTitle(false)
        setScreen("main")
      } else if (dialogRef.open) {
        dialogRef.close()
        // Close any nested confirm too — it'd otherwise stick around in
        // the top layer with no parent dialog behind it.
        setDeleteCandidateId(null)
      }
    },
  )

  createEffect(
    () => deleteCandidateId() !== null,
    isOpen => {
      if (isOpen) {
        confirmDeleteRef.showModal()
      } else if (confirmDeleteRef.open) {
        confirmDeleteRef.close()
      }
    },
  )

  // Bail out of the OPEN PROJECT sub-screen when the last other-project
  // is gone — the empty list would otherwise leave the user stranded.
  createEffect(
    () => otherProjects().length,
    count => {
      if (count === 0 && untrack(screen) === "open-project") {
        setScreen("main")
      }
    },
  )

  function onStartEditTitle() {
    setEditingTitle(true)
    // Defer focus until the input is mounted by Solid's reconciler.
    // Pre-select so typing replaces the placeholder name instead of
    // appending — primarily for the just-created "Untitled N" case.
    queueMicrotask(() => {
      titleInputRef?.focus()
      titleInputRef?.select()
    })
  }

  function onTitleKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter" || event.key === "Escape") {
      setEditingTitle(false)
      ;(event.currentTarget as HTMLInputElement).blur()
    }
  }

  function onRenameInput(event: InputEvent & { currentTarget: HTMLInputElement }) {
    const id = context.projects.activeId()
    if (id === null) {
      return
    }
    void context.projects.renameProject(id, event.currentTarget.value)
  }

  async function onNewProject() {
    logAction("new-project")
    await context.projects.createProject()
    // Stay in the menu and drop the user straight into renaming the
    // freshly-created project. The "Untitled N" placeholder is
    // pre-selected so typing overwrites it.
    onStartEditTitle()
  }

  async function onOpenProject(id: string) {
    logAction("open-project", { id })
    // Close first so the dialog doesn't sit blocking the canvas while
    // OPFS reads + clip decodes run; the new project's layout fades in
    // afterwards.
    setOpen(false)
    await context.projects.openProject(id)
  }

  function onDeleteRow(event: MouseEvent, id: string) {
    // Don't let the trash click bubble to the row's onOpenProject.
    event.stopPropagation()
    setDeleteCandidateId(id)
  }

  async function onConfirmDelete() {
    const id = deleteCandidateId()
    if (id === null) {
      return
    }
    logAction("delete-project", { id })
    setDeleteCandidateId(null)
    await context.projects.deleteProject(id)
  }

  function onConfirmBackdropClick(event: MouseEvent) {
    if (event.target === confirmDeleteRef) {
      setDeleteCandidateId(null)
    }
  }

  async function onDeleteProject() {
    if (!confirmingDelete()) {
      setConfirmingDelete(true)
      return
    }
    const id = context.projects.activeId()
    if (id === null) {
      return
    }
    logAction("delete-project", { id })
    await context.projects.deleteProject(id)
    setConfirmingDelete(false)
    setOpen(false)
  }

  function onBackdropClick(event: MouseEvent) {
    if (exporting()) {
      return
    }
    if (event.target === dialogRef) {
      setOpen(false)
    }
  }

  async function onExport() {
    const allClips = Object.values(context.clips.clips)
    if (allClips.length === 0) {
      return
    }
    const wrapper = document.querySelector<HTMLElement>("[data-canvas-inner]")
    if (wrapper === null) {
      throw new Error("ProjectMenu: canvas wrapper not mounted")
    }
    const rect = wrapper.getBoundingClientRect()
    logAction("export", { width: rect.width, height: rect.height })
    setProgress(0)
    try {
      const blob = await exportSong(allClips, context.app.layout, {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        onProgress: setProgress,
      })
      triggerDownload(blob)
    } finally {
      setProgress(null)
      setOpen(false)
    }
  }

  return (
    <>
      <Hud.Button
        data-action="open-project-menu"
        onClick={() => {
          if (context.transport.state() === "playing") {
            context.transport.stop()
          }
          setOpen(true)
        }}
      >
        <HamburgerIcon />
      </Hud.Button>
      <dialog
        ref={dialogRef}
        class={styles.dialog}
        onClose={() => setOpen(false)}
        onClick={onBackdropClick}
        data-testid="project-menu"
      >
        <Show
          when={screen() === "open-project"}
          fallback={
            <div class={styles.content}>
              <div class={styles.titleRow}>
                <Show
                  when={editingTitle()}
                  fallback={
                    <>
                      <h2 class={styles.title}>{context.projects.active()?.name ?? ""}</h2>
                      <button
                        class={styles.editButton}
                        data-action="edit-project-name"
                        onClick={onStartEditTitle}
                      >
                        EDIT
                      </button>
                    </>
                  }
                >
                  <input
                    ref={titleInputRef}
                    class={styles.titleInput}
                    data-action="rename-project"
                    value={context.projects.active()?.name ?? ""}
                    onInput={onRenameInput}
                    onBlur={() => setEditingTitle(false)}
                    onKeyDown={onTitleKeyDown}
                    spellcheck={false}
                  />
                </Show>
              </div>
              <div class={styles.divider} />

              <button class={styles.option} data-action="new-project" onClick={onNewProject}>
                NEW PROJECT
              </button>
              <button
                class={styles.option}
                data-action="show-open-project"
                disabled={otherProjects().length === 0}
                onClick={() => setScreen("open-project")}
              >
                OPEN PROJECT
              </button>
              <button
                class={styles.option}
                data-action="export"
                disabled={exporting() || context.clips.cellIds().length === 0}
                onClick={onExport}
              >
                <Show when={progress()} fallback="EXPORT MOVIE">
                  {pct => `Exporting… ${Math.round(pct() * 100)}%`}
                </Show>
              </button>
              <div class={styles.divider} />
              <button
                class={styles.optionDestructive}
                data-action="delete-project"
                onClick={onDeleteProject}
              >
                <Show when={confirmingDelete()} fallback="DELETE PROJECT">
                  CONFIRM DELETE?
                </Show>
              </button>
            </div>
          }
        >
          <div class={styles.content}>
            <div class={styles.titleRow}>
              <h2 class={styles.title}>OPEN PROJECT</h2>
            </div>
            <div class={styles.divider} />
            <div class={styles.projectList}>
              <For each={otherProjects()}>
                {project => (
                  <div class={styles.projectRow}>
                    <button
                      class={styles.projectOpen}
                      data-action="open-project"
                      data-project-id={project().id}
                      onClick={() => onOpenProject(project().id)}
                    >
                      <span class={styles.projectName}>{project().name}</span>
                      <span class={styles.projectAge}>{formatTimeAgo(project().updatedAt)}</span>
                    </button>
                    <button
                      class={styles.projectDelete}
                      data-action="delete-project-row"
                      data-project-id={project().id}
                      onClick={event => onDeleteRow(event, project().id)}
                      aria-label="Delete project"
                    >
                      <TrashIcon />
                    </button>
                  </div>
                )}
              </For>
            </div>
            <div class={styles.divider} />
            <button
              class={styles.option}
              data-action="back-to-main"
              onClick={() => setScreen("main")}
            >
              ← BACK
            </button>
          </div>
        </Show>
      </dialog>
      <dialog
        ref={confirmDeleteRef}
        class={styles.dialog}
        onClose={() => setDeleteCandidateId(null)}
        onClick={onConfirmBackdropClick}
        data-testid="confirm-delete-project"
      >
        <div class={styles.content}>
          <div class={styles.titleRow}>
            <h2 class={styles.title}>{`Delete “${deleteCandidate()?.name ?? ""}”?`}</h2>
          </div>
          <div class={styles.divider} />
          <button
            class={styles.option}
            data-action="cancel-delete-project"
            onClick={() => setDeleteCandidateId(null)}
          >
            CANCEL
          </button>
          <button
            class={styles.optionDestructive}
            data-action="confirm-delete-project"
            onClick={onConfirmDelete}
          >
            DELETE
          </button>
        </div>
      </dialog>
    </>
  )
}

function triggerDownload(blob: Blob) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = `eddy-${Date.now()}.mp4`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
