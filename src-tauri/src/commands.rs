use crate::capture::{
    capture_virtual_screen, crop_image, enumerate_monitors, enumerate_visible_windows,
    MonitorRect, VirtualScreenCapture, WindowRect,
};
use crate::encoder::{save_processed_image, SaveOptions, SaveResult};
use crate::frame::{apply_rounded_shadow_frame, FrameOptions};
use crate::gpu::{detect_ffmpeg_encoders, detect_gpu, GpuInfo, HardwareEncoders};
use crate::upscaler::{
    download_realesrgan, find_ffmpeg_exe, find_realesrgan_exe, get_bin_dir, upscale_image,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use directories::UserDirs;
use image::codecs::png::{CompressionType, FilterType as PngFilterType, PngEncoder};
use image::{ColorType, ImageEncoder, RgbaImage};
use serde::Serialize;
use std::borrow::Cow;
use std::io::Cursor;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Position, Size, State,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use windows::Win32::Foundation::RECT;
use windows::Win32::UI::WindowsAndMessaging::{
    SystemParametersInfoW, SPI_GETWORKAREA, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
};

#[derive(Debug, Clone)]
pub struct DockCaptureSettings {
    pub auto_upscale: bool,
    pub scale: u32,
    pub model: String,
    pub text_protection: String,
}

impl Default for DockCaptureSettings {
    fn default() -> Self {
        Self {
            auto_upscale: false,
            scale: 2,
            model: "realesrgan-x4plus".to_string(),
            text_protection: "supersample".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredShortcuts {
    pub region: String,
    pub window: String,
    pub fullscreen: String,
}

#[derive(Default)]
pub struct CaptureSession {
    pub session_id: u64,
    pub frozen_screen: Option<VirtualScreenCapture>,
    pub windows: Vec<WindowRect>,
    pub monitors: Vec<MonitorRect>,
    pub overlay_mode: String,
    pub pending_auto_upscale: bool,
    pub pending_scale: u32,
    pub pending_model: String,
    pub pending_text_protection: String,
    pub dock_was_visible: bool,
    pub capture_in_progress: bool,
    pub dock_settings: DockCaptureSettings,
    pub shortcuts: RegisteredShortcuts,
    pub editor_capture: Option<EditorCapturePayload>,
}

pub struct AppState {
    pub session: Mutex<CaptureSession>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            session: Mutex::new(CaptureSession::default()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStatus {
    pub gpu: GpuInfo,
    pub encoders: HardwareEncoders,
    pub realesrgan_installed: bool,
    pub realesrgan_path: Option<String>,
    pub ffmpeg_installed: bool,
    pub ffmpeg_path: Option<String>,
    pub bin_dir: String,
    pub default_save_dir: String,
    pub shortcuts: RegisteredShortcuts,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlaySessionPayload {
    pub session_id: u64,
    pub mode: String,
    pub width: u32,
    pub height: u32,
    pub image_data_url: String,
    pub windows: Vec<WindowRect>,
    pub monitors: Vec<MonitorRect>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorCapturePayload {
    pub session_id: u64,
    pub width: u32,
    pub height: u32,
    pub image_data_url: String,
    pub auto_upscaled: bool,
    pub upscale_engine: Option<String>,
    pub applied_scale: u32,
    pub applied_model: String,
    pub applied_text_protection: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpscalePreviewResult {
    pub image_data_url: String,
    pub width: u32,
    pub height: u32,
    pub engine: String,
    pub elapsed_ms: u128,
}

pub fn encode_rgba_to_data_url(img: &RgbaImage) -> Result<String, String> {
    let mut buf = Vec::with_capacity((img.width() * img.height() * 4) as usize / 2);
    let encoder = PngEncoder::new_with_quality(
        Cursor::new(&mut buf),
        CompressionType::Fast,
        PngFilterType::NoFilter,
    );
    encoder
        .write_image(
            img.as_raw(),
            img.width(),
            img.height(),
            ColorType::Rgba8.into(),
        )
        .map_err(|e| format!("Error codificando PNG en memoria: {e}"))?;

    Ok(format!("data:image/png;base64,{}", BASE64.encode(buf)))
}

pub fn decode_base64_image(data: &str) -> Result<RgbaImage, String> {
    let raw_b64 = data
        .split_once(',')
        .map(|(_, b)| b)
        .unwrap_or(data)
        .trim();

    let bytes = BASE64
        .decode(raw_b64)
        .map_err(|e| format!("Error decodificando imagen base64: {e}"))?;

    let dyn_img = image::load_from_memory(&bytes)
        .map_err(|e| format!("Error cargando imagen desde memoria: {e}"))?;

    Ok(dyn_img.to_rgba8())
}

#[tauri::command]
pub fn get_system_status(state: State<'_, AppState>) -> SystemStatus {
    let gpu = detect_gpu();
    let realesrgan = find_realesrgan_exe();
    let ffmpeg = find_ffmpeg_exe();
    let encoders = ffmpeg
        .as_deref()
        .map(detect_ffmpeg_encoders)
        .unwrap_or_default();

    let default_save_dir = UserDirs::new()
        .and_then(|u| u.picture_dir().map(|p| p.join("UpScreen")))
        .or_else(|| UserDirs::new().map(|u| u.home_dir().join("Pictures").join("UpScreen")))
        .unwrap_or_else(|| get_bin_dir().join("Captures"))
        .to_string_lossy()
        .to_string();

    let shortcuts = state
        .session
        .lock()
        .map(|g| g.shortcuts.clone())
        .unwrap_or_default();

    SystemStatus {
        gpu,
        encoders,
        realesrgan_installed: realesrgan.is_some(),
        realesrgan_path: realesrgan.map(|p| p.to_string_lossy().to_string()),
        ffmpeg_installed: ffmpeg.is_some(),
        ffmpeg_path: ffmpeg.map(|p| p.to_string_lossy().to_string()),
        bin_dir: get_bin_dir().to_string_lossy().to_string(),
        default_save_dir,
        shortcuts,
    }
}

fn get_primary_work_area(dock: &WebviewWindow) -> (i32, i32, i32, i32) {
    let mut rect = RECT::default();
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            Some(&mut rect as *mut RECT as *mut std::ffi::c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
        .is_ok()
    };
    if ok && rect.right > rect.left && rect.bottom > rect.top {
        return (rect.left, rect.top, rect.right, rect.bottom);
    }

    if let Ok(Some(mon)) = dock.primary_monitor() {
        let p = mon.position();
        let s = mon.size();
        return (p.x, p.y, p.x + s.width as i32, p.y + s.height as i32);
    }

    (0, 0, 1920, 1040)
}

pub fn position_dock_bottom_center(dock: &WebviewWindow, logical_w: f64, logical_h: f64) {
    let sf = dock.scale_factor().unwrap_or(1.0);
    let (wl, wt, wr, wb) = get_primary_work_area(dock);
    let phys_w = (logical_w * sf).round() as i32;
    let phys_h = (logical_h * sf).round() as i32;
    let margin = (16.0 * sf).round() as i32;

    let x = wl + ((wr - wl) - phys_w) / 2;
    let y = (wb - phys_h - margin).max(wt + 8);

    let _ = dock.set_size(Size::Logical(LogicalSize::new(logical_w, logical_h)));
    let _ = dock.set_position(Position::Physical(PhysicalPosition::new(x, y)));
}

pub fn show_or_recreate_dock(app: &AppHandle) {
    if let Some(dock) = app.get_webview_window("dock") {
        let _ = dock.unminimize();
        let _ = dock.show();
        let _ = dock.set_always_on_top(true);
        let _ = dock.set_focus();
        return;
    }

    if let Ok(win) = WebviewWindowBuilder::new(app, "dock", WebviewUrl::App("index.html".into()))
        .title("UpScreen")
        .inner_size(690.0, 76.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(false)
        .shadow(false)
        .skip_taskbar(false)
        .visible(false)
        .build()
    {
        position_dock_bottom_center(&win, 504.0, 64.0);
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[tauri::command]
pub fn sync_dock_settings(
    state: State<'_, AppState>,
    auto_upscale: bool,
    scale: u32,
    model: String,
    text_protection: String,
) -> Result<(), String> {
    let mut guard = state.session.lock().map_err(|_| "Lock error".to_string())?;
    guard.dock_settings = DockCaptureSettings {
        auto_upscale,
        scale: scale.clamp(2, 16),
        model,
        text_protection,
    };
    Ok(())
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

pub fn trigger_capture_from_backend(app: AppHandle, mode: &'static str) {
    let settings = {
        let state = app.state::<AppState>();
        state
            .session
            .lock()
            .map(|g| g.dock_settings.clone())
            .unwrap_or_default()
    };

    tauri::async_runtime::spawn(async move {
        let _ = execute_capture(
            app,
            mode.to_string(),
            settings.auto_upscale,
            settings.scale,
            settings.model,
            settings.text_protection,
        )
        .await;
    });
}

#[tauri::command]
pub async fn start_capture(
    app: AppHandle,
    state: State<'_, AppState>,
    mode: String,
    auto_upscale: bool,
    scale: u32,
    model: String,
    text_protection: Option<String>,
) -> Result<(), String> {
    let protection = text_protection.unwrap_or_else(|| "supersample".to_string());
    if let Ok(mut guard) = state.session.lock() {
        guard.dock_settings = DockCaptureSettings {
            auto_upscale,
            scale: scale.clamp(2, 16),
            model: model.clone(),
            text_protection: protection.clone(),
        };
    }
    execute_capture(app, mode, auto_upscale, scale, model, protection).await
}

pub async fn execute_capture(
    app: AppHandle,
    mode: String,
    auto_upscale: bool,
    scale: u32,
    model: String,
    protection: String,
) -> Result<(), String> {
    let dock_was_visible = app
        .get_webview_window("dock")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);

    {
        let state = app.state::<AppState>();
        let mut guard = state.session.lock().map_err(|_| "Lock error".to_string())?;
        if guard.capture_in_progress {
            return Ok(());
        }
        guard.capture_in_progress = true;
        guard.dock_was_visible = dock_was_visible;
    }

    let res = execute_capture_inner(
        &app,
        mode,
        auto_upscale,
        scale,
        model,
        protection,
        dock_was_visible,
    )
    .await;

    if res.is_err() {
        let state = app.state::<AppState>();
        if let Ok(mut guard) = state.session.lock() {
            guard.capture_in_progress = false;
        }
        if dock_was_visible {
            show_or_recreate_dock(&app);
        }
    }

    res
}

async fn execute_capture_inner(
    app: &AppHandle,
    mode: String,
    auto_upscale: bool,
    scale: u32,
    model: String,
    protection: String,
    _dock_was_visible: bool,
) -> Result<(), String> {
    if let Some(dock) = app.get_webview_window("dock") {
        let _ = dock.hide();
    }
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.hide();
    }

    // Give Windows DWM / Tray menu time to finish hiding before screen capture
    tokio::time::sleep(Duration::from_millis(180)).await;

    let screen = tokio::task::spawn_blocking(capture_virtual_screen)
        .await
        .map_err(|e| format!("Error en captura de pantalla: {e}"))??;

    let own_pid = std::process::id();
    let windows = enumerate_visible_windows(
        screen.origin_x,
        screen.origin_y,
        screen.width,
        screen.height,
        own_pid,
    );
    let monitors = enumerate_monitors(
        screen.origin_x,
        screen.origin_y,
        screen.width,
        screen.height,
    );

    let normalized_mode = match mode.as_str() {
        "window" => "window".to_string(),
        "fullscreen" | "monitor" => "monitor".to_string(),
        _ => "region".to_string(),
    };

    let origin_x = screen.origin_x;
    let origin_y = screen.origin_y;
    let screen_w = screen.width;
    let screen_h = screen.height;

    {
        let state = app.state::<AppState>();
        let mut guard = state.session.lock().map_err(|_| "Lock error".to_string())?;
        guard.session_id += 1;
        guard.frozen_screen = Some(screen);
        guard.windows = windows;
        guard.monitors = monitors;
        guard.overlay_mode = normalized_mode;
        guard.pending_auto_upscale = auto_upscale;
        guard.pending_scale = scale.clamp(2, 16);
        guard.pending_model = model;
        guard.pending_text_protection = protection;
    }

    open_or_focus_overlay(app, origin_x, origin_y, screen_w, screen_h)?;
    Ok(())
}

fn open_or_focus_overlay(
    app: &AppHandle,
    origin_x: i32,
    origin_y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let win = if let Some(existing) = app.get_webview_window("overlay") {
        existing
    } else {
        WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("index.html".into()))
            .title("UpScreen Capture Overlay")
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .visible(false)
            .build()
            .map_err(|e| format!("No se pudo crear ventana overlay: {e}"))?
    };

    let _ = win.hide();
    let _ = win.set_position(Position::Physical(PhysicalPosition::new(origin_x, origin_y)));
    let _ = win.set_size(Size::Physical(PhysicalSize::new(width, height)));
    let _ = win.set_always_on_top(true);
    let _ = app.emit("overlay-updated", ());
    Ok(())
}

#[tauri::command]
pub fn show_ready_overlay(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.unminimize();
        let _ = win.set_always_on_top(true);
        let _ = win.show();
        let _ = win.set_focus();
    }
    Ok(())
}

pub fn open_or_focus_editor(app: &AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("editor") {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        let _ = app.emit("editor-capture-updated", ());
        return Ok(());
    }

    let win = WebviewWindowBuilder::new(app, "editor", WebviewUrl::App("index.html".into()))
        .title("UpScreen — Editor & Real-ESRGAN")
        .inner_size(1280.0, 820.0)
        .min_inner_size(980.0, 660.0)
        .decorations(false)
        .transparent(false)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| format!("No se pudo abrir ventana editor: {e}"))?;

    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit("editor-capture-updated", ());
    Ok(())
}

#[tauri::command]
pub fn get_overlay_session(state: State<'_, AppState>) -> Result<OverlaySessionPayload, String> {
    let guard = state.session.lock().map_err(|_| "Lock error".to_string())?;
    let screen = guard
        .frozen_screen
        .as_ref()
        .ok_or_else(|| "No hay captura activa en el overlay".to_string())?;

    let data_url = encode_rgba_to_data_url(&screen.image)?;
    Ok(OverlaySessionPayload {
        session_id: guard.session_id,
        mode: guard.overlay_mode.clone(),
        width: screen.width,
        height: screen.height,
        image_data_url: data_url,
        windows: guard.windows.clone(),
        monitors: guard.monitors.clone(),
    })
}

#[tauri::command]
pub async fn confirm_overlay_capture(
    app: AppHandle,
    state: State<'_, AppState>,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    hwnd: Option<isize>,
) -> Result<(), String> {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.hide();
    }

    let (cropped, auto_upscale, scale, model, protection, dock_was_visible) = {
        let mut guard = state.session.lock().map_err(|_| "Lock error".to_string())?;
        let dock_was_visible = guard.dock_was_visible;
        let screen = match guard.frozen_screen.take() {
            Some(s) => s,
            None => {
                guard.capture_in_progress = false;
                return Err("No hay pantalla congelada disponible".to_string());
            }
        };
        guard.windows.clear();
        guard.monitors.clear();

        // When capturing a specific window, try transparent border-aware capture first
        let transparent_win = hwnd.and_then(|h| crate::capture::capture_window_transparent(h).ok());
        let cropped = if let Some(win_img) = transparent_win {
            win_img
        } else {
            match crop_image(&screen.image, x, y, width, height) {
                Ok(c) => c,
                Err(e) => {
                    guard.capture_in_progress = false;
                    return Err(e);
                }
            }
        };
        (
            cropped,
            guard.pending_auto_upscale,
            guard.pending_scale.clamp(2, 16),
            guard.pending_model.clone(),
            if guard.pending_text_protection.is_empty() {
                "supersample".to_string()
            } else {
                guard.pending_text_protection.clone()
            },
            dock_was_visible,
        )
    };

    let model_clone = model.clone();
    let prot_clone = protection.clone();
    let upscale_res = if auto_upscale {
        tokio::task::spawn_blocking(move || {
            upscale_image(&cropped, scale, &model_clone, &prot_clone)
        })
        .await
        .map_err(|e| format!("Error en upscaling: {e}"))
        .and_then(|r| r)
        .map(|(up, eng)| (up, true, Some(eng)))
    } else {
        Ok((cropped, false, None))
    };

    let (final_img, auto_upscaled, engine) = match upscale_res {
        Ok(v) => v,
        Err(e) => {
            if let Ok(mut guard) = state.session.lock() {
                guard.capture_in_progress = false;
            }
            if dock_was_visible {
                show_or_recreate_dock(&app);
            }
            return Err(e);
        }
    };

    let w = final_img.width();
    let h = final_img.height();
    let data_url = match tokio::task::spawn_blocking(move || encode_rgba_to_data_url(&final_img)).await {
        Ok(Ok(url)) => url,
        Ok(Err(e)) => {
            if let Ok(mut guard) = state.session.lock() {
                guard.capture_in_progress = false;
            }
            if dock_was_visible {
                show_or_recreate_dock(&app);
            }
            return Err(e);
        }
        Err(e) => {
            if let Ok(mut guard) = state.session.lock() {
                guard.capture_in_progress = false;
            }
            if dock_was_visible {
                show_or_recreate_dock(&app);
            }
            return Err(format!("Error codificando captura: {e}"));
        }
    };

    {
        let mut guard = state.session.lock().map_err(|_| "Lock error".to_string())?;
        guard.session_id += 1;
        let sid = guard.session_id;
        guard.capture_in_progress = false;
        guard.editor_capture = Some(EditorCapturePayload {
            session_id: sid,
            width: w,
            height: h,
            image_data_url: data_url,
            auto_upscaled,
            upscale_engine: engine,
            applied_scale: scale,
            applied_model: model,
            applied_text_protection: protection,
        });
    }

    if dock_was_visible {
        show_or_recreate_dock(&app);
    }

    open_or_focus_editor(&app)?;
    Ok(())
}

#[tauri::command]
pub fn cancel_overlay_capture(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.hide();
    }
    let mut restore_dock = true;
    if let Ok(mut guard) = state.session.lock() {
        guard.frozen_screen = None;
        guard.windows.clear();
        guard.monitors.clear();
        guard.capture_in_progress = false;
        restore_dock = guard.dock_was_visible;
    }
    if restore_dock {
        show_or_recreate_dock(&app);
    }
    Ok(())
}

#[tauri::command]
pub fn get_editor_capture(state: State<'_, AppState>) -> Result<Option<EditorCapturePayload>, String> {
    let guard = state.session.lock().map_err(|_| "Lock error".to_string())?;
    Ok(guard.editor_capture.clone())
}

#[tauri::command]
pub async fn preview_upscale(
    image_base64: String,
    scale: u32,
    model: String,
    text_protection: Option<String>,
) -> Result<UpscalePreviewResult, String> {
    let start = Instant::now();
    let protection = text_protection.unwrap_or_else(|| "supersample".to_string());
    let decoded = tokio::task::spawn_blocking(move || decode_base64_image(&image_base64))
        .await
        .map_err(|e| format!("Error decodificando imagen: {e}"))??;

    let (upscaled, engine) = tokio::task::spawn_blocking(move || {
        upscale_image(&decoded, scale.clamp(2, 16), &model, &protection)
    })
    .await
    .map_err(|e| format!("Error en upscale: {e}"))??;

    let w = upscaled.width();
    let h = upscaled.height();
    let data_url = tokio::task::spawn_blocking(move || encode_rgba_to_data_url(&upscaled))
        .await
        .map_err(|e| format!("Error codificando vista previa: {e}"))??;

    Ok(UpscalePreviewResult {
        image_data_url: data_url,
        width: w,
        height: h,
        engine,
        elapsed_ms: start.elapsed().as_millis(),
    })
}

#[tauri::command]
pub async fn save_edited_image(
    image_base64: String,
    options: SaveOptions,
) -> Result<SaveResult, String> {
    let decoded = tokio::task::spawn_blocking(move || decode_base64_image(&image_base64))
        .await
        .map_err(|e| format!("Error decodificando imagen: {e}"))??;

    tokio::task::spawn_blocking(move || save_processed_image(decoded, options))
        .await
        .map_err(|e| format!("Error guardando imagen: {e}"))?
}

#[tauri::command]
pub async fn copy_edited_image(
    image_base64: String,
    upscale_before_copy: bool,
    scale: u32,
    model: String,
    text_protection: Option<String>,
    frame: Option<FrameOptions>,
    frame_scale: Option<f32>,
) -> Result<String, String> {
    let protection = text_protection.unwrap_or_else(|| "supersample".to_string());
    let decoded = tokio::task::spawn_blocking(move || decode_base64_image(&image_base64))
        .await
        .map_err(|e| format!("Error decodificando imagen: {e}"))??;

    let (mut final_img, engine_note) = if upscale_before_copy {
        let clamped = scale.clamp(2, 16);
        let (up, eng) = tokio::task::spawn_blocking(move || {
            upscale_image(&decoded, clamped, &model, &protection)
        })
        .await
        .map_err(|e| format!("Error haciendo upscale para portapapeles: {e}"))??;
        (up, format!(" ({clamped}x · {eng})"))
    } else {
        (decoded, String::new())
    };

    if let Some(frame_opts) = frame {
        if frame_opts.enabled {
            let eff_scale = if upscale_before_copy {
                scale.clamp(2, 16) as f32
            } else {
                frame_scale.unwrap_or(1.0).max(1.0)
            };
            final_img = tokio::task::spawn_blocking(move || {
                apply_rounded_shadow_frame(&final_img, &frame_opts, eff_scale)
            })
            .await
            .map_err(|e| format!("Error aplicando marco redondeado: {e}"))?;
        }
    }

    let w = final_img.width() as usize;
    let h = final_img.height() as usize;

    tokio::task::spawn_blocking(move || {
        let mut clipboard = arboard::Clipboard::new()
            .map_err(|e| format!("No se pudo acceder al portapapeles: {e}"))?;
        let img_data = arboard::ImageData {
            width: w,
            height: h,
            bytes: Cow::Borrowed(final_img.as_raw()),
        };
        clipboard
            .set_image(img_data)
            .map_err(|e| format!("Error copiando imagen al portapapeles: {e}"))
    })
    .await
    .map_err(|e| format!("Error en portapapeles: {e}"))??;

    Ok(format!("Copiada al portapapeles: {w}×{h} px{engine_note}"))
}

#[tauri::command]
pub async fn download_realesrgan_engine(app: AppHandle) -> Result<String, String> {
    let exe_path = download_realesrgan(&app).await?;
    Ok(exe_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn open_editor_window(app: AppHandle) -> Result<(), String> {
    open_or_focus_editor(&app)
}

#[tauri::command]
pub fn resize_dock(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    if let Some(dock) = app.get_webview_window("dock") {
        let sf = dock.scale_factor().unwrap_or(1.0);
        let (wl, wt, wr, wb) = get_primary_work_area(&dock);
        let new_w = (width * sf).round() as i32;
        let new_h = (height * sf).round() as i32;

        let (center_x, bottom_y) = match (dock.outer_position(), dock.outer_size()) {
            (Ok(pos), Ok(sz)) if sz.width > 0 && sz.height > 0 => (
                pos.x + (sz.width as i32) / 2,
                pos.y + (sz.height as i32),
            ),
            _ => {
                let margin = (16.0 * sf).round() as i32;
                (wl + (wr - wl) / 2, wb - margin)
            }
        };

        let max_x = (wr - new_w - 8).max(wl);
        let max_y = (wb - new_h - 8).max(wt);
        let new_x = (center_x - new_w / 2).clamp(wl + 8, max_x);
        let new_y = (bottom_y - new_h).clamp(wt + 8, max_y);

        dock.set_size(Size::Logical(LogicalSize::new(width, height)))
            .map_err(|e| format!("Error redimensionando menú flotante: {e}"))?;
        let _ = dock.set_position(Position::Physical(PhysicalPosition::new(new_x, new_y)));
    }
    Ok(())
}

#[tauri::command]
pub fn list_system_fonts() -> Vec<String> {
    use std::collections::BTreeSet;
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::Graphics::Gdi::{
        EnumFontFamiliesExW, GetDC, ReleaseDC, DEFAULT_CHARSET, LOGFONTW, TEXTMETRICW,
    };

    unsafe extern "system" fn enum_proc(
        lpelfe: *const LOGFONTW,
        _lpntme: *const TEXTMETRICW,
        _font_type: u32,
        lparam: LPARAM,
    ) -> i32 {
        if !lpelfe.is_null() && lparam.0 != 0 {
            let lf = &*lpelfe;
            let len = lf
                .lfFaceName
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(lf.lfFaceName.len());
            if len > 0 {
                let name = String::from_utf16_lossy(&lf.lfFaceName[..len]);
                let trimmed = name.trim();
                if !trimmed.is_empty() && !trimmed.starts_with('@') {
                    let set = &mut *(lparam.0 as *mut BTreeSet<String>);
                    set.insert(trimmed.to_string());
                }
            }
        }
        1
    }

    let mut fonts = BTreeSet::<String>::new();
    unsafe {
        let hdc = GetDC(None);
        if !hdc.is_invalid() {
            let mut lf = LOGFONTW::default();
            lf.lfCharSet = DEFAULT_CHARSET;
            let ptr = &mut fonts as *mut BTreeSet<String> as isize;
            EnumFontFamiliesExW(hdc, &lf, Some(enum_proc), LPARAM(ptr), 0);
            let _ = ReleaseDC(None, hdc);
        }
    }

    if fonts.is_empty() {
        return vec![
            "Segoe UI".to_string(),
            "Arial".to_string(),
            "Consolas".to_string(),
            "Georgia".to_string(),
            "Impact".to_string(),
        ];
    }

    fonts.into_iter().collect()
}

fn resolve_config_file(filename: &str) -> std::path::PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(filename);
            if candidate.exists() {
                return candidate;
            }
            // Test writability of the executable root directory
            let probe = dir.join(".upscreen_write_probe");
            if std::fs::write(&probe, b"ok").is_ok() {
                let _ = std::fs::remove_file(&probe);
                return candidate;
            }
        }
    }
    let fallback_dir = directories::BaseDirs::new()
        .map(|d| d.data_local_dir().join("UpScreen"))
        .unwrap_or_else(|| std::env::temp_dir().join("UpScreen"));
    let _ = std::fs::create_dir_all(&fallback_dir);
    fallback_dir.join(filename)
}

#[tauri::command]
pub fn load_png_presets() -> Result<String, String> {
    let path = resolve_config_file("upscreen_png_presets.json");
    if !path.exists() {
        return Ok("[]".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("Error leyendo presets PNG: {e}"))
}

#[tauri::command]
pub fn save_png_presets(json: String) -> Result<String, String> {
    let path = resolve_config_file("upscreen_png_presets.json");
    std::fs::write(&path, json).map_err(|e| format!("Error guardando presets PNG: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn load_editor_settings() -> Result<Option<String>, String> {
    let path = resolve_config_file("upscreen_editor_settings.json");
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Error leyendo ajustes guardados: {e}"))?;
    Ok(Some(text))
}

#[tauri::command]
pub fn save_editor_settings(json: String) -> Result<(), String> {
    let path = resolve_config_file("upscreen_editor_settings.json");
    std::fs::write(&path, json).map_err(|e| format!("Error guardando ajustes: {e}"))
}
