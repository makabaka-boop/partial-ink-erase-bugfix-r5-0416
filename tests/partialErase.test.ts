import { describe, expect, it } from "vitest";
import { Document, MAX_DOCUMENT_POINTS } from "../src/model/document";
import { identityView } from "../src/model/geometry";
import { splitOutsideDisk } from "../src/model/partialErase";
import { renderScene, type CtxLike } from "../src/render/renderer";
import { SmoothingManager, type WorkerLike } from "../src/smoothing/manager";
import type { SmoothRequest, SmoothResponse } from "../src/smoothing/messages";
import { smoothPoints } from "../src/smoothing/smooth";
import type { Sample, StrokeStyle } from "../src/model/types";
import { down, makeController, move, sample, up } from "./helpers";

const STYLE: StrokeStyle = { color: "#000", baseWidth: 4 };

/** 水平线采样：x 从 x0 到 x1 步进 step，y 固定，t = x。 */
function linePoints(
  x0: number,
  x1: number,
  step: number,
  y = 0,
  pressure: (x: number) => number = () => 0.5,
): Sample[] {
  const out: Sample[] = [];
  for (let x = x0; x <= x1; x += step)
    out.push({ x, y, pressure: pressure(x), t: x });
  return out;
}

/** 同步可控的假 Worker（与 smoothing.test.ts 同款）。 */
class FakeWorker implements WorkerLike {
  onmessage: ((ev: { data: SmoothResponse }) => void) | null = null;
  inbox: SmoothRequest[] = [];
  postMessage(msg: SmoothRequest): void {
    this.inbox.push(msg);
  }
  flush(): void {
    const msgs = this.inbox.splice(0);
    for (const m of msgs) {
      this.onmessage?.({
        data: {
          type: "smoothed",
          strokeId: m.strokeId,
          gen: m.gen,
          points: smoothPoints(m.points),
        },
      });
    }
  }
}

/** 记录实际画出的线段（moveTo→lineTo 对）。 */
function mockCtx() {
  const segments: [number, number, number, number][] = [];
  let cur: [number, number] | null = null;
  const ctx: CtxLike = {
    setTransform: () => {},
    clearRect: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    scale: () => {},
    beginPath: () => {
      cur = null;
    },
    moveTo: (x, y) => {
      cur = [x, y];
    },
    lineTo: (x, y) => {
      if (cur) segments.push([cur[0], cur[1], x, y]);
      cur = [x, y];
    },
    stroke: () => {},
    lineCap: "",
    lineJoin: "",
    strokeStyle: "",
    lineWidth: 0,
    globalAlpha: 1,
  };
  return { ctx, segments };
}

describe("局部擦除：切割几何", () => {
  it("两端都在圆盘外的线段也会被切断，切口压力/时间同步插值", () => {
    // 线段 (40,0)→(60,0)，圆盘 (50,0) r=5：两个端点都在盘外
    const frags = splitOutsideDisk(
      [
        { x: 40, y: 0, pressure: 0.4, t: 40 },
        { x: 60, y: 0, pressure: 0.6, t: 60 },
      ],
      50,
      0,
      5,
    );
    expect(frags).toHaveLength(2);
    expect(frags[0].map((p) => p.x)).toEqual([40, 45]);
    expect(frags[1].map((p) => p.x)).toEqual([55, 60]);
    // 切口是插值点：压力与时间按线段参数同步插值
    expect(frags[0][1].pressure).toBeCloseTo(0.45, 10);
    expect(frags[0][1].t).toBeCloseTo(45, 10);
    expect(frags[1][0].pressure).toBeCloseTo(0.55, 10);
    expect(frags[1][0].t).toBeCloseTo(55, 10);
  });

  it("擦开的笔迹成为独立片段，渲染不跨缺口连线", () => {
    const doc = new Document();
    const stroke = doc.commitStroke(linePoints(0, 100, 10), STYLE)!;
    doc.beginErasePass();
    doc.partialEraseAt(50, 0, 5); // 擦掉点 (50,0)，切断相邻两段
    doc.endErasePass();

    const frags = doc.getStrokes();
    expect(frags).toHaveLength(2);
    expect(frags[0].id).not.toBe(stroke.id); // 片段是新笔画
    expect(frags[0].points.map((p) => p.x)).toEqual([0, 10, 20, 30, 40, 45]);
    expect(frags[1].points.map((p) => p.x)).toEqual([55, 60, 70, 80, 90, 100]);
    expect(doc.totalPoints).toBe(12);

    // 渲染出的所有线段，中点都不落在被擦除的圆盘内 —— 没有跨缺口连线
    const { ctx, segments } = mockCtx();
    renderScene(ctx, {
      width: 800,
      height: 600,
      dpr: 1,
      view: identityView(),
      strokes: doc.getStrokes(),
      active: null,
      preview: null,
      activeStyle: STYLE,
    });
    expect(segments.length).toBeGreaterThan(0);
    for (const [ax, ay, bx, by] of segments) {
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      expect(Math.hypot(mx - 50, my)).toBeGreaterThanOrEqual(5);
    }
  });

  it("与圆盘相切的笔迹不被切断，也不产生撤销操作", () => {
    const doc = new Document();
    // y=10 的直线与圆盘 (50,0) r=10 恰好相切于 (50,10)
    doc.commitStroke(linePoints(0, 100, 10, 10), STYLE);
    doc.beginErasePass();
    const changed = doc.partialEraseAt(50, 0, 10);
    doc.endErasePass();

    expect(changed).toBe(false);
    expect(doc.getStrokes()).toHaveLength(1);
    expect(doc.getStrokes()[0].points).toHaveLength(11);
    expect(doc.totalPoints).toBe(11);
    expect(doc.undoDepth).toBe(1); // 只有提交，没有擦除操作
  });

  it("边界上的点保留为孤立点（单点片段），撤销后完整恢复", () => {
    const doc = new Document();
    const stroke = doc.commitStroke(
      [
        { x: 4, y: 0, pressure: 0.5, t: 0 }, // 盘内
        { x: 5, y: 2, pressure: 0.8, t: 1 }, // 恰在边界上
        { x: 6, y: 0, pressure: 0.5, t: 2 }, // 盘内
      ],
      STYLE,
    )!;
    doc.beginErasePass();
    doc.partialEraseAt(5, 0, 2);
    doc.endErasePass();

    const frags = doc.getStrokes();
    expect(frags).toHaveLength(1);
    expect(frags[0].points).toHaveLength(1);
    expect(frags[0].points[0]).toBe(stroke.points[1]); // 原采样按引用保留
    expect(frags[0].points[0].pressure).toBe(0.8);
    expect(doc.totalPoints).toBe(1);

    expect(doc.undo()).toBe(true);
    expect(doc.getStrokes()[0].points).toHaveLength(3);
    expect(doc.totalPoints).toBe(3);
  });

  it("单点笔画：盘外保留、盘内删除", () => {
    const doc = new Document();
    const keep = doc.commitStroke([{ x: 0, y: 0, pressure: 0.5, t: 0 }], STYLE)!;
    const drop = doc.commitStroke(
      [{ x: 100, y: 0, pressure: 0.5, t: 1 }],
      STYLE,
    )!;
    doc.beginErasePass();
    doc.partialEraseAt(100, 0, 5);
    doc.endErasePass();

    expect(doc.getStrokes().map((s) => s.id)).toEqual([keep.id]);
    expect(doc.getStrokes()[0]).toBe(keep); // 未被动过，原对象
    expect(doc.totalPoints).toBe(1);

    doc.undo();
    expect(doc.getStrokes().map((s) => s.id)).toEqual([keep.id, drop.id]);
  });

  it("多次穿越圆盘的折线被切成多个有序片段", () => {
    const pts: Sample[] = [
      { x: 0, y: 0, pressure: 0.1, t: 0 }, // 盘外
      { x: 45, y: 0, pressure: 0.2, t: 1 }, // 盘内
      { x: 50, y: 20, pressure: 0.3, t: 2 }, // 盘外
      { x: 55, y: 0, pressure: 0.4, t: 3 }, // 盘内
      { x: 100, y: 0, pressure: 0.5, t: 4 }, // 盘外
    ];
    const doc = new Document();
    doc.commitStroke(pts, STYLE);
    doc.beginErasePass();
    doc.partialEraseAt(50, 0, 10);
    doc.endErasePass();

    const frags = doc.getStrokes();
    expect(frags).toHaveLength(3);
    expect(frags[0].points[0]).toBe(pts[0]);
    expect(frags[1].points[1]).toBe(pts[2]); // 中间片段保留原有点
    expect(frags[2].points[frags[2].points.length - 1]).toBe(pts[4]);
    // 先后顺序与原笔迹对应：片段沿笔迹方向依次排列
    const lastX = (f: { points: Sample[] }) => f.points[f.points.length - 1].x;
    expect(lastX(frags[0])).toBeLessThan(frags[1].points[0].x);
    expect(lastX(frags[1])).toBeLessThan(frags[2].points[0].x);
    // 所有片段点都在圆盘之外（含边界）
    for (const f of frags)
      for (const p of f.points)
        expect(Math.hypot(p.x - 50, p.y)).toBeGreaterThanOrEqual(10 - 1e-9);
  });
});

describe("局部擦除：撤销与一致性", () => {
  it("一次拖动的多次切割合并为一个可撤销操作，撤销完整恢复", () => {
    const doc = new Document();
    const pts = linePoints(0, 100, 5); // 21 点
    const stroke = doc.commitStroke(pts, STYLE)!;
    const eraser = makeController(doc, { tool: "partial", eraserRadiusPx: 2 });

    // 一次按下→拖动→抬起，途中切 4 刀（x=20/40/60/80）
    eraser.onPointerDown(down(2, sample(20, 0)));
    eraser.onPointerMove(move(2, [sample(40, 0), sample(60, 0)]));
    eraser.onPointerUp(up(2, sample(80, 0)));

    expect(doc.getStrokes()).toHaveLength(5); // 4 刀 → 5 个片段
    expect(doc.totalPoints).toBe(21 - 4 + 8); // 擦 4 点 + 8 个切口插值点
    expect(doc.undoDepth).toBe(2); // 提交 + 本次擦除（合并为一个）

    expect(doc.undo()).toBe(true); // 一次撤销完整恢复本次拖动
    expect(doc.getStrokes()).toHaveLength(1);
    expect(doc.getStrokes()[0].id).toBe(stroke.id);
    expect(doc.getStrokes()[0].points).toHaveLength(21);
    expect(doc.getStrokes()[0].points.map((p) => p.x)).toEqual(
      pts.map((p) => p.x),
    );
    expect(doc.getStrokes()[0].points.map((p) => p.pressure)).toEqual(
      pts.map((p) => p.pressure),
    );
    expect(doc.totalPoints).toBe(21);
  });

  it("局部擦除未命中不产生撤销操作", () => {
    const doc = new Document();
    doc.commitStroke(linePoints(0, 100, 10), STYLE);
    const eraser = makeController(doc, { tool: "partial" });
    eraser.onPointerDown(down(2, sample(0, 500)));
    eraser.onPointerMove(move(2, [sample(50, 500)]));
    eraser.onPointerUp(up(2, sample(100, 500)));
    expect(doc.getStrokes()).toHaveLength(1);
    expect(doc.getStrokes()[0].points).toHaveLength(11);
    expect(doc.undoDepth).toBe(1); // 只有提交
  });

  it("同一趟内的整条删除与局部切割合并为一个撤销操作", () => {
    const doc = new Document();
    const a = doc.commitStroke(linePoints(0, 100, 10, 0), STYLE)!;
    const b = doc.commitStroke(linePoints(0, 100, 10, 100), STYLE)!;
    doc.beginErasePass();
    doc.eraseStroke(a.id); // 整条删除
    doc.partialEraseAt(50, 100, 5); // 局部切割
    doc.endErasePass();

    expect(doc.getStrokes()).toHaveLength(2); // b 被切成两段
    expect(doc.undoDepth).toBe(3); // 2 次提交 + 1 次合并擦除
    expect(doc.undo()).toBe(true);
    expect(doc.getStrokes().map((s) => s.id)).toEqual([a.id, b.id]);
    expect(doc.getStrokes()[1].points).toHaveLength(11);
    expect(doc.totalPoints).toBe(22);
  });

  it("未被动过的笔画保持原对象，片段在原位置按顺序展开", () => {
    const doc = new Document();
    const s1 = doc.commitStroke(linePoints(0, 100, 10, -100), STYLE)!;
    const s2 = doc.commitStroke(linePoints(0, 100, 10, 0), STYLE)!;
    const s3 = doc.commitStroke(linePoints(0, 100, 10, 100), STYLE)!;
    doc.beginErasePass();
    doc.partialEraseAt(50, 0, 5); // 只切中间的 s2
    doc.endErasePass();

    const strokes = doc.getStrokes();
    expect(strokes).toHaveLength(4);
    expect(strokes[0]).toBe(s1); // 原对象：id、采样、平滑缓存都不变
    expect(strokes[3]).toBe(s3);
    expect(strokes[1].id).not.toBe(s2.id);
    expect(strokes[1].points[strokes[1].points.length - 1].x).toBe(45);
    expect(strokes[2].points[0].x).toBe(55);
  });

  it("预测点不参与局部擦除", () => {
    const doc = new Document();
    doc.commitStroke(linePoints(0, 100, 10), STYLE);
    const eraser = makeController(doc, { tool: "partial" });
    eraser.onPointerDown(down(2, sample(0, 500)));
    // 真实路径在 y=500，预测点扫过笔迹 —— 不得触发切割
    eraser.onPointerMove(move(2, [sample(50, 500)], [sample(50, 0)]));
    eraser.onPointerUp(up(2, sample(100, 500)));
    expect(doc.getStrokes()).toHaveLength(1);
    expect(doc.getStrokes()[0].points).toHaveLength(11);
    expect(doc.undoDepth).toBe(1);
  });
});

describe("局部擦除：平滑代次", () => {
  it("切割后，旧平滑结果不能恢复切割前的形状", () => {
    const doc = new Document();
    const worker = new FakeWorker();
    new SmoothingManager(doc, worker);

    const pts = linePoints(0, 100, 10);
    const stroke = doc.commitStroke(pts, STYLE)!;
    worker.flush(); // 旧笔画拿到平滑缓存（切割前形状）
    expect(stroke.smoothed).not.toBeNull();
    const oldId = stroke.id;
    const oldGen = doc.editGen;

    doc.beginErasePass();
    doc.partialEraseAt(50, 0, 5);
    doc.endErasePass();

    expect(doc.hasStroke(oldId)).toBe(false);
    const frags = doc.getStrokes();
    expect(frags).toHaveLength(2);
    // 旧平滑缓存不带入片段
    expect(frags.every((f) => f.smoothed === null)).toBe(true);
    // 旧 id / 旧代次的结果都被拒收 —— 旧形状不会回来
    expect(doc.applySmoothed(oldId, oldGen, pts)).toBe(false);
    expect(doc.applySmoothed(oldId, doc.editGen, pts)).toBe(false);

    // 片段按新代次重新平滑，结果与片段等长（不是切割前的形状）
    worker.flush();
    for (const f of frags) {
      expect(f.smoothed).not.toBeNull();
      expect(f.smoothed).toHaveLength(f.points.length);
    }
  });
});

describe("局部擦除：视图缩放", () => {
  it("缩放/平移视图下命中同一世界位置", () => {
    const view = { scale: 2, tx: 100, ty: 40 };
    const doc = new Document();
    doc.commitStroke(linePoints(0, 100, 10), STYLE);
    const eraser = makeController(doc, {
      tool: "partial",
      view,
      eraserRadiusPx: 10,
    });
    // 世界 (50,0) → 屏幕 (50*2+100, 0*2+40) = (200,40)；半径 10px → 世界 5
    eraser.onPointerDown(down(2, sample(200, 40)));
    eraser.onPointerUp(up(2, sample(200, 40)));

    const frags = doc.getStrokes();
    expect(frags).toHaveLength(2);
    expect(frags[0].points[frags[0].points.length - 1].x).toBeCloseTo(45, 10);
    expect(frags[1].points[0].x).toBeCloseTo(55, 10);
  });
});

describe("局部擦除：点数上限", () => {
  it("会使文档超过两万点的切割被整体放弃，不留部分完成的操作", () => {
    const doc = new Document();
    const big: Sample[] = Array.from(
      { length: MAX_DOCUMENT_POINTS },
      (_, i) => ({ x: i * 10, y: 0, pressure: 0.5, t: i }),
    );
    const stroke = doc.commitStroke(big, STYLE)!;
    expect(doc.totalPoints).toBe(MAX_DOCUMENT_POINTS);

    const depth = doc.undoDepth;
    const gen = doc.editGen;
    doc.beginErasePass();
    // 圆盘落在 x=50000 与 x=50010 之间：两端点都在盘外、不覆盖任何点，
    // 切割会净增 2 个插值点 → 20002 > 20000
    const changed = doc.partialEraseAt(50005, 0, 3);
    doc.endErasePass();

    expect(changed).toBe(false);
    expect(doc.getStrokes()).toHaveLength(1);
    expect(doc.getStrokes()[0]).toBe(stroke); // 原对象未动
    expect(doc.totalPoints).toBe(MAX_DOCUMENT_POINTS);
    expect(doc.undoDepth).toBe(depth); // 没有部分完成的操作入栈
    expect(doc.editGen).toBe(gen);
  });

  it("同一趟内：成功的切割生效、超限的被拒绝，一次撤销完整恢复", () => {
    const doc = new Document();
    const n = MAX_DOCUMENT_POINTS - 4;
    const big: Sample[] = Array.from({ length: n }, (_, i) => ({
      x: i * 10,
      y: 0,
      pressure: 0.5,
      t: i,
    }));
    const stroke = doc.commitStroke(big, STYLE)!;

    doc.beginErasePass();
    expect(doc.partialEraseAt(50005, 0, 3)).toBe(true); // +2 → 19998
    expect(doc.partialEraseAt(100005, 0, 3)).toBe(true); // +2 → 20000
    expect(doc.partialEraseAt(150005, 0, 3)).toBe(false); // +2 → 超限，拒绝
    doc.endErasePass();

    expect(doc.totalPoints).toBe(MAX_DOCUMENT_POINTS);
    expect(doc.getStrokes()).toHaveLength(3); // 两刀 → 3 个片段
    expect(doc.undoDepth).toBe(2); // 提交 + 本次擦除（合并）

    expect(doc.undo()).toBe(true); // 一次撤销恢复整次拖动
    expect(doc.getStrokes()).toHaveLength(1);
    expect(doc.getStrokes()[0]).toBe(stroke);
    expect(doc.totalPoints).toBe(n);
  });
});
