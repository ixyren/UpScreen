import { useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MotionConfig } from "framer-motion";
import FloatingDock from "./windows/FloatingDock";
import CaptureOverlay from "./windows/CaptureOverlay";
import EditorWindow from "./windows/EditorWindow";

export default function App() {
  const windowLabel = useMemo(() => {
    try {
      return getCurrentWindow().label;
    } catch {
      return "dock";
    }
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      {windowLabel === "overlay" && <CaptureOverlay />}
      {windowLabel === "editor" && <EditorWindow />}
      {windowLabel !== "overlay" && windowLabel !== "editor" && <FloatingDock />}
    </MotionConfig>
  );
}
