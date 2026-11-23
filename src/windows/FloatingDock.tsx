import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AnimatePresence, motion } from "framer-motion";
import {
  AppWindow,
  CheckCircle2,
  Cpu,
  Download,
  EyeOff,
  GripVertical,
  Loader2,
  Monitor,
  Scissors,
  SlidersHorizontal,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import type {
  AiQualityMode,
  CaptureMode,
  DownloadProgressEvent,
  RegisteredShortcuts,
  SystemStatus,
  UpscaleModel,
} from "../types";

export default function FloatingDock() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [shortcuts, setShortcuts] = useState<RegisteredShortcuts>({
    region: "Ctrl+Shift+S",
    window: "Ctrl+Shift+W",
    fullscreen: "Ctrl+Shift+F",
  });
  const [autoUpscale, setAutoUpscale] = useState<boolean>(false);
  const [scale, setScale] = useState<number>(2);
  const [model, setModel] = useState<UpscaleModel>("realesrgan-x4plus");
  const [textProtection, setTextProtection] =
    useState<AiQualityMode>("supersample");
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  const [capturing, setCapturing] = useState<boolean>(false);
  const [downloading, setDownloading] = useState<boolean>(false);
  const [downloadProgress, setDownloadProgress] =
    useState<DownloadProgressEvent | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const settingsRef = useRef({ autoUpscale, scale, model, textProtection });
  settingsRef.current = { autoUpscale, scale, model, textProtection };

  const loadStatus = useCallback(async () => {
    try {
      const res = await invoke<SystemStatus>("get_system_status");
      setStatus(res);
      if (res.shortcuts && res.shortcuts.region) {
        setShortcuts(res.shortcuts);
      }
    } catch (err) {
      console.error("Error cargando estado del sistema:", err);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    invoke("sync_dock_settings", {
      autoUpscale,
      scale,
      model,
      textProtection,
    }).catch(() => {});
  }, [autoUpscale, scale, model, textProtection]);

  useEffect(() => {
    const targetWidth = autoUpscale ? 835 : 690;
    const targetHeight = drawerOpen ? 410 : 76;
    invoke("resize_dock", { width: targetWidth, height: targetHeight }).catch(
      () => {}
    );
  }, [autoUpscale, drawerOpen]);

  const triggerCapture = useCallback(async (mode: CaptureMode) => {
    setErrorMsg(null);
    setCapturing(true);
    try {
      const {
        autoUpscale: au,
        scale: sc,
        model: md,
        textProtection: tp,
      } = settingsRef.current;
      await invoke("start_capture", {
        mode,
        autoUpscale: au,
        scale: sc,
        model: md,
        textProtection: tp,
      });
    } catch (err) {
      setErrorMsg(String(err));
    } finally {
      setCapturing(false);
    }
  }, []);

  useEffect(() => {
    let unlistenShortcuts: (() => void) | undefined;
    let unlistenDownload: (() => void) | undefined;

    listen<RegisteredShortcuts>("shortcuts-updated", (event) => {
      if (event.payload) {
        setShortcuts(event.payload);
      }
    }).then((u) => {
      unlistenShortcuts = u;
    });

    listen<DownloadProgressEvent>("engine-download-progress", (event) => {
      setDownloadProgress(event.payload);
    }).then((u) => {
      unlistenDownload = u;
    });

    return () => {
      unlistenShortcuts?.();
      unlistenDownload?.();
    };
  }, []);

  const handleDownloadEngine = async () => {
    setErrorMsg(null);
    setDownloading(true);
    setDownloadProgress({
      percent: 2,
      status: "Iniciando descarga de Real-ESRGAN Vulkan...",
    });
    try {
      await invoke("download_realesrgan_engine");
      await loadStatus();
    } catch (err) {
      setErrorMsg(String(err));
    } finally {
      setDownloading(false);
    }
  };

  const gpuLabel = (() => {
    if (!status) return "GPU...";
    if (status.gpu.supportsNvenc) return "NVENC";
    if (status.gpu.supportsAmf) return "AMF";
    if (status.gpu.vendor === "Intel") return "QSV";
    return "GPU";
  })();

  return (
    <div className="w-full h-full p-1.5 flex flex-col items-center justify-end bg-transparent">
      {/* Expandable Motor IA & Hardware Codecs Drawer (abre hacia arriba) */}
      <AnimatePresence>
        {drawerOpen && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 420, damping: 32 }}
            className="mb-2 w-full rounded-2xl bg-[#090D16]/95 backdrop-blur-2xl border border-white/15 p-3.5 text-xs space-y-3"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-cyan-300" />
                <div>
                  <div className="font-semibold text-slate-100">
                    {status?.gpu.name ?? "Detectando adaptador GPU..."}
                  </div>
                  <div className="text-[11px] text-slate-400">
                    {status?.gpu.vendor} ·{" "}
                    {status?.gpu.vramMb
                      ? `${status.gpu.vramMb} MB VRAM`
                      : "VRAM compartida"}{" "}
                    · Aceleración:{" "}
                    <span className="text-cyan-300 font-medium">
                      {status?.gpu.supportsNvenc
                        ? "NVIDIA NVENC"
                        : status?.gpu.supportsAmf
                          ? "AMD AMF"
                          : "Vulkan / CPU"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${
                    status?.ffmpegInstalled
                      ? "bg-emerald-500/15 border-emerald-400/35 text-emerald-200"
                      : "bg-slate-800/70 border-white/10 text-slate-400"
                  }`}
                >
                  {status?.ffmpegInstalled
                    ? status.encoders.hevcNvenc
                      ? "HEVC NVENC listo"
                      : status.encoders.hevcAmf
                        ? "HEVC AMF listo"
                        : "FFmpeg listo"
                    : "FFmpeg opcional"}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              {/* Default Model Selector */}
              <div className="rounded-xl bg-white/[0.03] border border-white/10 p-2.5 space-y-2">
                <div className="text-[11px] font-medium text-slate-300">
                  Modelo Real-ESRGAN predeterminado
                </div>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value as UpscaleModel)}
                  className="w-full rounded-lg bg-[#0F1624] border border-white/10 px-2 py-1.5 text-[11px] text-slate-100 outline-none focus:border-cyan-400/60"
                >
                  <option value="realesrgan-x4plus">
                    x4plus (Fotos / General)
                  </option>
                  <option value="realesrgan-x4plus-anime">
                    x4plus-anime (Ilustración / Gráficos)
                  </option>
                  <option value="realesr-animevideov3">
                    animevideov3 (Rápido 2x/3x/4x)
                  </option>
                  <option value="crisp-ui">
                    UI / Texto Puro (Sin deformación IA)
                  </option>
                </select>
                {model !== "crisp-ui" && (
                  <div className="flex items-center justify-between gap-1.5 pt-0.5">
                    <span className="text-[10px] text-slate-400">
                      Modo IA:
                    </span>
                    <div className="flex items-center gap-1">
                      {(
                        [
                          { id: "supersample", label: "IA Nítida" },
                          { id: "tta", label: "TTA 8x" },
                          { id: "raw", label: "Directa" },
                        ] as const
                      ).map((opt) => (
                        <button
                          key={opt.id}
                          onClick={() => setTextProtection(opt.id)}
                          className={`px-2 py-0.5 rounded-md text-[10px] font-semibold border transition-colors cursor-pointer ${
                            textProtection === opt.id
                              ? "bg-cyan-400/20 border-cyan-400/50 text-cyan-100"
                              : "bg-white/5 border-white/10 text-slate-400 hover:text-slate-200"
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Real-ESRGAN Vulkan Engine Status / Installer */}
              <div className="rounded-xl bg-white/[0.03] border border-white/10 p-2.5 flex flex-col justify-between gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-slate-300">
                    Motor Real-ESRGAN Vulkan
                  </span>
                  {status?.realesrganInstalled ? (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-300">
                      <CheckCircle2 className="w-3 h-3" />
                      Instalado
                    </span>
                  ) : (
                    <span className="text-[10px] text-amber-300">
                      No descargado (usa Lanczos3)
                    </span>
                  )}
                </div>

                {!status?.realesrganInstalled ? (
                  <button
                    onClick={handleDownloadEngine}
                    disabled={downloading}
                    className="w-full flex items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan-500 to-indigo-500 hover:brightness-110 disabled:opacity-60 text-slate-950 font-semibold py-1.5 px-2 text-[11px] transition-all cursor-pointer"
                  >
                    {downloading ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>{downloadProgress?.percent ?? 0}%</span>
                      </>
                    ) : (
                      <>
                        <Download className="w-3.5 h-3.5" />
                        <span>Descargar Motor IA (1-clic)</span>
                      </>
                    )}
                  </button>
                ) : (
                  <div className="text-[10px] text-slate-400 truncate">
                    GPU Vulkan activa · {status.realesrganPath}
                  </div>
                )}
              </div>
            </div>

            {downloading && downloadProgress && (
              <div className="space-y-1">
                <div className="flex justify-between text-[10px] text-cyan-200">
                  <span>{downloadProgress.status}</span>
                  <span>{downloadProgress.percent}%</span>
                </div>
                <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
                  <motion.div
                    className="h-full bg-gradient-to-r from-cyan-400 to-indigo-400"
                    animate={{ width: `${downloadProgress.percent}%` }}
                    transition={{ ease: "easeOut", duration: 0.2 }}
                  />
                </div>
              </div>
            )}

            {errorMsg && (
              <div className="rounded-lg bg-rose-500/15 border border-rose-400/30 px-2.5 py-1.5 text-[11px] text-rose-200">
                {errorMsg}
              </div>
            )}

            <div className="flex items-center justify-between text-[10px] text-slate-400 pt-0.5 border-t border-white/5">
              <span>
                Atajos: {shortcuts.region} (Recorte) · {shortcuts.window} (Ventana) · {shortcuts.fullscreen} (Pantalla)
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating Obsidian Glass Pill (sin sombra externa, abajo centrado) */}
      <motion.div
        layout
        initial={{ opacity: 0, y: 10, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 420, damping: 32 }}
        className="relative w-full rounded-2xl bg-[#090D16]/94 backdrop-blur-2xl border border-white/15 px-2.5 py-2 flex items-center gap-1.5"
      >
        {/* Drag Handle + Brand */}
        <div
          data-tauri-drag-region
          className="flex items-center gap-1.5 pl-1 pr-1.5 py-1 rounded-xl cursor-grab active:cursor-grabbing hover:bg-white/5 transition-colors shrink-0 whitespace-nowrap"
          title="Arrastrar menú flotante"
        >
          <GripVertical className="w-3.5 h-3.5 text-slate-500 pointer-events-none" />
          <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-cyan-400 to-indigo-500 flex items-center justify-center shadow-[0_0_12px_rgba(34,211,238,0.45)] pointer-events-none">
            <Sparkles className="w-3.5 h-3.5 text-slate-950" />
          </div>
          <span className="text-xs font-semibold tracking-tight text-slate-100 pointer-events-none">
            UpScreen
          </span>
        </div>

        <div className="h-5 w-px bg-white/10 shrink-0" />

        {/* Capture Action Buttons */}
        <div className="flex items-center gap-1 shrink-0">
          <DockActionButton
            icon={<Scissors className="w-3.5 h-3.5 text-cyan-300" />}
            label="Recorte"
            shortcut={shortcuts.region}
            disabled={capturing}
            onClick={() => triggerCapture("region")}
          />
          <DockActionButton
            icon={<AppWindow className="w-3.5 h-3.5 text-indigo-300" />}
            label="Ventana"
            shortcut={shortcuts.window}
            disabled={capturing}
            onClick={() => triggerCapture("window")}
          />
          <DockActionButton
            icon={<Monitor className="w-3.5 h-3.5 text-emerald-300" />}
            label="Pantalla"
            shortcut={shortcuts.fullscreen}
            disabled={capturing}
            onClick={() => triggerCapture("fullscreen")}
          />
        </div>

        <div className="h-5 w-px bg-white/10 shrink-0" />

        {/* Real-ESRGAN Auto Upscale Toggle + Scale Chips */}
        <div className="flex items-center gap-1 shrink-0">
          <motion.button
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.96 }}
            onClick={() => setAutoUpscale((v) => !v)}
            title="Activar mejora automática con Real-ESRGAN al capturar"
            className={`flex items-center gap-1.5 px-2 py-1.5 rounded-xl text-xs font-medium transition-all cursor-pointer border whitespace-nowrap shrink-0 ${
              autoUpscale
                ? "bg-gradient-to-r from-cyan-500/25 to-indigo-500/25 border-cyan-400/50 text-cyan-100 shadow-[0_0_16px_rgba(34,211,238,0.28)]"
                : "bg-white/[0.04] border-white/10 text-slate-400 hover:text-slate-200 hover:bg-white/[0.08]"
            }`}
          >
            {capturing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-300" />
            ) : (
              <Sparkles
                className={`w-3.5 h-3.5 ${
                  autoUpscale ? "text-cyan-300" : "text-slate-400"
                }`}
              />
            )}
            <span>AI</span>
          </motion.button>

          <AnimatePresence initial={false}>
            {autoUpscale && (
              <motion.div
                initial={{ opacity: 0, width: 0, scale: 0.9 }}
                animate={{ opacity: 1, width: "auto", scale: 1 }}
                exit={{ opacity: 0, width: 0, scale: 0.9 }}
                transition={{ duration: 0.18 }}
                className="flex items-center gap-0.5 bg-white/[0.05] border border-white/10 rounded-xl p-0.5 overflow-hidden shrink-0"
              >
                {[2, 3, 4, 6, 8].map((s) => (
                  <button
                    key={s}
                    onClick={() => setScale(s)}
                    className={`px-1.5 py-1 rounded-lg text-[11px] font-semibold transition-all cursor-pointer whitespace-nowrap ${
                      scale === s
                        ? "bg-cyan-400 text-slate-950 shadow-[0_0_10px_rgba(34,211,238,0.5)]"
                        : "text-slate-300 hover:bg-white/10"
                    }`}
                  >
                    {s}x
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="flex-1 min-w-1" />

        {/* GPU / Engine Settings Pill */}
        <motion.button
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.96 }}
          onClick={() => setDrawerOpen((v) => !v)}
          title="Motor Real-ESRGAN y Aceleración NVENC / AMF"
          className={`flex items-center gap-1.5 px-2 py-1.5 rounded-xl text-[11px] font-medium border transition-all cursor-pointer shrink-0 whitespace-nowrap ${
            drawerOpen
              ? "bg-indigo-500/25 border-indigo-400/50 text-indigo-100"
              : "bg-white/[0.04] border-white/10 text-slate-300 hover:bg-white/[0.09]"
          }`}
        >
          <Zap className="w-3 h-3 text-amber-300" />
          <span>{gpuLabel}</span>
          <SlidersHorizontal className="w-3 h-3 text-slate-400" />
        </motion.button>

        {/* Hide to Tray & Close */}
        <div className="flex items-center gap-0.5 pl-0.5 shrink-0">
          <button
            onClick={() => getCurrentWindow().hide()}
            title="Ocultar a la bandeja del sistema"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-white/10 transition-colors cursor-pointer"
          >
            <EyeOff className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => invoke("quit_app")}
            title="Salir de UpScreen"
            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-rose-500/15 transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function DockActionButton({
  icon,
  label,
  shortcut,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      whileHover={{ scale: 1.04, y: -1 }}
      whileTap={{ scale: 0.95 }}
      disabled={disabled}
      onClick={onClick}
      title={`${label} (${shortcut})`}
      className="flex items-center gap-1.5 px-2 py-1.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.11] border border-white/[0.07] hover:border-white/20 text-xs font-medium text-slate-100 transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
    >
      {icon}
      <span>{label}</span>
    </motion.button>
  );
}
