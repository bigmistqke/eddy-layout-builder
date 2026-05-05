// Minimum rendered dimensions a frame's UI requires to be usable.
// Derived from the worst-case in-frame UI footprint (handles + edge buttons + interior).
// Tune empirically; the implementation should adjust if the visible UI changes.
export const MIN_NODE_WIDTH = 200
export const MIN_NODE_HEIGHT = 200

// Padding around the selected node when fitting it inside the canvas viewport.
export const VIEWPORT_PADDING = 24
