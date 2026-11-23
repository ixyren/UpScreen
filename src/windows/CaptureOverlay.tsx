import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AnimatePresence, motion } from "framer-motion";
import { AppWindow, Layers, Monitor, Scissors, Sparkles, X } from "lucide-react";
import type { MonitorRect, OverlaySessionPayload, WindowRect } from "../types";
import { playCaptureShutter } from "../utils/sound";

interface DragState {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

interface FlashRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export default function CaptureOverlay() {
  const [session, setSession] = useState<OverlaySessionPayload | null>(null);
  const [mode, setMode] = useState<"region" | "window" | "monitor">("region");
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hoveredWin, setHoveredWin] = useState<WindowRect | null>(null);
  const [hoveredMonitor, setHoveredMonitor] = useState<MonitorRect | null>(null);
  const [flashRect, setFlashRect] = useState<FlashRect | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [shiftHeld, setShiftHeld] = useState<boolean>(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const shownSessionIdRef = useRef<number | null>(null);

  const notifyOverlayReady = useCallback((sessionId: number) => {
    if (shownSessionIdRef.current === sessionId) return;
    shownSessionIdRef.current = sessionId;
    requestAnimationFrame(() => {
      invoke("show_ready_overlay").catch(() => {});
    });
  }, []);

  const loadSession = useCallback(async () => {
    try {
      const payload = await invoke<OverlaySessionPayload>("get_overlay_session");
      setSession(payload);
      setMode(
        payload.mode === "window"
          ? "window"
          : payload.mode === "monitor"
            ? "monitor"
            : "region"
      );
      setDrag(null);
      setHoveredWin(null);
      const primary =
        payload.monitors?.find((m) => m.isPrimary) ??
        payload.monitors?.[0] ??
        null;
      setHoveredMonitor(primary);
      setFlashRect(null);
      setSubmitting(false);
      setShiftHeld(false);
    } catch (err) {
      console.error("Error cargando overlay:", err);
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    if (imgRef.current?.complete && imgRef.current.naturalWidth > 0) {
      notifyOverlayReady(session.sessionId);
      return;
    }
    const timer = window.setTimeout(() => {
      notifyOverlayReady(session.sessionId);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [session, notifyOverlayReady]);

  useEffect(() => {
    loadSession();
    let unlisten: (() => void) | undefined;
    listen("overlay-updated", () => {
      loadSession();
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      unlisten?.();
    };
  }, [loadSession]);

  const cancelCapture = useCallback(async () => {
    setDrag(null);
    setHoveredWin(null);
    setFlashRect(null);
    setShiftHeld(false);
    setSession(null);
    await invoke("cancel_overlay_capture").catch(() => {});
  }, []);

  const getScale = useCallback(() => {
    if (!session || window.innerWidth === 0 || window.innerHeight === 0) {
      return { sx: 1, sy: 1 };
    }
    return {
      sx: session.width / window.innerWidth,
      sy: session.height / window.innerHeight,
    };
  }, [session]);

  const confirmRect = useCallback(
    async (x: number, y: number, width: number, height: number) => {
      if (submitting || width < 6 || height < 6) return;
      setSubmitting(true);
      playCaptureShutter();

      const { sx, sy } = getScale();
      setFlashRect({
        x: x / sx,
        y: y / sy,
        w: width / sx,
        h: height / sy,
      });

      await new Promise((r) => setTimeout(r, 195));
      setFlashRect(null);
      setSession(null);

      try {
        await invoke("confirm_overlay_capture", { x, y, width, height });
      } catch (err) {
        console.error("Error confirmando captura:", err);
        setSubmitting(false);
      }
    },
    [submitting, getScale]
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        setShiftHeld(true);
        return;
      }
      if (e.key === "Escape") {
        cancelCapture();
        return;
      }
      if (
        mode === "monitor" &&
        !submitting &&
        (e.key === "Enter" || e.key === " ")
      ) {
        e.preventDefault();
        const target =
          hoveredMonitor ??
          session?.monitors?.find((m) => m.isPrimary) ??
          session?.monitors?.[0];
        if (target) {
          confirmRect(target.x, target.y, target.width, target.height);
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        setShiftHeld(false);
      }
    };
    const onBlur = () => setShiftHeld(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [cancelCapture, mode, submitting, hoveredMonitor, session, confirmRect]);

  const cssSelection = useMemo(() => {
    if (!drag) return null;
    if (shiftHeld) {
      const dx = drag.currentX - drag.startX;
      const dy = drag.currentY - drag.startY;
      const dirX = dx < 0 ? -1 : 1;
      const dirY = dy < 0 ? -1 : 1;
      const maxW = dirX < 0 ? drag.startX : window.innerWidth - drag.startX;
      const maxH = dirY < 0 ? drag.startY : window.innerHeight - drag.startY;
      const side = Math.min(Math.max(Math.abs(dx), Math.abs(dy)), maxW, maxH);
      const endX = drag.startX + dirX * side;
      const endY = drag.startY + dirY * side;
      return {
        x: Math.min(drag.startX, endX),
        y: Math.min(drag.startY, endY),
        w: side,
        h: side,
      };
    }
    const x = Math.min(drag.startX, drag.currentX);
    const y = Math.min(drag.startY, drag.currentY);
    const w = Math.abs(drag.currentX - drag.startX);
    const h = Math.abs(drag.currentY - drag.startY);
    return { x, y, w, h };
  }, [drag, shiftHeld]);

  const physSelection = useMemo(() => {
    if (!cssSelection) return null;
    const { sx, sy } = getScale();
    const x = Math.max(0, Math.round(cssSelection.x * sx));
    const y = Math.max(0, Math.round(cssSelection.y * sy));
    if (shiftHeld) {
      const maxSide = session
        ? Math.min(session.width - x, session.height - y)
        : Number.POSITIVE_INFINITY;
      const side = Math.max(
        1,
        Math.min(Math.round(cssSelection.w * sx), maxSide)
      );
      return { x, y, width: side, height: side };
    }
    return {
      x,
      y,
      width: Math.max(1, Math.round(cssSelection.w * sx)),
      height: Math.max(1, Math.round(cssSelection.h * sy)),
    };
  }, [cssSelection, getScale, shiftHeld, session]);

  const handleMouseDown = (e: React.MouseEvent) => {
    setShiftHeld(e.shiftKey);
    if (e.button === 2) {
      cancelCapture();
      return;
    }
    if (e.button !== 0 || submitting) return;
    if ((e.target as HTMLElement).closest("[data-overlay-toolbar]")) return;

    if (mode === "region") {
      setDrag({
        startX: e.clientX,
        startY: e.clientY,
        currentX: e.clientX,
        currentY: e.clientY,
      });
    } else if (mode === "window" && hoveredWin) {
      confirmRect(
        Math.max(0, hoveredWin.x),
        Math.max(0, hoveredWin.y),
        hoveredWin.width,
        hoveredWin.height
      );
    } else if (mode === "monitor" && hoveredMonitor) {
      confirmRect(
        Math.max(0, hoveredMonitor.x),
        Math.max(0, hoveredMonitor.y),
        hoveredMonitor.width,
        hoveredMonitor.height
      );
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!session || submitting) return;
    if (e.shiftKey !== shiftHeld) {
      setShiftHeld(e.shiftKey);
    }

    if (mode === "region" && drag) {
      setDrag((prev) =>
        prev ? { ...prev, currentX: e.clientX, currentY: e.clientY } : null
      );
      return;
    }

    const { sx, sy } = getScale();
    const px = e.clientX * sx;
    const py = e.clientY * sy;

    if (mode === "window") {
      const hit =
        session.windows.find(
          (w) =>
            px >= w.x &&
            px <= w.x + w.width &&
            py >= w.y &&
            py <= w.y + w.height
        ) ?? null;
      setHoveredWin(hit);
    } else if (mode === "monitor") {
      const hitMon =
        session.monitors?.find(
          (m) =>
            px >= m.x &&
            px <= m.x + m.width &&
            py >= m.y &&
            py <= m.y + m.height
        ) ?? null;
      if (hitMon) {
        setHoveredMonitor(hitMon);
      }
    }
  };

  const handleMouseUp = () => {
    if (mode === "region" && drag && physSelection) {
      const { x, y, width, height } = physSelection;
      setDrag(null);
      if (width >= 6 && height >= 6) {
        confirmRect(x, y, width, height);
      }
    }
  };

  if (!session) {
    return <div className="w-screen h-screen bg-black/20" />;
  }

  const { sx, sy } = getScale();
  const winCss = hoveredWin
    ? {
        x: hoveredWin.x / sx,
        y: hoveredWin.y / sy,
        w: hoveredWin.width / sx,
        h: hoveredWin.height / sy,
      }
    : null;

  const monCss = hoveredMonitor
    ? {
        x: hoveredMonitor.x / sx,
        y: hoveredMonitor.y / sy,
        w: hoveredMonitor.width / sx,
        h: hoveredMonitor.height / sy,
      }
    : null;

  const primaryMonitor =
    session.monitors?.find((m) => m.isPrimary) ?? session.monitors?.[0] ?? null;
  const toolbarCenterX = primaryMonitor
    ? (primaryMonitor.x + primaryMonitor.width / 2) / sx
    : window.innerWidth / 2;
  const toolbarTopY = primaryMonitor ? primaryMonitor.y / sy + 16 : 16;

  return (
    <div
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onContextMenu={(e) => {
        e.preventDefault();
        cancelCapture();
      }}
      className={`relative w-screen h-screen overflow-hidden select-none ${
        mode === "region" ? "cursor-crosshair" : "cursor-pointer"
      }`}
    >
      {/* Frozen crisp virtual desktop capture */}
      <img
        ref={imgRef}
        key={session.sessionId}
        src={session.imageDataUrl}
        alt="Frozen screen"
        draggable={false}
        onLoad={() => notifyOverlayReady(session.sessionId)}
        className="w-full h-full object-fill pointer-events-none"
      />

      {/* Dimmed Mask Around Region Selection */}
      {mode === "region" && cssSelection && cssSelection.w > 2 && cssSelection.h > 2 ? (
        <>
          <div
            className="absolute left-0 right-0 top-0 bg-slate-950/60 pointer-events-none"
            style={{ height: cssSelection.y }}
          />
          <div
            className="absolute left-0 right-0 bottom-0 bg-slate-950/60 pointer-events-none"
            style={{ top: cssSelection.y + cssSelection.h }}
          />
          <div
            className="absolute left-0 bg-slate-950/60 pointer-events-none"
            style={{
              top: cssSelection.y,
              height: cssSelection.h,
              width: cssSelection.x,
            }}
          />
          <div
            className="absolute right-0 bg-slate-950/60 pointer-events-none"
            style={{
              top: cssSelection.y,
              height: cssSelection.h,
              left: cssSelection.x + cssSelection.w,
            }}
          />

          {/* Glowing Selection Box */}
          <div
            className="absolute pointer-events-none border-2 border-cyan-400 shadow-[0_0_24px_rgba(34,211,238,0.45)]"
            style={{
              left: cssSelection.x,
              top: cssSelection.y,
              width: cssSelection.w,
              height: cssSelection.h,
            }}
          >
            <div className="absolute -top-1.5 -left-1.5 w-3 h-3 rounded-sm bg-cyan-300 border border-slate-950" />
            <div className="absolute -top-1.5 -right-1.5 w-3 h-3 rounded-sm bg-cyan-300 border border-slate-950" />
            <div className="absolute -bottom-1.5 -left-1.5 w-3 h-3 rounded-sm bg-cyan-300 border border-slate-950" />
            <div className="absolute -bottom-1.5 -right-1.5 w-3 h-3 rounded-sm bg-cyan-300 border border-slate-950" />

            {physSelection && (
              <div
                className="absolute left-0 px-2.5 py-1 rounded-lg bg-[#090D16]/92 border border-cyan-400/40 text-[11px] font-semibold text-cyan-100 shadow-lg whitespace-nowrap"
                style={{
                  top: cssSelection.y > 34 ? -32 : 8,
                }}
              >
                {physSelection.width} × {physSelection.height} px
                {shiftHeld && (
                  <span className="ml-1.5 text-cyan-300">· 1:1</span>
                )}
              </div>
            )}
          </div>
        </>
      ) : mode === "window" && winCss ? (
        <>
          <div className="absolute inset-0 bg-slate-950/38 pointer-events-none" />
          <motion.div
            animate={{
              left: winCss.x,
              top: winCss.y,
              width: winCss.w,
              height: winCss.h,
            }}
            transition={{ type: "spring", stiffness: 520, damping: 38 }}
            className="absolute pointer-events-none rounded-xl border-2 border-indigo-400 bg-indigo-400/10 shadow-[0_0_32px_rgba(129,140,248,0.5)]"
          >
            <div className="absolute left-3 top-3 max-w-[90%] flex items-center gap-2 px-3 py-1.5 rounded-xl bg-[#090D16]/92 border border-indigo-400/45 text-xs text-slate-100 shadow-xl backdrop-blur-md">
              <AppWindow className="w-3.5 h-3.5 text-indigo-300 shrink-0" />
              <span className="font-medium truncate">{hoveredWin?.title}</span>
              <span className="text-[11px] text-cyan-300 font-semibold shrink-0">
                {hoveredWin?.width} × {hoveredWin?.height}
              </span>
            </div>
          </motion.div>
        </>
      ) : mode === "monitor" && monCss && hoveredMonitor ? (
        <>
          <div className="absolute inset-0 bg-slate-950/48 pointer-events-none" />
          <motion.div
            animate={{
              left: monCss.x,
              top: monCss.y,
              width: monCss.w,
              height: monCss.h,
            }}
            transition={{ type: "spring", stiffness: 460, damping: 36 }}
            className="absolute pointer-events-none border-[3px] border-emerald-400 bg-emerald-400/10 shadow-[inset_0_0_48px_rgba(52,211,153,0.18)] flex items-center justify-center"
          >
            <div className="px-5 py-3.5 rounded-2xl bg-[#090D16]/92 border border-emerald-400/50 backdrop-blur-xl shadow-2xl flex flex-col items-center gap-1 text-center">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-100">
                <Monitor className="w-4 h-4 text-emerald-300" />
                <span>{hoveredMonitor.name}</span>
              </div>
              <div className="text-xs font-semibold text-cyan-300">
                {hoveredMonitor.width} × {hoveredMonitor.height} px
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                Haz clic (o pulsa Enter) para capturar esta pantalla
              </div>
            </div>
          </motion.div>
        </>
      ) : (
        <div className="absolute inset-0 bg-slate-950/42 pointer-events-none" />
      )}

      {/* Camera Flash Effect on Capture */}
      <AnimatePresence>
        {flashRect && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 0.85, 0] }}
            transition={{ duration: 0.21, times: [0, 0.18, 1], ease: "easeOut" }}
            className="absolute pointer-events-none z-50 bg-gradient-to-br from-white via-cyan-100 to-white shadow-[0_0_48px_rgba(255,255,255,0.9)]"
            style={{
              left: flashRect.x,
              top: flashRect.y,
              width: flashRect.w,
              height: flashRect.h,
            }}
          />
        )}
      </AnimatePresence>

      {/* Top Floating Hint & Mode Switcher Bar (centered on primary monitor) */}
      <motion.div
        data-overlay-toolbar
        initial={{ opacity: 0, y: -14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 30 }}
        style={{
          left: toolbarCenterX,
          top: toolbarTopY,
        }}
        className="absolute -translate-x-1/2 z-30 flex items-center gap-2 px-3 py-1.5 rounded-2xl bg-[#090D16]/92 backdrop-blur-xl border border-white/15 shadow-2xl whitespace-nowrap"
      >
        <Sparkles className="w-3.5 h-3.5 text-cyan-300 shrink-0" />
        <div className="flex items-center gap-1 bg-white/5 rounded-xl p-0.5">
          <button
            onClick={() => setMode("region")}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
              mode === "region"
                ? "bg-cyan-400 text-slate-950"
                : "text-slate-300 hover:text-white"
            }`}
          >
            <Scissors className="w-3 h-3" />
            <span>Recorte libre</span>
          </button>
          <button
            onClick={() => setMode("window")}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
              mode === "window"
                ? "bg-indigo-400 text-slate-950"
                : "text-slate-300 hover:text-white"
            }`}
          >
            <AppWindow className="w-3 h-3" />
            <span>Ventana</span>
          </button>
          <button
            onClick={() => setMode("monitor")}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
              mode === "monitor"
                ? "bg-emerald-400 text-slate-950"
                : "text-slate-300 hover:text-white"
            }`}
          >
            <Monitor className="w-3 h-3" />
            <span>Pantalla</span>
          </button>
        </div>

        {(session.monitors?.length ?? 0) > 1 && (
          <button
            onClick={() => confirmRect(0, 0, session.width, session.height)}
            className="flex items-center gap-1 px-2.5 py-1 rounded-xl bg-white/8 hover:bg-white/15 border border-white/12 text-xs font-medium text-cyan-200 transition-colors cursor-pointer"
            title="Capturar todas las pantallas combinadas"
          >
            <Layers className="w-3 h-3" />
            <span>Todas ({session.monitors.length})</span>
          </button>
        )}

        <span className="text-[11px] text-slate-300 px-1 hidden md:inline">
          {mode === "region"
            ? "Arrastra para recortar · Shift: 1:1 · Esc cancela"
            : mode === "window"
              ? "Clic en una ventana · Esc cancela"
              : "Clic en la pantalla a capturar · Esc cancela"}
        </span>

        <button
          onClick={cancelCapture}
          className="p-1 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-rose-500/15 transition-colors cursor-pointer"
          title="Cancelar (Esc)"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </motion.div>
    </div>
  );
}
