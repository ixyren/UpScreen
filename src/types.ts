export interface GpuInfo {
  name: string;
  vendor: string;
  vramMb: number;
  recommendedCodec: string;
  supportsNvenc: boolean;
  supportsAmf: boolean;
}

export interface HardwareEncoders {
  hevcNvenc: boolean;
  h264Nvenc: boolean;
  hevcAmf: boolean;
  h264Amf: boolean;
}

export interface RegisteredShortcuts {
  region: string;
  window: string;
  fullscreen: string;
}

export interface SystemStatus {
  gpu: GpuInfo;
  encoders: HardwareEncoders;
  realesrganInstalled: boolean;
  realesrganPath: string | null;
  ffmpegInstalled: boolean;
  ffmpegPath: string | null;
  binDir: string;
  defaultSaveDir: string;
  shortcuts?: RegisteredShortcuts;
}

export interface WindowRect {
  hwnd: number;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MonitorRect {
  index: number;
  name: string;
  isPrimary: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlaySessionPayload {
  sessionId: number;
  mode: "region" | "window" | "monitor";
  width: number;
  height: number;
  imageDataUrl: string;
  windows: WindowRect[];
  monitors: MonitorRect[];
}

export type AiQualityMode = "supersample" | "tta" | "raw";
export type TextProtectionMode = AiQualityMode;

export interface FrameOptions {
  enabled: boolean;
  borderRadius: number;
  padding: number;
  shadowStrength: "soft" | "medium" | "strong";
  subtleBorder: boolean;
}

export interface EditorCapturePayload {
  sessionId: number;
  width: number;
  height: number;
  imageDataUrl: string;
  autoUpscaled: boolean;
  upscaleEngine: string | null;
  appliedScale: number;
  appliedModel: string;
  appliedTextProtection?: AiQualityMode;
}

export interface UpscalePreviewResult {
  imageDataUrl: string;
  width: number;
  height: number;
  engine: string;
  elapsedMs: number;
}

export interface SaveOptions {
  path: string;
  format: "png" | "webp" | "jpg" | "hevc-hw";
  codecPreference: "auto" | "nvenc" | "amf" | "cpu";
  upscaleBeforeSave: boolean;
  scale: number;
  model: string;
  textProtection: AiQualityMode;
  frame?: FrameOptions;
  frameScale?: number;
}

export interface SaveResult {
  path: string;
  width: number;
  height: number;
  elapsedMs: number;
  upscaleEngine: string | null;
  codecUsed: string;
}

export interface DownloadProgressEvent {
  percent: number;
  status: string;
}

export type CaptureMode = "region" | "window" | "fullscreen";
export type ToolType = "select" | "crop" | "text" | "arrow" | "rect" | "blur";
export type AspectPreset = "free" | "16:9" | "4:3" | "1:1";
export type UpscaleModel =
  | "realesrgan-x4plus"
  | "realesrgan-x4plus-anime"
  | "realesr-animevideov3"
  | "crisp-ui";

export interface TextAnnotation {
  id: string;
  kind: "text";
  x: number;
  y: number;
  text: string;
  fontSize: number;
  color: string;
  bold: boolean;
  hasPill: boolean;
}

export interface RectAnnotation {
  id: string;
  kind: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  strokeWidth: number;
}

export interface ArrowAnnotation {
  id: string;
  kind: "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  strokeWidth: number;
}

export interface BlurAnnotation {
  id: string;
  kind: "blur";
  x: number;
  y: number;
  width: number;
  height: number;
  intensity: number;
}

export type Annotation =
  | TextAnnotation
  | RectAnnotation
  | ArrowAnnotation
  | BlurAnnotation;

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
