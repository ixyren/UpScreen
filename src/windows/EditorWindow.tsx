import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUpRight,
  Bold,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  CopyPlus,
  Cpu,
  Crop,
  Download,
  Droplets,
  Eye,
  EyeOff,
  Italic,
  Layers,
  Loader2,
  Maximize2,
  Minimize2,
  Minus,
  MousePointer2,
  Redo2,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Type,
  Undo2,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import EditorCanvas, {
  renderBaseWithBlursDataUrl,
  renderCompositeDataUrl,
  renderVectorsOntoUpscaledDataUrl,
  resolveTextBgStyle,
} from "../components/EditorCanvas";
import { useSmoothScroll } from "../hooks/useSmoothScroll";
import type {
  AiQualityMode,
  Annotation,
  AspectPreset,
  BlurMode,
  BorderPosition,
  CropRect,
  DownloadProgressEvent,
  EditorCapturePayload,
  FrameOptions,
  SaveResult,
  SystemStatus,
  TextBgStyle,
  TextStyleConfig,
  ToolType,
  UpscaleModel,
  UpscalePreviewResult,
} from "../types";

interface HistorySnapshot {
  imageDataUrl: string;
  width: number;
  height: number;
  annotations: Annotation[];
  activeCrop: CropRect | null;
}

const DEFAULT_TEXT_STYLE: TextStyleConfig = {
  fontFamily: "Segoe UI",
  fontSize: 28,
  color: "#FFFFFF",
  bold: true,
  italic: false,
  bgStyle: "glass",
  bgColor: "#090D16",
  bgColor2: "#4F46E5",
  bgOpacity: 0.84,
  paddingX: 16,
  paddingY: 9,
  textOffsetX: 0,
  textOffsetY: 0,
  borderRadius: 12,
  opacity: 1,
  shadowEnabled: true,
  shadowBlur: 4,
  shadowColor: "#000000",
  shadowOffsetY: 2,
};

const TEXT_PRESETS: Array<{
  id: string;
  label: string;
  previewBg: string;
  previewColor: string;
  patch: Partial<TextStyleConfig>;
}> = [
  {
    id: "glass",
    label: "Cristal Pro",
    previewBg: "linear-gradient(135deg, rgba(9,13,22,0.9), rgba(30,41,59,0.85))",
    previewColor: "#FFFFFF",
    patch: {
      color: "#FFFFFF",
      bold: true,
      italic: false,
      bgStyle: "glass",
      bgColor: "#090D16",
      bgOpacity: 0.84,
      paddingX: 16,
      paddingY: 9,
      borderRadius: 12,
      shadowEnabled: true,
      shadowBlur: 4,
      shadowColor: "#000000",
    },
  },
  {
    id: "aura",
    label: "Aura Degradado",
    previewBg: "linear-gradient(135deg, #06B6D4, #6366F1)",
    previewColor: "#FFFFFF",
    patch: {
      color: "#FFFFFF",
      bold: true,
      italic: false,
      bgStyle: "gradient",
      bgColor: "#06B6D4",
      bgColor2: "#6366F1",
      bgOpacity: 0.95,
      paddingX: 18,
      paddingY: 10,
      borderRadius: 14,
      shadowEnabled: true,
      shadowBlur: 6,
      shadowColor: "#000000",
    },
  },
  {
    id: "neon",
    label: "Neón Cian",
    previewBg: "rgba(34,211,238,0.14)",
    previewColor: "#22D3EE",
    patch: {
      color: "#22D3EE",
      bold: true,
      italic: false,
      bgStyle: "outline",
      bgColor: "#090D16",
      bgOpacity: 0.9,
      paddingX: 16,
      paddingY: 8,
      borderRadius: 12,
      shadowEnabled: true,
      shadowBlur: 10,
      shadowColor: "#22D3EE",
    },
  },
  {
    id: "solid-light",
    label: "Etiqueta Clara",
    previewBg: "#FFFFFF",
    previewColor: "#0F172A",
    patch: {
      color: "#0F172A",
      bold: true,
      italic: false,
      bgStyle: "solid",
      bgColor: "#FFFFFF",
      bgOpacity: 0.98,
      paddingX: 16,
      paddingY: 8,
      borderRadius: 10,
      shadowEnabled: false,
      shadowBlur: 0,
    },
  },
  {
    id: "highlight",
    label: "Resaltador",
    previewBg: "rgba(251,191,36,0.65)",
    previewColor: "#0F172A",
    patch: {
      color: "#0F172A",
      bold: true,
      italic: false,
      bgStyle: "highlight",
      bgColor: "#FBBF24",
      bgOpacity: 0.9,
      paddingX: 12,
      paddingY: 6,
      borderRadius: 6,
      shadowEnabled: false,
      shadowBlur: 0,
    },
  },
  {
    id: "minimal",
    label: "Minimalista",
    previewBg: "transparent",
    previewColor: "#FFFFFF",
    patch: {
      color: "#FFFFFF",
      bold: true,
      italic: false,
      bgStyle: "none",
      shadowEnabled: true,
      shadowBlur: 8,
      shadowColor: "#000000",
      shadowOffsetY: 3,
    },
  },
];

const COLOR_SWATCHES = [
  "#22D3EE",
  "#F43F5E",
  "#FBBF24",
  "#34D399",
  "#818CF8",
  "#FFFFFF",
  "#0F172A",
];

function formatTimestampName() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `UpScreen_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export default function EditorWindow() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [captureMeta, setCaptureMeta] = useState<EditorCapturePayload | null>(null);

  const [imageDataUrl, setImageDataUrl] = useState<string>("");
  const [imageWidth, setImageWidth] = useState<number>(0);
  const [imageHeight, setImageHeight] = useState<number>(0);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);

  const [past, setPast] = useState<HistorySnapshot[]>([]);
  const [future, setFuture] = useState<HistorySnapshot[]>([]);

  const [tool, setTool] = useState<ToolType>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [layersModalOpen, setLayersModalOpen] = useState<boolean>(false);
  const [textModalOpen, setTextModalOpen] = useState<boolean>(false);
  const [isMaximized, setIsMaximized] = useState<boolean>(false);
  const [systemFonts, setSystemFonts] = useState<string[]>([
    "Segoe UI",
    "Inter",
    "Arial",
    "Consolas",
    "Georgia",
    "Impact",
  ]);
  const [fontFilter, setFontFilter] = useState<string>("");

  const [activeColor, setActiveColor] = useState<string>("#22D3EE");
  const [strokeWidth, setStrokeWidth] = useState<number>(4);
  const [textStyle, setTextStyle] = useState<TextStyleConfig>(DEFAULT_TEXT_STYLE);
  const [blurMode, setBlurMode] = useState<BlurMode>("gaussian");
  const [blurIntensity, setBlurIntensity] = useState<number>(14);
  const [blurRadius, setBlurRadius] = useState<number>(8);

  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [fitNonce, setFitNonce] = useState<number>(0);
  const inspectorRef = useRef<HTMLElement | null>(null);
  useSmoothScroll(inspectorRef);

  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [activeCrop, setActiveCrop] = useState<CropRect | null>(null);
  const [aspectPreset, setAspectPreset] = useState<AspectPreset>("free");

  const handleToggleMaximize = useCallback(async () => {
    try {
      const win = getCurrentWindow();
      await win.toggleMaximize();
      const maxed = await win.isMaximized();
      setIsMaximized(maxed);
    } catch (err) {
      console.error("Error cambiando maximizado:", err);
    }
  }, []);

  useEffect(() => {
    invoke<string[]>("list_system_fonts")
      .then((fonts) => {
        if (Array.isArray(fonts) && fonts.length > 0) {
          setSystemFonts(fonts);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const win = getCurrentWindow();
    win.isMaximized().then(setIsMaximized).catch(() => {});
    let unlistenResize: (() => void) | undefined;
    win
      .onResized(() => {
        win.isMaximized().then(setIsMaximized).catch(() => {});
      })
      .then((u) => {
        unlistenResize = u;
      })
      .catch(() => {});
    return () => {
      unlistenResize?.();
    };
  }, []);

  const handleZoomChange = useCallback((next: number | "fit") => {
    setZoom(next);
    if (next === "fit") {
      setFitNonce((n) => n + 1);
    }
  }, []);

  // Upscale & Codec controls
  const [upscaleBeforeSave, setUpscaleBeforeSave] = useState<boolean>(false);
  const [scale, setScale] = useState<number>(2);
  const [model, setModel] = useState<UpscaleModel>("realesrgan-x4plus");
  const [textProtection, setTextProtection] =
    useState<AiQualityMode>("supersample");
  const [frameOptions, setFrameOptions] = useState<FrameOptions>({
    enabled: false,
    borderRadius: 18,
    padding: 44,
    shadowStrength: "medium",
    subtleBorder: true,
    borderWidth: 1.5,
    borderColor: "#FFFFFF",
    borderOpacity: 0.24,
    borderPosition: "inside",
    shadowColor: "#000000",
    shadowOffsetX: 0,
    shadowOffsetY: 12,
    shadowBlur: 24,
    shadowSpread: 0,
    shadowOpacity: 0.65,
  });
  const [codecPreference, setCodecPreference] = useState<
    "auto" | "nvenc" | "amf" | "cpu"
  >("auto");
  const [format, setFormat] = useState<"png" | "webp" | "jpg" | "hevc-hw">(
    "png"
  );

  const [previewResult, setPreviewResult] =
    useState<UpscalePreviewResult | null>(null);
  const [previewing, setPreviewing] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [copying, setCopying] = useState<boolean>(false);
  const [downloading, setDownloading] = useState<boolean>(false);
  const [downloadProgress, setDownloadProgress] =
    useState<DownloadProgressEvent | null>(null);
  const [toast, setToast] = useState<{
    type: "success" | "error";
    title: string;
    detail?: string;
  } | null>(null);

  const showToast = useCallback(
    (type: "success" | "error", title: string, detail?: string) => {
      setToast({ type, title, detail });
    },
    []
  );

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const loadSystemStatus = useCallback(async () => {
    try {
      const res = await invoke<SystemStatus>("get_system_status");
      setStatus(res);
    } catch (err) {
      console.error(err);
    }
  }, []);

  const loadEditorCapture = useCallback(async () => {
    try {
      const payload = await invoke<EditorCapturePayload | null>(
        "get_editor_capture"
      );
      if (!payload) return;
      setCaptureMeta(payload);
      setImageDataUrl(payload.imageDataUrl);
      setImageWidth(payload.width);
      setImageHeight(payload.height);
      setAnnotations([]);
      setPast([]);
      setFuture([]);
      setSelectedId(null);
      setCropRect(null);
      setActiveCrop(null);
      setPreviewResult(null);
      setTool("select");
      setScale(payload.appliedScale || 2);
      setModel((payload.appliedModel as UpscaleModel) || "realesrgan-x4plus");
      const rawMode = payload.appliedTextProtection as string | undefined;
      setTextProtection(
        rawMode === "tta" || rawMode === "balanced"
          ? "tta"
          : rawMode === "raw" || rawMode === "off"
            ? "raw"
            : "supersample"
      );
      // If capture was not already upscaled, default upscaleBeforeSave to false (user chooses in editor)
      setUpscaleBeforeSave(false);
    } catch (err) {
      console.error("Error cargando captura en editor:", err);
    }
  }, []);

  useEffect(() => {
    loadSystemStatus();
    loadEditorCapture();

    let unlistenCap: (() => void) | undefined;
    let unlistenDl: (() => void) | undefined;

    listen("editor-capture-updated", () => {
      loadEditorCapture();
    }).then((u) => {
      unlistenCap = u;
    });

    listen<DownloadProgressEvent>("engine-download-progress", (event) => {
      setDownloadProgress(event.payload);
    }).then((u) => {
      unlistenDl = u;
    });

    return () => {
      unlistenCap?.();
      unlistenDl?.();
    };
  }, [loadSystemStatus, loadEditorCapture]);

  const pushHistory = useCallback(() => {
    setPast((p) => [
      ...p.slice(-24),
      {
        imageDataUrl,
        width: imageWidth,
        height: imageHeight,
        annotations,
        activeCrop,
      },
    ]);
    setFuture([]);
  }, [imageDataUrl, imageWidth, imageHeight, annotations, activeCrop]);

  const handleUndo = useCallback(() => {
    setPast((prevPast) => {
      if (prevPast.length === 0) return prevPast;
      const last = prevPast[prevPast.length - 1];
      setFuture((f) => [
        {
          imageDataUrl,
          width: imageWidth,
          height: imageHeight,
          annotations,
          activeCrop,
        },
        ...f,
      ]);
      setImageDataUrl(last.imageDataUrl);
      setImageWidth(last.width);
      setImageHeight(last.height);
      setAnnotations(last.annotations);
      setActiveCrop(last.activeCrop);
      setSelectedId(null);
      setPreviewResult(null);
      return prevPast.slice(0, -1);
    });
  }, [imageDataUrl, imageWidth, imageHeight, annotations, activeCrop]);

  const handleRedo = useCallback(() => {
    setFuture((prevFuture) => {
      if (prevFuture.length === 0) return prevFuture;
      const next = prevFuture[0];
      setPast((p) => [
        ...p,
        {
          imageDataUrl,
          width: imageWidth,
          height: imageHeight,
          annotations,
          activeCrop,
        },
      ]);
      setImageDataUrl(next.imageDataUrl);
      setImageWidth(next.width);
      setImageHeight(next.height);
      setAnnotations(next.annotations);
      setActiveCrop(next.activeCrop);
      setSelectedId(null);
      setPreviewResult(null);
      return prevFuture.slice(1);
    });
  }, [imageDataUrl, imageWidth, imageHeight, annotations, activeCrop]);

  const handleAddAnnotation = useCallback(
    (ann: Annotation) => {
      pushHistory();
      setAnnotations((prev) => [...prev, ann]);
      setPreviewResult(null);
    },
    [pushHistory]
  );

  const handleUpdateAnnotation = useCallback(
    (id: string, patch: Partial<Annotation>, commitHistory = true) => {
      if (commitHistory) pushHistory();
      setAnnotations((prev) =>
        prev.map((a) => (a.id === id ? ({ ...a, ...patch } as Annotation) : a))
      );
      setPreviewResult(null);
    },
    [pushHistory]
  );

  const handleDeleteAnnotation = useCallback(
    (id: string) => {
      pushHistory();
      setAnnotations((prev) => prev.filter((a) => a.id !== id));
      if (selectedId === id) setSelectedId(null);
      setPreviewResult(null);
    },
    [pushHistory, selectedId]
  );

  const enterCropTool = useCallback(() => {
    setPreviewResult(null);
    setCropRect(
      activeCrop ??
        (imageWidth > 0 && imageHeight > 0
          ? { x: 0, y: 0, width: imageWidth, height: imageHeight }
          : null)
    );
    setTool("crop");
    handleZoomChange("fit");
  }, [activeCrop, imageWidth, imageHeight, handleZoomChange]);

  const handleApplyCrop = useCallback(() => {
    if (!cropRect || cropRect.width < 6 || cropRect.height < 6) return;
    pushHistory();
    const isFull =
      cropRect.x <= 1 &&
      cropRect.y <= 1 &&
      cropRect.width >= imageWidth - 2 &&
      cropRect.height >= imageHeight - 2;
    const nextCrop = isFull
      ? null
      : {
          x: Math.max(0, Math.round(cropRect.x)),
          y: Math.max(0, Math.round(cropRect.y)),
          width: Math.max(6, Math.round(cropRect.width)),
          height: Math.max(6, Math.round(cropRect.height)),
        };
    setActiveCrop(nextCrop);
    setCropRect(null);
    setPreviewResult(null);
    setTool("select");
    handleZoomChange("fit");
    showToast(
      "success",
      nextCrop ? "Recorte no destructivo aplicado" : "Captura restaurada al 100%",
      nextCrop
        ? `${nextCrop.width} × ${nextCrop.height} px · Puedes recuperarla al volver a Recortar`
        : `${imageWidth} × ${imageHeight} px`
    );
  }, [cropRect, pushHistory, imageWidth, imageHeight, handleZoomChange, showToast]);

  const handleResetCrop = useCallback(() => {
    pushHistory();
    setActiveCrop(null);
    setCropRect(null);
    setPreviewResult(null);
    setTool("select");
    handleZoomChange("fit");
    showToast("success", "Recorte restablecido", `${imageWidth} × ${imageHeight} px`);
  }, [pushHistory, imageWidth, imageHeight, handleZoomChange, showToast]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT";
      if (isTyping) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        handleRedo();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        handleDeleteAnnotation(selectedId);
        return;
      }

      const key = e.key.toLowerCase();
      if (key === "v") setTool("select");
      else if (key === "c") enterCropTool();
      else if (key === "t") setTool("text");
      else if (key === "a") setTool("arrow");
      else if (key === "r") setTool("rect");
      else if (key === "b") setTool("blur");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleUndo, handleRedo, handleDeleteAnnotation, selectedId, enterCropTool]);

  // Sync style changes with currently selected annotation
  const selectedAnn = useMemo(
    () => annotations.find((a) => a.id === selectedId) ?? null,
    [annotations, selectedId]
  );

  useEffect(() => {
    if (!selectedAnn) return;
    if (selectedAnn.kind === "text") {
      setActiveColor(selectedAnn.color);
      setTextStyle({
        fontFamily: selectedAnn.fontFamily ?? "Segoe UI",
        fontSize: selectedAnn.fontSize,
        color: selectedAnn.color,
        bold: selectedAnn.bold,
        italic: Boolean(selectedAnn.italic),
        bgStyle: resolveTextBgStyle(selectedAnn),
        bgColor: selectedAnn.bgColor ?? "#090D16",
        bgColor2: selectedAnn.bgColor2 ?? "#4F46E5",
        bgOpacity: selectedAnn.bgOpacity ?? 0.84,
        paddingX:
          selectedAnn.paddingX ??
          Math.round(Math.max(10, selectedAnn.fontSize * 0.42)),
        paddingY:
          selectedAnn.paddingY ??
          Math.round(Math.max(6, selectedAnn.fontSize * 0.25)),
        textOffsetX: selectedAnn.textOffsetX ?? 0,
        textOffsetY: selectedAnn.textOffsetY ?? 0,
        borderRadius: selectedAnn.borderRadius ?? 12,
        opacity: selectedAnn.opacity ?? 1,
        shadowEnabled: selectedAnn.shadowEnabled ?? true,
        shadowBlur: selectedAnn.shadowBlur ?? 4,
        shadowColor: selectedAnn.shadowColor ?? "#000000",
        shadowOffsetY: selectedAnn.shadowOffsetY ?? 2,
      });
    } else if (selectedAnn.kind === "rect" || selectedAnn.kind === "arrow") {
      setActiveColor(selectedAnn.color);
      setStrokeWidth(selectedAnn.strokeWidth);
    } else if (selectedAnn.kind === "blur") {
      setBlurMode(selectedAnn.mode ?? "gaussian");
      setBlurIntensity(selectedAnn.intensity || 14);
      setBlurRadius(selectedAnn.borderRadius ?? 8);
    }
  }, [selectedAnn]);

  const updateTextStyle = useCallback(
    (patch: Partial<TextStyleConfig>, commitHistory = true) => {
      setTextStyle((prev) => ({ ...prev, ...patch }));
      if (patch.color) setActiveColor(patch.color);
      if (selectedAnn?.kind === "text") {
        const annPatch: Record<string, unknown> = { ...patch };
        if (patch.bgStyle !== undefined) {
          annPatch.hasPill = patch.bgStyle !== "none";
        }
        handleUpdateAnnotation(
          selectedAnn.id,
          annPatch as Partial<Annotation>,
          commitHistory
        );
      }
    },
    [selectedAnn, handleUpdateAnnotation]
  );

  const applyColor = (c: string) => {
    setActiveColor(c);
    setTextStyle((prev) => ({ ...prev, color: c }));
    if (selectedAnn && selectedAnn.kind !== "blur") {
      handleUpdateAnnotation(selectedAnn.id, { color: c }, true);
    }
  };

  const applyStrokeWidth = (sw: number) => {
    setStrokeWidth(sw);
    if (selectedAnn?.kind === "rect" || selectedAnn?.kind === "arrow") {
      handleUpdateAnnotation(selectedAnn.id, { strokeWidth: sw }, true);
    }
  };

  const applyBlurMode = (mode: BlurMode) => {
    setBlurMode(mode);
    if (selectedAnn?.kind === "blur") {
      handleUpdateAnnotation(selectedAnn.id, { mode }, true);
    }
  };

  const applyBlurIntensity = (intensity: number) => {
    setBlurIntensity(intensity);
    if (selectedAnn?.kind === "blur") {
      handleUpdateAnnotation(selectedAnn.id, { intensity }, true);
    }
  };

  const applyBlurRadius = (borderRadius: number) => {
    setBlurRadius(borderRadius);
    if (selectedAnn?.kind === "blur") {
      handleUpdateAnnotation(selectedAnn.id, { borderRadius }, true);
    }
  };

  const handleToggleLayerVisibility = (id: string) => {
    pushHistory();
    setAnnotations((prev) =>
      prev.map((a) =>
        a.id === id ? { ...a, visible: a.visible === false ? true : false } : a
      )
    );
    setPreviewResult(null);
  };

  const handleMoveLayer = (id: string, delta: 1 | -1) => {
    pushHistory();
    setAnnotations((prev) => {
      const idx = prev.findIndex((a) => a.id === id);
      if (idx < 0) return prev;
      const target = idx + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(idx, 1);
      next.splice(target, 0, item);
      return next;
    });
    setPreviewResult(null);
  };

  const handleDuplicateLayer = (id: string) => {
    const src = annotations.find((a) => a.id === id);
    if (!src) return;
    pushHistory();
    const newId = `${src.kind}-${Date.now()}`;
    const clone: Annotation =
      src.kind === "arrow"
        ? {
            ...src,
            id: newId,
            x1: src.x1 + 18,
            y1: src.y1 + 18,
            x2: src.x2 + 18,
            y2: src.y2 + 18,
          }
        : {
            ...src,
            id: newId,
            x: src.x + 18,
            y: src.y + 18,
          };
    setAnnotations((prev) => [...prev, clone]);
    setSelectedId(newId);
    setPreviewResult(null);
  };

  const effectiveW = activeCrop ? Math.round(activeCrop.width) : imageWidth;
  const effectiveH = activeCrop ? Math.round(activeCrop.height) : imageHeight;

  const runUpscaleWithCrispVectors = useCallback(async () => {
    const hasVectors = annotations.some((a) => a.kind !== "blur" && a.visible !== false);
    const withinCanvasCap =
      effectiveW * scale <= 8192 && effectiveH * scale <= 8192;

    if (hasVectors && withinCanvasCap) {
      const baseWithBlurs = await renderBaseWithBlursDataUrl(
        imageDataUrl,
        annotations,
        activeCrop
      );
      const res = await invoke<UpscalePreviewResult>("preview_upscale", {
        imageBase64: baseWithBlurs,
        scale,
        model,
        textProtection,
      });
      const finalUrl = await renderVectorsOntoUpscaledDataUrl(
        res.imageDataUrl,
        annotations,
        scale,
        activeCrop
      );
      return {
        ...res,
        imageDataUrl: finalUrl,
        engine: `${res.engine} + vectores ${scale}x`,
      };
    }

    const compositeUrl = await renderCompositeDataUrl(
      imageDataUrl,
      annotations,
      activeCrop
    );
    return invoke<UpscalePreviewResult>("preview_upscale", {
      imageBase64: compositeUrl,
      scale,
      model,
      textProtection,
    });
  }, [
    annotations,
    imageDataUrl,
    effectiveW,
    effectiveH,
    activeCrop,
    scale,
    model,
    textProtection,
  ]);

  const handlePreviewUpscale = async () => {
    if (!imageDataUrl) return;
    setPreviewing(true);
    try {
      const res = await runUpscaleWithCrispVectors();
      setPreviewResult(res);
      showToast(
        "success",
        `Vista previa ${scale}x generada`,
        `Motor: ${res.engine} · ${res.width}×${res.height} px (${res.elapsedMs} ms)`
      );
    } catch (err) {
      showToast("error", "Error en vista previa Real-ESRGAN", String(err));
    } finally {
      setPreviewing(false);
    }
  };

  const handleCopy = async () => {
    if (!imageDataUrl) return;
    setCopying(true);
    try {
      const hasVectors = annotations.some((a) => a.kind !== "blur" && a.visible !== false);
      const withinCanvasCap =
        effectiveW * scale <= 8192 && effectiveH * scale <= 8192;

      if (upscaleBeforeSave && hasVectors && withinCanvasCap) {
        const upscaled = await runUpscaleWithCrispVectors();
        const msg = await invoke<string>("copy_edited_image", {
          imageBase64: upscaled.imageDataUrl,
          upscaleBeforeCopy: false,
          scale,
          model,
          textProtection,
          frame: frameOptions,
          frameScale: scale,
        });
        showToast("success", `${msg} (${upscaled.engine})`);
      } else {
        const compositeUrl = await renderCompositeDataUrl(
          imageDataUrl,
          annotations,
          activeCrop
        );
        const msg = await invoke<string>("copy_edited_image", {
          imageBase64: compositeUrl,
          upscaleBeforeCopy: upscaleBeforeSave,
          scale,
          model,
          textProtection,
          frame: frameOptions,
          frameScale: 1,
        });
        showToast("success", msg);
      }
    } catch (err) {
      showToast("error", "No se pudo copiar al portapapeles", String(err));
    } finally {
      setCopying(false);
    }
  };

  const handleSave = async () => {
    if (!imageDataUrl) return;
    const ext = format === "hevc-hw" ? "mp4" : format;
    const baseDir = status?.defaultSaveDir ?? "";
    const defaultPath = baseDir
      ? `${baseDir}\\${formatTimestampName()}.${ext}`
      : `${formatTimestampName()}.${ext}`;

    const chosenPath = await save({
      title: "Guardar captura de UpScreen",
      defaultPath,
      filters: [
        {
          name:
            format === "hevc-hw"
              ? "HEVC Hardware MP4"
              : `${format.toUpperCase()} Imagen`,
          extensions: [ext],
        },
      ],
    });

    if (!chosenPath) return;

    setSaving(true);
    try {
      const hasVectors = annotations.some((a) => a.kind !== "blur" && a.visible !== false);
      const withinCanvasCap =
        effectiveW * scale <= 8192 && effectiveH * scale <= 8192;

      let payloadUrl: string;
      let shouldUpscaleInSave = upscaleBeforeSave;
      let preEngine: string | null = null;
      let frameScale = 1;

      if (upscaleBeforeSave && hasVectors && withinCanvasCap) {
        const upscaled = await runUpscaleWithCrispVectors();
        payloadUrl = upscaled.imageDataUrl;
        shouldUpscaleInSave = false;
        preEngine = upscaled.engine;
        frameScale = scale;
      } else {
        payloadUrl = await renderCompositeDataUrl(
          imageDataUrl,
          annotations,
          activeCrop
        );
      }

      const res = await invoke<SaveResult>("save_edited_image", {
        imageBase64: payloadUrl,
        options: {
          path: chosenPath,
          format,
          codecPreference,
          upscaleBeforeSave: shouldUpscaleInSave,
          scale,
          model,
          textProtection,
          frame: frameOptions,
          frameScale,
        },
      });
      const engineNote = res.upscaleEngine ?? preEngine;
      showToast(
        "success",
        `Guardado en ${res.width}×${res.height} px (${res.elapsedMs} ms)`,
        `${res.path} · ${res.codecUsed}${
          engineNote ? ` · AI: ${engineNote}` : ""
        }`
      );
    } catch (err) {
      showToast("error", "Error al guardar archivo", String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadEngine = async () => {
    setDownloading(true);
    setDownloadProgress({
      percent: 2,
      status: "Descargando Real-ESRGAN Vulkan...",
    });
    try {
      await invoke("download_realesrgan_engine");
      await loadSystemStatus();
      showToast(
        "success",
        "Real-ESRGAN Vulkan instalado",
        "Ya puedes mejorar capturas con aceleración GPU Vulkan."
      );
    } catch (err) {
      showToast("error", "Error descargando Real-ESRGAN", String(err));
    } finally {
      setDownloading(false);
    }
  };

  const projectedW = upscaleBeforeSave ? effectiveW * scale : effectiveW;
  const projectedH = upscaleBeforeSave ? effectiveH * scale : effectiveH;
  const targetScaledW = effectiveW * scale;
  const targetScaledH = effectiveH * scale;
  const projectedMp = (targetScaledW * targetScaledH) / 1_000_000;
  const exceedsSafeCap =
    targetScaledW > 16384 || targetScaledH > 16384 || projectedMp > 100;
  const showTextControls = tool === "text" || selectedAnn?.kind === "text";
  const showBlurControls = tool === "blur" || selectedAnn?.kind === "blur";
  const filteredSystemFonts = useMemo(() => {
    const q = fontFilter.trim().toLowerCase();
    if (!q) return systemFonts;
    return systemFonts.filter((f) => f.toLowerCase().includes(q));
  }, [systemFonts, fontFilter]);

  return (
    <div className="w-screen h-screen flex flex-col bg-[#070B13] text-slate-100 border border-white/10 overflow-hidden">
      {/* Custom Modern Dark Titlebar */}
      <header
        data-tauri-drag-region
        onDoubleClick={handleToggleMaximize}
        className="h-11 shrink-0 bg-[#0A0F1B] border-b border-white/10 px-3 flex items-center justify-between"
      >
        <div
          data-tauri-drag-region
          className="flex items-center gap-2.5 pointer-events-none"
        >
          <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-cyan-400 to-indigo-500 flex items-center justify-center shadow-[0_0_14px_rgba(34,211,238,0.4)]">
            <Sparkles className="w-3.5 h-3.5 text-slate-950" />
          </div>
          <span className="text-xs font-semibold tracking-tight">
            UpScreen Editor
          </span>
          {imageWidth > 0 && (
            <span className="px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-[11px] text-slate-300 font-medium">
              {effectiveW} × {effectiveH} px
              {activeCrop ? ` (recorte de ${imageWidth}×${imageHeight})` : ""}
            </span>
          )}
          {captureMeta?.autoUpscaled && (
            <span className="px-2 py-0.5 rounded-md bg-cyan-500/15 border border-cyan-400/40 text-[11px] text-cyan-200 font-medium">
              AI {captureMeta.appliedScale}x aplicada ({captureMeta.upscaleEngine})
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => getCurrentWindow().minimize()}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            title="Minimizar"
          >
            <Minus className="w-4 h-4" />
          </button>
          <button
            onClick={handleToggleMaximize}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            title={isMaximized ? "Restaurar ventana" : "Maximizar ventana"}
          >
            {isMaximized ? (
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            onClick={() => getCurrentWindow().hide()}
            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-rose-500/15 transition-colors cursor-pointer"
            title="Cerrar editor"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Top Contextual Formatting & Action Bar */}
      <div className="h-12 shrink-0 bg-[#0C1220]/95 border-b border-white/10 px-3 flex items-center gap-2 overflow-x-auto">
        <div className="flex items-center gap-1">
          <button
            onClick={handleUndo}
            disabled={past.length === 0}
            className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-35 text-slate-200 transition-colors cursor-pointer"
            title="Deshacer (Ctrl+Z)"
          >
            <Undo2 className="w-4 h-4" />
          </button>
          <button
            onClick={handleRedo}
            disabled={future.length === 0}
            className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-35 text-slate-200 transition-colors cursor-pointer"
            title="Rehacer (Ctrl+Y)"
          >
            <Redo2 className="w-4 h-4" />
          </button>
        </div>

        <div className="h-5 w-px bg-white/10 shrink-0" />

        {tool === "crop" ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-emerald-300 font-medium">
              Recorte:
            </span>
            {(["free", "16:9", "4:3", "1:1"] as AspectPreset[]).map((preset) => (
              <button
                key={preset}
                onClick={() => setAspectPreset(preset)}
                className={`px-2 py-1 rounded-lg text-[11px] font-medium transition-colors cursor-pointer ${
                  aspectPreset === preset
                    ? "bg-emerald-400 text-slate-950 font-semibold"
                    : "bg-white/5 text-slate-300 hover:bg-white/10"
                }`}
              >
                {preset === "free" ? "Libre" : preset}
              </button>
            ))}
            <button
              onClick={handleApplyCrop}
              disabled={!cropRect || cropRect.width < 6 || cropRect.height < 6}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 text-xs font-semibold cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Aplicar recorte</span>
            </button>
            {activeCrop && (
              <button
                onClick={handleResetCrop}
                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-400/35 text-xs text-amber-200 cursor-pointer"
                title="Recuperar imagen original completa"
              >
                <RotateCcw className="w-3 h-3" />
                <span>Restablecer 100%</span>
              </button>
            )}
            <button
              onClick={() => {
                setCropRect(null);
                setTool("select");
              }}
              className="px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-slate-300 cursor-pointer"
            >
              Cancelar
            </button>
          </div>
        ) : showBlurControls ? (
          <div className="flex items-center gap-2.5 shrink-0">
            <div className="flex items-center gap-1 bg-white/5 rounded-lg p-0.5 border border-white/10">
              <button
                onClick={() => applyBlurMode("gaussian")}
                className={`px-2 py-1 rounded-md text-[11px] font-semibold transition-colors cursor-pointer ${
                  blurMode === "gaussian"
                    ? "bg-cyan-400 text-slate-950"
                    : "text-slate-300 hover:text-white"
                }`}
              >
                Gaussiano
              </button>
              <button
                onClick={() => applyBlurMode("pixelate")}
                className={`px-2 py-1 rounded-md text-[11px] font-semibold transition-colors cursor-pointer ${
                  blurMode === "pixelate"
                    ? "bg-cyan-400 text-slate-950"
                    : "text-slate-300 hover:text-white"
                }`}
              >
                Pixelado
              </button>
            </div>

            <div className="h-4 w-px bg-white/10" />

            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-slate-400">
                {blurMode === "gaussian" ? "Radio" : "Bloque"}
              </span>
              <input
                type="range"
                min={4}
                max={40}
                value={blurIntensity}
                onChange={(e) => applyBlurIntensity(Number(e.target.value))}
                className="w-20 accent-cyan-400 cursor-pointer"
              />
              <span className="text-[11px] text-slate-200 w-7">
                {blurIntensity}px
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-slate-400">Curva</span>
              <input
                type="range"
                min={0}
                max={32}
                value={blurRadius}
                onChange={(e) => applyBlurRadius(Number(e.target.value))}
                className="w-16 accent-cyan-400 cursor-pointer"
              />
              <span className="text-[11px] text-slate-200 w-7">
                {blurRadius}px
              </span>
            </div>

            {selectedAnn?.kind === "blur" && (
              <span className="text-[10px] text-cyan-300 bg-cyan-500/10 border border-cyan-400/30 rounded-md px-2 py-0.5 whitespace-nowrap">
                {Math.round(selectedAnn.width)}×{Math.round(selectedAnn.height)} px
              </span>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 shrink-0">
            {/* Color Swatches + Custom Color Picker */}
            <div className="flex items-center gap-1">
              {COLOR_SWATCHES.map((c) => (
                <button
                  key={c}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyColor(c)}
                  className={`w-5 h-5 rounded-full border transition-transform cursor-pointer ${
                    activeColor.toLowerCase() === c.toLowerCase()
                      ? "scale-115 border-white ring-2 ring-cyan-400/60"
                      : "border-white/25 hover:scale-105"
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
              <label
                className="w-5 h-5 rounded-full border border-white/30 overflow-hidden cursor-pointer flex items-center justify-center bg-gradient-to-tr from-cyan-400 via-fuchsia-400 to-amber-300"
                title="Color personalizado"
              >
                <input
                  type="color"
                  value={activeColor}
                  onChange={(e) => applyColor(e.target.value)}
                  className="opacity-0 w-full h-full cursor-pointer"
                />
              </label>
            </div>

            <div className="h-4 w-px bg-white/10" />

            {showTextControls ? (
              <div className="flex items-center gap-1.5">
                <select
                  value={textStyle.fontFamily}
                  onChange={(e) =>
                    updateTextStyle({ fontFamily: e.target.value })
                  }
                  className="max-w-[130px] rounded-lg bg-white/5 border border-white/10 px-1.5 py-1 text-[11px] text-slate-100 outline-none cursor-pointer"
                  style={{ fontFamily: `"${textStyle.fontFamily}", sans-serif` }}
                  title="Fuente instalada en el sistema"
                >
                  {systemFonts.map((f) => (
                    <option
                      key={f}
                      value={f}
                      className="bg-[#0C1220] text-slate-100"
                      style={{ fontFamily: `"${f}", sans-serif` }}
                    >
                      {f}
                    </option>
                  ))}
                </select>

                <input
                  type="range"
                  min={12}
                  max={120}
                  value={textStyle.fontSize}
                  onChange={(e) =>
                    updateTextStyle({ fontSize: Number(e.target.value) })
                  }
                  className="w-16 accent-cyan-400 cursor-pointer"
                  title="Tamaño de fuente"
                />
                <span className="text-[11px] text-slate-200 w-6">
                  {textStyle.fontSize}
                </span>

                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => updateTextStyle({ bold: !textStyle.bold })}
                  className={`p-1.5 rounded-lg border text-xs cursor-pointer ${
                    textStyle.bold
                      ? "bg-cyan-500/20 border-cyan-400/50 text-cyan-200"
                      : "bg-white/5 border-white/10 text-slate-400"
                  }`}
                  title="Negrita"
                >
                  <Bold className="w-3.5 h-3.5" />
                </button>
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => updateTextStyle({ italic: !textStyle.italic })}
                  className={`p-1.5 rounded-lg border text-xs cursor-pointer ${
                    textStyle.italic
                      ? "bg-cyan-500/20 border-cyan-400/50 text-cyan-200"
                      : "bg-white/5 border-white/10 text-slate-400"
                  }`}
                  title="Cursiva"
                >
                  <Italic className="w-3.5 h-3.5" />
                </button>

                <select
                  value={textStyle.bgStyle}
                  onChange={(e) =>
                    updateTextStyle({ bgStyle: e.target.value as TextBgStyle })
                  }
                  className="rounded-lg bg-white/5 border border-white/10 px-1.5 py-1 text-[11px] text-slate-100 outline-none cursor-pointer"
                  title="Estilo de fondo del texto"
                >
                  <option value="none" className="bg-[#0C1220]">
                    Sin fondo
                  </option>
                  <option value="glass" className="bg-[#0C1220]">
                    Cristal
                  </option>
                  <option value="solid" className="bg-[#0C1220]">
                    Sólido
                  </option>
                  <option value="gradient" className="bg-[#0C1220]">
                    Degradado
                  </option>
                  <option value="outline" className="bg-[#0C1220]">
                    Contorno
                  </option>
                  <option value="highlight" className="bg-[#0C1220]">
                    Resaltado
                  </option>
                </select>

                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setTextModalOpen((v) => !v)}
                  className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                    textModalOpen
                      ? "bg-cyan-500/25 border-cyan-400/60 text-cyan-100"
                      : "bg-white/5 hover:bg-white/10 border-white/15 text-cyan-200"
                  }`}
                  title="Abrir presets, fuentes, margen, desplazamiento interno y sombra de texto"
                >
                  <SlidersHorizontal className="w-3 h-3" />
                  <span>Presets y estilo</span>
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-slate-400">Grosor</span>
                <input
                  type="range"
                  min={2}
                  max={16}
                  value={strokeWidth}
                  onChange={(e) => applyStrokeWidth(Number(e.target.value))}
                  className="w-20 accent-cyan-400 cursor-pointer"
                />
                <span className="text-[11px] text-slate-200">
                  {strokeWidth}px
                </span>
              </div>
            )}
          </div>
        )}

        <div className="flex-1" />

        {/* Layers Modal Toggle Button */}
        <button
          onClick={() => setLayersModalOpen((v) => !v)}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-xs font-medium transition-colors cursor-pointer shrink-0 ${
            layersModalOpen
              ? "bg-cyan-500/20 border-cyan-400/55 text-cyan-100"
              : "bg-white/5 hover:bg-white/10 border-white/10 text-slate-200"
          }`}
          title="Abrir modal de capas no destructivas"
        >
          <Layers className="w-3.5 h-3.5 text-cyan-300" />
          <span>Capas</span>
          {annotations.length > 0 && (
            <span className="px-1.5 py-0.2 rounded-full bg-cyan-400/20 text-cyan-200 text-[10px] font-bold">
              {annotations.length}
            </span>
          )}
        </button>

        {/* Zoom Controls */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() =>
              setZoom((prev) =>
                prev === "fit"
                  ? 0.75
                  : Math.max(0.1, Number((prev / 1.25).toFixed(2)))
              )
            }
            className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-200 transition-colors cursor-pointer"
            title="Alejar"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <select
            value={zoom === "fit" ? "fit" : String(zoom)}
            onChange={(e) =>
              handleZoomChange(
                e.target.value === "fit" ? "fit" : Number(e.target.value)
              )
            }
            className="rounded-lg bg-white/5 border border-white/10 px-2 py-1 text-xs text-slate-200 outline-none cursor-pointer"
          >
            <option value="fit" className="bg-[#0C1220]">
              Ajustar
            </option>
            {[0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8].map((z) => (
              <option key={z} value={String(z)} className="bg-[#0C1220]">
                {Math.round(z * 100)}%
              </option>
            ))}
            {zoom !== "fit" &&
              ![0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8].includes(zoom) && (
                <option value={String(zoom)} className="bg-[#0C1220]">
                  {Math.round(zoom * 100)}%
                </option>
              )}
          </select>
          <button
            onClick={() =>
              setZoom((prev) =>
                prev === "fit"
                  ? 1.5
                  : Math.min(10.0, Number((prev * 1.25).toFixed(2)))
              )
            }
            className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-200 transition-colors cursor-pointer"
            title="Acercar"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Copy & Primary Save */}
        <motion.button
          whileTap={{ scale: 0.96 }}
          onClick={handleCopy}
          disabled={!imageDataUrl || copying}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/7 hover:bg-white/12 border border-white/12 text-xs font-medium text-slate-100 transition-colors cursor-pointer disabled:opacity-40"
        >
          {copying ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-300" />
          ) : (
            <Copy className="w-3.5 h-3.5 text-cyan-300" />
          )}
          <span>Copiar</span>
        </motion.button>

        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.96 }}
          onClick={handleSave}
          disabled={!imageDataUrl || saving}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-cyan-400 to-indigo-500 hover:brightness-110 text-slate-950 text-xs font-bold shadow-[0_0_20px_rgba(34,211,238,0.35)] transition-all cursor-pointer disabled:opacity-40"
        >
          {saving ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Save className="w-3.5 h-3.5" />
          )}
          <span>
            {upscaleBeforeSave ? `Guardar + ${scale}x AI` : "Guardar"}
          </span>
        </motion.button>
      </div>

      {/* Main Editor Body: Left Rail + Center Canvas + Right Inspector */}
      <div className="flex-1 min-h-0 flex">
        {/* Left Vertical Tool Rail */}
        <aside className="w-14 shrink-0 bg-[#0A0F1B] border-r border-white/10 py-3 flex flex-col items-center gap-1.5">
          <ToolRailButton
            active={tool === "select"}
            icon={<MousePointer2 className="w-4 h-4" />}
            label="Seleccionar / Mover (V)"
            onClick={() => setTool("select")}
          />
          <ToolRailButton
            active={tool === "crop"}
            icon={<Crop className="w-4 h-4" />}
            label="Recortar captura no destructivo (C)"
            onClick={enterCropTool}
          />
          <ToolRailButton
            active={tool === "text"}
            icon={<Type className="w-4 h-4" />}
            label="Añadir texto (T)"
            onClick={() => {
              setPreviewResult(null);
              setTool("text");
            }}
          />
          <ToolRailButton
            active={tool === "arrow"}
            icon={<ArrowUpRight className="w-4 h-4" />}
            label="Flecha (A)"
            onClick={() => {
              setPreviewResult(null);
              setTool("arrow");
            }}
          />
          <ToolRailButton
            active={tool === "rect"}
            icon={<Square className="w-4 h-4" />}
            label="Rectángulo (R)"
            onClick={() => {
              setPreviewResult(null);
              setTool("rect");
            }}
          />
          <ToolRailButton
            active={tool === "blur"}
            icon={<Droplets className="w-4 h-4" />}
            label="Desenfoque / Ocultar (B)"
            onClick={() => {
              setPreviewResult(null);
              setTool("blur");
            }}
          />
        </aside>

        {/* Center Interactive Stage + Floating Layers Modal */}
        <div className="relative flex-1 min-w-0 min-h-0 flex">
          {imageDataUrl ? (
            <EditorCanvas
              imageDataUrl={imageDataUrl}
              imageWidth={imageWidth}
              imageHeight={imageHeight}
              tool={tool}
              annotations={annotations}
              selectedId={selectedId}
              activeColor={activeColor}
              strokeWidth={strokeWidth}
              textStyle={textStyle}
              blurMode={blurMode}
              blurIntensity={blurIntensity}
              blurRadius={blurRadius}
              zoom={zoom}
              fitNonce={fitNonce}
              cropRect={cropRect}
              activeCrop={activeCrop}
              aspectPreset={aspectPreset}
              previewResult={previewResult}
              frameOptions={frameOptions}
              onSelectId={setSelectedId}
              onAddAnnotation={handleAddAnnotation}
              onUpdateAnnotation={handleUpdateAnnotation}
              onDeleteAnnotation={handleDeleteAnnotation}
              onChangeCropRect={setCropRect}
              onChangeZoom={handleZoomChange}
              onCheckpointHistory={pushHistory}
            />
          ) : (
            <div className="flex-1 checker-bg flex flex-col items-center justify-center text-center p-6 gap-3">
              <div className="w-12 h-12 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
                <Sparkles className="w-6 h-6 text-cyan-300" />
              </div>
              <div className="text-sm font-medium text-slate-200">
                Esperando una captura de pantalla...
              </div>
              <div className="text-xs text-slate-400 max-w-sm">
                Usa el menú flotante o presiona Ctrl+Shift+S (Recorte), Ctrl+Shift+W (Ventana) o Ctrl+Shift+F (Pantalla completa).
              </div>
            </div>
          )}

          {/* Floating Text Presets & Full Customization Modal */}
          <AnimatePresence>
            {textModalOpen && showTextControls && (
              <motion.div
                initial={{ opacity: 0, x: -16, scale: 0.96 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: -16, scale: 0.96 }}
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
                className="absolute top-3 left-3 z-40 w-80 max-h-[82%] flex flex-col rounded-2xl bg-[#0A0F1B]/96 backdrop-blur-2xl border border-white/15 shadow-[0_20px_60px_rgba(0,0,0,0.78)] overflow-hidden"
              >
                <div className="px-3.5 py-2.5 border-b border-white/10 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Type className="w-3.5 h-3.5 text-cyan-300" />
                    <span className="text-xs font-semibold text-slate-100">
                      Estudio de Texto y Presets
                    </span>
                  </div>
                  <button
                    onClick={() => setTextModalOpen(false)}
                    className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 cursor-pointer"
                    title="Cerrar ajustes de texto"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto p-3 space-y-3 text-xs">
                  {/* Text Presets */}
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-medium text-slate-300">
                      Presets rápidos
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      {TEXT_PRESETS.map((preset) => (
                        <button
                          key={preset.id}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => updateTextStyle(preset.patch)}
                          className="rounded-xl p-1.5 border border-white/12 hover:border-cyan-400/60 transition-all cursor-pointer flex flex-col items-center gap-1 bg-white/[0.03]"
                        >
                          <div
                            className="w-full py-1 rounded-lg text-[10px] font-bold text-center border border-white/10"
                            style={{
                              background: preset.previewBg,
                              color: preset.previewColor,
                            }}
                          >
                            Aa
                          </div>
                          <span className="text-[10px] text-slate-300 truncate w-full text-center">
                            {preset.label}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* System Fonts Search & Picker */}
                  <div className="space-y-1.5 pt-1 border-t border-white/10">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-slate-300 font-medium">
                        Fuentes del sistema ({systemFonts.length})
                      </span>
                    </div>
                    <input
                      type="text"
                      value={fontFilter}
                      onChange={(e) => setFontFilter(e.target.value)}
                      placeholder="Buscar fuente instalada..."
                      className="w-full rounded-lg bg-[#0F1624] border border-white/10 px-2.5 py-1.5 text-[11px] text-slate-100 placeholder:text-slate-500 outline-none focus:border-cyan-400/60"
                    />
                    <div className="max-h-28 overflow-y-auto rounded-lg bg-[#0F1624] border border-white/10 p-1 space-y-0.5">
                      {filteredSystemFonts.slice(0, 120).map((f) => (
                        <button
                          key={f}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => updateTextStyle({ fontFamily: f })}
                          style={{ fontFamily: `"${f}", sans-serif` }}
                          className={`w-full text-left px-2 py-1 rounded-md text-xs truncate cursor-pointer transition-colors ${
                            textStyle.fontFamily === f
                              ? "bg-cyan-500/25 text-cyan-100 font-semibold"
                              : "text-slate-300 hover:bg-white/10"
                          }`}
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Background & Colors */}
                  <div className="space-y-2 pt-1 border-t border-white/10">
                    <div className="text-[11px] font-medium text-slate-300">
                      Fondo y colores
                    </div>
                    <div className="grid grid-cols-3 gap-1">
                      {(
                        [
                          { id: "none", label: "Sin fondo" },
                          { id: "glass", label: "Cristal" },
                          { id: "solid", label: "Sólido" },
                          { id: "gradient", label: "Degradado" },
                          { id: "outline", label: "Contorno" },
                          { id: "highlight", label: "Resaltado" },
                        ] as const
                      ).map((opt) => (
                        <button
                          key={opt.id}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => updateTextStyle({ bgStyle: opt.id })}
                          className={`py-1 rounded-lg text-[10px] font-semibold border cursor-pointer ${
                            textStyle.bgStyle === opt.id
                              ? "bg-cyan-400/20 border-cyan-400/55 text-cyan-100"
                              : "bg-white/5 border-white/10 text-slate-400 hover:text-slate-200"
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>

                    <StyledColorControl
                      label="Color de texto"
                      value={textStyle.color}
                      onChange={(c) => updateTextStyle({ color: c })}
                    />

                    {textStyle.bgStyle !== "none" && (
                      <>
                        <StyledColorControl
                          label={
                            textStyle.bgStyle === "gradient"
                              ? "Color inicio"
                              : "Color de fondo"
                          }
                          value={textStyle.bgColor}
                          onChange={(c) => updateTextStyle({ bgColor: c })}
                        />
                        {textStyle.bgStyle === "gradient" && (
                          <StyledColorControl
                            label="Color final"
                            value={textStyle.bgColor2}
                            onChange={(c) => updateTextStyle({ bgColor2: c })}
                          />
                        )}

                        <div className="space-y-1">
                          <div className="flex justify-between text-[10px]">
                            <span className="text-slate-400">Opacidad fondo</span>
                            <span className="text-cyan-200 font-semibold">
                              {Math.round(textStyle.bgOpacity * 100)}%
                            </span>
                          </div>
                          <input
                            type="range"
                            min={0.05}
                            max={1}
                            step={0.05}
                            value={textStyle.bgOpacity}
                            onChange={(e) =>
                              updateTextStyle({
                                bgOpacity: Number(e.target.value),
                              })
                            }
                            className="w-full accent-cyan-400 cursor-pointer"
                          />
                        </div>

                        <div className="space-y-1">
                          <div className="flex justify-between text-[10px]">
                            <span className="text-slate-400">Radio de esquina</span>
                            <span className="text-cyan-200 font-semibold">
                              {textStyle.borderRadius} px
                            </span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={40}
                            value={textStyle.borderRadius}
                            onChange={(e) =>
                              updateTextStyle({
                                borderRadius: Number(e.target.value),
                              })
                            }
                            className="w-full accent-cyan-400 cursor-pointer"
                          />
                        </div>

                        {/* Margins & Inner Text Position inside Background */}
                        <div className="grid grid-cols-2 gap-2">
                          <div className="space-y-1">
                            <div className="flex justify-between text-[10px]">
                              <span className="text-slate-400">Margen X</span>
                              <span className="text-slate-200">
                                {textStyle.paddingX}px
                              </span>
                            </div>
                            <input
                              type="range"
                              min={0}
                              max={72}
                              value={textStyle.paddingX}
                              onChange={(e) =>
                                updateTextStyle({
                                  paddingX: Number(e.target.value),
                                })
                              }
                              className="w-full accent-cyan-400 cursor-pointer"
                            />
                          </div>
                          <div className="space-y-1">
                            <div className="flex justify-between text-[10px]">
                              <span className="text-slate-400">Margen Y</span>
                              <span className="text-slate-200">
                                {textStyle.paddingY}px
                              </span>
                            </div>
                            <input
                              type="range"
                              min={0}
                              max={56}
                              value={textStyle.paddingY}
                              onChange={(e) =>
                                updateTextStyle({
                                  paddingY: Number(e.target.value),
                                })
                              }
                              className="w-full accent-cyan-400 cursor-pointer"
                            />
                          </div>
                        </div>

                        <div className="rounded-xl bg-white/[0.03] border border-white/10 p-2 space-y-1.5">
                          <div className="flex items-center justify-between text-[10px]">
                            <span className="text-slate-300 font-medium">
                              Mover texto dentro del fondo
                            </span>
                            {(textStyle.textOffsetX !== 0 ||
                              textStyle.textOffsetY !== 0) && (
                              <button
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() =>
                                  updateTextStyle({
                                    textOffsetX: 0,
                                    textOffsetY: 0,
                                  })
                                }
                                className="text-cyan-300 hover:underline cursor-pointer"
                              >
                                Centrar
                              </button>
                            )}
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-0.5">
                              <div className="flex justify-between text-[10px] text-slate-400">
                                <span>Offset X</span>
                                <span>{textStyle.textOffsetX}px</span>
                              </div>
                              <input
                                type="range"
                                min={-48}
                                max={48}
                                value={textStyle.textOffsetX}
                                onChange={(e) =>
                                  updateTextStyle({
                                    textOffsetX: Number(e.target.value),
                                  })
                                }
                                className="w-full accent-cyan-400 cursor-pointer"
                              />
                            </div>
                            <div className="space-y-0.5">
                              <div className="flex justify-between text-[10px] text-slate-400">
                                <span>Offset Y</span>
                                <span>{textStyle.textOffsetY}px</span>
                              </div>
                              <input
                                type="range"
                                min={-36}
                                max={36}
                                value={textStyle.textOffsetY}
                                onChange={(e) =>
                                  updateTextStyle({
                                    textOffsetY: Number(e.target.value),
                                  })
                                }
                                className="w-full accent-cyan-400 cursor-pointer"
                              />
                            </div>
                          </div>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Shadow & Global Opacity */}
                  <div className="space-y-2 pt-1 border-t border-white/10">
                    <label className="flex items-center justify-between text-[11px] text-slate-300 cursor-pointer">
                      <span>Sombra del texto</span>
                      <input
                        type="checkbox"
                        checked={textStyle.shadowEnabled}
                        onChange={(e) =>
                          updateTextStyle({ shadowEnabled: e.target.checked })
                        }
                        className="accent-cyan-400 w-3.5 h-3.5 cursor-pointer"
                      />
                    </label>
                    {textStyle.shadowEnabled && (
                      <div className="space-y-1.5 pl-1">
                        <div className="grid grid-cols-2 gap-2">
                          <div className="space-y-0.5">
                            <div className="flex justify-between text-[10px] text-slate-400">
                              <span>Desenfoque</span>
                              <span>{textStyle.shadowBlur}px</span>
                            </div>
                            <input
                              type="range"
                              min={0}
                              max={28}
                              value={textStyle.shadowBlur}
                              onChange={(e) =>
                                updateTextStyle({
                                  shadowBlur: Number(e.target.value),
                                })
                              }
                              className="w-full accent-cyan-400 cursor-pointer"
                            />
                          </div>
                          <div className="space-y-0.5">
                            <div className="flex justify-between text-[10px] text-slate-400">
                              <span>Distancia Y</span>
                              <span>{textStyle.shadowOffsetY}px</span>
                            </div>
                            <input
                              type="range"
                              min={-12}
                              max={20}
                              value={textStyle.shadowOffsetY}
                              onChange={(e) =>
                                updateTextStyle({
                                  shadowOffsetY: Number(e.target.value),
                                })
                              }
                              className="w-full accent-cyan-400 cursor-pointer"
                            />
                          </div>
                        </div>
                        <StyledColorControl
                          label="Color sombra"
                          value={textStyle.shadowColor}
                          onChange={(c) => updateTextStyle({ shadowColor: c })}
                        />
                      </div>
                    )}

                    <div className="space-y-1">
                      <div className="flex justify-between text-[10px]">
                        <span className="text-slate-400">Opacidad global</span>
                        <span className="text-cyan-200 font-semibold">
                          {Math.round(textStyle.opacity * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0.1}
                        max={1}
                        step={0.05}
                        value={textStyle.opacity}
                        onChange={(e) =>
                          updateTextStyle({ opacity: Number(e.target.value) })
                        }
                        className="w-full accent-cyan-400 cursor-pointer"
                      />
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Floating Non-Destructive Layers Modal */}
          <AnimatePresence>
            {layersModalOpen && (
              <motion.div
                initial={{ opacity: 0, x: 16, scale: 0.96 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: 16, scale: 0.96 }}
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
                className="absolute top-3 right-3 z-40 w-72 max-h-[76%] flex flex-col rounded-2xl bg-[#0A0F1B]/95 backdrop-blur-2xl border border-white/15 shadow-[0_20px_60px_rgba(0,0,0,0.75)] overflow-hidden"
              >
                <div className="px-3.5 py-2.5 border-b border-white/10 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Layers className="w-3.5 h-3.5 text-cyan-300" />
                    <span className="text-xs font-semibold text-slate-100">
                      Capas ({annotations.length})
                    </span>
                  </div>
                  <button
                    onClick={() => setLayersModalOpen(false)}
                    className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 cursor-pointer"
                    title="Cerrar panel de capas"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
                  {annotations.length === 0 ? (
                    <div className="py-6 px-3 text-center text-[11px] text-slate-400">
                      Aún no hay capas. Añade texto, desenfoque, flechas o rectángulos para ajustarlos aquí sin destruir la captura.
                    </div>
                  ) : (
                    [...annotations].reverse().map((ann, revIdx) => {
                      const origIdx = annotations.length - 1 - revIdx;
                      const isSelected = ann.id === selectedId;
                      const isVisible = ann.visible !== false;
                      const label =
                        ann.kind === "text"
                          ? ann.text.trim().slice(0, 24) || "Texto vacío"
                          : ann.kind === "blur"
                            ? `${(ann.mode ?? "gaussian") === "gaussian" ? "Gaussiano" : "Pixelado"} · ${ann.intensity}px`
                            : ann.kind === "arrow"
                              ? `Flecha (${ann.strokeWidth}px)`
                              : `Rectángulo (${Math.round(ann.width)}×${Math.round(ann.height)})`;
                      return (
                        <div
                          key={ann.id}
                          onClick={() => {
                            setSelectedId(ann.id);
                            if (tool === "crop") setTool("select");
                          }}
                          className={`group flex items-center gap-2 px-2.5 py-2 rounded-xl border text-xs transition-colors cursor-pointer ${
                            isSelected
                              ? "bg-cyan-500/18 border-cyan-400/55 text-cyan-100"
                              : "bg-white/[0.03] border-white/8 text-slate-200 hover:bg-white/[0.07]"
                          } ${!isVisible ? "opacity-50" : ""}`}
                        >
                          <div className="shrink-0 text-cyan-300">
                            {ann.kind === "text" ? (
                              <Type className="w-3.5 h-3.5" />
                            ) : ann.kind === "blur" ? (
                              <Droplets className="w-3.5 h-3.5" />
                            ) : ann.kind === "arrow" ? (
                              <ArrowUpRight className="w-3.5 h-3.5" />
                            ) : (
                              <Square className="w-3.5 h-3.5" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0 truncate text-[11px] font-medium">
                            {label}
                          </div>
                          <div className="flex items-center gap-0.5 shrink-0">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleToggleLayerVisibility(ann.id);
                              }}
                              className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-white/10 cursor-pointer"
                              title={isVisible ? "Ocultar capa" : "Mostrar capa"}
                            >
                              {isVisible ? (
                                <Eye className="w-3 h-3" />
                              ) : (
                                <EyeOff className="w-3 h-3" />
                              )}
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleMoveLayer(ann.id, 1);
                              }}
                              disabled={origIdx === annotations.length - 1}
                              className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-white/10 disabled:opacity-25 cursor-pointer"
                              title="Subir capa"
                            >
                              <ChevronUp className="w-3 h-3" />
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleMoveLayer(ann.id, -1);
                              }}
                              disabled={origIdx === 0}
                              className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-white/10 disabled:opacity-25 cursor-pointer"
                              title="Bajar capa"
                            >
                              <ChevronDown className="w-3 h-3" />
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDuplicateLayer(ann.id);
                              }}
                              className="p-1 rounded-md text-slate-400 hover:text-cyan-200 hover:bg-white/10 cursor-pointer"
                              title="Duplicar capa"
                            >
                              <CopyPlus className="w-3 h-3" />
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteAnnotation(ann.id);
                              }}
                              className="p-1 rounded-md text-slate-400 hover:text-rose-300 hover:bg-rose-500/15 cursor-pointer"
                              title="Eliminar capa"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Base Capture Indicator (always non-destructively preserved) */}
                <div className="px-3 py-2 border-t border-white/10 bg-white/[0.02] flex items-center justify-between text-[10px] text-slate-400">
                  <span>Captura base ({imageWidth}×{imageHeight} px)</span>
                  <span className="text-emerald-300 font-medium">Intacta</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Right Inspector: Real-ESRGAN Upscaling & NVENC/AMF Hardware */}
        <aside
          ref={inspectorRef}
          className="w-80 shrink-0 bg-[#0A0F1B] border-l border-white/10 p-4 overflow-y-auto smooth-scroll space-y-4"
        >
          {/* Card 1: Real-ESRGAN Upscaling */}
          <div className="rounded-2xl bg-white/[0.03] border border-white/10 p-3.5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-cyan-300" />
                <span className="text-xs font-semibold text-slate-100">
                  Real-ESRGAN Upscaler
                </span>
              </div>
              {status?.realesrganInstalled ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-400/35 text-[10px] font-semibold text-emerald-300">
                  <CheckCircle2 className="w-3 h-3" />
                  Vulkan
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-400/35 text-[10px] font-medium text-amber-200">
                  Fallback Lanczos
                </span>
              )}
            </div>

            {/* Activate Upscale Before Save Toggle */}
            <button
              onClick={() => setUpscaleBeforeSave((v) => !v)}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl border text-left transition-all cursor-pointer ${
                upscaleBeforeSave
                  ? "bg-gradient-to-r from-cyan-500/20 to-indigo-500/20 border-cyan-400/50 text-cyan-100 shadow-[0_0_20px_rgba(34,211,238,0.16)]"
                  : "bg-white/[0.03] border-white/10 text-slate-300 hover:bg-white/[0.06]"
              }`}
            >
              <div>
                <div className="text-xs font-semibold">
                  Upscale antes de guardar
                </div>
                <div className="text-[10px] text-slate-400">
                  Mejora resolución automáticamente al exportar
                </div>
              </div>
              <div
                className={`w-9 h-5 rounded-full p-0.5 transition-colors ${
                  upscaleBeforeSave ? "bg-cyan-400" : "bg-slate-700"
                }`}
              >
                <div
                  className={`w-4 h-4 rounded-full bg-slate-950 transition-transform ${
                    upscaleBeforeSave ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </div>
            </button>

            {/* Scale Amount Selector (2x..16x) */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[11px] gap-2">
                <span className="text-slate-400 shrink-0">Factor</span>
                <span className="text-cyan-300 font-semibold text-right truncate">
                  {imageWidth > 0
                    ? `${targetScaledW}×${targetScaledH} px (${projectedMp.toFixed(1)} MP)`
                    : `${scale}x`}
                </span>
              </div>
              {upscaleBeforeSave && imageWidth > 0 && (
                <div className="text-[10px] text-slate-400">
                  Original: {imageWidth}×{imageHeight} → Guardar: {projectedW}×{projectedH}
                </div>
              )}
              <div className="grid grid-cols-5 gap-1">
                {[2, 3, 4, 6, 8].map((s) => (
                  <button
                    key={s}
                    onClick={() => {
                      setScale(s);
                      setPreviewResult(null);
                    }}
                    className={`py-1.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                      scale === s
                        ? "bg-cyan-400 text-slate-950 border-cyan-300 shadow-[0_0_14px_rgba(34,211,238,0.4)]"
                        : "bg-white/5 text-slate-300 border-white/10 hover:bg-white/10"
                    }`}
                  >
                    {s}x
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2 pt-0.5">
                <span className="text-[10px] text-slate-400 whitespace-nowrap">
                  Personalizado
                </span>
                <input
                  type="range"
                  min={2}
                  max={16}
                  step={1}
                  value={scale}
                  onChange={(e) => {
                    setScale(Number(e.target.value));
                    setPreviewResult(null);
                  }}
                  className="flex-1 accent-cyan-400 cursor-pointer"
                />
                <span className="text-[11px] font-bold text-cyan-200 w-7 text-right">
                  {scale}x
                </span>
              </div>
              {exceedsSafeCap ? (
                <div className="rounded-lg bg-rose-500/15 border border-rose-400/35 px-2 py-1 text-[10px] text-rose-200">
                  Excede el límite seguro (16384 px / 100 MP). Recorta primero o reduce la escala.
                </div>
              ) : projectedMp > 50 ? (
                <div className="rounded-lg bg-amber-500/10 border border-amber-400/30 px-2 py-1 text-[10px] text-amber-200">
                  Imagen muy grande ({projectedMp.toFixed(0)} MP): puede tardar unos segundos extra.
                </div>
              ) : null}
            </div>

            {/* Model Selector */}
            <div className="space-y-1.5">
              <label className="block text-[11px] text-slate-400">
                Modelo IA / Escalado
              </label>
              <select
                value={model}
                onChange={(e) => {
                  setModel(e.target.value as UpscaleModel);
                  setPreviewResult(null);
                }}
                className="w-full rounded-xl bg-[#0F1624] border border-white/10 px-2.5 py-2 text-xs text-slate-100 outline-none focus:border-cyan-400/60"
              >
                <option value="realesrgan-x4plus">
                  x4plus · Fotos / General
                </option>
                <option value="realesrgan-x4plus-anime">
                  x4plus-anime · Ilustración / Gráficos
                </option>
                <option value="realesr-animevideov3">
                  animevideov3 · Rápido
                </option>
                <option value="crisp-ui">
                  UI / Texto Puro · Sin IA deformante
                </option>
              </select>
            </div>

            {/* Real-ESRGAN AI Quality Mode */}
            {model !== "crisp-ui" && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] text-slate-400">
                    Modo Real-ESRGAN
                  </label>
                  <span className="text-[10px] text-cyan-300 font-medium">
                    {textProtection === "supersample"
                      ? "100% IA + SSAA texto"
                      : textProtection === "tta"
                        ? "100% IA + TTA 8x"
                        : "100% IA Directa"}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-1">
                  {(
                    [
                      { id: "supersample", label: "IA Nítida" },
                      { id: "tta", label: "TTA 8x" },
                      { id: "raw", label: "Directa" },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      onClick={() => {
                        setTextProtection(opt.id);
                        setPreviewResult(null);
                      }}
                      className={`py-1.5 rounded-lg text-[11px] font-semibold border transition-colors cursor-pointer ${
                        textProtection === opt.id
                          ? "bg-cyan-400/20 border-cyan-400/55 text-cyan-100"
                          : "bg-white/5 border-white/10 text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Preview Upscale Button */}
            <div className="flex gap-1.5">
              <button
                onClick={handlePreviewUpscale}
                disabled={!imageDataUrl || previewing}
                className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-400/40 text-xs font-semibold text-indigo-100 transition-colors cursor-pointer disabled:opacity-45"
              >
                {previewing ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-300" />
                    <span>Procesando {scale}x...</span>
                  </>
                ) : (
                  <>
                    <Eye className="w-3.5 h-3.5 text-cyan-300" />
                    <span>Previsualizar {scale}x</span>
                  </>
                )}
              </button>

              {previewResult && (
                <button
                  onClick={() => setPreviewResult(null)}
                  className="px-2.5 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs text-slate-300 cursor-pointer"
                  title="Cerrar comparación"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Download Real-ESRGAN Engine if not installed */}
            {!status?.realesrganInstalled && (
              <div className="pt-1 border-t border-white/10 space-y-2">
                <button
                  onClick={handleDownloadEngine}
                  disabled={downloading}
                  className="w-full flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl bg-gradient-to-r from-cyan-400 to-indigo-500 hover:brightness-110 disabled:opacity-60 text-slate-950 text-xs font-bold cursor-pointer"
                >
                  {downloading ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Descargando {downloadProgress?.percent ?? 0}%</span>
                    </>
                  ) : (
                    <>
                      <Download className="w-3.5 h-3.5" />
                      <span>Instalar Real-ESRGAN Vulkan</span>
                    </>
                  )}
                </button>
                {downloading && downloadProgress && (
                  <div className="space-y-1">
                    <div className="text-[10px] text-cyan-200 truncate">
                      {downloadProgress.status}
                    </div>
                    <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
                      <div
                        className="h-full bg-cyan-400 transition-all"
                        style={{ width: `${downloadProgress.percent}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Card 2: PNG Presentation Style (Rounded Corners & Soft Shadow) */}
          <div className="rounded-2xl bg-white/[0.03] border border-white/10 p-3.5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Square className="w-4 h-4 text-indigo-300" />
                <span className="text-xs font-semibold text-slate-100">
                  Estilo PNG (Bordes y sombra)
                </span>
              </div>
              {frameOptions.enabled && (
                <span className="px-2 py-0.5 rounded-full bg-indigo-500/15 border border-indigo-400/35 text-[10px] font-semibold text-indigo-200">
                  Alfa
                </span>
              )}
            </div>

            <button
              onClick={() => {
                setFrameOptions((prev) => {
                  const nextEnabled = !prev.enabled;
                  if (nextEnabled) {
                    setFormat("png");
                  }
                  return { ...prev, enabled: nextEnabled };
                });
              }}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl border text-left transition-all cursor-pointer ${
                frameOptions.enabled
                  ? "bg-gradient-to-r from-indigo-500/20 to-cyan-500/20 border-indigo-400/50 text-indigo-100"
                  : "bg-white/[0.03] border-white/10 text-slate-300 hover:bg-white/[0.06]"
              }`}
            >
              <div>
                <div className="text-xs font-semibold">
                  Bordes curvos y sombra
                </div>
                <div className="text-[10px] text-slate-400">
                  Exporta en PNG transparente listo para presentar
                </div>
              </div>
              <div
                className={`w-9 h-5 rounded-full p-0.5 transition-colors shrink-0 ${
                  frameOptions.enabled ? "bg-indigo-400" : "bg-slate-700"
                }`}
              >
                <div
                  className={`w-4 h-4 rounded-full bg-slate-950 transition-transform ${
                    frameOptions.enabled ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </div>
            </button>

            {frameOptions.enabled && (
              <div className="space-y-2.5 pt-0.5">
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-slate-400">Radio de esquinas</span>
                    <span className="text-indigo-200 font-semibold">
                      {frameOptions.borderRadius} px
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={64}
                    step={2}
                    value={frameOptions.borderRadius}
                    onChange={(e) =>
                      setFrameOptions((p) => ({
                        ...p,
                        borderRadius: Number(e.target.value),
                      }))
                    }
                    className="w-full accent-indigo-400 cursor-pointer"
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-slate-400">Sombra</span>
                    <button
                      onClick={() =>
                        setFrameOptions((p) => ({
                          ...p,
                          shadowStrength:
                            p.shadowStrength === "custom" ? "medium" : "custom",
                        }))
                      }
                      className={`px-2 py-0.5 rounded-md text-[10px] font-semibold border transition-colors cursor-pointer ${
                        frameOptions.shadowStrength === "custom"
                          ? "bg-cyan-500/20 border-cyan-400/55 text-cyan-100"
                          : "bg-white/5 border-white/10 text-slate-300 hover:bg-white/10"
                      }`}
                    >
                      Personalizar
                    </button>
                  </div>
                  <div className="grid grid-cols-4 gap-1">
                    {(
                      [
                        { id: "none", label: "No" },
                        { id: "soft", label: "Suave" },
                        { id: "medium", label: "Media" },
                        { id: "strong", label: "Intensa" },
                      ] as const
                    ).map((s) => (
                      <button
                        key={s.id}
                        onClick={() =>
                          setFrameOptions((p) => ({
                            ...p,
                            shadowStrength: s.id,
                          }))
                        }
                        className={`py-1.5 rounded-lg text-[11px] font-semibold border transition-colors cursor-pointer ${
                          frameOptions.shadowStrength === s.id
                            ? "bg-indigo-400/20 border-indigo-400/55 text-indigo-100"
                            : "bg-white/5 border-white/10 text-slate-400 hover:text-slate-200"
                        }`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>

                  {frameOptions.shadowStrength !== "none" &&
                    frameOptions.shadowStrength !== "custom" && (
                      <StyledColorControl
                        label="Color de sombra"
                        value={frameOptions.shadowColor}
                        onChange={(c) =>
                          setFrameOptions((p) => ({ ...p, shadowColor: c }))
                        }
                      />
                    )}

                  {frameOptions.shadowStrength === "custom" && (
                    <div className="space-y-2 rounded-xl bg-white/[0.02] border border-cyan-400/25 p-2.5">
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-0.5">
                          <div className="flex justify-between text-[10px]">
                            <span className="text-slate-400">Distancia X</span>
                            <span className="text-cyan-200">
                              {frameOptions.shadowOffsetX}px
                            </span>
                          </div>
                          <input
                            type="range"
                            min={-60}
                            max={60}
                            value={frameOptions.shadowOffsetX}
                            onChange={(e) =>
                              setFrameOptions((p) => ({
                                ...p,
                                shadowOffsetX: Number(e.target.value),
                              }))
                            }
                            className="w-full accent-cyan-400 cursor-pointer"
                          />
                        </div>
                        <div className="space-y-0.5">
                          <div className="flex justify-between text-[10px]">
                            <span className="text-slate-400">Distancia Y</span>
                            <span className="text-cyan-200">
                              {frameOptions.shadowOffsetY}px
                            </span>
                          </div>
                          <input
                            type="range"
                            min={-60}
                            max={60}
                            value={frameOptions.shadowOffsetY}
                            onChange={(e) =>
                              setFrameOptions((p) => ({
                                ...p,
                                shadowOffsetY: Number(e.target.value),
                              }))
                            }
                            className="w-full accent-cyan-400 cursor-pointer"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-0.5">
                          <div className="flex justify-between text-[10px]">
                            <span className="text-slate-400">Desenfoque</span>
                            <span className="text-cyan-200">
                              {frameOptions.shadowBlur}px
                            </span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            value={frameOptions.shadowBlur}
                            onChange={(e) =>
                              setFrameOptions((p) => ({
                                ...p,
                                shadowBlur: Number(e.target.value),
                              }))
                            }
                            className="w-full accent-cyan-400 cursor-pointer"
                          />
                        </div>
                        <div className="space-y-0.5">
                          <div className="flex justify-between text-[10px]">
                            <span className="text-slate-400">Expansión</span>
                            <span className="text-cyan-200">
                              {frameOptions.shadowSpread}px
                            </span>
                          </div>
                          <input
                            type="range"
                            min={-20}
                            max={40}
                            value={frameOptions.shadowSpread}
                            onChange={(e) =>
                              setFrameOptions((p) => ({
                                ...p,
                                shadowSpread: Number(e.target.value),
                              }))
                            }
                            className="w-full accent-cyan-400 cursor-pointer"
                          />
                        </div>
                      </div>

                      <div className="space-y-0.5">
                        <div className="flex justify-between text-[10px]">
                          <span className="text-slate-400">Opacidad / Intensidad</span>
                          <span className="text-cyan-200 font-semibold">
                            {Math.round(frameOptions.shadowOpacity * 100)}%
                          </span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={frameOptions.shadowOpacity}
                          onChange={(e) =>
                            setFrameOptions((p) => ({
                              ...p,
                              shadowOpacity: Number(e.target.value),
                            }))
                          }
                          className="w-full accent-cyan-400 cursor-pointer"
                        />
                      </div>

                      <StyledColorControl
                        label="Color sombra"
                        value={frameOptions.shadowColor}
                        onChange={(c) =>
                          setFrameOptions((p) => ({ ...p, shadowColor: c }))
                        }
                      />
                    </div>
                  )}
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-slate-400">Margen transparente</span>
                    <span className="text-indigo-200 font-semibold">
                      {frameOptions.padding} px
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={120}
                    step={4}
                    value={frameOptions.padding}
                    onChange={(e) =>
                      setFrameOptions((p) => ({
                        ...p,
                        padding: Number(e.target.value),
                      }))
                    }
                    className="w-full accent-indigo-400 cursor-pointer"
                  />
                </div>

                <label className="flex items-center justify-between text-[11px] text-slate-300 cursor-pointer pt-0.5">
                  <span>Borde de cristal</span>
                  <input
                    type="checkbox"
                    checked={frameOptions.subtleBorder}
                    onChange={(e) =>
                      setFrameOptions((p) => ({
                        ...p,
                        subtleBorder: e.target.checked,
                      }))
                    }
                    className="accent-indigo-400 w-3.5 h-3.5 cursor-pointer"
                  />
                </label>

                {frameOptions.subtleBorder && (
                  <div className="space-y-2 rounded-xl bg-white/[0.02] border border-white/10 p-2.5">
                    <div className="space-y-1">
                      <span className="block text-[10px] text-slate-400">
                        Posición del borde
                      </span>
                      <div className="grid grid-cols-3 gap-1">
                        {(
                          [
                            { id: "inside", label: "Interior" },
                            { id: "center", label: "Centro" },
                            { id: "outside", label: "Exterior" },
                          ] as Array<{ id: BorderPosition; label: string }>
                        ).map((pos) => (
                          <button
                            key={pos.id}
                            onClick={() =>
                              setFrameOptions((p) => ({
                                ...p,
                                borderPosition: pos.id,
                              }))
                            }
                            className={`py-1 rounded-lg text-[10px] font-semibold border transition-colors cursor-pointer ${
                              frameOptions.borderPosition === pos.id
                                ? "bg-indigo-400/25 border-indigo-400/60 text-indigo-100"
                                : "bg-white/5 border-white/10 text-slate-400 hover:text-slate-200"
                            }`}
                          >
                            {pos.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-slate-400">Grosor del borde</span>
                        <span className="text-indigo-200 font-semibold">
                          {frameOptions.borderWidth.toFixed(1)} px
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0.5}
                        max={12}
                        step={0.5}
                        value={frameOptions.borderWidth}
                        onChange={(e) =>
                          setFrameOptions((p) => ({
                            ...p,
                            borderWidth: Number(e.target.value),
                          }))
                        }
                        className="w-full accent-indigo-400 cursor-pointer"
                      />
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-slate-400">Opacidad cristal</span>
                        <span className="text-indigo-200 font-semibold">
                          {Math.round(frameOptions.borderOpacity * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0.05}
                        max={1}
                        step={0.05}
                        value={frameOptions.borderOpacity}
                        onChange={(e) =>
                          setFrameOptions((p) => ({
                            ...p,
                            borderOpacity: Number(e.target.value),
                          }))
                        }
                        className="w-full accent-indigo-400 cursor-pointer"
                      />
                    </div>

                    <StyledColorControl
                      label="Color del borde"
                      value={frameOptions.borderColor}
                      onChange={(c) =>
                        setFrameOptions((p) => ({ ...p, borderColor: c }))
                      }
                    />
                  </div>
                )}

                {(format === "jpg" || format === "hevc-hw") && (
                  <div className="rounded-lg bg-amber-500/10 border border-amber-400/30 px-2 py-1 text-[10px] text-amber-200">
                    El formato {format.toUpperCase()} no soporta transparencia alfa; selecciona PNG o WebP para conservar bordes y sombra transparentes.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Card 3: Hardware Codecs (NVENC & AMF) & Output Format */}
          <div className="rounded-2xl bg-white/[0.03] border border-white/10 p-3.5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Zap className="w-4 h-4 text-amber-300" />
                <span className="text-xs font-semibold text-slate-100">
                  Codecs NVENC & AMF
                </span>
              </div>
              <span className="text-[10px] font-semibold text-cyan-300">
                {status?.gpu.supportsNvenc
                  ? "NVENC Ready"
                  : status?.gpu.supportsAmf
                    ? "AMF Ready"
                    : "GPU"}
              </span>
            </div>

            <div className="rounded-xl bg-[#0F1624] border border-white/10 p-2.5 flex items-center gap-2.5">
              <Cpu className="w-4 h-4 text-cyan-300 shrink-0" />
              <div className="min-w-0">
                <div className="text-xs font-medium text-slate-100 truncate">
                  {status?.gpu.name ?? "Detectando GPU..."}
                </div>
                <div className="text-[10px] text-slate-400">
                  {status?.gpu.vendor} ·{" "}
                  {status?.gpu.vramMb ? `${status.gpu.vramMb} MB VRAM` : "GPU"}
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="block text-[11px] text-slate-400">
                Acelerador de codificación
              </label>
              <div className="grid grid-cols-4 gap-1">
                {(["auto", "nvenc", "amf", "cpu"] as const).map((pref) => (
                  <button
                    key={pref}
                    onClick={() => setCodecPreference(pref)}
                    className={`py-1.5 rounded-lg text-[11px] font-semibold uppercase border transition-colors cursor-pointer ${
                      codecPreference === pref
                        ? "bg-amber-400/20 border-amber-300/60 text-amber-200"
                        : "bg-white/5 border-white/10 text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    {pref}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="block text-[11px] text-slate-400">
                Formato de exportación
              </label>
              <select
                value={format}
                onChange={(e) =>
                  setFormat(
                    e.target.value as "png" | "webp" | "jpg" | "hevc-hw"
                  )
                }
                className="w-full rounded-xl bg-[#0F1624] border border-white/10 px-2.5 py-2 text-xs text-slate-100 outline-none focus:border-cyan-400/60"
              >
                <option value="png">PNG · Sin pérdida (Máxima nitidez)</option>
                <option value="webp">WebP · Alta calidad moderna</option>
                <option value="jpg">JPEG · Calidad 96%</option>
                <option value="hevc-hw">
                  HEVC Hardware (.mp4 · NVENC / AMF)
                </option>
              </select>
            </div>

            {format === "hevc-hw" && !status?.ffmpegInstalled && (
              <div className="rounded-xl bg-amber-500/10 border border-amber-400/30 p-2 text-[10px] text-amber-200">
                Para exportar .mp4 con hevc_nvenc / hevc_amf instala FFmpeg en
                PATH o en {status?.binDir}.
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Animated Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.96 }}
            className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-xl rounded-2xl px-4 py-2.5 border backdrop-blur-xl shadow-2xl flex items-start gap-2.5 ${
              toast.type === "success"
                ? "bg-[#090D16]/95 border-cyan-400/45 text-cyan-100"
                : "bg-[#1A0B12]/95 border-rose-400/45 text-rose-100"
            }`}
          >
            <div className="min-w-0">
              <div className="text-xs font-semibold">{toast.title}</div>
              {toast.detail && (
                <div className="text-[11px] text-slate-300 truncate mt-0.5">
                  {toast.detail}
                </div>
              )}
            </div>
            <button
              onClick={() => setToast(null)}
              className="p-0.5 text-slate-400 hover:text-white cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function StyledColorControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  const presets = ["#FFFFFF", "#22D3EE", "#818CF8", "#F43F5E", "#FBBF24", "#090D16"];
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-slate-400">{label}</span>
        <label className="flex items-center gap-1.5 px-2 py-0.5 rounded-lg bg-[#0F1624] border border-white/15 hover:border-cyan-400/50 transition-colors cursor-pointer">
          <span
            className="w-3 h-3 rounded-full border border-white/30 shadow-inner shrink-0"
            style={{ backgroundColor: value }}
          />
          <span className="font-mono text-[10px] text-slate-200 uppercase">
            {value}
          </span>
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="sr-only"
          />
        </label>
      </div>
      <div className="flex items-center gap-1.5">
        {presets.map((c) => (
          <button
            key={c}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange(c)}
            className={`w-4 h-4 rounded-full border transition-transform cursor-pointer ${
              value.toLowerCase() === c.toLowerCase()
                ? "scale-115 border-white ring-2 ring-cyan-400/60"
                : "border-white/25 hover:scale-110"
            }`}
            style={{ backgroundColor: c }}
            title={c}
          />
        ))}
      </div>
    </div>
  );
}

function ToolRailButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <motion.button
      whileHover={{ scale: 1.06 }}
      whileTap={{ scale: 0.94 }}
      onClick={onClick}
      title={label}
      className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all cursor-pointer border ${
        active
          ? "bg-gradient-to-br from-cyan-400/25 to-indigo-500/25 border-cyan-400/60 text-cyan-200 shadow-[0_0_16px_rgba(34,211,238,0.22)]"
          : "bg-transparent border-transparent text-slate-400 hover:text-slate-100 hover:bg-white/[0.06]"
      }`}
    >
      {icon}
    </motion.button>
  );
}
