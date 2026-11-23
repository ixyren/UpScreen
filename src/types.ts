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

export type BorderPosition = "inside" | "center" | "outside";

export interface FrameOptions {
  enabled: boolean;
  borderRadius: number;
  padding: number;
  shadowStrength: "none" | "soft" | "medium" | "strong" | "custom";
  subtleBorder: boolean;
  borderWidth: number;
  borderColor: string;
  borderOpacity: number;
  borderPosition: BorderPosition;
  shadowColor: string;
  shadowOffsetX: number;
  shadowOffsetY: number;
  shadowBlur: number;
  shadowSpread: number;
  shadowOpacity: number;
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

export type TextBgStyle =
  | "none"
  | "glass"
  | "solid"
  | "outline"
  | "highlight"
  | "gradient";
export type TextFontFamily = string;
export type BlurMode = "gaussian" | "pixelate";

export interface TextStyleConfig {
  fontFamily: string;
  fontSize: number;
  color: string;
  bold: boolean;
  italic: boolean;
  bgStyle: TextBgStyle;
  bgColor: string;
  bgColor2: string;
  bgOpacity: number;
  paddingX: number;
  paddingY: number;
  textOffsetX: number;
  textOffsetY: number;
  borderRadius: number;
  opacity: number;
  shadowEnabled: boolean;
  shadowBlur: number;
  shadowColor: string;
  shadowOffsetY: number;
}

export interface TextAnnotation {
  id: string;
  kind: "text";
  name?: string;
  visible?: boolean;
  x: number;
  y: number;
  text: string;
  fontSize: number;
  fontFamily?: string;
  color: string;
  bold: boolean;
  italic?: boolean;
  hasPill: boolean;
  bgStyle?: TextBgStyle;
  bgColor?: string;
  bgColor2?: string;
  bgOpacity?: number;
  paddingX?: number;
  paddingY?: number;
  textOffsetX?: number;
  textOffsetY?: number;
  borderRadius?: number;
  opacity?: number;
  shadowEnabled?: boolean;
  shadowBlur?: number;
  shadowColor?: string;
  shadowOffsetY?: number;
}

export interface RectAnnotation {
  id: string;
  kind: "rect";
  name?: string;
  visible?: boolean;
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
  name?: string;
  visible?: boolean;
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
  name?: string;
  visible?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  mode?: BlurMode;
  intensity: number;
  borderRadius?: number;
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
