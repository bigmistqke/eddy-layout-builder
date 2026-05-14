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

