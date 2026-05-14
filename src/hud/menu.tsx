import { ProjectMenu } from "../components/project-menu"
import { Hud } from "./hud"

/** Top-right HUD with just the hamburger button. Always visible; the
 *  contextual tool-bar (trash / cycle / volume slider) lives in its
 *  own HUD underneath, mounted only in edit mode. */
export function Menu() {
  return (
    <Hud position="top-right" orientation="vertical">
      <ProjectMenu />
    </Hud>
  )
}
