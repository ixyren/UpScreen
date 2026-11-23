import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import type {
  Annotation,
  AspectPreset,
  BlurAnnotation,
  CropRect,
  FrameOptions,
  TextAnnotation,
  ToolType,
  UpscalePreviewResult,
} from "../types";

interface EditorCanvasProps {
  imageDataUrl: string;
  imageWidth: number;
  imageHeight: number;
  tool: ToolType;
  annotations: Annotation[];
  selectedId: string | null;
  activeColor: string;
  strokeWidth: number;
  fontSize: number;
  textBold: boolean;
  textHasPill: boolean;
  zoom: number | "fit";
  fitNonce?: number;
  cropRect: CropRect | null;
  aspectPreset: AspectPreset;
  previewResult: UpscalePreviewResult | null;
  frameOptions?: FrameOptions;
  onSelectId: (id: string | null) => void;
  onAddAnnotation: (ann: Annotation) => void;
  onUpdateAnnotation: (
    id: string,
    patch: Partial<Annotation>,
    commitHistory?: boolean
  ) => void;
  onDeleteAnnotation: (id: string) => void;
  onChangeCropRect: (rect: CropRect | null) => void;
  onChangeZoom: (next: number | "fit") => void;
  onCheckpointHistory?: () => void;
}

interface CameraState {
  scale: number;
  x: number;
  y: number;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}

function drawRoundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  strokeWidth: number
) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 2) return;

  const angle = Math.atan2(dy, dx);
  const headLen = Math.max(14, strokeWidth * 4.2);
  const shaftEndX = x2 - Math.cos(angle) * (headLen * 0.68);
  const shaftEndY = y2 - Math.sin(angle) * (headLen * 0.68);

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 6;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = "round";

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(shaftEndX, shaftEndY);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - headLen * Math.cos(angle - Math.PI / 6),
    y2 - headLen * Math.sin(angle - Math.PI / 6)
  );
  ctx.lineTo(
    x2 - headLen * Math.cos(angle + Math.PI / 6),
    y2 - headLen * Math.sin(angle + Math.PI / 6)
  );
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawBlurRegion(
  ctx: CanvasRenderingContext2D,
  sourceImg: HTMLImageElement,
  ann: BlurAnnotation
) {
  const rx = Math.max(0, Math.round(ann.x));
  const ry = Math.max(0, Math.round(ann.y));
  const rw = Math.min(sourceImg.naturalWidth - rx, Math.round(ann.width));
  const rh = Math.min(sourceImg.naturalHeight - ry, Math.round(ann.height));
  if (rw < 2 || rh < 2) return;

  const factor = Math.max(6, ann.intensity || 14);
  const tinyW = Math.max(2, Math.round(rw / factor));
  const tinyH = Math.max(2, Math.round(rh / factor));

  const tiny = document.createElement("canvas");
  tiny.width = tinyW;
  tiny.height = tinyH;
  const tctx = tiny.getContext("2d");
  if (!tctx) return;

  tctx.imageSmoothingEnabled = true;
  tctx.drawImage(sourceImg, rx, ry, rw, rh, 0, 0, tinyW, tinyH);

  ctx.save();
  const touchesEdge =
    rx <= 1 ||
    ry <= 1 ||
    rx + rw >= sourceImg.naturalWidth - 1 ||
    ry + rh >= sourceImg.naturalHeight - 1;
  drawRoundedRectPath(ctx, rx, ry, rw, rh, touchesEdge ? 0 : 6);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tiny, 0, 0, tinyW, tinyH, rx, ry, rw, rh);
  ctx.fillStyle = "rgba(15, 23, 42, 0.08)";
  ctx.fillRect(rx, ry, rw, rh);
  ctx.restore();
}

function drawTextAnnotation(ctx: CanvasRenderingContext2D, ann: TextAnnotation) {
  const lines = (ann.text || " ").split("\n");
  const lineHeight = ann.fontSize * 1.25;
  ctx.save();
  ctx.font = `${ann.bold ? "700" : "500"} ${ann.fontSize}px "Inter", "Segoe UI", sans-serif`;
  ctx.textBaseline = "top";

  let maxW = 0;
  for (const line of lines) {
    maxW = Math.max(maxW, ctx.measureText(line).width);
  }
  const totalH = lines.length * lineHeight;
  const padX = Math.max(10, ann.fontSize * 0.42);
  const padY = Math.max(6, ann.fontSize * 0.25);

  if (ann.hasPill) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 12;
    ctx.fillStyle = "rgba(9, 13, 22, 0.84)";
    drawRoundedRectPath(
      ctx,
      ann.x - padX,
      ann.y - padY,
      maxW + padX * 2,
      totalH + padY * 2,
      10
    );
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  ctx.shadowColor = "rgba(0,0,0,0.65)";
  ctx.shadowBlur = ann.hasPill ? 2 : 6;
  ctx.fillStyle = ann.color;

  lines.forEach((line, idx) => {
    ctx.fillText(line, ann.x, ann.y + idx * lineHeight);
  });

  ctx.restore();
}

export function drawAnnotationsOnCanvas(
  ctx: CanvasRenderingContext2D,
  sourceImg: HTMLImageElement,
  annotations: Annotation[]
) {
  for (const ann of annotations) {
    if (ann.kind === "blur") {
      drawBlurRegion(ctx, sourceImg, ann);
    } else if (ann.kind === "rect") {
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.45)";
      ctx.shadowBlur = 6;
      ctx.strokeStyle = ann.color;
      ctx.lineWidth = ann.strokeWidth;
      drawRoundedRectPath(ctx, ann.x, ann.y, ann.width, ann.height, 4);
      ctx.stroke();
      ctx.restore();
    } else if (ann.kind === "arrow") {
      drawArrow(
        ctx,
        ann.x1,
        ann.y1,
        ann.x2,
        ann.y2,
        ann.color,
        ann.strokeWidth
      );
    } else if (ann.kind === "text") {
      drawTextAnnotation(ctx, ann);
    }
  }
}

export async function renderCompositeDataUrl(
  baseImageUrl: string,
  annotations: Annotation[],
  cropRect?: CropRect | null
): Promise<string> {
  const img = await loadImage(baseImageUrl);
  const sx = cropRect ? Math.max(0, Math.round(cropRect.x)) : 0;
  const sy = cropRect ? Math.max(0, Math.round(cropRect.y)) : 0;
  const sw = cropRect
    ? Math.max(1, Math.min(img.naturalWidth - sx, Math.round(cropRect.width)))
    : img.naturalWidth;
  const sh = cropRect
    ? Math.max(1, Math.min(img.naturalHeight - sy, Math.round(cropRect.height)))
    : img.naturalHeight;

  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No se pudo crear contexto 2D para exportar");

  ctx.save();
  ctx.translate(-sx, -sy);
  ctx.drawImage(img, 0, 0);
  drawAnnotationsOnCanvas(ctx, img, annotations);
  ctx.restore();

  return canvas.toDataURL("image/png");
}

export async function renderBaseWithBlursDataUrl(
  baseImageUrl: string,
  annotations: Annotation[]
): Promise<string> {
  const blurs = annotations.filter((a) => a.kind === "blur");
  return renderCompositeDataUrl(baseImageUrl, blurs);
}

export async function renderVectorsOntoUpscaledDataUrl(
  upscaledImageUrl: string,
  annotations: Annotation[],
  scale: number
): Promise<string> {
  const img = await loadImage(upscaledImageUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No se pudo crear contexto 2D para vectores");

  ctx.drawImage(img, 0, 0);
  const vectors = annotations.filter((a) => a.kind !== "blur");
  if (vectors.length > 0) {
    ctx.save();
    ctx.scale(scale, scale);
    drawAnnotationsOnCanvas(ctx, img, vectors);
    ctx.restore();
  }

  return canvas.toDataURL("image/png");
}

function getAnnotationBounds(
  ann: Annotation,
  measureCtx: CanvasRenderingContext2D | null
): { x: number; y: number; w: number; h: number } {
  if (ann.kind === "rect" || ann.kind === "blur") {
    return { x: ann.x, y: ann.y, w: ann.width, h: ann.height };
  }
  if (ann.kind === "arrow") {
    const minX = Math.min(ann.x1, ann.x2) - 10;
    const minY = Math.min(ann.y1, ann.y2) - 10;
    const maxX = Math.max(ann.x1, ann.x2) + 10;
    const maxY = Math.max(ann.y1, ann.y2) + 10;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  const lines = (ann.text || " ").split("\n");
  const lineH = ann.fontSize * 1.25;
  let maxW = 80;
  if (measureCtx) {
    measureCtx.font = `${ann.bold ? "700" : "500"} ${ann.fontSize}px "Inter", "Segoe UI", sans-serif`;
    maxW = lines.reduce(
      (acc, l) => Math.max(acc, measureCtx.measureText(l).width),
      20
    );
  }
  return {
    x: ann.x - 10,
    y: ann.y - 6,
    w: maxW + 20,
    h: lines.length * lineH + 12,
  };
}

export default function EditorCanvas({
  imageDataUrl,
  imageWidth,
  imageHeight,
  tool,
  annotations,
  selectedId,
  activeColor,
  strokeWidth,
  fontSize,
  textBold,
  textHasPill,
  zoom,
  fitNonce = 0,
  cropRect,
  aspectPreset,
  previewResult,
  frameOptions,
  onSelectId,
  onAddAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  onChangeCropRect,
  onChangeZoom,
  onCheckpointHistory,
}: EditorCanvasProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const loadedImgRef = useRef<HTMLImageElement | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);

  const [vpSize, setVpSize] = useState({ w: 800, h: 600 });
  const [cam, setCam] = useState<CameraState>({ scale: 1, x: 24, y: 24 });
  const curCamRef = useRef<CameraState>({ scale: 1, x: 24, y: 24 });
  const targetCamRef = useRef<CameraState>({ scale: 1, x: 24, y: 24 });
  const rafRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);
  const lastReportedZoomRef = useRef<number | "fit">(zoom);
  const prevImgKeyRef = useRef<string>("");

  const [imgReadyTick, setImgReadyTick] = useState(0);
  const [draftAnn, setDraftAnn] = useState<Annotation | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [splitPct, setSplitPct] = useState<number>(50);
  const [draggingSplit, setDraggingSplit] = useState<boolean>(false);
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const [spacePressed, setSpacePressed] = useState<boolean>(false);

  const panDragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    origCamX: number;
    origCamY: number;
  } | null>(null);

  const interactionRef = useRef<{
    kind: "draw" | "move-ann" | "draw-crop" | "move-crop";
    startImgX: number;
    startImgY: number;
    targetId?: string;
    origAnn?: Annotation;
    origCrop?: CropRect;
    checkpointed?: boolean;
    pointerId?: number;
  } | null>(null);

  const showLiveFrame = Boolean(frameOptions?.enabled) && tool !== "crop";

  const computeFitCamera = useCallback(
    (w: number, h: number): CameraState => {
      const pad = showLiveFrame ? (frameOptions?.padding ?? 44) * 2 : 0;
      const availW = Math.max(80, w - 48);
      const availH = Math.max(80, h - 48);
      const fitScale = Math.min(
        1,
        availW / Math.max(1, imageWidth + pad),
        availH / Math.max(1, imageHeight + pad)
      );
      return {
        scale: fitScale,
        x: (w - imageWidth * fitScale) * 0.5,
        y: (h - imageHeight * fitScale) * 0.5,
      };
    },
    [imageWidth, imageHeight, showLiveFrame, frameOptions?.padding]
  );

  const clampCamera = useCallback(
    (scale: number, x: number, y: number, w: number, h: number): CameraState => {
      const imgW = imageWidth * scale;
      const imgH = imageHeight * scale;
      const keepX = Math.min(110, Math.max(36, imgW * 0.35));
      const keepY = Math.min(110, Math.max(36, imgH * 0.35));
      return {
        scale,
        x: Math.max(keepX - imgW, Math.min(w - keepX, x)),
        y: Math.max(keepY - imgH, Math.min(h - keepY, y)),
      };
    },
    [imageWidth, imageHeight]
  );

  const startCameraLoop = useCallback(() => {
    if (rafRef.current !== null) return;
    lastFrameTimeRef.current = performance.now();

    const step = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - lastFrameTimeRef.current) / 1000));
      lastFrameTimeRef.current = now;

      const cur = curCamRef.current;
      const tgt = targetCamRef.current;
      const alpha = 1 - Math.exp(-18 * dt);

      const nextScale = cur.scale + (tgt.scale - cur.scale) * alpha;
      const nextX = cur.x + (tgt.x - cur.x) * alpha;
      const nextY = cur.y + (tgt.y - cur.y) * alpha;

      if (
        Math.abs(tgt.scale - nextScale) < 0.0003 &&
        Math.abs(tgt.x - nextX) < 0.2 &&
        Math.abs(tgt.y - nextY) < 0.2
      ) {
        const snapped = { ...tgt };
        curCamRef.current = snapped;
        setCam(snapped);
        rafRef.current = null;
      } else {
        const updated = { scale: nextScale, x: nextX, y: nextY };
        curCamRef.current = updated;
        setCam(updated);
        rafRef.current = requestAnimationFrame(step);
      }
    };

    rafRef.current = requestAnimationFrame(step);
  }, []);

  const animateCameraTo = useCallback(
    (next: CameraState, immediate = false) => {
      const clamped = clampCamera(next.scale, next.x, next.y, vpSize.w, vpSize.h);
      targetCamRef.current = clamped;
      if (immediate) {
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        curCamRef.current = clamped;
        setCam(clamped);
      } else {
        startCameraLoop();
      }
    },
    [clampCamera, vpSize.w, vpSize.h, startCameraLoop]
  );

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Observe viewport size changes
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.max(120, entry.contentRect.width);
        const h = Math.max(120, entry.contentRect.height);
        setVpSize({ w, h });
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Track Spacebar for instant hand-pan from any tool
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT";
      if (isTyping || e.code !== "Space") return;
      e.preventDefault();
      setSpacePressed(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        setSpacePressed(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  useEffect(() => {
    let active = true;
    loadImage(imageDataUrl).then((img) => {
      if (!active) return;
      loadedImgRef.current = img;
      setImgReadyTick((t) => t + 1);
    });
    return () => {
      active = false;
    };
  }, [imageDataUrl]);

  // Snap to fit on brand new capture / crop, and glide on fit/zoom changes
  useEffect(() => {
    if (vpSize.w <= 0 || vpSize.h <= 0 || imageWidth <= 0 || imageHeight <= 0) {
      return;
    }

    const imgKey = `${imageDataUrl.slice(0, 48)}-${imageWidth}x${imageHeight}`;
    const isNewImg = prevImgKeyRef.current !== imgKey;
    prevImgKeyRef.current = imgKey;

    if (isNewImg) {
      const fitCam = computeFitCamera(vpSize.w, vpSize.h);
      lastReportedZoomRef.current = "fit";
      animateCameraTo(fitCam, true);
      return;
    }

    if (zoom === "fit") {
      const fitCam = computeFitCamera(vpSize.w, vpSize.h);
      lastReportedZoomRef.current = "fit";
      animateCameraTo(fitCam, false);
      return;
    }

    if (zoom !== lastReportedZoomRef.current) {
      lastReportedZoomRef.current = zoom;
      const old = targetCamRef.current;
      const cx = vpSize.w * 0.5;
      const cy = vpSize.h * 0.5;
      const ix = (cx - old.x) / Math.max(0.01, old.scale);
      const iy = (cy - old.y) / Math.max(0.01, old.scale);
      animateCameraTo(
        {
          scale: zoom,
          x: cx - ix * zoom,
          y: cy - iy * zoom,
        },
        false
      );
    }
  }, [
    imageDataUrl,
    imageWidth,
    imageHeight,
    vpSize.w,
    vpSize.h,
    zoom,
    fitNonce,
    computeFitCamera,
    animateCameraTo,
  ]);

  // Smooth cursor-centered wheel zoom (0.10..10.0) in both Edit and Preview modes
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();

      const old = targetCamRef.current;
      const clampedDelta = Math.max(-180, Math.min(180, e.deltaY));
      const factor = Math.pow(1.0016, -clampedDelta);
      const nextScale = Math.max(
        0.1,
        Math.min(10.0, Number((old.scale * factor).toFixed(3)))
      );
      if (Math.abs(nextScale - old.scale) < 0.0005) return;

      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const ix = (mx - old.x) / Math.max(0.01, old.scale);
      const iy = (my - old.y) / Math.max(0.01, old.scale);

      lastReportedZoomRef.current = nextScale;
      onChangeZoom(nextScale);
      animateCameraTo(
        {
          scale: nextScale,
          x: mx - ix * nextScale,
          y: my - iy * nextScale,
        },
        false
      );
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [animateCameraTo, onChangeZoom]);

  const commitEditingText = useCallback(
    (id: string | null) => {
      if (!id) return;
      const ann = annotations.find(
        (a): a is TextAnnotation => a.id === id && a.kind === "text"
      );
      if (ann && ann.text.trim() === "") {
        onDeleteAnnotation(id);
      }
      setEditingTextId(null);
    },
    [annotations, onDeleteAnnotation]
  );

  useEffect(() => {
    if (!editingTextId) return;
    const raf = requestAnimationFrame(() => {
      const el = textAreaRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [editingTextId]);

  useEffect(() => {
    setEditingTextId(null);
  }, [imageDataUrl]);

  // Redraw composite live canvas only when pixels or annotations change (never during zoom/pan!)
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = loadedImgRef.current;
    if (!canvas || !img) return;
    canvas.width = imageWidth;
    canvas.height = imageHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, imageWidth, imageHeight);
    ctx.drawImage(img, 0, 0);
    const visibleAnns = editingTextId
      ? annotations.filter((a) => a.id !== editingTextId)
      : annotations;
    const list = draftAnn ? [...visibleAnns, draftAnn] : visibleAnns;
    drawAnnotationsOnCanvas(ctx, img, list);
  }, [
    imageDataUrl,
    imageWidth,
    imageHeight,
    annotations,
    draftAnn,
    editingTextId,
    imgReadyTick,
    previewResult,
  ]);

  const clientToImg = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      const x = ((clientX - rect.left) / Math.max(1, rect.width)) * imageWidth;
      const y = ((clientY - rect.top) / Math.max(1, rect.height)) * imageHeight;
      return {
        x: Math.max(0, Math.min(imageWidth, x)),
        y: Math.max(0, Math.min(imageHeight, y)),
      };
    },
    [imageWidth, imageHeight]
  );

  const applyAspectToDrag = useCallback(
    (x0: number, y0: number, x1: number, y1: number): CropRect => {
      let dx = x1 - x0;
      let dy = y1 - y0;
      const ratio =
        aspectPreset === "16:9"
          ? 16 / 9
          : aspectPreset === "4:3"
            ? 4 / 3
            : aspectPreset === "1:1"
              ? 1
              : null;

      if (ratio) {
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        if (absDx / ratio >= absDy) {
          dy = (Math.sign(dy) || 1) * (absDx / ratio);
        } else {
          dx = (Math.sign(dx) || 1) * (absDy * ratio);
        }
      }

      const x = Math.max(0, Math.min(x0, x0 + dx));
      const y = Math.max(0, Math.min(y0, y0 + dy));
      const w = Math.min(imageWidth - x, Math.abs(dx));
      const h = Math.min(imageHeight - y, Math.abs(dy));
      return { x, y, width: w, height: h };
    },
    [aspectPreset, imageWidth, imageHeight]
  );

  const beginViewportPan = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const vp = viewportRef.current;
      if (!vp) return;
      const cur = curCamRef.current;
      panDragRef.current = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        origCamX: cur.x,
        origCamY: cur.y,
      };
      setIsPanning(true);
      try {
        vp.setPointerCapture(e.pointerId);
      } catch {
        // Ignore if pointer capture unavailable
      }
    },
    []
  );

  const handleViewportPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("[data-zoom-hud]")) return;
    if ((e.target as HTMLElement).closest("[data-split-handle]")) return;
    if ((e.target as HTMLElement).closest("[data-inline-editor]")) return;

    // Middle-click or Spacebar always pans from any mode/tool
    if (e.button === 1 || (e.button === 0 && spacePressed)) {
      e.preventDefault();
      beginViewportPan(e);
      return;
    }

    if (e.button !== 0) return;

    // Preview mode: dragging anywhere pans the viewport smoothly
    if (previewResult) {
      beginViewportPan(e);
      return;
    }

    if (editingTextId) {
      commitEditingText(editingTextId);
      if (tool === "text") {
        e.preventDefault();
        return;
      }
    }

    const clickedInsideCanvas = Boolean(
      (e.target as HTMLElement).closest("[data-canvas-stage]")
    );
    const allowOutsidePan = tool === "select" || tool === "text";
    if (!clickedInsideCanvas && allowOutsidePan) {
      if (tool === "select") {
        onSelectId(null);
      }
      beginViewportPan(e);
      return;
    }

    const pt = clientToImg(e.clientX, e.clientY);

    const captureInteractionPointer = () => {
      try {
        viewportRef.current?.setPointerCapture(e.pointerId);
      } catch {
        // Ignore if pointer capture unavailable
      }
    };

    if (tool === "crop") {
      if (
        clickedInsideCanvas &&
        cropRect &&
        pt.x >= cropRect.x &&
        pt.x <= cropRect.x + cropRect.width &&
        pt.y >= cropRect.y &&
        pt.y <= cropRect.y + cropRect.height
      ) {
        interactionRef.current = {
          kind: "move-crop",
          startImgX: pt.x,
          startImgY: pt.y,
          origCrop: { ...cropRect },
          pointerId: e.pointerId,
        };
      } else {
        interactionRef.current = {
          kind: "draw-crop",
          startImgX: pt.x,
          startImgY: pt.y,
          pointerId: e.pointerId,
        };
        onChangeCropRect({ x: pt.x, y: pt.y, width: 0, height: 0 });
      }
      captureInteractionPointer();
      return;
    }

    if (tool === "text") {
      e.preventDefault();
      e.stopPropagation();
      const id = `txt-${Date.now()}`;
      const newText: TextAnnotation = {
        id,
        kind: "text",
        x: pt.x,
        y: pt.y,
        text: "Texto",
        fontSize,
        color: activeColor,
        bold: textBold,
        hasPill: textHasPill,
      };
      onAddAnnotation(newText);
      onSelectId(id);
      setEditingTextId(id);
      return;
    }

    if (tool === "select") {
      const ctx = canvasRef.current?.getContext("2d") ?? null;
      const hit = [...annotations].reverse().find((ann) => {
        const b = getAnnotationBounds(ann, ctx);
        return (
          pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h
        );
      });

      if (hit) {
        onSelectId(hit.id);
        interactionRef.current = {
          kind: "move-ann",
          startImgX: pt.x,
          startImgY: pt.y,
          targetId: hit.id,
          origAnn: { ...hit },
          pointerId: e.pointerId,
        };
        captureInteractionPointer();
      } else {
        // Clicking empty image area in Select tool lets the user effortlessly drag-pan!
        onSelectId(null);
        setEditingTextId(null);
        beginViewportPan(e);
      }
      return;
    }

    const id = `${tool}-${Date.now()}`;
    if (tool === "rect") {
      setDraftAnn({
        id,
        kind: "rect",
        x: pt.x,
        y: pt.y,
        width: 0,
        height: 0,
        color: activeColor,
        strokeWidth,
      });
    } else if (tool === "blur") {
      setDraftAnn({
        id,
        kind: "blur",
        x: pt.x,
        y: pt.y,
        width: 0,
        height: 0,
        intensity: 14,
      });
    } else if (tool === "arrow") {
      setDraftAnn({
        id,
        kind: "arrow",
        x1: pt.x,
        y1: pt.y,
        x2: pt.x,
        y2: pt.y,
        color: activeColor,
        strokeWidth,
      });
    }

    interactionRef.current = {
      kind: "draw",
      startImgX: pt.x,
      startImgY: pt.y,
      targetId: id,
      pointerId: e.pointerId,
    };
    captureInteractionPointer();
  };

  const handleViewportPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingSplit) {
      const canvas = canvasRef.current;
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const pct = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 100;
        setSplitPct(Math.max(2, Math.min(98, pct)));
      }
      return;
    }

    if (panDragRef.current) {
      const p = panDragRef.current;
      const dx = e.clientX - p.startClientX;
      const dy = e.clientY - p.startClientY;
      animateCameraTo(
        {
          scale: targetCamRef.current.scale,
          x: p.origCamX + dx,
          y: p.origCamY + dy,
        },
        true
      );
      return;
    }

    const inter = interactionRef.current;
    if (!inter) return;
    const pt = clientToImg(e.clientX, e.clientY);

    if (inter.kind === "draw-crop") {
      onChangeCropRect(
        applyAspectToDrag(inter.startImgX, inter.startImgY, pt.x, pt.y)
      );
      return;
    }

    if (inter.kind === "move-crop" && inter.origCrop) {
      const dx = pt.x - inter.startImgX;
      const dy = pt.y - inter.startImgY;
      const nx = Math.max(
        0,
        Math.min(imageWidth - inter.origCrop.width, inter.origCrop.x + dx)
      );
      const ny = Math.max(
        0,
        Math.min(imageHeight - inter.origCrop.height, inter.origCrop.y + dy)
      );
      onChangeCropRect({ ...inter.origCrop, x: nx, y: ny });
      return;
    }

    if (inter.kind === "move-ann" && inter.targetId && inter.origAnn) {
      const dx = pt.x - inter.startImgX;
      const dy = pt.y - inter.startImgY;
      if (!inter.checkpointed && Math.hypot(dx, dy) > 1.5) {
        onCheckpointHistory?.();
        inter.checkpointed = true;
      }
      const orig = inter.origAnn;
      if (orig.kind === "arrow") {
        onUpdateAnnotation(
          inter.targetId,
          {
            x1: orig.x1 + dx,
            y1: orig.y1 + dy,
            x2: orig.x2 + dx,
            y2: orig.y2 + dy,
          },
          false
        );
      } else {
        onUpdateAnnotation(
          inter.targetId,
          { x: orig.x + dx, y: orig.y + dy },
          false
        );
      }
      return;
    }

    if (inter.kind === "draw" && draftAnn) {
      if (draftAnn.kind === "arrow") {
        setDraftAnn({ ...draftAnn, x2: pt.x, y2: pt.y });
      } else if (draftAnn.kind === "rect" || draftAnn.kind === "blur") {
        setDraftAnn({
          ...draftAnn,
          x: Math.min(inter.startImgX, pt.x),
          y: Math.min(inter.startImgY, pt.y),
          width: Math.abs(pt.x - inter.startImgX),
          height: Math.abs(pt.y - inter.startImgY),
        });
      }
    }
  };

  const handleViewportPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    setDraggingSplit(false);

    if (panDragRef.current) {
      try {
        viewportRef.current?.releasePointerCapture(panDragRef.current.pointerId);
      } catch {
        // Ignore
      }
      panDragRef.current = null;
      setIsPanning(false);
    }

    const inter = interactionRef.current;
    interactionRef.current = null;
    if (inter?.pointerId !== undefined) {
      try {
        viewportRef.current?.releasePointerCapture(inter.pointerId);
      } catch {
        // Ignore
      }
    }

    if (inter?.kind === "draw" && draftAnn) {
      const valid =
        draftAnn.kind === "arrow"
          ? Math.hypot(draftAnn.x2 - draftAnn.x1, draftAnn.y2 - draftAnn.y1) > 6
          : draftAnn.kind === "rect" || draftAnn.kind === "blur"
            ? draftAnn.width > 6 && draftAnn.height > 6
            : false;

      if (valid) {
        onAddAnnotation(draftAnn);
        onSelectId(draftAnn.id);
      }
      setDraftAnn(null);
    }

    if (e.button === 1) {
      e.preventDefault();
    }
  };

  const stepZoom = useCallback(
    (dir: 1 | -1) => {
      const curScale = targetCamRef.current.scale;
      const factor = dir === 1 ? 1.25 : 0.8;
      const next = Math.max(
        0.1,
        Math.min(10.0, Number((curScale * factor).toFixed(2)))
      );
      onChangeZoom(next);
    },
    [onChangeZoom]
  );

  const selectedAnn = annotations.find((a) => a.id === selectedId) ?? null;
  const selectedBounds = useMemo(() => {
    if (!selectedAnn) return null;
    const ctx = canvasRef.current?.getContext("2d") ?? null;
    return getAnnotationBounds(selectedAnn, ctx);
  }, [selectedAnn]);

  const editingTextAnn =
    annotations.find(
      (a): a is TextAnnotation => a.id === editingTextId && a.kind === "text"
    ) ?? null;

  const displayScale = cam.scale;
  const displayW = Math.max(1, Math.round(imageWidth * displayScale));
  const displayH = Math.max(1, Math.round(imageHeight * displayScale));

  const framePadPx = showLiveFrame
    ? Math.max(8, Math.round((frameOptions?.padding ?? 44) * displayScale))
    : 0;
  const frameRadiusPx = showLiveFrame
    ? Math.max(2, Math.round((frameOptions?.borderRadius ?? 18) * displayScale))
    : 12;
  const frameShadowCss = showLiveFrame
    ? frameOptions?.shadowStrength === "soft"
      ? `0 ${Math.round(8 * displayScale)}px ${Math.round(24 * displayScale)}px rgba(0, 0, 0, 0.45)`
      : frameOptions?.shadowStrength === "strong"
        ? `0 ${Math.round(18 * displayScale)}px ${Math.round(54 * displayScale)}px rgba(0, 0, 0, 0.86)`
        : `0 ${Math.round(12 * displayScale)}px ${Math.round(36 * displayScale)}px rgba(0, 0, 0, 0.68)`
    : undefined;

  const viewportCursor = isPanning
    ? "cursor-grabbing"
    : spacePressed || previewResult || tool === "select"
      ? "cursor-grab"
      : tool === "text"
        ? "cursor-text"
        : "cursor-crosshair";

  return (
    <div
      ref={viewportRef}
      onPointerDown={handleViewportPointerDown}
      onPointerMove={handleViewportPointerMove}
      onPointerUp={handleViewportPointerUp}
      onPointerCancel={handleViewportPointerUp}
      className={`relative flex-1 min-w-0 min-h-0 overflow-hidden checker-bg select-none ${viewportCursor}`}
    >
      {/* Smooth GPU-Translated Stage (cam.x, cam.y always anchor image top-left) */}
      <div
        className="absolute left-0 top-0 will-change-transform"
        style={{
          transform: `translate3d(${cam.x - framePadPx}px, ${cam.y - framePadPx}px, 0)`,
          padding: framePadPx,
        }}
      >
        {previewResult ? (
          /* Interactive Before / After Real-ESRGAN Comparison Viewer */
          <div
            data-canvas-stage
            className={`relative overflow-hidden select-none ${
              showLiveFrame
                ? ""
                : "rounded-xl shadow-[0_24px_64px_rgba(0,0,0,0.85)] border border-cyan-400/35"
            }`}
            style={{
              width: displayW,
              height: displayH,
              ...(showLiveFrame
                ? {
                    borderRadius: frameRadiusPx,
                    boxShadow: frameShadowCss,
                    border: frameOptions?.subtleBorder
                      ? "1.5px solid rgba(255,255,255,0.22)"
                      : "none",
                  }
                : {}),
            }}
          >
            {/* After (Real-ESRGAN) Base Layer */}
            <img
              src={previewResult.imageDataUrl}
              alt="Upscaled preview"
              draggable={false}
              className="w-full h-full object-fill pointer-events-none"
            />

            {/* Before (Original Canvas) Clipped Left Layer */}
            <div
              className="absolute inset-0 pointer-events-none overflow-hidden"
              style={{ clipPath: `inset(0 ${100 - splitPct}% 0 0)` }}
            >
              <canvas
                ref={canvasRef}
                style={{
                  width: displayW,
                  height: displayH,
                  imageRendering: displayScale >= 2 ? "pixelated" : "auto",
                }}
                className="block"
              />
            </div>

            {/* Comparison Split Line & Handle */}
            <div
              data-split-handle
              className="absolute top-0 bottom-0 w-0.5 bg-cyan-300 shadow-[0_0_16px_rgba(34,211,238,0.9)] cursor-ew-resize z-10"
              style={{ left: `${splitPct}%` }}
              onPointerDown={(e) => {
                e.stopPropagation();
                setDraggingSplit(true);
              }}
            >
              <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-8 h-8 rounded-full bg-[#090D16] border-2 border-cyan-300 flex items-center justify-center text-[10px] font-bold text-cyan-200 shadow-xl">
                ↔
              </div>
            </div>

            <div className="absolute top-3 left-3 px-2.5 py-1 rounded-lg bg-[#090D16]/88 border border-white/15 text-[11px] font-medium text-slate-200 backdrop-blur-md pointer-events-none">
              Original · {imageWidth} × {imageHeight}
            </div>
            <div className="absolute top-3 right-3 px-2.5 py-1 rounded-lg bg-[#090D16]/88 border border-cyan-400/45 text-[11px] font-semibold text-cyan-200 backdrop-blur-md pointer-events-none">
              {previewResult.engine} · {previewResult.width} ×{" "}
              {previewResult.height} ({previewResult.elapsedMs} ms)
            </div>
          </div>
        ) : (
          /* Active Editing Canvas Stage */
          <div
            data-canvas-stage
            onDoubleClick={(e) => {
              const pt = clientToImg(e.clientX, e.clientY);
              const ctx = canvasRef.current?.getContext("2d") ?? null;
              const hitText = [...annotations].reverse().find((ann) => {
                if (ann.kind !== "text") return false;
                const b = getAnnotationBounds(ann, ctx);
                return (
                  pt.x >= b.x &&
                  pt.x <= b.x + b.w &&
                  pt.y >= b.y &&
                  pt.y <= b.y + b.h
                );
              });
              if (hitText) {
                onSelectId(hitText.id);
                setEditingTextId(hitText.id);
              } else if (selectedAnn?.kind === "text") {
                setEditingTextId(selectedAnn.id);
              }
            }}
            className={`relative overflow-hidden ${
              showLiveFrame
                ? ""
                : "rounded-xl shadow-[0_24px_64px_rgba(0,0,0,0.85)] border border-white/15"
            }`}
            style={{
              width: displayW,
              height: displayH,
              ...(showLiveFrame
                ? {
                    borderRadius: frameRadiusPx,
                    boxShadow: frameShadowCss,
                    border: frameOptions?.subtleBorder
                      ? "1.5px solid rgba(255,255,255,0.22)"
                      : "none",
                  }
                : {}),
            }}
          >
            <canvas
              ref={canvasRef}
              style={{ width: displayW, height: displayH }}
              className="block"
            />

            {/* Selected Annotation Bounding Box */}
            {selectedBounds && selectedAnn && !editingTextId && tool === "select" && (
              <div
                className="absolute border border-dashed border-cyan-400 rounded-md pointer-events-none"
                style={{
                  left: selectedBounds.x * displayScale,
                  top: selectedBounds.y * displayScale,
                  width: Math.max(20, selectedBounds.w * displayScale),
                  height: Math.max(20, selectedBounds.h * displayScale),
                }}
              >
                <button
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onDeleteAnnotation(selectedAnn.id);
                  }}
                  className="pointer-events-auto absolute -top-3 -right-3 w-6 h-6 rounded-full bg-rose-500 hover:bg-rose-400 text-white flex items-center justify-center shadow-lg cursor-pointer"
                  title="Eliminar anotación (Supr)"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            )}

            {/* Inline Text Editor */}
            {editingTextAnn && (
              <textarea
                ref={textAreaRef}
                data-inline-editor
                value={editingTextAnn.text}
                onPointerDown={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) =>
                  onUpdateAnnotation(
                    editingTextAnn.id,
                    { text: e.target.value },
                    false
                  )
                }
                onBlur={() => commitEditingText(editingTextAnn.id)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) {
                    e.preventDefault();
                    commitEditingText(editingTextAnn.id);
                  }
                }}
                style={{
                  left: editingTextAnn.x * displayScale,
                  top: editingTextAnn.y * displayScale,
                  fontSize: Math.max(12, editingTextAnn.fontSize * displayScale),
                  color: editingTextAnn.color,
                  fontWeight: editingTextAnn.bold ? 700 : 500,
                  userSelect: "text",
                  WebkitUserSelect: "text",
                }}
                className="absolute z-20 min-w-[160px] min-h-[38px] bg-[#090D16]/94 border-2 border-cyan-400 rounded-lg px-2.5 py-1.5 outline-none resize shadow-xl leading-tight select-text"
              />
            )}

            {/* Crop Overlay Grid */}
            {tool === "crop" && cropRect && cropRect.width > 4 && cropRect.height > 4 && (
              <>
                <div
                  className="absolute inset-x-0 top-0 bg-slate-950/65 pointer-events-none"
                  style={{ height: cropRect.y * displayScale }}
                />
                <div
                  className="absolute inset-x-0 bottom-0 bg-slate-950/65 pointer-events-none"
                  style={{ top: (cropRect.y + cropRect.height) * displayScale }}
                />
                <div
                  className="absolute left-0 bg-slate-950/65 pointer-events-none"
                  style={{
                    top: cropRect.y * displayScale,
                    height: cropRect.height * displayScale,
                    width: cropRect.x * displayScale,
                  }}
                />
                <div
                  className="absolute right-0 bg-slate-950/65 pointer-events-none"
                  style={{
                    top: cropRect.y * displayScale,
                    height: cropRect.height * displayScale,
                    left: (cropRect.x + cropRect.width) * displayScale,
                  }}
                />

                <div
                  className="absolute border-2 border-emerald-400 shadow-[0_0_22px_rgba(52,211,153,0.4)] pointer-events-none"
                  style={{
                    left: cropRect.x * displayScale,
                    top: cropRect.y * displayScale,
                    width: cropRect.width * displayScale,
                    height: cropRect.height * displayScale,
                  }}
                >
                  <div className="absolute inset-y-0 left-1/3 w-px bg-white/25" />
                  <div className="absolute inset-y-0 left-2/3 w-px bg-white/25" />
                  <div className="absolute inset-x-0 top-1/3 h-px bg-white/25" />
                  <div className="absolute inset-x-0 top-2/3 h-px bg-white/25" />
                  <div className="absolute left-2 top-2 px-2 py-0.5 rounded bg-[#090D16]/85 text-[10px] font-semibold text-emerald-300 border border-emerald-400/40">
                    {Math.round(cropRect.width)} × {Math.round(cropRect.height)} px
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Floating Zoom & Pan HUD */}
      <div
        data-zoom-hud
        className="pointer-events-none absolute bottom-4 right-4 z-30 flex items-center gap-2"
      >
        <div className="hidden sm:flex items-center px-2.5 py-1.5 rounded-xl bg-[#090D16]/88 border border-white/10 text-[11px] text-slate-300 backdrop-blur-xl shadow-lg">
          {previewResult
            ? "Rueda: zoom · Arrastra: mover"
            : "Rueda: zoom · Arrastra o Espacio: mover"}
        </div>
        <div className="pointer-events-auto flex items-center gap-1 px-1.5 py-1 rounded-xl bg-[#090D16]/92 border border-white/15 backdrop-blur-xl shadow-2xl">
          <button
            onClick={() => stepZoom(-1)}
            disabled={displayScale <= 0.1}
            className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-white/10 disabled:opacity-35 transition-colors cursor-pointer"
            title="Alejar"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onChangeZoom("fit")}
            className="px-2 py-1 rounded-lg text-[11px] font-semibold text-cyan-200 hover:bg-white/10 transition-colors cursor-pointer min-w-[48px] text-center"
            title="Restablecer y centrar"
          >
            {Math.round(displayScale * 100)}%
          </button>
          <button
            onClick={() => stepZoom(1)}
            disabled={displayScale >= 10}
            className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-white/10 disabled:opacity-35 transition-colors cursor-pointer"
            title="Acercar"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <div className="w-px h-4 bg-white/10 mx-0.5" />
          <button
            onClick={() => onChangeZoom(1)}
            className={`px-2 py-1 rounded-lg text-[11px] font-medium transition-colors cursor-pointer ${
              zoom === 1
                ? "bg-cyan-400/20 text-cyan-200"
                : "text-slate-300 hover:bg-white/10"
            }`}
            title="Tamaño real 100%"
          >
            100%
          </button>
          <button
            onClick={() => onChangeZoom("fit")}
            className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
              zoom === "fit"
                ? "bg-cyan-400/20 text-cyan-200"
                : "text-slate-300 hover:bg-white/10"
            }`}
            title="Ajustar y centrar en pantalla"
          >
            <Maximize className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
