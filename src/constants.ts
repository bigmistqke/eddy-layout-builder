// Handle dimensions in CSS pixels — mirror notch.module.css geometry
// inside .canvasInner (where --hud-height is 48px and backdrop width is
// 60px). Top/bottom handles are HANDLE_W wide × HANDLE_H tall, centered
// on the frame's top/bottom edge. Left/right handles are 90° rotated,
// so they occupy HANDLE_H × HANDLE_W centered on the frame's left/right
// edge.
export const HANDLE_W = 60
export const HANDLE_H = 48

// Buffer added to handle-fit minimums so frames are slightly bigger than
// the strict minimum — avoids floating-point drift flipping rectsOverlap
// from "touch" (no overlap) to "0.0001px overlap" at the boundary.
export const HANDLE_BUFFER = 20

// Same-axis pair (top vs bottom or left vs right) requires both notches
// HANDLE_H tall to fit non-overlapping along the axis.
export const SAME_AXIS_MIN = 2 * HANDLE_H + HANDLE_BUFFER

// Corner pairs (top vs left, etc.): top handle's horizontal range is
// [c − HANDLE_W/2, c + HANDLE_W/2]; rotated left handle's horizontal
// range is [0, HANDLE_H]. For non-overlap, frame must satisfy
// width ≥ HANDLE_W + 2·HANDLE_H (or the same on height).
export const CROSS_PAIR_MIN = HANDLE_W + 2 * HANDLE_H + HANDLE_BUFFER

// Per-side inset of the "target box" used by viewport zoom-to-fit. The
// selected frame is scaled (aspect-preserved) so it fits inside
// `canvas - 2*FRAME_PADDING` on each axis. Tweakable independently of
// HANDLE_H so the visual breathing room can be tuned without affecting
// handle dimensions.
export const FRAME_PADDING = 2 * HANDLE_H

// Layout — must stay in sync with --padding in index.css and the
// .layoutContainerRoot/.layoutContainer rules in node-component.module.css.
// Root container has padding on all sides plus gap between children.
// Non-root containers have only gap.
export const ROOT_PADDING = 2
export const SIBLING_GAP = 2
