import type { Sample, Stroke, StrokeStyle } from "./types";
import { splitOutsideDisk } from "./partialErase";

/** 单份文档采样点上限。 */
export const MAX_DOCUMENT_POINTS = 20000;

export type EditOp =
  | { type: "add"; strokeId: string }
  | { type: "erase"; before: Stroke[] };

/**
 * 文档模型：笔画集合 + 撤销栈 + 编辑代次。
 *
 * - editGen 在每次可撤销编辑（提交笔画、结束一次擦除、撤销）时递增；
 *   Worker 平滑结果携带 (strokeId, gen)，仅当 gen 与当前 editGen 一致
 *   且笔画仍存在时才被接受，旧结果无法复活已擦除的笔画。
 * - applySmoothed 不是可撤销编辑，不推进 editGen，也不改动保存的采样。
 * - 一次擦除（按下到抬起）内的整条删除与局部切割合并为一个可撤销操作：
 *   趟开始时快照笔画数组，趟内任何改动都只累积，endErasePass 才入栈。
 */
export class Document {
  private strokes: Stroke[] = [];
  private undoStack: EditOp[] = [];
  private listeners = new Set<() => void>();
  private erasePass: { before: Stroke[]; changed: boolean } | null = null;
  private nextId = 1;

  editGen = 0;
  totalPoints = 0;

  getStrokes(): readonly Stroke[] {
    return this.strokes.slice();
  }

  getStroke(id: string): Stroke | undefined {
    return this.strokes.find((s) => s.id === id);
  }

  hasStroke(id: string): boolean {
    return this.strokes.some((s) => s.id === id);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  remainingPointBudget(): number {
    return MAX_DOCUMENT_POINTS - this.totalPoints;
  }

  onEdit(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }

  /** 抬笔后提交完整笔画。超出两万点上限的部分被截断；预算耗尽返回 null。 */
  commitStroke(points: Sample[], style: StrokeStyle): Stroke | null {
    const budget = this.remainingPointBudget();
    if (budget <= 0 || points.length === 0) return null;
    const pts =
      points.length > budget ? points.slice(0, budget) : points.slice();
    this.editGen++;
    const stroke: Stroke = {
      id: `stroke-${this.nextId++}`,
      points: pts,
      smoothed: null,
      gen: this.editGen,
      style: { ...style },
    };
    this.strokes.push(stroke);
    this.totalPoints += pts.length;
    this.undoStack.push({ type: "add", strokeId: stroke.id });
    this.emit();
    return stroke;
  }

  /**
   * 局部擦除：用橡皮圆盘裁剪每条笔迹，圆盘外的部分成为独立片段。
   *
   * - 片段是新笔画（新 id、smoothed 清空），旧笔迹的平滑缓存与途中的
   *   平滑结果都不会把切割前的形状带回来；
   * - 未被动过的笔画保留原对象（id、平滑缓存、撤销引用都不变）；
   * - 切割是原子的：先算完整结果，会使文档超过两万点上限时整体放弃，
   *   保持本次切割前状态，不留部分完成的操作；
   * - 一趟擦除（beginErasePass..endErasePass）内的所有切割与删除
   *   合并为一个可撤销操作。
   *
   * 返回本次是否真的切掉了什么。
   */
  partialEraseAt(x: number, y: number, radius: number): boolean {
    const pass = this.erasePass;
    if (!pass) throw new Error("no erase pass");
    // 先完整计算，不改动文档
    const plan = this.strokes.map((stroke) => {
      const fragments = splitOutsideDisk(stroke.points, x, y, radius);
      const unchanged =
        fragments.length === 1 &&
        fragments[0].length === stroke.points.length &&
        fragments[0].every((p, i) => p === stroke.points[i]);
      return { stroke, fragments, unchanged };
    });
    if (plan.every((p) => p.unchanged)) return false;
    let total = 0;
    for (const p of plan)
      for (const f of p.fragments) total += f.length;
    if (total > MAX_DOCUMENT_POINTS) return false; // 超上限：保持切割前状态
    const next: Stroke[] = [];
    for (const { stroke, fragments, unchanged } of plan) {
      if (unchanged) {
        next.push(stroke);
        continue;
      }
      for (const points of fragments) {
        next.push({
          ...stroke,
          id: `stroke-${this.nextId++}`,
          points,
          smoothed: null, // 旧平滑缓存属于切割前形状，不得带入片段
          gen: this.editGen,
        });
      }
    }
    this.strokes = next;
    this.totalPoints = total;
    pass.changed = true;
    this.emit();
    return true;
  }

  beginErasePass(): void {
    if (this.erasePass) throw new Error("erase pass already open");
    this.erasePass = { before: this.strokes.slice(), changed: false };
  }

  /** 擦除过程中命中即整条删除；与局部切割一起累积，endErasePass 合并为一个可撤销操作。 */
  eraseStroke(id: string): boolean {
    const pass = this.erasePass;
    if (!pass) throw new Error("no open erase pass");
    const index = this.strokes.findIndex((s) => s.id === id);
    if (index < 0) return false;
    const [stroke] = this.strokes.splice(index, 1);
    this.totalPoints -= stroke.points.length;
    pass.changed = true;
    this.emit();
    return true;
  }

  /** 结束一趟擦除：趟内有任何删除/切割才合并入栈为一个可撤销操作。 */
  endErasePass(): void {
    const pass = this.erasePass;
    this.erasePass = null;
    if (!pass || !pass.changed) return;
    this.editGen++;
    this.undoStack.push({ type: "erase", before: pass.before });
    this.emit();
  }

  /** 便捷方法：一次擦除若干笔画，合并为一个可撤销操作。 */
  eraseStrokes(ids: string[]): void {
    this.beginErasePass();
    try {
      for (const id of ids) this.eraseStroke(id);
    } finally {
      this.endErasePass();
    }
  }

  undo(): boolean {
    const op = this.undoStack.pop();
    if (!op) return false;
    if (op.type === "add") {
      const index = this.strokes.findIndex((s) => s.id === op.strokeId);
      if (index >= 0) {
        const [stroke] = this.strokes.splice(index, 1);
        this.totalPoints -= stroke.points.length;
      }
    } else {
      // 一次擦除（整条删除与局部切割的合并）整体回滚到趟前快照，
      // 笔画的相对顺序、采样与点数随之完整恢复。
      this.strokes = op.before.slice();
      this.totalPoints = this.strokes.reduce((n, s) => n + s.points.length, 0);
    }
    this.editGen++;
    this.emit();
    return true;
  }

  /**
   * 接收 Worker 平滑结果。代次不符（文档已编辑）或笔画已不存在（已擦除/
   * 已被切割替换）时丢弃；只写 smoothed 缓存，绝不触碰保存的采样 points。
   */
  applySmoothed(strokeId: string, gen: number, points: Sample[]): boolean {
    if (gen !== this.editGen) return false;
    const stroke = this.getStroke(strokeId);
    if (!stroke) return false;
    stroke.smoothed = points;
    this.emit();
    return true;
  }
}
