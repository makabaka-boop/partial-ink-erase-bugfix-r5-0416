import type { Sample } from "./types";
export function splitOutsideDisk(
  points: readonly Sample[],
  x: number,
  y: number,
  radius: number,
): Sample[][] {
  const remaining = points.filter(
    (p) => Math.hypot(p.x - x, p.y - y) >= radius,
  );
  return remaining.length ? [remaining] : [];
}
