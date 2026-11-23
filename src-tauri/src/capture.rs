use image::RgbaImage;
use serde::Serialize;
use std::ffi::c_void;
use std::mem::size_of;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
    EnumDisplayMonitors, GetDC, GetDIBits, GetMonitorInfoW, ReleaseDC, SelectObject, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HDC, HGDIOBJ, HMONITOR, MONITORINFO,
    SRCCOPY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetSystemMetrics, GetWindowLongW, GetWindowRect, GetWindowTextLengthW,
    GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE,
    SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, WS_EX_TOOLWINDOW,
};

#[derive(Debug, Clone)]
pub struct VirtualScreenCapture {
    pub origin_x: i32,
    pub origin_y: i32,
    pub width: u32,
    pub height: u32,
    pub image: RgbaImage,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRect {
    pub hwnd: isize,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorRect {
    pub index: usize,
    pub name: String,
    pub is_primary: bool,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub fn capture_virtual_screen() -> Result<VirtualScreenCapture, String> {
    unsafe {
        let origin_x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let origin_y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let width_i = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let height_i = GetSystemMetrics(SM_CYVIRTUALSCREEN);

        if width_i <= 0 || height_i <= 0 {
            return Err("No se pudo obtener el tamaño de la pantalla virtual".into());
        }

        let width = width_i as u32;
        let height = height_i as u32;

        let hdc_screen = GetDC(HWND::default());
        if hdc_screen.is_invalid() {
            return Err("GetDC falló al capturar la pantalla".into());
        }

        let hdc_mem = CreateCompatibleDC(hdc_screen);
        if hdc_mem.is_invalid() {
            ReleaseDC(HWND::default(), hdc_screen);
            return Err("CreateCompatibleDC falló".into());
        }

        let hbmp = CreateCompatibleBitmap(hdc_screen, width_i, height_i);
        if hbmp.is_invalid() {
            let _ = DeleteDC(hdc_mem);
            ReleaseDC(HWND::default(), hdc_screen);
            return Err("CreateCompatibleBitmap falló".into());
        }

        let prev_obj = SelectObject(hdc_mem, HGDIOBJ(hbmp.0));
        let blt_res = BitBlt(
            hdc_mem,
            0,
            0,
            width_i,
            height_i,
            hdc_screen,
            origin_x,
            origin_y,
            SRCCOPY | CAPTUREBLT,
        );

        let mut pixels = vec![0u8; (width * height * 4) as usize];
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width_i,
                biHeight: -height_i, // Top-down DIB
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: Default::default(),
        };

        let dib_lines = if blt_res.is_ok() {
            GetDIBits(
                hdc_mem,
                hbmp,
                0,
                height,
                Some(pixels.as_mut_ptr() as *mut c_void),
                &mut bmi,
                DIB_RGB_COLORS,
            )
        } else {
            0
        };

        SelectObject(hdc_mem, prev_obj);
        let _ = DeleteObject(HGDIOBJ(hbmp.0));
        let _ = DeleteDC(hdc_mem);
        ReleaseDC(HWND::default(), hdc_screen);

        blt_res.map_err(|e| format!("BitBlt falló: {e}"))?;
        if dib_lines == 0 {
            return Err("GetDIBits no pudo leer los píxeles de pantalla".into());
        }

        // Convert BGRA -> RGBA and ensure opaque alpha for desktop pixels
        for chunk in pixels.chunks_exact_mut(4) {
            let b = chunk[0];
            let r = chunk[2];
            chunk[0] = r;
            chunk[2] = b;
            chunk[3] = 255;
        }

        let image = RgbaImage::from_raw(width, height, pixels)
            .ok_or_else(|| "Error construyendo imagen RGBA de pantalla".to_string())?;

        Ok(VirtualScreenCapture {
            origin_x,
            origin_y,
            width,
            height,
            image,
        })
    }
}

struct EnumContext {
    origin_x: i32,
    origin_y: i32,
    screen_w: i32,
    screen_h: i32,
    exclude_pid: u32,
    windows: Vec<WindowRect>,
}

pub fn enumerate_visible_windows(
    origin_x: i32,
    origin_y: i32,
    screen_w: u32,
    screen_h: u32,
    exclude_pid: u32,
) -> Vec<WindowRect> {
    let mut ctx = EnumContext {
        origin_x,
        origin_y,
        screen_w: screen_w as i32,
        screen_h: screen_h as i32,
        exclude_pid,
        windows: Vec::new(),
    };

    unsafe {
        let _ = EnumWindows(
            Some(enum_window_proc),
            LPARAM(&mut ctx as *mut EnumContext as isize),
        );
    }

    ctx.windows
}

unsafe extern "system" fn enum_window_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam.0 as *mut EnumContext);

    if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
        return BOOL(1);
    }

    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == ctx.exclude_pid {
        return BOOL(1);
    }

    let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    if (ex_style & WS_EX_TOOLWINDOW.0) != 0 {
        return BOOL(1);
    }

    let mut cloaked: u32 = 0;
    if DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED,
        &mut cloaked as *mut u32 as *mut c_void,
        size_of::<u32>() as u32,
    )
    .is_ok()
        && cloaked != 0
    {
        return BOOL(1);
    }

    let title_len = GetWindowTextLengthW(hwnd);
    if title_len <= 0 {
        return BOOL(1);
    }

    let mut title_buf = vec![0u16; (title_len + 1) as usize];
    let copied = GetWindowTextW(hwnd, &mut title_buf);
    if copied <= 0 {
        return BOOL(1);
    }
    let title = String::from_utf16_lossy(&title_buf[..copied as usize])
        .trim()
        .to_string();
    if title.is_empty() || title == "Program Manager" {
        return BOOL(1);
    }

    let mut rect = RECT::default();
    let got_rect = DwmGetWindowAttribute(
        hwnd,
        DWMWA_EXTENDED_FRAME_BOUNDS,
        &mut rect as *mut RECT as *mut c_void,
        size_of::<RECT>() as u32,
    )
    .is_ok()
        || GetWindowRect(hwnd, &mut rect).is_ok();

    if !got_rect {
        return BOOL(1);
    }

    // Convert to virtual-screen-relative coordinates and clamp
    let left = (rect.left - ctx.origin_x).clamp(0, ctx.screen_w);
    let top = (rect.top - ctx.origin_y).clamp(0, ctx.screen_h);
    let right = (rect.right - ctx.origin_x).clamp(0, ctx.screen_w);
    let bottom = (rect.bottom - ctx.origin_y).clamp(0, ctx.screen_h);

    let width = right - left;
    let height = bottom - top;

    if width >= 40 && height >= 40 {
        ctx.windows.push(WindowRect {
            hwnd: hwnd.0 as isize,
            title,
            x: left,
            y: top,
            width: width as u32,
            height: height as u32,
        });
    }

    BOOL(1)
}

pub fn crop_image(img: &RgbaImage, x: u32, y: u32, w: u32, h: u32) -> Result<RgbaImage, String> {
    let img_w = img.width();
    let img_h = img.height();

    if x >= img_w || y >= img_h {
        return Err("Las coordenadas de recorte están fuera de la captura".into());
    }

    let cw = w.min(img_w - x);
    let ch = h.min(img_h - y);

    if cw == 0 || ch == 0 {
        return Err("El área de recorte debe ser mayor a 0 píxeles".into());
    }

    Ok(image::imageops::crop_imm(img, x, y, cw, ch).to_image())
}

struct MonitorEnumContext {
    origin_x: i32,
    origin_y: i32,
    screen_w: i32,
    screen_h: i32,
    monitors: Vec<MonitorRect>,
}

pub fn enumerate_monitors(
    origin_x: i32,
    origin_y: i32,
    screen_w: u32,
    screen_h: u32,
) -> Vec<MonitorRect> {
    let mut ctx = MonitorEnumContext {
        origin_x,
        origin_y,
        screen_w: screen_w as i32,
        screen_h: screen_h as i32,
        monitors: Vec::new(),
    };

    unsafe {
        let _ = EnumDisplayMonitors(
            HDC::default(),
            None,
            Some(monitor_enum_proc),
            LPARAM(&mut ctx as *mut MonitorEnumContext as isize),
        );
    }

    if ctx.monitors.is_empty() {
        ctx.monitors.push(MonitorRect {
            index: 1,
            name: "Pantalla 1 (Principal)".to_string(),
            is_primary: true,
            x: 0,
            y: 0,
            width: screen_w.max(1),
            height: screen_h.max(1),
        });
        return ctx.monitors;
    }

    ctx.monitors.sort_by_key(|m| (!m.is_primary, m.x, m.y));
    for (i, m) in ctx.monitors.iter_mut().enumerate() {
        m.index = i + 1;
        m.name = if m.is_primary {
            format!("Pantalla {} (Principal)", i + 1)
        } else {
            format!("Pantalla {}", i + 1)
        };
    }

    ctx.monitors
}

unsafe extern "system" fn monitor_enum_proc(
    hmon: HMONITOR,
    _hdc: HDC,
    _lprc: *mut RECT,
    lparam: LPARAM,
) -> BOOL {
    let ctx = &mut *(lparam.0 as *mut MonitorEnumContext);
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };

    if GetMonitorInfoW(hmon, &mut info).as_bool() {
        let r = info.rcMonitor;
        let left = (r.left - ctx.origin_x).clamp(0, ctx.screen_w);
        let top = (r.top - ctx.origin_y).clamp(0, ctx.screen_h);
        let right = (r.right - ctx.origin_x).clamp(0, ctx.screen_w);
        let bottom = (r.bottom - ctx.origin_y).clamp(0, ctx.screen_h);
        let w = right - left;
        let h = bottom - top;
        if w > 0 && h > 0 {
            ctx.monitors.push(MonitorRect {
                index: 0,
                name: String::new(),
                is_primary: (info.dwFlags & 1) != 0,
                x: left,
                y: top,
                width: w as u32,
                height: h as u32,
            });
        }
    }

    BOOL(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enumerate_monitors_returns_at_least_one_monitor() {
        let origin_x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
        let origin_y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
        let w = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) }.max(1) as u32;
        let h = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) }.max(1) as u32;
        let mons = enumerate_monitors(origin_x, origin_y, w, h);
        assert!(!mons.is_empty());
        assert_eq!(mons[0].index, 1);
        assert!(mons[0].width > 0 && mons[0].height > 0);
    }
}
