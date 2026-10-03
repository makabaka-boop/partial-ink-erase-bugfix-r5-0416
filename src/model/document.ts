import type { Sample, Stroke, StrokeStyle } from "./types";
import { splitOutsideDisk } from "./partialErase";

/** 单份文档采样点上限。 */
export const MAX_DOCUMENT_POINTS = 20000;

export type EditOp =
  | { type: "add"; strokeId: string }
  | { type: "erase"; before: Stroke[] };

interface ErasePass {
  /** 本次拖动开始前的完整文档快照；一次拖动 = 一个可撤销操作。 */
  snapshot: Stroke[];
  /** 本次拖动实际改动过文档。 */
  changed: boolean;
  /** 本次拖动中局部切割产生的片段 id（结束时统一刷新为新代次）。 */
  createdIds: Set<string>;
  /**
   * 切割新增切口点会使总点数上升；任一圆盘切割后将超过两万点上限时，
   * 该次圆盘整体不生效并置位 overflow——之后的圆盘全部跳过，
   * 抬起时整体回滚到拖动前，绝不留下部分完成的操作。
   */
  overflow: boolean;
}

/**
 * 文档模型：笔画集合 + 撤销栈 + 编辑代次。
 *
 * - editGen 在每次可撤销编辑（提交笔画、结束一次擦除、撤销）时递增；
 *   Worker 平滑结果携带 (strokeId, gen)，仅当 gen 与当前 editGen 一致
 *   且笔画仍存在时才被接受，旧结果无法复活已擦除的笔画或恢复切割前形状。
 * - applySmoothed 不是可撤销编辑，不推进 editGen，也不改动保存的采样。
 */
export class Document {
  private strokes: Stroke[] = [];
  private undoStack: EditOp[] = [];
  private listeners = new Set<() => void>();
  private erasePass: ErasePass | null = null;
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

  private pointCount(list: readonly Stroke[]): number {
    return list.reduce((n, s) => n + s.points.length, 0);
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

  beginErasePass(): void {
    if (this.erasePass) throw new Error("erase pass already open");
    this.erasePass = {
      snapshot: this.strokes.slice(),
      changed: false,
      createdIds: new Set(),
      overflow: false,
    };
  }

  /**
   * 局部橡皮的一个采样圆盘：对全部笔画按线段/圆盘做几何裁剪。
   * 必须处于一次擦除拖动（beginErasePass…endErasePass）之内；
   * 整个拖动只在 endErasePass 时落一个撤销操作。
   * 返回该圆盘是否实际生效（超上限未生效时为 false）。
   */
  partialEraseAt(x: number, y: number, radius: number): boolean {
    const pass = this.erasePass;
    if (!pass) throw new Error("no erase pass");
    if (pass.overflow) return false;

    const produced: Stroke[] = [];
    let changed = false;
    for (const stroke of this.strokes) {
      const pieces = splitOutsideDisk(stroke.points, x, y, radius);
      // splitOutsideDisk 对未相交的笔画原样返回；片段数为 1 且为同一份采样
      // 时说明该笔画未受影响，保留原对象（连同 id/平滑缓存）。
      const untouched =
        pieces.length === 1 && pieces[0] === stroke.points;
      if (untouched) {
        produced.push(stroke);
      } else {
        changed = true;
        for (const points of pieces) {
          if (points.length > 0) {
            // 立即分配唯一 id：在途平滑结果按 id 验收，多个片段不得共用空 id；
            // 代次仍在拖动结束时统一刷新（拖动中 editGen 不变，结果至多写入
            // 会被下一次圆盘重建丢弃的缓存，结束后旧代次结果一律拒收）。
            const id = `stroke-${this.nextId++}`;
            pass.createdIds.add(id);
            produced.push({
              id,
              points: points.slice(),
              smoothed: null,
              gen: this.editGen,
              style: stroke.style,
            });
          }
        }
      }
    }
    if (!changed) return false;

    const newTotal = this.pointCount(produced);
    if (newTotal > MAX_DOCUMENT_POINTS) {
      // 该圆盘整体放弃：画面与文档保持上一个圆盘后的状态，
      // 拖动结束时再整体回滚；不能留下部分切割。
      pass.overflow = true;
      return false;
    }

    this.strokes = produced;
    this.totalPoints = newTotal;
    pass.changed = true;
    this.emit();
    return true;
  }

  /** 擦除过程中命中即整条删除；整次拖动在 endErasePass 合并为一个可撤销操作。 */
  eraseStroke(id: string): boolean {
    const pass = this.erasePass;
    if (!pass) throw new Error("no open erase pass");
    if (pass.overflow) return false;
    const index = this.strokes.findIndex((s) => s.id === id);
    if (index < 0) return false;
    const [stroke] = this.strokes.splice(index, 1);
    this.totalPoints -= stroke.points.length;
    pass.changed = true;
    this.emit();
    return true;
  }

  endErasePass(): void {
    const pass = this.erasePass;
    this.erasePass = null;
    if (!pass) return;

    if (pass.overflow) {
      // 本次拖动中有圆盘因点数上限未能整体生效：回滚到拖动前状态，
      // 不产生撤销记录、不推进代次（平滑结果仍按拖动前代次验收）。
      this.strokes = pass.snapshot;
      this.totalPoints = this.pointCount(this.strokes);
      this.emit();
      return;
    }

    if (!pass.changed) return;

    // 切割产生的片段统一刷成新代次；旧 id 的在途平滑结果（原笔画或拖动中
    // 代次）因代次不符必然被丢弃，不会恢复切割前的旧形状。
    const gen = this.editGen + 1;
    for (const s of this.strokes) {
      if (pass.createdIds.has(s.id)) s.gen = gen;
    }
    this.editGen = gen;
    this.undoStack.push({ type: "erase", before: pass.snapshot });
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
      // 整次擦除拖动（整条删除与局部切割）用拖动前快照一次性恢复，
      // 片段消失、原笔画（含各自 id、顺序与平滑缓存）原样回来。
      this.strokes = op.before;
      this.totalPoints = this.pointCount(this.strokes);
    }
    this.editGen++;
    this.emit();
    return true;
  }

  /**
   * 接收 Worker 平滑结果。代次不符（文档已编辑）或笔画已不存在（已擦除/
   * 已被局部切割替换）时丢弃；只写 smoothed 缓存，绝不触碰保存的采样 points。
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
