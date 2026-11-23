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
  Copy,
  Cpu,
  Crop,
  Download,
  Droplets,
  Eye,
  Loader2,
  Maximize2,
  Minus,
  MousePointer2,
  Redo2,
  Save,
  Sparkles,
  Square,
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
} from "../components/EditorCanvas";
import { useSmoothScroll } from "../hooks/useSmoothScroll";
import type {
  AiQualityMode,
  Annotation,
  AspectPreset,
  CropRect,
  DownloadProgressEvent,
  EditorCapturePayload,
  FrameOptions,
  SaveResult,
  SystemStatus,
  ToolType,
  UpscaleModel,
  UpscalePreviewResult,
} from "../types";

interface HistorySnapshot {
  imageDataUrl: string;
  width: number;
  height: number;
  annotations: Annotation[];
}

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
  const [activeColor, setActiveColor] = useState<string>("#22D3EE");
  const [strokeWidth, setStrokeWidth] = useState<number>(4);
  const [fontSize, setFontSize] = useState<number>(26);
  const [textBold, setTextBold] = useState<boolean>(true);
  const [textHasPill, setTextHasPill] = useState<boolean>(true);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [fitNonce, setFitNonce] = useState<number>(0);
  const inspectorRef = useRef<HTMLElement | null>(null);
  useSmoothScroll(inspectorRef);

  const handleZoomChange = useCallback((next: number | "fit") => {
    setZoom(next);
    if (next === "fit") {
      setFitNonce((n) => n + 1);
    }
  }, []);

  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [aspectPreset, setAspectPreset] = useState<AspectPreset>("free");

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
      { imageDataUrl, width: imageWidth, height: imageHeight, annotations },
    ]);
    setFuture([]);
  }, [imageDataUrl, imageWidth, imageHeight, annotations]);

  const handleUndo = useCallback(() => {
    setPast((prevPast) => {
      if (prevPast.length === 0) return prevPast;
      const last = prevPast[prevPast.length - 1];
      setFuture((f) => [
        { imageDataUrl, width: imageWidth, height: imageHeight, annotations },
        ...f,
      ]);
      setImageDataUrl(last.imageDataUrl);
      setImageWidth(last.width);
      setImageHeight(last.height);
      setAnnotations(last.annotations);
      setSelectedId(null);
      setPreviewResult(null);
      return prevPast.slice(0, -1);
    });
  }, [imageDataUrl, imageWidth, imageHeight, annotations]);

  const handleRedo = useCallback(() => {
    setFuture((prevFuture) => {
      if (prevFuture.length === 0) return prevFuture;
      const next = prevFuture[0];
      setPast((p) => [
        ...p,
        { imageDataUrl, width: imageWidth, height: imageHeight, annotations },
      ]);
      setImageDataUrl(next.imageDataUrl);
      setImageWidth(next.width);
      setImageHeight(next.height);
      setAnnotations(next.annotations);
      setSelectedId(null);
      setPreviewResult(null);
      return prevFuture.slice(1);
    });
  }, [imageDataUrl, imageWidth, imageHeight, annotations]);

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

  const handleApplyCrop = useCallback(async () => {
    if (!cropRect || cropRect.width < 6 || cropRect.height < 6) return;
    try {
      pushHistory();
      const croppedDataUrl = await renderCompositeDataUrl(
        imageDataUrl,
        annotations,
        cropRect
      );
      setImageDataUrl(croppedDataUrl);
      setImageWidth(Math.round(cropRect.width));
      setImageHeight(Math.round(cropRect.height));
      setAnnotations([]);
      setCropRect(null);
      setSelectedId(null);
      setPreviewResult(null);
      setTool("select");
      showToast(
        "success",
        "Recorte aplicado",
        `${Math.round(cropRect.width)} × ${Math.round(cropRect.height)} px`
      );
    } catch (err) {
      showToast("error", "No se pudo aplicar el recorte", String(err));
    }
  }, [cropRect, pushHistory, imageDataUrl, annotations, showToast]);

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
      else if (key === "c") setTool("crop");
      else if (key === "t") setTool("text");
      else if (key === "a") setTool("arrow");
      else if (key === "r") setTool("rect");
      else if (key === "b") setTool("blur");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleUndo, handleRedo, handleDeleteAnnotation, selectedId]);

  // Sync style changes with currently selected annotation
  const selectedAnn = useMemo(
    () => annotations.find((a) => a.id === selectedId) ?? null,
    [annotations, selectedId]
  );

  useEffect(() => {
    if (!selectedAnn) return;
    if (selectedAnn.kind === "text") {
      setActiveColor(selectedAnn.color);
      setFontSize(selectedAnn.fontSize);
      setTextBold(selectedAnn.bold);
      setTextHasPill(selectedAnn.hasPill);
    } else if (selectedAnn.kind === "rect" || selectedAnn.kind === "arrow") {
      setActiveColor(selectedAnn.color);
      setStrokeWidth(selectedAnn.strokeWidth);
    }
  }, [selectedAnn]);

  const applyColor = (c: string) => {
    setActiveColor(c);
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

  const applyFontSize = (sz: number) => {
    setFontSize(sz);
    if (selectedAnn?.kind === "text") {
      handleUpdateAnnotation(selectedAnn.id, { fontSize: sz }, true);
    }
  };

  const toggleBold = () => {
    const next = !textBold;
    setTextBold(next);
    if (selectedAnn?.kind === "text") {
      handleUpdateAnnotation(selectedAnn.id, { bold: next }, true);
    }
  };

  const togglePill = () => {
    const next = !textHasPill;
    setTextHasPill(next);
    if (selectedAnn?.kind === "text") {
      handleUpdateAnnotation(selectedAnn.id, { hasPill: next }, true);
    }
  };

  const runUpscaleWithCrispVectors = useCallback(async () => {
    const hasVectors = annotations.some((a) => a.kind !== "blur");
    const withinCanvasCap =
      imageWidth * scale <= 8192 && imageHeight * scale <= 8192;

    if (hasVectors && withinCanvasCap) {
      const baseWithBlurs = await renderBaseWithBlursDataUrl(
        imageDataUrl,
        annotations
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
        scale
      );
      return {
        ...res,
        imageDataUrl: finalUrl,
        engine: `${res.engine} + vectores ${scale}x`,
      };
    }

    const compositeUrl = await renderCompositeDataUrl(imageDataUrl, annotations);
    return invoke<UpscalePreviewResult>("preview_upscale", {
      imageBase64: compositeUrl,
      scale,
      model,
      textProtection,
    });
  }, [annotations, imageDataUrl, imageWidth, imageHeight, scale, model, textProtection]);

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
      const hasVectors = annotations.some((a) => a.kind !== "blur");
      const withinCanvasCap =
        imageWidth * scale <= 8192 && imageHeight * scale <= 8192;

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
          annotations
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
      const hasVectors = annotations.some((a) => a.kind !== "blur");
      const withinCanvasCap =
        imageWidth * scale <= 8192 && imageHeight * scale <= 8192;

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
        payloadUrl = await renderCompositeDataUrl(imageDataUrl, annotations);
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

  const projectedW = upscaleBeforeSave ? imageWidth * scale : imageWidth;
  const projectedH = upscaleBeforeSave ? imageHeight * scale : imageHeight;
  const targetScaledW = imageWidth * scale;
  const targetScaledH = imageHeight * scale;
  const projectedMp = (targetScaledW * targetScaledH) / 1_000_000;
  const exceedsSafeCap =
    targetScaledW > 16384 || targetScaledH > 16384 || projectedMp > 100;
  const showTextControls = tool === "text" || selectedAnn?.kind === "text";

  return (
    <div className="w-screen h-screen flex flex-col bg-[#070B13] text-slate-100 border border-white/10 overflow-hidden">
      {/* Custom Modern Dark Titlebar */}
      <header
        data-tauri-drag-region
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
              {imageWidth} × {imageHeight} px
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
            onClick={() => getCurrentWindow().toggleMaximize()}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            title="Maximizar / Restaurar"
          >
            <Maximize2 className="w-3.5 h-3.5" />
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
        ) : (
          <div className="flex items-center gap-2.5">
            {/* Color Swatches */}
            <div className="flex items-center gap-1">
              {COLOR_SWATCHES.map((c) => (
                <button
                  key={c}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyColor(c)}
                  className={`w-5 h-5 rounded-full border transition-transform cursor-pointer ${
                    activeColor === c
                      ? "scale-115 border-white ring-2 ring-cyan-400/60"
                      : "border-white/25 hover:scale-105"
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>

            <div className="h-4 w-px bg-white/10" />

            {showTextControls ? (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-slate-400">Tamaño</span>
                <input
                  type="range"
                  min={14}
                  max={72}
                  value={fontSize}
                  onChange={(e) => applyFontSize(Number(e.target.value))}
                  className="w-20 accent-cyan-400 cursor-pointer"
                />
                <span className="text-[11px] text-slate-200 w-7">
                  {fontSize}
                </span>
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={toggleBold}
                  className={`p-1.5 rounded-lg border text-xs cursor-pointer ${
                    textBold
                      ? "bg-cyan-500/20 border-cyan-400/50 text-cyan-200"
                      : "bg-white/5 border-white/10 text-slate-400"
                  }`}
                  title="Negrita"
                >
                  <Bold className="w-3.5 h-3.5" />
                </button>
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={togglePill}
                  className={`px-2 py-1 rounded-lg border text-[11px] font-medium cursor-pointer ${
                    textHasPill
                      ? "bg-cyan-500/20 border-cyan-400/50 text-cyan-200"
                      : "bg-white/5 border-white/10 text-slate-400"
                  }`}
                  title="Fondo oscuro legible"
                >
                  Fondo
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-slate-400">Grosor</span>
                <input
                  type="range"
                  min={2}
                  max={12}
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
            label="Recortar captura (C)"
            onClick={() => {
              setPreviewResult(null);
              setTool("crop");
            }}
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

        {/* Center Interactive Stage */}
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
            fontSize={fontSize}
            textBold={textBold}
            textHasPill={textHasPill}
            zoom={zoom}
            fitNonce={fitNonce}
            cropRect={cropRect}
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
                    min={4}
                    max={48}
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

                <div className="space-y-1">
                  <span className="block text-[11px] text-slate-400">
                    Intensidad de sombra
                  </span>
                  <div className="grid grid-cols-3 gap-1">
                    {(
                      [
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
                    min={16}
                    max={96}
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
                  <span>Borde cristal sutil</span>
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
