import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Maximize, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import type {
  Annotation,
  AspectPreset,
  BlurAnnotation,
  BlurMode,
  CropRect,
  FrameOptions,
  TextAnnotation,
  TextBgStyle,
  TextStyleConfig,
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
  textStyle: TextStyleConfig;
  blurMode: BlurMode;
  blurIntensity: number;
  blurRadius: number;
  zoom: number | "fit";
  fitNonce?: number;
  cropRect: CropRect | null;
  activeCrop: CropRect | null;
  aspectPreset: AspectPreset;
  previewResult: UpscalePreviewResult | null;
  frameOptions?: FrameOptions;
  previewFontFamily?: string | null;
  editingPadding?: boolean;
  onSelectId: (id: string | null) => void;
  onAddAnnotation: (ann: Annotation) => void;
  onUpdateAnnotation: (
    id: string,
    patch: Partial<Annotation>,
    commitHistory?: boolean
  ) => void;
  onDeleteAnnotation: (id: string) => void;
  onChangeCropRect: (rect: CropRect | null) => void;
  onChangeFrameOptions?: (patch: Partial<FrameOptions>, commit?: boolean) => void;
  onChangeZoom: (next: number | "fit") => void;
  onCheckpointHistory?: () => void;
}

type HandleDir = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "start" | "end";

function hexToRgba(hex: string, alpha: number): string {
  const clean = (hex || "#000000").trim().replace(/^#/, "");
  if (clean.length === 6) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
      return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
    }
  }
  return `rgba(0, 0, 0, ${Math.max(0, Math.min(1, alpha))})`;
}

export function getFontStack(family?: string): string {
  const f = (family || "Inter").trim();
  if (!f || f === "Inter") return `"Inter", "Segoe UI", sans-serif`;
  const escaped = f.replace(/"/g, "");
  return `"${escaped}", "Segoe UI", sans-serif`;
}

export function resolveTextBgStyle(ann: TextAnnotation): TextBgStyle {
  if (ann.bgStyle) return ann.bgStyle;
  return ann.hasPill ? "glass" : "none";
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

  const mode: BlurMode = ann.mode ?? "gaussian";
  const intensity = Math.max(2, Math.min(48, ann.intensity || 14));
  const touchesEdge =
    rx <= 1 ||
    ry <= 1 ||
    rx + rw >= sourceImg.naturalWidth - 1 ||
    ry + rh >= sourceImg.naturalHeight - 1;
  const radius = touchesEdge ? 0 : Math.max(0, ann.borderRadius ?? 8);

  if (mode === "gaussian") {
    const blurPx = Math.max(2, Math.round(intensity * 0.9));
    const pad = Math.min(80, blurPx * 2);
    const sx = Math.max(0, rx - pad);
    const sy = Math.max(0, ry - pad);
    const sx2 = Math.min(sourceImg.naturalWidth, rx + rw + pad);
    const sy2 = Math.min(sourceImg.naturalHeight, ry + rh + pad);
    const sw = Math.max(1, sx2 - sx);
    const sh = Math.max(1, sy2 - sy);

    const off = document.createElement("canvas");
    off.width = sw;
    off.height = sh;
    const octx = off.getContext("2d");
    if (!octx) return;

    octx.filter = `blur(${blurPx}px)`;
    octx.drawImage(sourceImg, sx, sy, sw, sh, 0, 0, sw, sh);
    octx.filter = "none";

    ctx.save();
    drawRoundedRectPath(ctx, rx, ry, rw, rh, radius);
    ctx.clip();
    ctx.drawImage(off, rx - sx, ry - sy, rw, rh, rx, ry, rw, rh);
    ctx.restore();
    return;
  }

  // Pixelate mode (sharp mosaic blocks)
  const blockSize = Math.max(4, intensity);
  const tinyW = Math.max(1, Math.round(rw / blockSize));
  const tinyH = Math.max(1, Math.round(rh / blockSize));

  const tiny = document.createElement("canvas");
  tiny.width = tinyW;
  tiny.height = tinyH;
  const tctx = tiny.getContext("2d");
  if (!tctx) return;

  tctx.imageSmoothingEnabled = true;
  tctx.drawImage(sourceImg, rx, ry, rw, rh, 0, 0, tinyW, tinyH);

  ctx.save();
  drawRoundedRectPath(ctx, rx, ry, rw, rh, radius);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tiny, 0, 0, tinyW, tinyH, rx, ry, rw, rh);
  ctx.imageSmoothingEnabled = true;
  ctx.restore();
}

function drawTextAnnotation(ctx: CanvasRenderingContext2D, ann: TextAnnotation) {
  const lines = (ann.text || " ").split("\n");
  const lineHeight = ann.fontSize * 1.25;
  const fontStack = getFontStack(ann.fontFamily);
  const bgStyle = resolveTextBgStyle(ann);
  const bgColor = ann.bgColor || "#090D16";
  const bgColor2 = ann.bgColor2 || "#4F46E5";
  const bgOpacity = ann.bgOpacity ?? (bgStyle === "glass" ? 0.82 : bgStyle === "highlight" ? 0.48 : 0.96);
  const padX = ann.paddingX ?? Math.round(Math.max(10, ann.fontSize * 0.42));
  const padY = ann.paddingY ?? Math.round(Math.max(6, ann.fontSize * 0.25));
  const offX = ann.textOffsetX ?? 0;
  const offY = ann.textOffsetY ?? 0;
  const cornerR = ann.borderRadius ?? (bgStyle === "highlight" ? 6 : 12);
  const layerOpacity = Math.max(0.05, Math.min(1, ann.opacity ?? 1));
  const shadowEnabled = ann.shadowEnabled ?? true;
  const shadowBlur = ann.shadowBlur ?? (bgStyle === "none" ? 6 : 3);
  const shadowColor = ann.shadowColor || "#000000";
  const shadowOffsetY = ann.shadowOffsetY ?? 2;

  ctx.save();
  ctx.globalAlpha = layerOpacity;
  ctx.font = `${ann.italic ? "italic " : ""}${ann.bold ? "700" : "500"} ${ann.fontSize}px ${fontStack}`;
  ctx.textBaseline = "top";

  let maxW = 0;
  for (const line of lines) {
    maxW = Math.max(maxW, ctx.measureText(line).width);
  }
  const totalH = lines.length * lineHeight;

  if (bgStyle !== "none") {
    ctx.save();
    const boxX = ann.x - padX;
    const boxY = ann.y - padY;
    const boxW = maxW + padX * 2;
    const boxH = totalH + padY * 2;

    drawRoundedRectPath(ctx, boxX, boxY, boxW, boxH, cornerR);

    if (bgStyle === "glass") {
      ctx.shadowColor = "rgba(0,0,0,0.42)";
      ctx.shadowBlur = 12;
      ctx.fillStyle = hexToRgba(bgColor, bgOpacity);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else if (bgStyle === "solid") {
      ctx.shadowColor = "rgba(0,0,0,0.36)";
      ctx.shadowBlur = 10;
      ctx.fillStyle = hexToRgba(bgColor, bgOpacity);
      ctx.fill();
    } else if (bgStyle === "gradient") {
      ctx.shadowColor = "rgba(0,0,0,0.4)";
      ctx.shadowBlur = 14;
      const grad = ctx.createLinearGradient(boxX, boxY, boxX + boxW, boxY + boxH);
      grad.addColorStop(0, hexToRgba(bgColor, bgOpacity));
      grad.addColorStop(1, hexToRgba(bgColor2, bgOpacity));
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.lineWidth = 1;
      ctx.stroke();
    } else if (bgStyle === "outline") {
      ctx.fillStyle = hexToRgba(bgColor, bgOpacity * 0.3);
      ctx.fill();
      ctx.strokeStyle = ann.color;
      ctx.lineWidth = Math.max(2, ann.fontSize * 0.08);
      ctx.stroke();
    } else if (bgStyle === "highlight") {
      ctx.fillStyle = hexToRgba(bgColor, bgOpacity * 0.65);
      ctx.fill();
    }
    ctx.restore();
  }

  if (shadowEnabled && shadowBlur > 0) {
    ctx.shadowColor = hexToRgba(shadowColor, 0.72);
    ctx.shadowBlur = shadowBlur;
    ctx.shadowOffsetY = shadowOffsetY;
  } else {
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
  }
  ctx.fillStyle = ann.color;

  lines.forEach((line, idx) => {
    ctx.fillText(line, ann.x + offX, ann.y + offY + idx * lineHeight);
  });

  ctx.restore();
}

export function drawAnnotationsOnCanvas(
  ctx: CanvasRenderingContext2D,
  sourceImg: HTMLImageElement,
  annotations: Annotation[]
) {
  for (const ann of annotations) {
    if (ann.visible === false) continue;
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
  annotations: Annotation[],
  cropRect?: CropRect | null
): Promise<string> {
  const blurs = annotations.filter((a) => a.kind === "blur");
  return renderCompositeDataUrl(baseImageUrl, blurs, cropRect);
}

export async function renderVectorsOntoUpscaledDataUrl(
  upscaledImageUrl: string,
  annotations: Annotation[],
  scale: number,
  cropRect?: CropRect | null
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
    const ox = cropRect ? Math.max(0, Math.round(cropRect.x)) : 0;
    const oy = cropRect ? Math.max(0, Math.round(cropRect.y)) : 0;
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(-ox, -oy);
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
    measureCtx.font = `${ann.italic ? "italic " : ""}${ann.bold ? "700" : "500"} ${ann.fontSize}px ${getFontStack(ann.fontFamily)}`;
    maxW = lines.reduce(
      (acc, l) => Math.max(acc, measureCtx.measureText(l).width),
      20
    );
  }
  const padX = ann.paddingX ?? Math.round(Math.max(10, ann.fontSize * 0.42));
  const padY = ann.paddingY ?? Math.round(Math.max(6, ann.fontSize * 0.25));
  return {
    x: ann.x - padX,
    y: ann.y - padY,
    w: maxW + padX * 2,
    h: lines.length * lineH + padY * 2,
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
  textStyle,
  blurMode,
  blurIntensity,
  blurRadius,
  zoom,
  fitNonce = 0,
  cropRect,
  activeCrop,
  aspectPreset,
  previewResult,
  frameOptions,
  previewFontFamily = null,
  editingPadding = false,
  onSelectId,
  onAddAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  onChangeCropRect,
  onChangeFrameOptions,
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
    kind:
      | "draw"
      | "move-ann"
      | "resize-ann"
      | "draw-crop"
      | "move-crop"
      | "resize-crop"
      | "resize-pad";
    startImgX: number;
    startImgY: number;
    startClientX?: number;
    startClientY?: number;
    targetId?: string;
    origAnn?: Annotation;
    origBounds?: { x: number; y: number; w: number; h: number };
    origCrop?: CropRect;
    origPads?: { top: number; right: number; bottom: number; left: number };
    handle?: HandleDir;
    checkpointed?: boolean;
    pointerId?: number;
  } | null>(null);

  const showLiveFrame = Boolean(frameOptions?.enabled) && tool !== "crop";
  const viewCrop = tool === "crop" ? null : activeCrop;
  const viewOffsetX = viewCrop ? Math.max(0, Math.round(viewCrop.x)) : 0;
  const viewOffsetY = viewCrop ? Math.max(0, Math.round(viewCrop.y)) : 0;
  const viewWidth = viewCrop
    ? Math.max(1, Math.min(imageWidth - viewOffsetX, Math.round(viewCrop.width)))
    : imageWidth;
  const viewHeight = viewCrop
    ? Math.max(1, Math.min(imageHeight - viewOffsetY, Math.round(viewCrop.height)))
    : imageHeight;

  const padTopVal = frameOptions?.customPadding
    ? (frameOptions.paddingTop ?? frameOptions.padding ?? 44)
    : (frameOptions?.padding ?? 44);
  const padRightVal = frameOptions?.customPadding
    ? (frameOptions.paddingRight ?? frameOptions.padding ?? 44)
    : (frameOptions?.padding ?? 44);
  const padBottomVal = frameOptions?.customPadding
    ? (frameOptions.paddingBottom ?? frameOptions.padding ?? 44)
    : (frameOptions?.padding ?? 44);
  const padLeftVal = frameOptions?.customPadding
    ? (frameOptions.paddingLeft ?? frameOptions.padding ?? 44)
    : (frameOptions?.padding ?? 44);

  const computeFitCamera = useCallback(
    (w: number, h: number): CameraState => {
      const padX = showLiveFrame ? padLeftVal + padRightVal : 0;
      const padY = showLiveFrame ? padTopVal + padBottomVal : 0;
      const availW = Math.max(80, w - 48);
      const availH = Math.max(80, h - 48);
      const fitScale = Math.min(
        1,
        availW / Math.max(1, viewWidth + padX),
        availH / Math.max(1, viewHeight + padY)
      );
      const totalW = (viewWidth + padX) * fitScale;
      const totalH = (viewHeight + padY) * fitScale;
      return {
        scale: fitScale,
        x: (w - totalW) * 0.5 + (showLiveFrame ? padLeftVal * fitScale : 0),
        y: (h - totalH) * 0.5 + (showLiveFrame ? padTopVal * fitScale : 0),
      };
    },
    [viewWidth, viewHeight, showLiveFrame, padLeftVal, padRightVal, padTopVal, padBottomVal]
  );

  const clampCamera = useCallback(
    (scale: number, x: number, y: number, w: number, h: number): CameraState => {
      const imgW = viewWidth * scale;
      const imgH = viewHeight * scale;
      const keepX = Math.min(110, Math.max(36, imgW * 0.35));
      const keepY = Math.min(110, Math.max(36, imgH * 0.35));
      return {
        scale,
        x: Math.max(keepX - imgW, Math.min(w - keepX, x)),
        y: Math.max(keepY - imgH, Math.min(h - keepY, y)),
      };
    },
    [viewWidth, viewHeight]
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

  // Redraw composite live canvas only when pixels, crop or annotations change (never during zoom/pan!)
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = loadedImgRef.current;
    if (!canvas || !img) return;
    canvas.width = viewWidth;
    canvas.height = viewHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, viewWidth, viewHeight);
    ctx.save();
    ctx.translate(-viewOffsetX, -viewOffsetY);
    ctx.drawImage(img, 0, 0);
    // In interactive edit mode, text/rect/arrow render as crisp animated vector overlays above canvas;
    // canvas only renders base image + blurs (in comparison preview mode, render all layers on left side).
    const allList = draftAnn ? [...annotations, draftAnn] : annotations;
    const canvasList = previewResult
      ? allList
      : allList.filter((a) => a.kind === "blur");
    drawAnnotationsOnCanvas(ctx, img, canvasList);
    ctx.restore();
  }, [
    imageDataUrl,
    viewWidth,
    viewHeight,
    viewOffsetX,
    viewOffsetY,
    annotations,
    draftAnn,
    editingTextId,
    imgReadyTick,
    previewResult,
  ]);

  const clientToImg = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: viewOffsetX, y: viewOffsetY };
      const rect = canvas.getBoundingClientRect();
      const localX = ((clientX - rect.left) / Math.max(1, rect.width)) * viewWidth;
      const localY = ((clientY - rect.top) / Math.max(1, rect.height)) * viewHeight;
      return {
        x: Math.max(0, Math.min(imageWidth, viewOffsetX + localX)),
        y: Math.max(0, Math.min(imageHeight, viewOffsetY + localY)),
      };
    },
    [imageWidth, imageHeight, viewOffsetX, viewOffsetY, viewWidth, viewHeight]
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

  const startCropHandleDrag = useCallback(
    (handle: HandleDir, e: React.PointerEvent) => {
      if (!cropRect) return;
      e.preventDefault();
      e.stopPropagation();
      const pt = clientToImg(e.clientX, e.clientY);
      interactionRef.current = {
        kind: "resize-crop",
        startImgX: pt.x,
        startImgY: pt.y,
        origCrop: { ...cropRect },
        handle,
        pointerId: e.pointerId,
      };
      try {
        viewportRef.current?.setPointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
    },
    [cropRect, clientToImg]
  );

  const startAnnHandleDrag = useCallback(
    (ann: Annotation, handle: HandleDir, e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const pt = clientToImg(e.clientX, e.clientY);
      const ctx = canvasRef.current?.getContext("2d") ?? null;
      const origBounds = getAnnotationBounds(ann, ctx);
      interactionRef.current = {
        kind: "resize-ann",
        startImgX: pt.x,
        startImgY: pt.y,
        targetId: ann.id,
        origAnn: { ...ann },
        origBounds,
        handle,
        pointerId: e.pointerId,
      };
      try {
        viewportRef.current?.setPointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
    },
    [clientToImg]
  );

  const startPaddingHandleDrag = useCallback(
    (handle: HandleDir, e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      interactionRef.current = {
        kind: "resize-pad",
        startImgX: 0,
        startImgY: 0,
        startClientX: e.clientX,
        startClientY: e.clientY,
        origPads: {
          top: padTopVal,
          right: padRightVal,
          bottom: padBottomVal,
          left: padLeftVal,
        },
        handle,
        pointerId: e.pointerId,
      };
      try {
        viewportRef.current?.setPointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
    },
    [padTopVal, padRightVal, padBottomVal, padLeftVal]
  );

  const handleViewportPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("[data-zoom-hud]")) return;
    if ((e.target as HTMLElement).closest("[data-split-handle]")) return;
    if ((e.target as HTMLElement).closest("[data-inline-editor]")) return;
    if ((e.target as HTMLElement).closest("[data-resize-handle]")) return;

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
        visible: true,
        x: pt.x,
        y: pt.y,
        text: "Texto",
        fontSize: textStyle.fontSize,
        fontFamily: textStyle.fontFamily,
        color: textStyle.color,
        bold: textStyle.bold,
        italic: textStyle.italic,
        hasPill: textStyle.bgStyle !== "none",
        bgStyle: textStyle.bgStyle,
        bgColor: textStyle.bgColor,
        bgColor2: textStyle.bgColor2,
        bgOpacity: textStyle.bgOpacity,
        paddingX: textStyle.paddingX,
        paddingY: textStyle.paddingY,
        textOffsetX: textStyle.textOffsetX,
        textOffsetY: textStyle.textOffsetY,
        borderRadius: textStyle.borderRadius,
        opacity: textStyle.opacity,
        shadowEnabled: textStyle.shadowEnabled,
        shadowBlur: textStyle.shadowBlur,
        shadowColor: textStyle.shadowColor,
        shadowOffsetY: textStyle.shadowOffsetY,
      };
      onAddAnnotation(newText);
      onSelectId(id);
      setEditingTextId(id);
      return;
    }

    if (tool === "select") {
      const ctx = canvasRef.current?.getContext("2d") ?? null;
      const hit = [...annotations].reverse().find((ann) => {
        if (ann.visible === false) return false;
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
        visible: true,
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
        visible: true,
        x: pt.x,
        y: pt.y,
        width: 0,
        height: 0,
        mode: blurMode,
        intensity: blurIntensity,
        borderRadius: blurRadius,
      });
    } else if (tool === "arrow") {
      setDraftAnn({
        id,
        kind: "arrow",
        visible: true,
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

    if (inter.kind === "resize-crop" && inter.origCrop && inter.handle) {
      const o = inter.origCrop;
      const h = inter.handle;
      const minSize = 12;
      let left = o.x;
      let top = o.y;
      let right = o.x + o.width;
      let bottom = o.y + o.height;

      if (h.includes("w")) left = Math.max(0, Math.min(right - minSize, pt.x));
      if (h.includes("e")) right = Math.min(imageWidth, Math.max(left + minSize, pt.x));
      if (h.includes("n")) top = Math.max(0, Math.min(bottom - minSize, pt.y));
      if (h.includes("s")) bottom = Math.min(imageHeight, Math.max(top + minSize, pt.y));

      const ratio =
        aspectPreset === "16:9"
          ? 16 / 9
          : aspectPreset === "4:3"
            ? 4 / 3
            : aspectPreset === "1:1"
              ? 1
              : null;

      if (ratio) {
        let w = right - left;
        let ch = bottom - top;
        if (h === "n" || h === "s") {
          w = ch * ratio;
          const cx = (left + right) * 0.5;
          left = Math.max(0, cx - w * 0.5);
          right = Math.min(imageWidth, left + w);
          w = right - left;
          ch = w / ratio;
          if (h === "n") top = Math.max(0, bottom - ch);
          else bottom = Math.min(imageHeight, top + ch);
        } else if (h === "e" || h === "w") {
          ch = w / ratio;
          const cy = (top + bottom) * 0.5;
          top = Math.max(0, cy - ch * 0.5);
          bottom = Math.min(imageHeight, top + ch);
          ch = bottom - top;
          w = ch * ratio;
          if (h === "w") left = Math.max(0, right - w);
          else right = Math.min(imageWidth, left + w);
        } else {
          // Corner handle: match dominant axis while clamping inside bounds
          if (w / ratio >= ch) {
            ch = w / ratio;
          } else {
            w = ch * ratio;
          }
          if (h.includes("w")) left = right - w;
          else right = left + w;
          if (h.includes("n")) top = bottom - ch;
          else bottom = top + ch;

          if (left < 0) {
            left = 0;
            w = right;
            ch = w / ratio;
            if (h.includes("n")) top = bottom - ch;
            else bottom = top + ch;
          }
          if (right > imageWidth) {
            right = imageWidth;
            w = right - left;
            ch = w / ratio;
            if (h.includes("n")) top = bottom - ch;
            else bottom = top + ch;
          }
          if (top < 0) {
            top = 0;
            ch = bottom;
            w = ch * ratio;
            if (h.includes("w")) left = right - w;
            else right = left + w;
          }
          if (bottom > imageHeight) {
            bottom = imageHeight;
            ch = bottom - top;
            w = ch * ratio;
            if (h.includes("w")) left = right - w;
            else right = left + w;
          }
        }
      }

      onChangeCropRect({
        x: Math.max(0, left),
        y: Math.max(0, top),
        width: Math.max(minSize, right - left),
        height: Math.max(minSize, bottom - top),
      });
      return;
    }

    if (inter.kind === "resize-pad" && inter.origPads && inter.handle) {
      if (!inter.checkpointed) {
        onCheckpointHistory?.();
        inter.checkpointed = true;
      }
      const scaleInv = 1 / Math.max(0.05, curCamRef.current.scale);
      const dx = (e.clientX - (inter.startClientX ?? e.clientX)) * scaleInv;
      const dy = (e.clientY - (inter.startClientY ?? e.clientY)) * scaleInv;
      const o = inter.origPads;
      const h = inter.handle;

      const nextTop = h.includes("n")
        ? Math.max(0, Math.min(240, Math.round(o.top - dy)))
        : o.top;
      const nextBottom = h.includes("s")
        ? Math.max(0, Math.min(240, Math.round(o.bottom + dy)))
        : o.bottom;
      const nextLeft = h.includes("w")
        ? Math.max(0, Math.min(240, Math.round(o.left - dx)))
        : o.left;
      const nextRight = h.includes("e")
        ? Math.max(0, Math.min(240, Math.round(o.right + dx)))
        : o.right;

      onChangeFrameOptions?.(
        {
          customPadding: true,
          paddingTop: nextTop,
          paddingRight: nextRight,
          paddingBottom: nextBottom,
          paddingLeft: nextLeft,
        },
        false
      );
      return;
    }

    if (inter.kind === "resize-ann" && inter.targetId && inter.origAnn && inter.handle) {
      if (!inter.checkpointed) {
        onCheckpointHistory?.();
        inter.checkpointed = true;
      }
      const orig = inter.origAnn;
      const h = inter.handle;

      if (orig.kind === "arrow") {
        if (h === "start") {
          onUpdateAnnotation(inter.targetId, { x1: pt.x, y1: pt.y }, false);
        } else {
          onUpdateAnnotation(inter.targetId, { x2: pt.x, y2: pt.y }, false);
        }
        return;
      }

      if (orig.kind === "text" && inter.origBounds) {
        const b = inter.origBounds;
        const cx = b.x + b.w * 0.5;
        const cy = b.y + b.h * 0.5;
        const startDist = Math.max(12, Math.hypot(inter.startImgX - cx, inter.startImgY - cy));
        const curDist = Math.max(8, Math.hypot(pt.x - cx, pt.y - cy));
        const ratio = curDist / startDist;
        const nextSize = Math.max(10, Math.min(240, Math.round(orig.fontSize * ratio)));
        onUpdateAnnotation(
          inter.targetId,
          { fontSize: nextSize },
          false
        );
        return;
      }

      if (orig.kind === "rect" || orig.kind === "blur") {
        const minSize = 10;
        let left = orig.x;
        let top = orig.y;
        let right = orig.x + orig.width;
        let bottom = orig.y + orig.height;

        if (h.includes("w")) left = Math.max(0, Math.min(right - minSize, pt.x));
        if (h.includes("e")) right = Math.min(imageWidth, Math.max(left + minSize, pt.x));
        if (h.includes("n")) top = Math.max(0, Math.min(bottom - minSize, pt.y));
        if (h.includes("s")) bottom = Math.min(imageHeight, Math.max(top + minSize, pt.y));

        onUpdateAnnotation(
          inter.targetId,
          {
            x: left,
            y: top,
            width: Math.max(minSize, right - left),
            height: Math.max(minSize, bottom - top),
          },
          false
        );
      }
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
  const displayW = Math.max(1, Math.round(viewWidth * displayScale));
  const displayH = Math.max(1, Math.round(viewHeight * displayScale));

  const padTopPx = showLiveFrame ? Math.max(0, Math.round(padTopVal * displayScale)) : 0;
  const padRightPx = showLiveFrame ? Math.max(0, Math.round(padRightVal * displayScale)) : 0;
  const padBottomPx = showLiveFrame ? Math.max(0, Math.round(padBottomVal * displayScale)) : 0;
  const padLeftPx = showLiveFrame ? Math.max(0, Math.round(padLeftVal * displayScale)) : 0;
  const frameRadiusPx = showLiveFrame
    ? Math.max(0, Math.round((frameOptions?.borderRadius ?? 18) * displayScale))
    : 12;

  const frameShadowCss = useMemo(() => {
    if (!showLiveFrame || frameOptions?.shadowStrength === "none") return "none";
    const sHex = frameOptions?.shadowColor || "#000000";
    if (frameOptions?.shadowStrength === "custom") {
      const ox = Math.round((frameOptions.shadowOffsetX ?? 0) * displayScale);
      const oy = Math.round((frameOptions.shadowOffsetY ?? 12) * displayScale);
      const bl = Math.round((frameOptions.shadowBlur ?? 24) * displayScale);
      const sp = Math.round((frameOptions.shadowSpread ?? 0) * displayScale);
      const op = frameOptions.shadowOpacity ?? 0.65;
      return `${ox}px ${oy}px ${bl}px ${sp}px ${hexToRgba(sHex, op)}`;
    }
    if (frameOptions?.shadowStrength === "soft") {
      return `0 ${Math.round(8 * displayScale)}px ${Math.round(24 * displayScale)}px ${hexToRgba(sHex, 0.45)}`;
    }
    if (frameOptions?.shadowStrength === "strong") {
      return `0 ${Math.round(18 * displayScale)}px ${Math.round(54 * displayScale)}px ${hexToRgba(sHex, 0.86)}`;
    }
    return `0 ${Math.round(12 * displayScale)}px ${Math.round(36 * displayScale)}px ${hexToRgba(sHex, 0.68)}`;
  }, [
    showLiveFrame,
    frameOptions?.shadowStrength,
    frameOptions?.shadowColor,
    frameOptions?.shadowOffsetX,
    frameOptions?.shadowOffsetY,
    frameOptions?.shadowBlur,
    frameOptions?.shadowSpread,
    frameOptions?.shadowOpacity,
    displayScale,
  ]);

  const frameBorderOverlayStyle = useMemo<React.CSSProperties | null>(() => {
    if (!showLiveFrame || !frameOptions?.subtleBorder) return null;
    const bw = Math.max(0, (frameOptions.borderWidth ?? 1.5) * displayScale);
    const op = frameOptions.borderOpacity ?? 0.24;
    if (bw <= 0.05 || op <= 0.005) return null;
    const col = hexToRgba(frameOptions.borderColor || "#FFFFFF", op);
    const pos = frameOptions.borderPosition || "inside";

    if (pos === "outside") {
      return {
        inset: -bw,
        border: `${bw}px solid ${col}`,
        borderRadius: frameRadiusPx + bw,
      };
    }
    if (pos === "center") {
      const half = bw * 0.5;
      return {
        inset: -half,
        border: `${bw}px solid ${col}`,
        borderRadius: frameRadiusPx + half,
      };
    }
    // inside
    return {
      inset: 0,
      boxShadow: `inset 0 0 0 ${bw}px ${col}`,
      borderRadius: frameRadiusPx,
    };
  }, [
    showLiveFrame,
    frameOptions?.subtleBorder,
    frameOptions?.borderWidth,
    frameOptions?.borderColor,
    frameOptions?.borderOpacity,
    frameOptions?.borderPosition,
    frameRadiusPx,
    displayScale,
  ]);

  const handleViewportDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-zoom-hud]")) return;
      if (target.closest("[data-split-handle]")) return;
      if (target.closest("[data-inline-editor]")) return;
      if (target.closest("[data-resize-handle]")) return;

      if (!previewResult && tool !== "crop" && target.closest("[data-canvas-stage]")) {
        const pt = clientToImg(e.clientX, e.clientY);
        const ctx = canvasRef.current?.getContext("2d") ?? null;
        const hitText = [...annotations].reverse().find((ann) => {
          if (ann.kind !== "text" || ann.visible === false) return false;
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
          return;
        }
      }

      // Double-click anywhere else on the viewport centers and fits the capture
      onChangeZoom("fit");
    },
    [previewResult, tool, clientToImg, annotations, onSelectId, onChangeZoom]
  );

  const totalPngW = viewWidth + padLeftVal + padRightVal;
  const totalPngH = viewHeight + padTopVal + padBottomVal;

  const vectorShapes = useMemo(() => {
    const base = annotations.filter(
      (a) => (a.kind === "rect" || a.kind === "arrow") && a.visible !== false
    );
    if (draftAnn && (draftAnn.kind === "rect" || draftAnn.kind === "arrow")) {
      return [...base, draftAnn];
    }
    return base;
  }, [annotations, draftAnn]);

  const vectorTexts = useMemo(
    () =>
      annotations.filter(
        (a): a is TextAnnotation =>
          a.kind === "text" && a.visible !== false && a.id !== editingTextId
      ),
    [annotations, editingTextId]
  );

  // Keep the Before/After comparison handle vertically centered inside the visible viewport
  const splitHandleTopPx = Math.max(
    28,
    Math.min(Math.max(28, displayH - 28), vpSize.h * 0.5 - cam.y)
  );

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
      onDoubleClick={handleViewportDoubleClick}
      className={`relative flex-1 min-w-0 min-h-0 overflow-hidden checker-bg select-none ${viewportCursor}`}
    >
      {/* Smooth GPU-Translated Stage (cam.x, cam.y always anchor image top-left) */}
      <div
        className={`absolute left-0 top-0 will-change-transform ${
          showLiveFrame
            ? editingPadding
              ? "border-2 border-dashed border-cyan-300 bg-cyan-400/[0.045] rounded-lg"
              : "border border-dashed border-cyan-400/50 bg-cyan-400/[0.025] rounded-lg"
            : ""
        }`}
        style={{
          transform: `translate3d(${cam.x - padLeftPx}px, ${cam.y - padTopPx}px, 0)`,
          padding: `${padTopPx}px ${padRightPx}px ${padBottomPx}px ${padLeftPx}px`,
        }}
      >
        {showLiveFrame && (
          <div className="pointer-events-none absolute -top-6 left-0 px-2 py-0.5 rounded-md bg-[#090D16]/90 border border-cyan-400/35 text-[10px] font-medium text-cyan-200 whitespace-nowrap shadow-md">
            PNG · {totalPngW}×{totalPngH} px · Margen{" "}
            {frameOptions?.customPadding
              ? `${padTopVal}/${padRightVal}/${padBottomVal}/${padLeftVal}px`
              : `${padTopVal}px`}
          </div>
        )}

        {/* Interactive 4-Side + 4-Corner Padding Handles when editingPadding is active */}
        {showLiveFrame && editingPadding && (
          <>
            {(
              [
                { dir: "n", cls: "-top-2 left-1/2 -translate-x-1/2 w-8 h-3 cursor-ns-resize" },
                { dir: "s", cls: "-bottom-2 left-1/2 -translate-x-1/2 w-8 h-3 cursor-ns-resize" },
                { dir: "w", cls: "top-1/2 -left-2 -translate-y-1/2 w-3 h-8 cursor-ew-resize" },
                { dir: "e", cls: "top-1/2 -right-2 -translate-y-1/2 w-3 h-8 cursor-ew-resize" },
                { dir: "nw", cls: "-top-2 -left-2 w-4 h-4 cursor-nwse-resize" },
                { dir: "ne", cls: "-top-2 -right-2 w-4 h-4 cursor-nesw-resize" },
                { dir: "sw", cls: "-bottom-2 -left-2 w-4 h-4 cursor-nesw-resize" },
                { dir: "se", cls: "-bottom-2 -right-2 w-4 h-4 cursor-nwse-resize" },
              ] as const
            ).map((h) => (
              <div
                key={h.dir}
                data-resize-handle
                onPointerDown={(e) => startPaddingHandleDrag(h.dir, e)}
                title="Arrastra para ajustar el margen transparente"
                className={`pointer-events-auto absolute rounded-full bg-cyan-300 border-2 border-slate-950 shadow-[0_0_12px_rgba(34,211,238,0.85)] hover:scale-120 transition-transform z-30 ${h.cls}`}
              />
            ))}
          </>
        )}

        {previewResult ? (
          /* Interactive Before / After Real-ESRGAN Comparison Viewer */
          <div
            data-canvas-stage
            className="relative select-none"
            style={{
              width: displayW,
              height: displayH,
              ...(showLiveFrame
                ? {
                    borderRadius: frameRadiusPx,
                    boxShadow: frameShadowCss,
                  }
                : {}),
            }}
          >
            <div
              className={`relative w-full h-full overflow-hidden ${
                showLiveFrame
                  ? ""
                  : "rounded-xl shadow-[0_24px_64px_rgba(0,0,0,0.85)] border border-cyan-400/35"
              }`}
              style={showLiveFrame ? { borderRadius: frameRadiusPx } : undefined}
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
                <div
                  style={{ top: splitHandleTopPx }}
                  className="absolute -translate-y-1/2 -translate-x-1/2 w-8 h-8 rounded-full bg-[#090D16]/95 border-2 border-cyan-300 flex items-center justify-center text-[10px] font-bold text-cyan-200 shadow-xl"
                >
                  ↔
                </div>
              </div>

              <div className="absolute top-3 left-3 px-2.5 py-1 rounded-lg bg-[#090D16]/88 border border-white/15 text-[11px] font-medium text-slate-200 backdrop-blur-md pointer-events-none">
                Original · {viewWidth} × {viewHeight}
              </div>
              <div className="absolute top-3 right-3 px-2.5 py-1 rounded-lg bg-[#090D16]/88 border border-cyan-400/45 text-[11px] font-semibold text-cyan-200 backdrop-blur-md pointer-events-none">
                {previewResult.engine} · {previewResult.width} ×{" "}
                {previewResult.height} ({previewResult.elapsedMs} ms)
              </div>
            </div>

            {frameBorderOverlayStyle && (
              <div
                className="pointer-events-none absolute z-20"
                style={frameBorderOverlayStyle}
              />
            )}
          </div>
        ) : (
          /* Active Editing Canvas Stage */
          <div
            data-canvas-stage
            className="relative"
            style={{
              width: displayW,
              height: displayH,
              ...(showLiveFrame
                ? {
                    borderRadius: frameRadiusPx,
                    boxShadow: frameShadowCss,
                  }
                : {}),
            }}
          >
            <div
              className={`relative w-full h-full overflow-hidden ${
                showLiveFrame
                  ? ""
                  : "rounded-xl shadow-[0_24px_64px_rgba(0,0,0,0.85)] border border-white/15"
              }`}
              style={showLiveFrame ? { borderRadius: frameRadiusPx } : undefined}
            >
              <canvas
                ref={canvasRef}
                style={{ width: displayW, height: displayH }}
                className="block"
              />

              {/* Crisp Animated Vector Layer for Arrows & Rectangles */}
              <svg
                viewBox={`${viewOffsetX} ${viewOffsetY} ${viewWidth} ${viewHeight}`}
                className="pointer-events-none absolute inset-0 w-full h-full overflow-visible"
              >
                <defs>
                  <filter id="up-vec-shadow" x="-20%" y="-20%" width="140%" height="140%">
                    <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#000000" floodOpacity="0.45" />
                  </filter>
                </defs>
                <AnimatePresence>
                  {vectorShapes.map((ann) => {
                    if (ann.kind === "rect") {
                      const cx = ann.x + ann.width * 0.5;
                      const cy = ann.y + ann.height * 0.5;
                      return (
                        <motion.g
                          key={ann.id}
                          initial={{ opacity: 0, scale: 0.88 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.82 }}
                          transition={{ type: "spring", stiffness: 460, damping: 32 }}
                          style={{ transformOrigin: `${cx}px ${cy}px` }}
                          filter="url(#up-vec-shadow)"
                        >
                          <rect
                            x={ann.x}
                            y={ann.y}
                            width={Math.max(0, ann.width)}
                            height={Math.max(0, ann.height)}
                            rx={4}
                            ry={4}
                            fill="none"
                            stroke={ann.color}
                            strokeWidth={ann.strokeWidth}
                          />
                        </motion.g>
                      );
                    }
                    if (ann.kind === "arrow") {
                      const dx = ann.x2 - ann.x1;
                      const dy = ann.y2 - ann.y1;
                      const len = Math.hypot(dx, dy);
                      if (len < 2) return null;
                      const angle = Math.atan2(dy, dx);
                      const headLen = Math.max(14, ann.strokeWidth * 4.2);
                      const shaftEndX = ann.x2 - Math.cos(angle) * (headLen * 0.68);
                      const shaftEndY = ann.y2 - Math.sin(angle) * (headLen * 0.68);
                      const p1x = ann.x2 - headLen * Math.cos(angle - Math.PI / 6);
                      const p1y = ann.y2 - headLen * Math.sin(angle - Math.PI / 6);
                      const p2x = ann.x2 - headLen * Math.cos(angle + Math.PI / 6);
                      const p2y = ann.y2 - headLen * Math.sin(angle + Math.PI / 6);
                      const mx = (ann.x1 + ann.x2) * 0.5;
                      const my = (ann.y1 + ann.y2) * 0.5;
                      return (
                        <motion.g
                          key={ann.id}
                          initial={{ opacity: 0, scale: 0.85 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.8 }}
                          transition={{ type: "spring", stiffness: 460, damping: 32 }}
                          style={{ transformOrigin: `${mx}px ${my}px` }}
                          filter="url(#up-vec-shadow)"
                        >
                          <line
                            x1={ann.x1}
                            y1={ann.y1}
                            x2={shaftEndX}
                            y2={shaftEndY}
                            stroke={ann.color}
                            strokeWidth={ann.strokeWidth}
                            strokeLinecap="round"
                          />
                          <polygon
                            points={`${ann.x2},${ann.y2} ${p1x},${p1y} ${p2x},${p2y}`}
                            fill={ann.color}
                          />
                        </motion.g>
                      );
                    }
                    return null;
                  })}
                </AnimatePresence>
              </svg>

              {/* Crisp Animated Vector Text Overlay (never pixelates at any zoom!) */}
              <div className="pointer-events-none absolute inset-0 overflow-hidden">
                <AnimatePresence>
                  {vectorTexts.map((ann) => {
                    const bgStyle = resolveTextBgStyle(ann);
                    const bgColor = ann.bgColor || "#090D16";
                    const bgColor2 = ann.bgColor2 || "#4F46E5";
                    const bgOpacity =
                      ann.bgOpacity ??
                      (bgStyle === "glass"
                        ? 0.82
                        : bgStyle === "highlight"
                          ? 0.48
                          : 0.96);
                    const padX =
                      (ann.paddingX ??
                        Math.round(Math.max(10, ann.fontSize * 0.42))) *
                      displayScale;
                    const padY =
                      (ann.paddingY ??
                        Math.round(Math.max(6, ann.fontSize * 0.25))) *
                      displayScale;
                    const offX = (ann.textOffsetX ?? 0) * displayScale;
                    const offY = (ann.textOffsetY ?? 0) * displayScale;
                    const cornerR =
                      (ann.borderRadius ?? (bgStyle === "highlight" ? 6 : 12)) *
                      displayScale;
                    const activeFont =
                      previewFontFamily && ann.id === selectedId
                        ? previewFontFamily
                        : ann.fontFamily;

                    const bgCss: React.CSSProperties =
                      bgStyle === "glass"
                        ? {
                            backgroundColor: hexToRgba(bgColor, bgOpacity),
                            border: `${Math.max(1, 1.5 * displayScale)}px solid rgba(255,255,255,0.22)`,
                            borderRadius: cornerR,
                            boxShadow: "0 4px 18px rgba(0,0,0,0.42)",
                          }
                        : bgStyle === "solid"
                          ? {
                              backgroundColor: hexToRgba(bgColor, bgOpacity),
                              borderRadius: cornerR,
                              boxShadow: "0 4px 16px rgba(0,0,0,0.36)",
                            }
                          : bgStyle === "gradient"
                            ? {
                                backgroundImage: `linear-gradient(135deg, ${hexToRgba(bgColor, bgOpacity)}, ${hexToRgba(bgColor2, bgOpacity)})`,
                                border: "1px solid rgba(255,255,255,0.18)",
                                borderRadius: cornerR,
                                boxShadow: "0 4px 18px rgba(0,0,0,0.4)",
                              }
                            : bgStyle === "outline"
                              ? {
                                  backgroundColor: hexToRgba(
                                    bgColor,
                                    bgOpacity * 0.3
                                  ),
                                  border: `${Math.max(1.5, ann.fontSize * 0.08 * displayScale)}px solid ${ann.color}`,
                                  borderRadius: cornerR,
                                }
                              : bgStyle === "highlight"
                                ? {
                                    backgroundColor: hexToRgba(
                                      bgColor,
                                      bgOpacity * 0.65
                                    ),
                                    borderRadius: cornerR,
                                  }
                                : {};

                    const shadowCss =
                      (ann.shadowEnabled ?? true) && (ann.shadowBlur ?? 4) > 0
                        ? `0 ${(ann.shadowOffsetY ?? 2) * displayScale}px ${(ann.shadowBlur ?? 4) * displayScale}px ${hexToRgba(ann.shadowColor || "#000000", 0.72)}`
                        : "none";

                    return (
                      <motion.div
                        key={ann.id}
                        initial={{ opacity: 0, scale: 0.86 }}
                        animate={{ opacity: ann.opacity ?? 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.82 }}
                        transition={{
                          type: "spring",
                          stiffness: 460,
                          damping: 32,
                        }}
                        style={{
                          left: (ann.x - viewOffsetX) * displayScale - padX,
                          top: (ann.y - viewOffsetY) * displayScale - padY,
                          paddingLeft: padX,
                          paddingRight: padX,
                          paddingTop: padY,
                          paddingBottom: padY,
                          ...bgCss,
                        }}
                        className="absolute whitespace-pre"
                      >
                        <div
                          style={{
                            transform: `translate(${offX}px, ${offY}px)`,
                            fontSize: ann.fontSize * displayScale,
                            lineHeight: 1.25,
                            fontFamily: getFontStack(activeFont),
                            color: ann.color,
                            fontWeight: ann.bold ? 700 : 500,
                            fontStyle: ann.italic ? "italic" : "normal",
                            textShadow: shadowCss,
                          }}
                        >
                          {ann.text || " "}
                        </div>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>
            </div>

            {frameBorderOverlayStyle && (
              <div
                className="pointer-events-none absolute z-10"
                style={frameBorderOverlayStyle}
              />
            )}

            {/* Selected Annotation Bounding Box + Resize Handles */}
            {selectedBounds &&
              selectedAnn &&
              selectedAnn.visible !== false &&
              !editingTextId &&
              tool === "select" && (
                <>
                  <div
                    className="absolute border border-dashed border-cyan-400 rounded-md pointer-events-none z-20"
                    style={{
                      left: (selectedBounds.x - viewOffsetX) * displayScale,
                      top: (selectedBounds.y - viewOffsetY) * displayScale,
                      width: Math.max(20, selectedBounds.w * displayScale),
                      height: Math.max(20, selectedBounds.h * displayScale),
                    }}
                  >
                    <button
                      data-resize-handle
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        onDeleteAnnotation(selectedAnn.id);
                      }}
                      className="pointer-events-auto absolute -top-3 -right-3 w-6 h-6 rounded-full bg-rose-500 hover:bg-rose-400 text-white flex items-center justify-center shadow-lg cursor-pointer z-20"
                      title="Eliminar capa (Supr)"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>

                    {(selectedAnn.kind === "rect" ||
                      selectedAnn.kind === "blur" ||
                      selectedAnn.kind === "text") &&
                      (
                        [
                          { dir: "nw", cls: "-top-1.5 -left-1.5 cursor-nwse-resize" },
                          { dir: "ne", cls: "-top-1.5 -right-1.5 cursor-nesw-resize" },
                          { dir: "sw", cls: "-bottom-1.5 -left-1.5 cursor-nesw-resize" },
                          { dir: "se", cls: "-bottom-1.5 -right-1.5 cursor-nwse-resize" },
                        ] as const
                      ).map((h) => (
                        <div
                          key={h.dir}
                          data-resize-handle
                          onPointerDown={(e) =>
                            startAnnHandleDrag(selectedAnn, h.dir, e)
                          }
                          className={`pointer-events-auto absolute w-3 h-3 rounded-sm bg-cyan-300 border border-slate-950 shadow-md z-10 ${h.cls}`}
                        />
                      ))}
                  </div>

                  {selectedAnn.kind === "arrow" && (
                    <>
                      <div
                        data-resize-handle
                        onPointerDown={(e) =>
                          startAnnHandleDrag(selectedAnn, "start", e)
                        }
                        style={{
                          left: (selectedAnn.x1 - viewOffsetX) * displayScale,
                          top: (selectedAnn.y1 - viewOffsetY) * displayScale,
                        }}
                        className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-cyan-300 border-2 border-slate-950 shadow-md cursor-move z-20"
                        title="Mover origen de flecha"
                      />
                      <div
                        data-resize-handle
                        onPointerDown={(e) =>
                          startAnnHandleDrag(selectedAnn, "end", e)
                        }
                        style={{
                          left: (selectedAnn.x2 - viewOffsetX) * displayScale,
                          top: (selectedAnn.y2 - viewOffsetY) * displayScale,
                        }}
                        className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-cyan-300 border-2 border-slate-950 shadow-md cursor-move z-20"
                        title="Mover punta de flecha"
                      />
                    </>
                  )}
                </>
              )}

            {/* WYSIWYG Live Inline Text Editor */}
            {editingTextAnn &&
              (() => {
                const bgStyle = resolveTextBgStyle(editingTextAnn);
                const bgColor = editingTextAnn.bgColor || "#090D16";
                const bgColor2 = editingTextAnn.bgColor2 || "#4F46E5";
                const bgOpacity =
                  editingTextAnn.bgOpacity ??
                  (bgStyle === "glass" ? 0.82 : bgStyle === "highlight" ? 0.48 : 0.96);
                const padX =
                  (editingTextAnn.paddingX ??
                    Math.round(Math.max(10, editingTextAnn.fontSize * 0.42))) *
                  displayScale;
                const padY =
                  (editingTextAnn.paddingY ??
                    Math.round(Math.max(6, editingTextAnn.fontSize * 0.25))) *
                  displayScale;
                const offX = (editingTextAnn.textOffsetX ?? 0) * displayScale;
                const offY = (editingTextAnn.textOffsetY ?? 0) * displayScale;
                const cornerR =
                  (editingTextAnn.borderRadius ??
                    (bgStyle === "highlight" ? 6 : 12)) * displayScale;
                const scaledFont = Math.max(
                  10,
                  editingTextAnn.fontSize * displayScale
                );
                const lines = (editingTextAnn.text || " ").split("\n");
                const ctx = canvasRef.current?.getContext("2d") ?? null;
                let measuredW = 60;
                if (ctx) {
                  ctx.font = `${editingTextAnn.italic ? "italic " : ""}${editingTextAnn.bold ? "700" : "500"} ${editingTextAnn.fontSize}px ${getFontStack(editingTextAnn.fontFamily)}`;
                  measuredW = lines.reduce(
                    (acc, l) => Math.max(acc, ctx.measureText(l || " ").width),
                    40
                  );
                }
                const boxW = Math.max(
                  80,
                  measuredW * displayScale + padX * 2 + 16
                );
                const lineH = scaledFont * 1.25;
                const boxH = Math.max(
                  lineH + padY * 2,
                  lines.length * lineH + padY * 2 + 2
                );

                const bgCss: React.CSSProperties =
                  bgStyle === "glass"
                    ? {
                        backgroundColor: hexToRgba(bgColor, bgOpacity),
                        border: "1.5px solid rgba(255,255,255,0.22)",
                        borderRadius: cornerR,
                        boxShadow: "0 4px 18px rgba(0,0,0,0.42)",
                      }
                    : bgStyle === "solid"
                      ? {
                          backgroundColor: hexToRgba(bgColor, bgOpacity),
                          border: "1px solid transparent",
                          borderRadius: cornerR,
                          boxShadow: "0 4px 16px rgba(0,0,0,0.38)",
                        }
                      : bgStyle === "gradient"
                        ? {
                            backgroundImage: `linear-gradient(135deg, ${hexToRgba(bgColor, bgOpacity)}, ${hexToRgba(bgColor2, bgOpacity)})`,
                            border: "1px solid rgba(255,255,255,0.18)",
                            borderRadius: cornerR,
                            boxShadow: "0 4px 18px rgba(0,0,0,0.4)",
                          }
                        : bgStyle === "outline"
                          ? {
                              backgroundColor: hexToRgba(bgColor, bgOpacity * 0.3),
                              border: `${Math.max(1.5, editingTextAnn.fontSize * 0.08 * displayScale)}px solid ${editingTextAnn.color}`,
                              borderRadius: cornerR,
                            }
                          : bgStyle === "highlight"
                            ? {
                                backgroundColor: hexToRgba(bgColor, bgOpacity * 0.65),
                                border: "1px solid transparent",
                                borderRadius: cornerR,
                              }
                            : {
                                backgroundColor: "transparent",
                                border: "1px solid transparent",
                              };

                const shadowCss =
                  (editingTextAnn.shadowEnabled ?? true) &&
                  (editingTextAnn.shadowBlur ?? 4) > 0
                    ? `0 ${(editingTextAnn.shadowOffsetY ?? 2) * displayScale}px ${(editingTextAnn.shadowBlur ?? 4) * displayScale}px ${hexToRgba(editingTextAnn.shadowColor || "#000000", 0.72)}`
                    : "none";

                return (
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
                      if (
                        e.key === "Escape" ||
                        (e.key === "Enter" && !e.shiftKey)
                      ) {
                        e.preventDefault();
                        commitEditingText(editingTextAnn.id);
                      }
                    }}
                    spellCheck={false}
                    style={{
                      left:
                        (editingTextAnn.x - viewOffsetX) * displayScale - padX,
                      top:
                        (editingTextAnn.y - viewOffsetY) * displayScale - padY,
                      width: boxW,
                      height: boxH,
                      paddingLeft: Math.max(0, padX + offX),
                      paddingRight: Math.max(0, padX - offX),
                      paddingTop: Math.max(0, padY + offY),
                      paddingBottom: Math.max(0, padY - offY),
                      fontSize: scaledFont,
                      lineHeight: 1.25,
                      fontFamily: getFontStack(
                        previewFontFamily || editingTextAnn.fontFamily
                      ),
                      color: editingTextAnn.color,
                      fontWeight: editingTextAnn.bold ? 700 : 500,
                      fontStyle: editingTextAnn.italic ? "italic" : "normal",
                      opacity: editingTextAnn.opacity ?? 1,
                      textShadow: shadowCss,
                      outline: "1.5px dashed rgba(34, 211, 238, 0.65)",
                      outlineOffset: 3,
                      userSelect: "text",
                      WebkitUserSelect: "text",
                      ...bgCss,
                    }}
                    className="absolute z-30 overflow-hidden resize-none whitespace-pre select-text"
                  />
                );
              })()}

            {/* Crop Overlay Grid + 8 Interactive Corner/Edge Handles */}
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

                  {/* 4 Corner Handles */}
                  {(
                    [
                      { dir: "nw", cls: "-top-2 -left-2 cursor-nwse-resize" },
                      { dir: "ne", cls: "-top-2 -right-2 cursor-nesw-resize" },
                      { dir: "sw", cls: "-bottom-2 -left-2 cursor-nesw-resize" },
                      { dir: "se", cls: "-bottom-2 -right-2 cursor-nwse-resize" },
                    ] as const
                  ).map((h) => (
                    <div
                      key={h.dir}
                      data-resize-handle
                      onPointerDown={(e) => startCropHandleDrag(h.dir, e)}
                      className={`pointer-events-auto absolute w-4 h-4 rounded-full bg-emerald-300 border-2 border-slate-950 shadow-[0_0_10px_rgba(52,211,153,0.75)] hover:scale-125 transition-transform z-20 ${h.cls}`}
                    />
                  ))}

                  {/* 4 Mid-Edge Handles */}
                  {(
                    [
                      { dir: "n", cls: "-top-1.5 left-1/2 -translate-x-1/2 w-6 h-2.5 cursor-ns-resize" },
                      { dir: "s", cls: "-bottom-1.5 left-1/2 -translate-x-1/2 w-6 h-2.5 cursor-ns-resize" },
                      { dir: "w", cls: "top-1/2 -left-1.5 -translate-y-1/2 w-2.5 h-6 cursor-ew-resize" },
                      { dir: "e", cls: "top-1/2 -right-1.5 -translate-y-1/2 w-2.5 h-6 cursor-ew-resize" },
                    ] as const
                  ).map((h) => (
                    <div
                      key={h.dir}
                      data-resize-handle
                      onPointerDown={(e) => startCropHandleDrag(h.dir, e)}
                      className={`pointer-events-auto absolute rounded-full bg-emerald-300/95 border border-slate-950 shadow-md hover:scale-110 transition-transform z-20 ${h.cls}`}
                    />
                  ))}
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
          Rueda: zoom · Arrastra: mover
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
