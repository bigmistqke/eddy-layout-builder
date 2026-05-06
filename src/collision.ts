export type CollisionKind = "hud" | "handle"

export type Collidable = { el: HTMLElement; kind: CollisionKind }

export type CollisionHit = { el: HTMLElement; kind: CollisionKind; rect: DOMRect }

export function rectsOverlap(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}
