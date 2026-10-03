import { describe, expect, it } from "vitest";
import { Document, MAX_DOCUMENT_POINTS } from "../src/model/document";
import { splitOutsideDisk } from "../src/model/partialErase";
import type { Sample, Stroke } from "../src/model/types";
import {
  down,
  drawLineStroke,
  makeController,
  move,
  sample,
  up,
} from "./helpers";
import { screenToWorld, type ViewTransform } from "../src/model/geometry";
import type { SmoothRequest, SmoothResponse } from "../src/smoothing/messages";
import { smoothPoints } from "../src/smoothing/smooth";
import { SmoothingManager } from "../src/smoothing/manager";

const STYLE = { color: "#000", baseWidth: 4 };

function p(x: number, y: number, pressure = 0.5, t = x + y): Sample {
  return { x, y, pressure, t };
}

function stroke(doc: Document, points: Sample[]): Stroke {
  return doc.commitStroke(points, STYLE)!;
}

/** 同步可控假 Worker：与 smoothing.test.ts 中相同的回包逻辑。 */
class FakeWorker {
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

describe("局部擦除：几何裁剪", () => {
  it("两端采样都在圆盘外、中部穿过圆盘的线段也会被切开", () => {
    // (-10,0) → (10,0)，圆盘圆心 (0,0)、半径 2：两端都远在圆外
    const pieces = splitOutsideDisk([p(-10, 0), p(10, 0)], 0, 0, 2);
    expect(pieces).toHaveLength(2);
    expect(pieces[0][pieces[0].length - 1].x).toBeCloseTo(-2, 10);
    expect(pieces[1][0].x).toBeCloseTo(2, 10);
    // 剩余片段各自只有“圆外”部分，不存在跨越空白的线段
    expect(pieces[0].every((q) => q.x <= -2 + 1e-9)).toBe(true);
    expect(pieces[1].every((q) => q.x >= 2 - 1e-9)).toBe(true);
  });

  it("多次穿越产生多个独立片段，不连成跨越空白的直线", () => {
    // W 形折线两次穿过圆盘：外-内-外-内-外
    const pts = [
      p(-10, 0),
      p(-3, 0),
      p(0, 0.6), // 圆内（r=2，圆心原点）附近凸起
      p(3, 0),
      p(10, 0),
      p(0, 5), // 绕到远处
      p(0, 1.5), // 再次进入圆盘
      p(0, -1.5), // 圆内
      p(0, -5),
    ];
    const pieces = splitOutsideDisk(pts, 0, 0, 2);
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    // 片段的每个采样都在圆盘外或圆上：片段之间绝不存在穿越圆盘内部的连线
    for (const frag of pieces) {
      for (const q of frag) {
        expect(Math.hypot(q.x, q.y)).toBeGreaterThanOrEqual(2 - 1e-9);
      }
    }
  });

  it("与圆盘相切不擦除", () => {
    // 水平线 y=2，圆盘 r=2 圆心原点：线段在 (0,2) 处相切
    const pts = [p(-10, 2), p(-5, 2), p(0, 2), p(5, 2), p(10, 2)];
    const pieces = splitOutsideDisk(pts, 0, 0, 2);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toBe(pts); // 未相交：引用不变
  });

  it("孤立点：圆内删除，圆上/圆外保留", () => {
    expect(splitOutsideDisk([p(0, 0)], 0, 0, 1)).toEqual([]);
    const onEdge = splitOutsideDisk([p(1, 0)], 0, 0, 1);
    expect(onEdge).toHaveLength(1); // 圆上保留
    expect(splitOutsideDisk([p(2, 0)], 0, 0, 1)).toHaveLength(1);
  });

  it("零长度退化线段（重复采样）：圆上保留、圆内删除", () => {
    const dupOnEdge = [p(1, 0, 0.5, 1), p(1, 0, 0.5, 2)];
    const pieces = splitOutsideDisk(dupOnEdge, 0, 0, 1);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toBe(dupOnEdge);
    const dupInside = [p(0, 0, 0.5, 1), p(0, 0, 0.5, 2)];
    expect(splitOutsideDisk(dupInside, 0, 0, 1)).toEqual([]);
  });

  it("切口边界插值保留压力与时间，原采样顺序不变", () => {
    const pts = [
      { x: -10, y: 0, pressure: 0.2, t: 100 },
      { x: 10, y: 0, pressure: 0.8, t: 200 },
    ];
    const pieces = splitOutsideDisk(pts, 0, 0, 2);
    const leftEnd = pieces[0][pieces[0].length - 1];
    const rightStart = pieces[1][0];
    expect(leftEnd.x).toBeCloseTo(-2, 10);
    expect(rightStart.x).toBeCloseTo(2, 10);
    // t=-2 → 参数 0.4，压力 0.2 + 0.6*0.4 = 0.44，时间 140
    expect(leftEnd.pressure).toBeCloseTo(0.44, 10);
    expect(leftEnd.t).toBeCloseTo(140, 10);
    // 左片段沿原笔迹向前（x 单调），右片段沿原笔迹向后
    const xs = pieces[0].map((q) => q.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });
});

describe("局部擦除：整次拖动一个撤销操作", () => {
  it("一次拖动跨多个圆盘，只需一次撤销完整恢复", () => {
    const doc = new Document();
    drawLineStroke(doc, 0); // 水平线 0..100，11 个点
    const before = JSON.stringify(doc.getStrokes());
    const depthBefore = doc.undoDepth;

    const eraser = makeController(doc, { tool: "partial", eraserRadiusPx: 5 });
    eraser.onPointerDown(down(2, sample(30, 0)));
    eraser.onPointerMove(move(2, [sample(40, 0), sample(50, 0), sample(60, 0)]));
    eraser.onPointerUp(up(2, sample(70, 0)));

    // 拖动中被切成多个片段
    expect(doc.getStrokes().length).toBeGreaterThan(1);
    // 整次拖动只产生一个撤销操作
    expect(doc.undoDepth).toBe(depthBefore + 1);

    doc.undo();
    expect(JSON.stringify(doc.getStrokes())).toBe(before);
    expect(doc.undoDepth).toBe(depthBefore);
  });

  it("未命中的拖动不产生撤销操作、不推进代次", () => {
    const doc = new Document();
    drawLineStroke(doc, 0);
    const genBefore = doc.editGen;
    const depthBefore = doc.undoDepth;
    const eraser = makeController(doc, { tool: "partial", eraserRadiusPx: 5 });
    eraser.onPointerDown(down(2, sample(0, 500)));
    eraser.onPointerMove(move(2, [sample(50, 500)]));
    eraser.onPointerUp(up(2, sample(100, 500)));
    expect(doc.undoDepth).toBe(depthBefore);
    expect(doc.editGen).toBe(genBefore);
    expect(doc.getStrokes()).toHaveLength(1);
  });

  it("擦除过程中取消（pointercancel）也合并为一次可撤销操作", () => {
    const doc = new Document();
    drawLineStroke(doc, 0);
    const before = JSON.stringify(doc.getStrokes());
    const eraser = makeController(doc, { tool: "partial", eraserRadiusPx: 5 });
    eraser.onPointerDown(down(2, sample(30, 0)));
    eraser.onPointerMove(move(2, [sample(50, 0)]));
    eraser.onPointerCancel({ pointerId: 2 });
    expect(doc.getStrokes().length).toBeGreaterThan(1);
    expect(doc.undo()).toBe(true);
    expect(JSON.stringify(doc.getStrokes())).toBe(before);
  });

  it("缩放后命中同一世界位置", () => {
    // scale=2、平移使屏幕 (100,100) 对应世界 (0,0)：screen = 2*world + 100
    const zoomed: ViewTransform = { scale: 2, tx: 100, ty: 100 };

    const cut = (view: ViewTransform, sx: number, sy: number, rPx: number) => {
      const d = new Document();
      drawLineStroke(d, 0, -100, 100, 10); // -100..100 穿过原点，共 21 点
      const ctl = makeController(d, {
        view,
        tool: "partial",
        eraserRadiusPx: rPx,
      });
      ctl.onPointerDown(down(3, sample(sx, sy)));
      ctl.onPointerUp(up(3, sample(sx, sy)));
      return d.getStrokes().map((s) => s.points.length);
    };

    // 世界坐标下在原点下刀
    const cutAtScale1 = cut({ scale: 1, tx: 0, ty: 0 }, 0, 0, 4);

    const w = screenToWorld(zoomed, 100, 100);
    expect(w).toEqual({ x: 0, y: 0 });
    // 缩放到 2x：同样的世界原点在屏幕 (100,100)，屏幕半径 8 = 世界半径 4
    const cutAtScale2 = cut(zoomed, 100, 100, 8);
    expect(cutAtScale2).toEqual(cutAtScale1);
    expect(cutAtScale1).toEqual([11, 11]); // 左右各 10 个原采样 + 1 个切口点
  });
});

describe("局部擦除：点数上限原子性", () => {
  it("新增切口将使总点数超过两万时，本次拖动整体回滚，不留撤销记录", () => {
    const doc = new Document();
    // 19999 点的横线（相邻整数采样）；一个半径 0.4、圆心落在相邻采样正中间
    // 的圆盘两端都在圆外、只穿过一条线段，切两刀新增 2 点 → 20001 > 20000
    const n = MAX_DOCUMENT_POINTS - 1;
    const s = stroke(
      doc,
      Array.from({ length: n }, (_, i) => p(i, 0, 0.5, i)),
    );
    expect(doc.totalPoints).toBe(n);

    const eraser = makeController(doc, { tool: "partial", eraserRadiusPx: 0.4 });
    eraser.onPointerDown(down(2, sample(100.5, 0))); // 第一刀即超限
    // 超限圆盘不生效，画面仍是原笔画
    expect(doc.getStrokes()).toHaveLength(1);
    expect(doc.getStrokes()[0].id).toBe(s.id);
    eraser.onPointerMove(move(2, [sample(500.5, 0)])); // 之后的圆盘全部跳过
    eraser.onPointerUp(up(2, sample(900.5, 0)));

    // 抬起后整体回到拖动前：画面、文档点数、撤销栈一致
    expect(doc.getStrokes()).toHaveLength(1);
    expect(doc.getStrokes()[0].id).toBe(s.id);
    expect(doc.totalPoints).toBe(n);
    expect(doc.undoDepth).toBe(1); // 只有最初的 add
  });

  it("预算内的切割正常落账，撤销释放切口点预算", () => {
    const doc = new Document();
    stroke(doc, [p(0, 0), p(10, 0)]); // 2 点
    const eraser = makeController(doc, { tool: "partial", eraserRadiusPx: 1 });
    eraser.onPointerDown(down(2, sample(5, 0)));
    eraser.onPointerUp(up(2, sample(5, 0)));
    expect(doc.totalPoints).toBe(4); // 两个切口点
    expect(doc.remainingPointBudget()).toBe(MAX_DOCUMENT_POINTS - 4);
    doc.undo();
    expect(doc.totalPoints).toBe(2);
  });
});

describe("局部擦除：平滑代次", () => {
  it("拖动途中返回的旧平滑结果不能恢复切割前形状", () => {
    const doc = new Document();
    const worker = new FakeWorker();
    new SmoothingManager(doc, worker as never);

    const s = stroke(doc, [p(-10, 0), p(-5, 0), p(0, 0), p(5, 0), p(10, 0)]);
    worker.inbox.length = 0;

    const eraser = makeController(doc, { tool: "partial", eraserRadiusPx: 2 });
    eraser.onPointerDown(down(2, sample(0, 0)));
    const midDragGen = doc.editGen; // 拖动中不推进代次
    // 原笔画在第一次切割后即被片段替换，旧代次结果无法写入
    expect(doc.applySmoothed(s.id, midDragGen, [p(0, 9)] as Sample[])).toBe(
      false,
    );
    eraser.onPointerUp(up(2, sample(0, 0)));

    const afterGen = doc.editGen;
    expect(afterGen).toBe(midDragGen + 1);
    // 原笔画 id 已不存在；以拖动中代次到达的结果无法复活/恢复旧形状
    expect(doc.hasStroke(s.id)).toBe(false);
    expect(doc.applySmoothed(s.id, midDragGen, [p(0, 9)] as Sample[])).toBe(
      false,
    );
    // 片段以新代次重新平滑（在途的旧代次请求到达时被丢弃）
    worker.flush();
    for (const frag of doc.getStrokes()) {
      expect(frag.smoothed).not.toBeNull();
      expect(frag.gen).toBe(afterGen);
    }
    // 撤销后原笔画（真实采样完整）回来，按新代次重平滑
    worker.inbox.length = 0;
    doc.undo();
    expect(doc.hasStroke(s.id)).toBe(true);
    expect(doc.getStroke(s.id)!.points).toHaveLength(5);
    worker.flush();
    expect(doc.getStroke(s.id)!.smoothed).not.toBeNull();
  });
});
