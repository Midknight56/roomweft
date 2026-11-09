export interface Point2D {
  x: number;
  y: number;
}

export interface RectLike {
  left: number;
  top: number;
  right?: number;
  bottom?: number;
  width?: number;
  height?: number;
}

export interface ViewportLike {
  width: number;
  height: number;
}

export function threadVisible(
  endpoint: Point2D | null | undefined,
  hostRect: RectLike | null | undefined,
  start: Point2D | null | undefined,
  viewport: ViewportLike,
): boolean {
  if (!endpoint || !hostRect || !start) {
    return false;
  }
  const hostRight = hostRect.right ?? (hostRect.left + (hostRect.width ?? 0));
  const hostBottom = hostRect.bottom ?? (hostRect.top + (hostRect.height ?? 0));
  if (endpoint.x < hostRect.left || endpoint.x > hostRight || endpoint.y < hostRect.top || endpoint.y > hostBottom) {
    return false;
  }
  if (endpoint.x < 0 || endpoint.x > viewport.width || endpoint.y < 0 || endpoint.y > viewport.height) {
    return false;
  }
  if (start.x < 0 || start.x > viewport.width || start.y < 0 || start.y > viewport.height) {
    return false;
  }
  return true;
}
