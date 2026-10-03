import type { Sample } from "./types";

/**
 * 局部擦除：沿笔画的**线段**与橡皮圆盘做几何裁剪，返回圆盘外的独立片段。
 *
 * - 判定基于线段而非采样端点：两端都在圆盘外、中部穿过圆盘的线段同样会被切开；
 *   同一条笔画多次穿入/穿出圆盘会产生多个独立片段，不会被连成跨越空白的直线。
 * - 切口处按线段参数插值生成边界采样（坐标、压力、时间都插值），
 *   其余采样原样保留，因此剩余片段的压感与先后顺序仍与原笔迹一一对应。
 * - 与圆盘相切（重根）不产生切口；圆上的点视为圆外、予以保留。
 * - 没有任何部分进入圆盘时，原样返回同一个 points 数组（引用相等），
 *   便于调用方廉价判断“本笔画未受影响”。
 */

const ROOT_EPS = 1e-9;

function interpolate(a: Sample, b: Sample, t: number): Sample {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    pressure: a.pressure + (b.pressure - a.pressure) * t,
    t: a.t + (b.t - a.t) * t,
  };
}

function samePoint(a: Sample, b: Sample): boolean {
  return (
    a === b ||
    (Math.abs(a.x - b.x) <= 1e-9 &&
      Math.abs(a.y - b.y) <= 1e-9 &&
      Math.abs(a.t - b.t) <= 1e-9 &&
      Math.abs(a.pressure - b.pressure) <= 1e-9)
  );
}

interface Interval {
  u: number;
  v: number;
  inside: boolean;
}

/**
 * 线段 a→b 按与圆盘的交点切分为若干参数区间，并标注每段中点在圆内还是圆外。
 * 相切（判别式约为 0）不产生交点，因此相切区间不会被误判为擦除。
 */
function segmentIntervals(
  a: Sample,
  b: Sample,
  cx: number,
  cy: number,
  r: number,
): Interval[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const cuts: number[] = [];
  const A = dx * dx + dy * dy;
  if (A > 0) {
    const fx = a.x - cx;
    const fy = a.y - cy;
    const B = 2 * (fx * dx + fy * dy);
    const C = fx * fx + fy * fy - r * r;
    const disc = B * B - 4 * A * C;
    // 判别式按 4A·r² 归一化后约为 0 即视为相切（重根），不切。
    const tol = 1e-10 * 4 * A * Math.max(r * r, 1e-12);
    if (disc > tol) {
      const s = Math.sqrt(disc);
      for (const t of [(-B - s) / (2 * A), (-B + s) / (2 * A)]) {
        if (t > ROOT_EPS && t < 1 - ROOT_EPS) cuts.push(t);
      }
      cuts.sort((p, q) => p - q);
    }
  }

  const bounds = [0, ...cuts, 1];
  const intervals: Interval[] = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const u = bounds[k];
    const v = bounds[k + 1];
    if (v - u <= ROOT_EPS) continue;
    const m = (u + v) / 2;
    const mx = a.x + dx * m;
    const my = a.y + dy * m;
    // 严格小于：圆上（相切/边界）保留。
    intervals.push({ u, v, inside: Math.hypot(mx - cx, my - cy) < r });
  }
  return intervals;
}

export function splitOutsideDisk(
  points: readonly Sample[],
  x: number,
  y: number,
  radius: number,
): readonly (readonly Sample[])[] {
  if (points.length === 0) return [];
  if (points.length === 1) {
    const p = points[0];
    // 严格小于：圆上的孤立点保留。
    return Math.hypot(p.x - x, p.y - y) < radius ? [] : [points];
  }

  let touched = false;
  const fragments: Sample[][] = [];
  let current: Sample[] = [];
  const pushPoint = (p: Sample): void => {
    const last = current[current.length - 1];
    // 相邻线段共用顶点，避免在接缝处重复同一个点。
    if (!last || !samePoint(last, p)) current.push(p);
  };

  // 先看是否有原始采样严格位于圆盘内部（覆盖零长度退化线段的情形）。
  for (const q of points) {
    if ((q.x - x) ** 2 + (q.y - y) ** 2 < radius * radius) touched = true;
  }

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const intervals = segmentIntervals(a, b, x, y, radius);
    for (const { u, v, inside } of intervals) {
      if (inside) {
        touched = true;
        if (current.length > 0) {
          fragments.push(current);
          current = [];
        }
      } else {
        pushPoint(u === 0 ? a : interpolate(a, b, u));
        pushPoint(v === 1 ? b : interpolate(a, b, v));
      }
    }
  }
  if (current.length > 0) fragments.push(current);

  // 完全未与圆盘相交：原样返回同一份采样（引用相等），调用方可据此跳过本笔画。
  return touched ? fragments : [points];
}
