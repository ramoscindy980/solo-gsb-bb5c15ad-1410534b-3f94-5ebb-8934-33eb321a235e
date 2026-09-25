import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LoudnessSegment } from '../audio/loudness';
import type { Chapter, Peaks } from '../types';
import type { ChainEditResult } from '../utils/chainOps';
import { clamp, formatTime } from '../utils/time';

const RULER_H = 24;
const SNAP_PX = 10;
const EDGE_PX = 6;
const MIN_ZOOM = 2; // px per second
const MAX_ZOOM = 800;
/**
 * 鼠标位移不超过该像素数时，按下+松开一律判为“单击”（即使有轻微抖动）；
 * 超过后才升级为对应的拖拽（创建 / 移动 / 缩放）。所有手势共用同一阈值。
 */
const CLICK_PX = 4;

const QUIET_FILL = 'rgba(240, 196, 25, 0.16)';
const QUIET_STRIP = 'rgba(240, 196, 25, 0.9)';
const LOUD_FILL = 'rgba(255, 107, 157, 0.18)';
const LOUD_STRIP = 'rgba(255, 107, 157, 0.95)';
/** 敏感片段消音：与音量质检的粉色区分，用红色 */
const MUTE_FILL = 'rgba(248, 81, 73, 0.20)';
const MUTE_STRIP = 'rgba(248, 81, 73, 0.95)';
/** 连锁移动：被带动章节的虚线描边与止点墙颜色 */
const CHAIN_AMBER = 'rgba(255, 184, 77, 0.95)';
const CHAIN_FILL = 'rgba(255, 184, 77, 0.10)';

interface WaveformProps {
  peaks: Peaks;
  chapters: Chapter[];
  selectedId: string | null;
  playhead: number;
  pxPerSec: number;
  follow: boolean;
  /** silence-split candidate boundaries (preview markers) */
  suggestions: number[];
  /** continuous 过轻/过响 ranges to color on the waveform */
  loudnessSegments: LoudnessSegment[];
  /** 消音区间（已合并，秒）：在波形上以红色条带标示 */
  muteRanges: Array<{ start: number; end: number }>;
  /** 当前会话锁定的章节 id（连锁移动的固定止点） */
  lockedIds: ReadonlySet<string>;
  onZoom: (pxPerSec: number) => void;
  onSeek: (t: number) => void;
  /** click an abnormal band: start previewing from that time */
  onPreviewSegment: (t: number) => void;
  onSelect: (id: string | null) => void;
  onCreateFromDrag: (a: number, b: number, snap: number) => string | null;
  onMove: (id: string, start: number, snap: number) => ChainEditResult | 'locked' | null;
  onResize: (
    id: string,
    edge: 'start' | 'end',
    t: number,
    snap: number,
  ) => ChainEditResult | 'locked' | null;
  /** 尝试编辑锁定章节时的一次性提示 */
  onLockedAttempt: (id: string) => void;
  /** 拖拽/缩放过程的反馈：钳制原因提示 + 实时连锁摘要（null 表示手势结束） */
  onEditFeedback: (r: ChainEditResult | 'locked' | null) => void;
}

/**
 * 手势状态机：
 * - pending：按下后尚未确认是点击还是拖拽（位移 ≤ CLICK_PX），此时不做任何
 *   章节编辑，轻微抖动不会误触移动 / 缩放；
 * - create / move / resize：位移超过阈值后升级为真正的拖拽，执行原有编辑；
 * - locked：按在锁定章节上，任何位移都不编辑，超阈值仅提示一次锁定原因。
 */
type Gesture =
  | { mode: 'pending'; kind: 'empty'; downX: number; downT: number; band: LoudnessSegment | null }
  | {
      mode: 'pending';
      kind: 'chapter';
      downX: number;
      downT: number;
      band: LoudnessSegment | null;
      hit: HitChapter;
    }
  | { mode: 'locked'; downX: number; id: string; hinted: boolean }
  | { mode: 'create'; startT: number; curT: number }
  | { mode: 'move'; id: string; grabOffset: number }
  | { mode: 'resize'; id: string; edge: 'start' | 'end' };

/** 拖拽创建章节时需要的画布预览（其余手势不产生覆盖层）。 */
type DragState = { mode: 'create'; startT: number; curT: number } | null;

interface HitChapter {
  chapter: Chapter;
  edge: 'start' | 'end' | 'body';
}

/** 拖拽中的连锁预览：被带动章节 + 止点。 */
interface ChainPreview {
  movedIds: Set<string>;
  stop: ChainEditResult['stop'];
  limitAt?: number;
  clipped: boolean;
}

function niceStep(pxPerSec: number): number {
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  for (const s of steps) {
    if (s * pxPerSec >= 70) return s;
  }
  return 7200;
}

export function Waveform(props: WaveformProps) {
  const {
    peaks,
    chapters,
    selectedId,
    playhead,
    pxPerSec,
    follow,
    suggestions,
    loudnessSegments,
    muteRanges,
    lockedIds,
  } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [viewportW, setViewportW] = useState(800);
  const [scrollLeft, setScrollLeft] = useState(0);
  /** 拖拽创建的实时覆盖层（仅 create 手势有） */
  const [drag, setDrag] = useState<DragState>(null);
  /** 当前手势；window 事件回调通过此 ref 读取，避免闭包过期 */
  const gestureRef = useRef<Gesture | null>(null);
  /** 活动手势的 window 监听解绑函数（指针取消 / 组件卸载时兜底清理） */
  const endListenersRef = useRef<(() => void) | null>(null);
  const [chainPreview, setChainPreview] = useState<ChainPreview | null>(null);
  const chainPreviewRef = useRef<ChainPreview | null>(null);
  const pendingAnchor = useRef<{ t: number; x: number } | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const duration = peaks.duration;
  const totalWidth = Math.max(1, Math.ceil(duration * pxPerSec));

  // observe viewport size
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportW(el.clientWidth));
    ro.observe(el);
    setViewportW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // apply pending zoom anchor after zoom changes
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pendingAnchor.current) {
      const { t, x } = pendingAnchor.current;
      el.scrollLeft = Math.max(0, t * pxPerSec - x);
      pendingAnchor.current = null;
    }
  }, [pxPerSec]);

  // follow playhead during playback
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !follow) return;
    const px = playhead * pxPerSec;
    if (px < el.scrollLeft || px > el.scrollLeft + el.clientWidth - 40) {
      el.scrollLeft = Math.max(0, px - el.clientWidth / 2);
    }
  }, [playhead, follow, pxPerSec]);

  const timeAtClientX = useCallback(
    (clientX: number): { t: number; x: number } => {
      const canvas = canvasRef.current!;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const t = clamp((scrollRef.current!.scrollLeft + x) / pxPerSec, 0, duration);
      return { t, x };
    },
    [pxPerSec, duration],
  );

  const hitTest = useCallback(
    (t: number, x: number): HitChapter | null => {
      const scroll = scrollRef.current?.scrollLeft ?? 0;
      for (const c of chapters) {
        if (t >= c.start && t <= c.end) {
          const startX = c.start * pxPerSec - scroll;
          const endX = c.end * pxPerSec - scroll;
          if (Math.abs(x - startX) <= EDGE_PX) return { chapter: c, edge: 'start' };
          if (Math.abs(x - endX) <= EDGE_PX) return { chapter: c, edge: 'end' };
          return { chapter: c, edge: 'body' };
        }
      }
      return null;
    },
    [chapters, pxPerSec],
  );

  const hitBand = useCallback(
    (t: number): LoudnessSegment | null => {
      for (const s of loudnessSegments) {
        if (t >= s.start && t < s.end) return s;
      }
      return null;
    },
    [loudnessSegments],
  );

  // ---- 统一手势判定（pointerdown 开始，window 监听收尾，画布外松开也成立）----
  /** 结束手势：解绑 window 监听、清掉拖拽覆盖层与编辑反馈。 */
  const teardownGesture = useCallback(() => {
    endListenersRef.current?.();
    endListenersRef.current = null;
    gestureRef.current = null;
    setDrag(null);
    chainPreviewRef.current = null;
    setChainPreview(null);
    propsRef.current.onEditFeedback(null);
  }, []);

  /** 组件卸载时若手势仍在进行，兜底解绑 window 监听（不回调父组件）。 */
  useEffect(() => () => endListenersRef.current?.(), []);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const canvas = canvasRef.current;
    // 捕获指针：拖到画布 / 浏览器窗口外再松开，pointerup 仍会派发到画布，
    // window 上的监听也随之收到，按真实手势（点击 / 拖拽 / 取消）处理。
    try {
      canvas?.setPointerCapture(e.pointerId);
    } catch {
      /* 个别环境不支持时退回 window 监听，仍可正常工作 */
    }

    const loc = timeAtClientX(e.clientX);
    const hit = hitTest(loc.t, loc.x);
    const band = hitBand(loc.t);

    // 普通 / 锁定章节按下都先选中；是否编辑要等位移超过阈值才决定
    if (hit) props.onSelect(hit.chapter.id);

    const gesture: Gesture = hit
      ? props.lockedIds.has(hit.chapter.id)
        ? { mode: 'locked', downX: e.clientX, id: hit.chapter.id, hinted: false }
        : { mode: 'pending', kind: 'chapter', downX: e.clientX, downT: loc.t, band, hit }
      : { mode: 'pending', kind: 'empty', downX: e.clientX, downT: loc.t, band };
    gestureRef.current = gesture;

    const applyMove = (g: Extract<Gesture, { mode: 'move' }>, ct: number) => {
      const r = propsRef.current.onMove(g.id, ct - g.grabOffset, SNAP_PX / pxPerSec);
      handleEditResult(r);
    };
    const applyResize = (g: Extract<Gesture, { mode: 'resize' }>, ct: number) => {
      const r = propsRef.current.onResize(g.id, g.edge, ct, SNAP_PX / pxPerSec);
      handleEditResult(r);
    };

    const onWinMove = (ev: PointerEvent) => {
      const g = gestureRef.current;
      if (!g) return;
      const { t: ct } = timeAtClientX(ev.clientX);

      if (g.mode === 'locked') {
        // 锁定章节：只有真的“按住拖了一下”才提示锁定原因，单击保持安静
        if (!g.hinted && Math.abs(ev.clientX - g.downX) > CLICK_PX) {
          g.hinted = true;
          propsRef.current.onLockedAttempt(g.id);
        }
        return;
      }

      if (g.mode === 'pending') {
        // 轻微抖动不升级：仍按点击处理，不产生任何编辑
        if (Math.abs(ev.clientX - g.downX) <= CLICK_PX) return;
        if (g.kind === 'empty') {
          const ng: Gesture = { mode: 'create', startT: g.downT, curT: ct };
          gestureRef.current = ng;
          setDrag(ng);
        } else if (g.hit.edge === 'body') {
          const ng: Gesture = {
            mode: 'move',
            id: g.hit.chapter.id,
            grabOffset: g.downT - g.hit.chapter.start,
          };
          gestureRef.current = ng;
          applyMove(ng, ct);
        } else {
          const ng: Gesture = {
            mode: 'resize',
            id: g.hit.chapter.id,
            edge: g.hit.edge,
          };
          gestureRef.current = ng;
          applyResize(ng, ct);
        }
        return;
      }

      if (g.mode === 'create') {
        const ng = { ...g, curT: ct };
        gestureRef.current = ng;
        setDrag(ng);
      } else if (g.mode === 'move') {
        applyMove(g, ct);
      } else if (g.mode === 'resize') {
        applyResize(g, ct);
      }
    };

    /**
     * 松开：未升级为拖拽的手势一律按“单击”处理——
     * 落在音量异常带上则按现有规则试听，否则走 App 唯一的 seek 通路
     *（播放中原声继续、试听先切回声源、暂停则只定位）。
     */
    const onWinUp = (ev: PointerEvent) => {
      const g = gestureRef.current;
      teardownGesture();
      try {
        canvas?.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      if (!g) return;
      const { t: ct } = timeAtClientX(ev.clientX);

      if (g.mode === 'create') {
        propsRef.current.onCreateFromDrag(g.startT, ct, SNAP_PX / pxPerSec);
        return;
      }
      // move / resize 是真实拖拽：编辑已在移动中提交，松开不触发定位
      if (g.mode === 'move' || g.mode === 'resize') return;
      // 锁定章节上发生过实际拖拽（已提示）：不再当作点击定位
      if (g.mode === 'locked' && g.hinted) return;

      // pending 单击（章节内部 / 边界 / 空白）或锁定章节的安静单击：
      // 按下点与松开点任一落在异常带内即试听，保持既有规则
      const bandHere = g.mode === 'locked' ? hitBand(ct) : g.band ?? hitBand(ct);
      if (bandHere) {
        propsRef.current.onPreviewSegment(ct);
        return;
      }
      if (g.mode === 'pending' && g.kind === 'empty') {
        // 空白处单击：定位并清除选中（与既有行为一致）
        propsRef.current.onSeek(ct);
        propsRef.current.onSelect(null);
      } else {
        // 普通章节（含边界）或锁定章节：保持选中，定位到点击时间
        propsRef.current.onSeek(ct);
      }
    };

    /** 指针被系统取消（浏览器手势抢占等）：放弃整个手势，不编辑也不定位。 */
    const onWinCancel = () => teardownGesture();

    window.addEventListener('pointermove', onWinMove);
    window.addEventListener('pointerup', onWinUp);
    window.addEventListener('pointercancel', onWinCancel);
    endListenersRef.current = () => {
      window.removeEventListener('pointermove', onWinMove);
      window.removeEventListener('pointerup', onWinUp);
      window.removeEventListener('pointercancel', onWinCancel);
    };
  };

  /** 把编辑结果同步到画布上的连锁高亮，并上报钳制/摘要信息。 */
  const handleEditResult = (r: ChainEditResult | 'locked' | null) => {
    if (!r || r === 'locked') {
      if (r === 'locked') propsRef.current.onEditFeedback('locked');
      return;
    }
    const prev: ChainPreview = {
      movedIds: new Set(r.movedIds),
      stop: r.stop,
      limitAt: r.limitAt,
      clipped: r.clipped,
    };
    chainPreviewRef.current = prev;
    setChainPreview(prev);
    propsRef.current.onEditFeedback(r);
  };

  const onHover = (e: React.PointerEvent) => {
    if (gestureRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { t, x } = timeAtClientX(e.clientX);
    const hit = hitTest(t, x);
    if (hit) {
      if (lockedIds.has(hit.chapter.id)) canvas.style.cursor = 'not-allowed';
      else canvas.style.cursor = hit.edge === 'body' ? 'grab' : 'ew-resize';
    } else {
      canvas.style.cursor = hitBand(t) ? 'pointer' : 'crosshair';
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const { t, x } = timeAtClientX(e.clientX);
    const factor = e.deltaY < 0 ? 1.25 : 0.8;
    const next = clamp(pxPerSec * factor, MIN_ZOOM, MAX_ZOOM);
    if (next === pxPerSec) return;
    pendingAnchor.current = { t, x };
    props.onZoom(next);
  };

  // ---- rendering ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const h = canvas.clientHeight;
    const w = viewportW;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const waveTop = RULER_H;
    const waveH = h - RULER_H;
    const mid = waveTop + waveH / 2;

    // background
    ctx.fillStyle = '#101418';
    ctx.fillRect(0, 0, w, h);

    const t0 = scrollLeft / pxPerSec;
    const t1 = (scrollLeft + w) / pxPerSec;

    // chapter regions (under waveform tint)
    for (const c of chapters) {
      const x0 = c.start * pxPerSec - scrollLeft;
      const x1 = c.end * pxPerSec - scrollLeft;
      if (x1 < 0 || x0 > w) continue;
      const sel = c.id === selectedId;
      const isLocked = lockedIds.has(c.id);
      const isMoved = chainPreview?.movedIds.has(c.id) ?? false;
      if (isLocked) {
        ctx.fillStyle = sel ? 'rgba(255, 184, 77, 0.26)' : 'rgba(255, 184, 77, 0.12)';
      } else if (isMoved) {
        // 被编辑章节与被带动章节统一琥珀色提示，选中章节略强
        ctx.fillStyle = sel ? 'rgba(255, 184, 77, 0.24)' : CHAIN_FILL;
      } else {
        ctx.fillStyle = sel ? 'rgba(64, 160, 255, 0.28)' : 'rgba(64, 160, 255, 0.13)';
      }
      ctx.fillRect(x0, waveTop, x1 - x0, waveH);
    }

    // loudness QC bands: continuous 过轻/过响 ranges, distinct colors
    for (const seg of loudnessSegments) {
      const x0 = seg.start * pxPerSec - scrollLeft;
      const x1 = seg.end * pxPerSec - scrollLeft;
      if (x1 < 0 || x0 > w) continue;
      const isQuiet = seg.kind === 'quiet';
      ctx.fillStyle = isQuiet ? QUIET_FILL : LOUD_FILL;
      ctx.fillRect(x0, waveTop, x1 - x0, waveH);
      // solid status strip along the bottom edge of the band
      ctx.fillStyle = isQuiet ? QUIET_STRIP : LOUD_STRIP;
      ctx.fillRect(x0, waveTop + waveH - 5, x1 - x0, 5);
    }

    // 敏感片段消音区间：红色填充 + 顶部实心条 + 两侧竖线（边界带 ≤20ms 包络）
    for (const seg of muteRanges) {
      const x0 = seg.start * pxPerSec - scrollLeft;
      const x1 = seg.end * pxPerSec - scrollLeft;
      if (x1 < 0 || x0 > w) continue;
      ctx.fillStyle = MUTE_FILL;
      ctx.fillRect(x0, waveTop, x1 - x0, waveH);
      ctx.fillStyle = MUTE_STRIP;
      ctx.fillRect(x0, waveTop, Math.max(1, x1 - x0), 4);
      ctx.fillRect(x0, waveTop + 4, 2, waveH - 4);
      ctx.fillRect(x1 - 2, waveTop + 4, 2, waveH - 4);
    }

    // drag-create preview
    if (drag && drag.mode === 'create') {
      const a = Math.min(drag.startT, drag.curT) * pxPerSec - scrollLeft;
      const b = Math.max(drag.startT, drag.curT) * pxPerSec - scrollLeft;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
      ctx.fillRect(a, waveTop, b - a, waveH);
    }

    // waveform
    ctx.strokeStyle = '#7fd4a8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const { min, max, rate } = peaks;
    for (let x = 0; x < w; x++) {
      const ts = (scrollLeft + x) / pxPerSec;
      const te = (scrollLeft + x + 1) / pxPerSec;
      let i0 = Math.floor(ts * rate);
      let i1 = Math.max(i0 + 1, Math.ceil(te * rate));
      if (i0 >= min.length) break;
      i1 = Math.min(i1, min.length);
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = i0; i < i1; i++) {
        if (min[i] < lo) lo = min[i];
        if (max[i] > hi) hi = max[i];
      }
      if (lo === Infinity) continue;
      const y0 = mid - hi * (waveH / 2) * 0.92;
      const y1 = mid - lo * (waveH / 2) * 0.92;
      ctx.moveTo(x + 0.5, y0);
      ctx.lineTo(x + 0.5, Math.max(y1, y0 + 1));
    }
    ctx.stroke();

    // center line
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();

    // chapter borders, handles, labels
    for (const c of chapters) {
      const x0 = c.start * pxPerSec - scrollLeft;
      const x1 = c.end * pxPerSec - scrollLeft;
      if (x1 < 0 || x0 > w) continue;
      const sel = c.id === selectedId;
      const isLocked = lockedIds.has(c.id);
      const isMoved = chainPreview?.movedIds.has(c.id) ?? false;
      const accent = isLocked || isMoved ? CHAIN_AMBER : null;
      if (accent) {
        ctx.strokeStyle = accent;
        ctx.lineWidth = sel ? 2 : 1.5;
        ctx.setLineDash(isLocked ? [] : [6, 4]);
      } else {
        ctx.strokeStyle = sel ? '#5eb1ff' : 'rgba(94, 177, 255, 0.55)';
        ctx.lineWidth = sel ? 2 : 1;
        ctx.setLineDash([]);
      }
      ctx.strokeRect(x0 + 0.5, waveTop + 0.5, x1 - x0 - 1, waveH - 1);
      ctx.setLineDash([]);
      // handles（锁定章节为琥珀色，表示不可拖拽）
      ctx.fillStyle = accent ? (sel ? CHAIN_AMBER : 'rgba(255, 184, 77, 0.85)') : sel ? '#5eb1ff' : 'rgba(94, 177, 255, 0.8)';
      ctx.fillRect(x0 - 2, waveTop, 4, 14);
      ctx.fillRect(x1 - 2, waveTop, 4, 14);
      ctx.fillRect(x0 - 2, waveTop + waveH - 14, 4, 14);
      ctx.fillRect(x1 - 2, waveTop + waveH - 14, 4, 14);
      // 锁定标识：右上角 🔒 徽标
      if (isLocked) {
        ctx.font = '11px system-ui, sans-serif';
        const badge = '🔒';
        const bw = 18;
        const bx = x1 - bw - 2;
        ctx.fillStyle = 'rgba(40, 30, 10, 0.85)';
        ctx.fillRect(bx, waveTop + 3, bw, 15);
        ctx.strokeStyle = CHAIN_AMBER;
        ctx.lineWidth = 1;
        ctx.strokeRect(bx + 0.5, waveTop + 3.5, bw - 1, 14);
        ctx.fillStyle = '#ffd8a8';
        ctx.fillText(badge, bx + 3, waveTop + 15);
      }
      // label
      const label = c.title || '(未命名)';
      ctx.font = '12px system-ui, sans-serif';
      const tw = ctx.measureText(label).width;
      const labelFits = x1 - x0 > tw + 12 + (isLocked ? 22 : 0);
      if (labelFits) {
        ctx.fillStyle = accent ? '#ffe6c4' : sel ? '#dceeff' : 'rgba(220, 238, 255, 0.75)';
        ctx.fillText(label, x0 + 6, waveTop + 16);
      }
    }

    // 连锁止点墙：被钳制时在止点位置画一条琥珀色粗竖线 + 标签
    if (chainPreview?.clipped && chainPreview.limitAt !== undefined) {
      const st = chainPreview.stop;
      const wallX = chainPreview.limitAt * pxPerSec - scrollLeft;
      const tag = !st
        ? '最短时长'
        : st.kind === 'audio-end'
          ? '音频结尾'
          : st.kind === 'audio-start'
            ? '音频开头'
            : st.kind === 'locked-chapter'
              ? '🔒 锁定章节'
              : '相邻章节';
      if (wallX >= -2 && wallX <= w + 2) {
        ctx.strokeStyle = CHAIN_AMBER;
        ctx.lineWidth = 3;
        ctx.setLineDash([8, 4]);
        ctx.beginPath();
        ctx.moveTo(wallX, waveTop + 2);
        ctx.lineTo(wallX, waveTop + waveH - 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = '11px system-ui, sans-serif';
        const tw2 = ctx.measureText(tag).width + 10;
        let tx = wallX + 4;
        if (tx + tw2 > w - 4) tx = wallX - tw2 - 4;
        ctx.fillStyle = 'rgba(40, 30, 10, 0.92)';
        ctx.fillRect(tx, waveTop + 4, tw2, 16);
        ctx.fillStyle = '#ffd8a8';
        ctx.fillText(tag, tx + 5, waveTop + 16);
      }
    }

    // silence-split suggestions: dashed orange markers, distinct from chapters
    if (suggestions.length > 0) {
      ctx.strokeStyle = 'rgba(255, 176, 66, 0.9)';
      ctx.fillStyle = 'rgba(255, 176, 66, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      for (const t of suggestions) {
        const x = t * pxPerSec - scrollLeft;
        if (x < 0 || x > w) continue;
        ctx.beginPath();
        ctx.moveTo(x, waveTop);
        ctx.lineTo(x, waveTop + waveH);
        ctx.stroke();
        // flag triangle at the top of the marker
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x, waveTop);
        ctx.lineTo(x + 8, waveTop + 5);
        ctx.lineTo(x, waveTop + 10);
        ctx.closePath();
        ctx.fill();
        ctx.setLineDash([5, 4]);
      }
      ctx.setLineDash([]);
    }

    // ruler
    ctx.fillStyle = '#0b0e11';
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.moveTo(0, RULER_H - 0.5);
    ctx.lineTo(w, RULER_H - 0.5);
    ctx.stroke();
    const step = niceStep(pxPerSec);
    const firstTick = Math.floor(t0 / step) * step;
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    for (let t = firstTick; t <= t1 + step; t += step) {
      if (t < 0 || t > duration + 1e-6) continue;
      const x = t * pxPerSec - scrollLeft;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, RULER_H - 6);
      ctx.lineTo(x + 0.5, RULER_H);
      ctx.stroke();
      ctx.fillText(formatTime(t), x + 4, RULER_H - 8);
    }

    // playhead
    const px = playhead * pxPerSec - scrollLeft;
    if (px >= -2 && px <= w + 2) {
      ctx.strokeStyle = '#ff5a5a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
      ctx.fillStyle = '#ff5a5a';
      ctx.beginPath();
      ctx.moveTo(px - 5, 0);
      ctx.lineTo(px + 5, 0);
      ctx.lineTo(px, 8);
      ctx.closePath();
      ctx.fill();
    }
  }, [
    peaks,
    chapters,
    selectedId,
    playhead,
    pxPerSec,
    scrollLeft,
    viewportW,
    drag,
    duration,
    suggestions,
    loudnessSegments,
    muteRanges,
    lockedIds,
    chainPreview,
  ]);

  return (
    <div
      ref={scrollRef}
      className="wave-scroll"
      onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
    >
      <div style={{ width: totalWidth, height: '100%', position: 'relative' }}>
        <canvas
          ref={canvasRef}
          className="wave-canvas"
          style={{ width: viewportW, touchAction: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onHover}
          onWheel={onWheel}
        />
      </div>
    </div>
  );
}
