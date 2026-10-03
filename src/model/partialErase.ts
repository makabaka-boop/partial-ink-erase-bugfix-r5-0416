import type { Sample } from "./types";

/** 参数比较精度（线段参数 t 空间）。 */
const T_EPS = 1e-9;

/** 点是否被橡皮圆盘覆盖：严格内部才算擦除，边界上的点保留。 */
function insideDisk(
  px: number,
  py: number,
  cx: number,
  cy: number,
  r: number,
): boolean {
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy < r * r;
}

/**
 * 线段 p→q 与圆边界的交点参数（t ∈ [0,1]，升序）。
 * 圆盘是凸集，一段直线最多两个交点；相切（重根）不切断笔迹，返回空。
 */
function segmentCircleParams(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  r: number,
): number[] {
  const dx = bx - ax;
  const dy = by - ay;
  const a = dx * dx + dy * dy;
  if (a === 0) return []; // 零长线段：无穿越可言
  const fx = ax - cx;
  const fy = ay - cy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return []; // 无交点或相切
  const sq = Math.sqrt(disc);
  const out: number[] = [];
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  if (t1 >= 0 && t1 <= 1) out.push(t1);
  if (t2 >= 0 && t2 <= 1) out.push(t2);
  return out;
}

/** 按参数 t 在线段上插值，压力与时间同步插值。 */
function lerpSample(a: Sample, b: Sample, t: number): Sample {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    pressure: a.pressure + (b.pressure - a.pressure) * t,
    t: a.t + (b.t - a.t) * t,
  };
}

/**
 * 局部擦除的核心：用橡皮圆盘裁剪折线（原始采样中心线），
 * 返回圆盘之外的若干独立片段（按原笔迹先后顺序排列）。
 *
 * - 线段穿过圆盘即被切断，即使两个端点都在圆盘之外；
 *   切口处生成插值边界点（坐标、压力、时间同步插值）。
 * - 圆盘严格内部的点被擦除；恰好落在边界上的点保留，
 *   两端都被擦除时成为单点片段（孤立点）。
 * - 与圆盘相切的线段不被切断。
 * - 未被覆盖的原始点按引用保留（不复制、不改写），
 *   因此调用方可用 === 判断笔迹是否被动过。
 */
export function splitOutsideDisk(
  points: readonly Sample[],
  x: number,
  y: number,
  radius: number,
): Sample[][] {
  // 沿曲线参数顺序收集“保留片”：每个保留的原始点一个单点片，
  // 每段折线按交点切成子段后，圆盘外的子段各一个片。
  const pieces: Sample[][] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!insideDisk(p.x, p.y, x, y, radius)) pieces.push([p]);
    if (i + 1 >= points.length) break;
    const q = points[i + 1];
    // 子段参数序列：0、各交点（去重）、1
    const ts: number[] = [0];
    for (const t of segmentCircleParams(p.x, p.y, q.x, q.y, x, y, radius)) {
      if (t - ts[ts.length - 1] > T_EPS) ts.push(t);
    }
    if (ts[ts.length - 1] < 1 - T_EPS) ts.push(1);
    else ts[ts.length - 1] = 1;
    for (let j = 0; j + 1 < ts.length; j++) {
      const t0 = ts[j];
      const t1 = ts[j + 1];
      // 子段整体在圆盘内/外由中点判定（凸集内一段直线的覆盖区间必连续）
      const tm = (t0 + t1) / 2;
      if (
        insideDisk(
          p.x + (q.x - p.x) * tm,
          p.y + (q.y - p.y) * tm,
          x,
          y,
          radius,
        )
      ) {
        continue;
      }
      // 端点恰好是原始采样时沿用原对象，保证未动过的笔迹引用不变
      const start = t0 === 0 ? p : lerpSample(p, q, t0);
      const end = t1 === 1 ? q : lerpSample(p, q, t1);
      pieces.push([start, end]);
    }
  }
  // 拼接：相邻片共享同一端点对象（原始采样）则属于同一片段，
  // 否则中间隔了被擦除的部分，另起片段 —— 绝不会跨缺口连线。
  const fragments: Sample[][] = [];
  for (const piece of pieces) {
    const last = fragments[fragments.length - 1];
    if (last && last[last.length - 1] === piece[0]) {
      for (let k = 1; k < piece.length; k++) last.push(piece[k]);
    } else {
      fragments.push(piece.slice());
    }
  }
  return fragments;
}
