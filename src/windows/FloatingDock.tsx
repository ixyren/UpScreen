import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { motion } from "framer-motion";
import {
  AppWindow,
  EyeOff,
  GripVertical,
  Loader2,
  Monitor,
  Scissors,
  Sparkles,
} from "lucide-react";
import type { CaptureMode, RegisteredShortcuts, SystemStatus } from "../types";

export default function FloatingDock() {
  const [shortcuts, setShortcuts] = useState<RegisteredShortcuts>({
    region: "Ctrl+Shift+S",
    window: "Ctrl+Shift+W",
    fullscreen: "Ctrl+Shift+F",
  });
  const [capturing, setCapturing] = useState<boolean>(false);

  useEffect(() => {
    invoke<SystemStatus>("get_system_status")
      .then((res) => {
        if (res.shortcuts?.region) {
          setShortcuts(res.shortcuts);
        }
      })
      .catch(() => {});

    // Keep dock compact and centered at bottom
    invoke("resize_dock", { width: 470, height: 64 }).catch(() => {});
    // Disable auto-upscale before editor so all AI magic happens inside Editor
    invoke("sync_dock_settings", {
      autoUpscale: false,
      scale: 2,
      model: "realesrgan-x4plus",
      textProtection: "supersample",
    }).catch(() => {});

    let unlistenShortcuts: (() => void) | undefined;
    listen<RegisteredShortcuts>("shortcuts-updated", (event) => {
      if (event.payload) setShortcuts(event.payload);
    }).then((u) => {
      unlistenShortcuts = u;
    });

    return () => {
      unlistenShortcuts?.();
    };
  }, []);

  const triggerCapture = useCallback(async (mode: CaptureMode) => {
    setCapturing(true);
    try {
      await invoke("start_capture", {
        mode,
        autoUpscale: false,
        scale: 2,
        model: "realesrgan-x4plus",
        textProtection: "supersample",
      });
    } catch (err) {
      console.error("Error iniciando captura:", err);
    } finally {
      setCapturing(false);
    }
  }, []);

  return (
    <div className="w-full h-full p-1.5 flex flex-col items-center justify-end bg-transparent">
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 420, damping: 32 }}
        className="relative w-full rounded-2xl bg-[#090D16]/94 backdrop-blur-2xl border border-white/15 px-2.5 py-2 flex items-center gap-1.5"
      >
        {/* Drag Handle + Brand Logo */}
        <div
          data-tauri-drag-region
          className="flex items-center gap-1.5 pl-1 pr-1.5 py-1 rounded-xl cursor-grab active:cursor-grabbing hover:bg-white/5 transition-colors shrink-0 whitespace-nowrap"
          title="Arrastrar menú flotante"
        >
          <GripVertical className="w-3.5 h-3.5 text-slate-500 pointer-events-none" />
          <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-cyan-400 to-indigo-500 flex items-center justify-center shadow-[0_0_12px_rgba(34,211,238,0.45)] pointer-events-none">
            {capturing ? (
              <Loader2 className="w-3.5 h-3.5 text-slate-950 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5 text-slate-950" />
            )}
          </div>
          <span className="text-xs font-semibold tracking-tight text-slate-100 pointer-events-none">
            UpScreen
          </span>
        </div>

        <div className="h-5 w-px bg-white/10 shrink-0" />

        {/* Capture Action Buttons */}
        <div className="flex items-center gap-1.5 shrink-0">
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

        <div className="flex-1 min-w-1" />

        {/* Hide to System Tray */}
        <button
          onClick={() => getCurrentWindow().hide()}
          title="Ocultar a la bandeja del sistema"
          className="p-1.5 rounded-xl text-slate-400 hover:text-slate-100 hover:bg-white/10 transition-colors cursor-pointer shrink-0"
        >
          <EyeOff className="w-4 h-4" />
        </button>
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
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.11] border border-white/[0.07] hover:border-white/20 text-xs font-medium text-slate-100 transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
    >
      {icon}
      <span>{label}</span>
    </motion.button>
  );
}
