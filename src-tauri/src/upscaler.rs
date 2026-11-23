use directories::BaseDirs;
use futures_util::StreamExt;
use image::imageops::FilterType;
use image::RgbaImage;
use serde::Serialize;
use std::fs::{self, File};
use std::io::{self, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;
use zip::ZipArchive;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const MAX_OUTPUT_DIM: u32 = 16384;
const MAX_OUTPUT_PIXELS: u64 = 100_000_000;
const REALESRGAN_URL: &str =
    "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgressEvent {
    pub percent: u8,
    pub status: String,
}

pub fn get_bin_dir() -> PathBuf {
    if let Some(base) = BaseDirs::new() {
        return base.data_local_dir().join("UpScreen").join("bin");
    }
    PathBuf::from("bin")
}

pub fn find_realesrgan_exe() -> Option<PathBuf> {
    let local_bin = get_bin_dir();
    let mut candidates = vec![
        local_bin.join("realesrgan").join("realesrgan-ncnn-vulkan.exe"),
        local_bin.join("realesrgan-ncnn-vulkan.exe"),
    ];

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("realesrgan-ncnn-vulkan.exe"));
            candidates.push(dir.join("bin").join("realesrgan-ncnn-vulkan.exe"));
            candidates.push(dir.join("realesrgan").join("realesrgan-ncnn-vulkan.exe"));
        }
    }

    for c in candidates {
        if c.is_file() {
            return Some(c);
        }
    }

    let nested_root = local_bin.join("realesrgan");
    if let Ok(entries) = fs::read_dir(&nested_root) {
        for entry in entries.flatten() {
            let candidate = entry.path().join("realesrgan-ncnn-vulkan.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    find_in_path("realesrgan-ncnn-vulkan.exe")
}

pub fn find_ffmpeg_exe() -> Option<PathBuf> {
    let local_bin = get_bin_dir();
    let mut candidates = vec![
        local_bin.join("ffmpeg").join("ffmpeg.exe"),
        local_bin.join("ffmpeg.exe"),
        PathBuf::from(r"C:\ffmpeg\bin\ffmpeg.exe"),
    ];

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("ffmpeg.exe"));
            candidates.push(dir.join("bin").join("ffmpeg.exe"));
        }
    }

    for c in candidates {
        if c.is_file() {
            return Some(c);
        }
    }

    find_in_path("ffmpeg.exe")
}

fn find_in_path(exe_name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(exe_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

pub fn upscale_image(
    img: &RgbaImage,
    scale: u32,
    model: &str,
    text_protection: &str,
) -> Result<(RgbaImage, String), String> {
    let target_scale = scale.clamp(2, 16);
    let target_w = img.width().saturating_mul(target_scale);
    let target_h = img.height().saturating_mul(target_scale);
    let total_pixels = (target_w as u64).saturating_mul(target_h as u64);

    if target_w > MAX_OUTPUT_DIM || target_h > MAX_OUTPUT_DIM || total_pixels > MAX_OUTPUT_PIXELS {
        return Err(format!(
            "La resolución resultante ({target_w}×{target_h}) excede el límite seguro (16384 px por lado o 100 MP). Usa una escala menor o recorta primero."
        ));
    }

    if model == "crisp-ui" {
        let crisp = crisp_geometric_upscale(img, target_w, target_h);
        return Ok((crisp, format!("crisp-ui-{}x", target_scale)));
    }

    let quality_mode = match text_protection {
        "raw" | "off" => "raw",
        "tta" | "balanced" => "tta",
        _ => "supersample",
    };

    if let Some(exe_path) = find_realesrgan_exe() {
        let is_animevideo = model == "realesr-animevideov3";

        if quality_mode == "supersample" {
            // Pre-scale small/medium captures with ringing-free CatmullRom so small UI glyphs
            // become crisp multi-pixel strokes before entering the Real-ESRGAN neural network.
            let (pre_num, pre_den) = if img.width() <= 1600 && img.height() <= 1600 {
                (2u32, 1u32)
            } else if img.width() <= 2200 && img.height() <= 2200 {
                (3u32, 2u32)
            } else {
                (1u32, 1u32)
            };

            let pre_img = if pre_num != pre_den {
                let pw = (img.width().saturating_mul(pre_num) / pre_den).max(1);
                let ph = (img.height().saturating_mul(pre_num) / pre_den).max(1);
                image::imageops::resize(img, pw, ph, FilterType::CatmullRom)
            } else {
                img.clone()
            };

            let pass1_scale = if is_animevideo {
                if pre_num == 2 && pre_den == 1 {
                    if target_scale <= 4 {
                        2
                    } else if target_scale <= 6 {
                        3
                    } else {
                        4
                    }
                } else if pre_num == 3 && pre_den == 2 {
                    if target_scale <= 3 {
                        2
                    } else if target_scale <= 4 {
                        3
                    } else {
                        4
                    }
                } else {
                    target_scale.clamp(2, 4)
                }
            } else {
                4
            };

            let p1 = run_realesrgan_pass(&exe_path, &pre_img, pass1_scale, model, false)?;
            let ai_reached_num = pre_num.saturating_mul(pass1_scale);
            let ssaa_tag = if pre_num != pre_den { " (SSAA)" } else { "" };

            if target_scale.saturating_mul(pre_den) <= ai_reached_num {
                let sized = if p1.width() != target_w || p1.height() != target_h {
                    image::imageops::resize(&p1, target_w, target_h, FilterType::Lanczos3)
                } else {
                    p1
                };
                let cleaned = clean_flat_color_regions(img, &sized);
                return Ok((cleaned, format!("realesrgan-vulkan{ssaa_tag}")));
            }

            if p1.width() <= 3200 && p1.height() <= 3200 {
                let rem = (target_w as f32 / p1.width() as f32)
                    .max(target_h as f32 / p1.height() as f32);
                let pass2_scale = if rem <= 2.0 {
                    2
                } else if rem <= 3.0 {
                    3
                } else {
                    4
                };
                let p2 = run_realesrgan_pass(&exe_path, &p1, pass2_scale, "realesr-animevideov3", false)?;
                let sized = if p2.width() != target_w || p2.height() != target_h {
                    image::imageops::resize(&p2, target_w, target_h, FilterType::Lanczos3)
                } else {
                    p2
                };
                let cleaned = clean_flat_color_regions(img, &sized);
                let tag = if pre_num != pre_den {
                    "realesrgan-vulkan (SSAA 2-pass)"
                } else {
                    "realesrgan-vulkan (2-pass)"
                };
                return Ok((cleaned, tag.to_string()));
            }

            let finished = crisp_geometric_upscale(&p1, target_w, target_h);
            let cleaned = clean_flat_color_regions(img, &finished);
            let tag = if pre_num != pre_den {
                "realesrgan-vulkan (SSAA+crisp)"
            } else {
                "realesrgan-vulkan (4x+crisp)"
            };
            return Ok((cleaned, tag.to_string()));
        }

        // Direct ("raw") or TTA ("tta") 100% Real-ESRGAN Vulkan pass
        let use_tta = quality_mode == "tta";
        let mode_suffix = if use_tta { " (TTA)" } else { "" };

        if target_scale <= 4 {
            let cli_scale = if is_animevideo { target_scale } else { 4 };
            let pass1 = run_realesrgan_pass(&exe_path, img, cli_scale, model, use_tta)?;
            let sized = if pass1.width() != target_w || pass1.height() != target_h {
                image::imageops::resize(&pass1, target_w, target_h, FilterType::Lanczos3)
            } else {
                pass1
            };
            let cleaned = clean_flat_color_regions(img, &sized);
            return Ok((cleaned, format!("realesrgan-vulkan{mode_suffix}")));
        }

        let p1 = run_realesrgan_pass(&exe_path, img, 4, model, use_tta)?;
        if p1.width() <= 3200 && p1.height() <= 3200 {
            let pass2_scale = if target_scale <= 8 {
                2
            } else if p1.width() <= 1800 && p1.height() <= 1800 {
                4
            } else {
                0
            };

            if pass2_scale > 0 {
                let p2 = run_realesrgan_pass(&exe_path, &p1, pass2_scale, "realesr-animevideov3", false)?;
                let sized = if p2.width() != target_w || p2.height() != target_h {
                    image::imageops::resize(&p2, target_w, target_h, FilterType::Lanczos3)
                } else {
                    p2
                };
                let cleaned = clean_flat_color_regions(img, &sized);
                let tag = if use_tta {
                    "realesrgan-vulkan (TTA 2-pass)"
                } else {
                    "realesrgan-vulkan (2-pass)"
                };
                return Ok((cleaned, tag.to_string()));
            }
        }

        let finished = crisp_geometric_upscale(&p1, target_w, target_h);
        let cleaned = clean_flat_color_regions(img, &finished);
        let tag = if use_tta {
            "realesrgan-vulkan (TTA+crisp)"
        } else {
            "realesrgan-vulkan (4x+crisp)"
        };
        return Ok((cleaned, tag.to_string()));
    }

    // Graceful crisp geometric fallback when Real-ESRGAN binary is not yet installed
    let crisp = crisp_geometric_upscale(img, target_w, target_h);
    Ok((crisp, "crisp-fallback".to_string()))
}

fn run_realesrgan_pass(
    exe_path: &Path,
    img: &RgbaImage,
    pass_scale: u32,
    model: &str,
    use_tta: bool,
) -> Result<RgbaImage, String> {
    let tmp_dir = std::env::temp_dir().join(format!("upscreen-{}", Uuid::new_v4()));
    fs::create_dir_all(&tmp_dir)
        .map_err(|e| format!("No se pudo crear directorio temporal: {e}"))?;

    let input_path = tmp_dir.join("input.png");
    let output_path = tmp_dir.join("output.png");

    if let Err(e) = img.save(&input_path) {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(format!("No se pudo preparar imagen para Real-ESRGAN: {e}"));
    }

    let normalized_model = match model {
        "realesrgan-x4plus-anime" => "realesrgan-x4plus-anime",
        "realesr-animevideov3" => "realesr-animevideov3",
        _ => "realesrgan-x4plus",
    };

    let cli_scale = if normalized_model == "realesr-animevideov3" {
        pass_scale.clamp(2, 4)
    } else {
        4
    };

    let models_dir = exe_path
        .parent()
        .map(|p| p.join("models"))
        .filter(|p| p.is_dir());

    let mut cmd = Command::new(exe_path);
    cmd.arg("-i")
        .arg(&input_path)
        .arg("-o")
        .arg(&output_path)
        .arg("-n")
        .arg(normalized_model)
        .arg("-s")
        .arg(cli_scale.to_string())
        .arg("-t")
        .arg("400")
        .arg("-f")
        .arg("png")
        .creation_flags(CREATE_NO_WINDOW);

    if use_tta {
        cmd.arg("-x");
    }
    if let Some(mdir) = models_dir {
        cmd.arg("-m").arg(mdir);
    }
    if let Some(parent) = exe_path.parent() {
        cmd.current_dir(parent);
    }

    let status = cmd.output();
    let res = match status {
        Ok(out) if out.status.success() && output_path.is_file() => image::open(&output_path)
            .map(|d| d.to_rgba8())
            .map_err(|e| format!("Error leyendo salida de Real-ESRGAN: {e}")),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let stdout = String::from_utf8_lossy(&out.stdout);
            Err(format!(
                "Real-ESRGAN falló (código {:?}): {} {}",
                out.status.code(),
                stderr.trim(),
                stdout.trim()
            ))
        }
        Err(e) => Err(format!("No se pudo ejecutar Real-ESRGAN: {e}")),
    };

    let _ = fs::remove_dir_all(&tmp_dir);
    res
}

fn crisp_geometric_upscale(img: &RgbaImage, target_w: u32, target_h: u32) -> RgbaImage {
    if img.width() == target_w && img.height() == target_h {
        return img.clone();
    }

    if target_w <= img.width().saturating_mul(2) && target_h <= img.height().saturating_mul(2) {
        let resized = image::imageops::resize(img, target_w, target_h, FilterType::Lanczos3);
        return unsharp_mask_luma(&resized, 0.50, 5.0);
    }

    let mut cur = img.clone();
    while cur.width() < target_w || cur.height() < target_h {
        let next_w = cur.width().saturating_mul(2).min(target_w);
        let next_h = cur.height().saturating_mul(2).min(target_h);
        let stepped = image::imageops::resize(&cur, next_w, next_h, FilterType::Lanczos3);
        if next_w == target_w && next_h == target_h {
            cur = unsharp_mask_luma(&stepped, 0.50, 5.0);
        } else {
            cur = unsharp_mask_luma(&stepped, 0.22, 6.0);
        }
    }
    cur
}

fn unsharp_mask_luma(img: &RgbaImage, amount: f32, threshold: f32) -> RgbaImage {
    let w = img.width() as usize;
    let h = img.height() as usize;
    if w == 0 || h == 0 {
        return img.clone();
    }

    let raw = img.as_raw();
    let total = w * h;
    let mut luma = vec![0.0f32; total];
    for (i, px) in raw.chunks_exact(4).enumerate() {
        luma[i] = 0.299 * (px[0] as f32) + 0.587 * (px[1] as f32) + 0.114 * (px[2] as f32);
    }

    let mut tmp = vec![0.0f32; total];
    for y in 0..h {
        let row = y * w;
        for x in 0..w {
            let xl = x.saturating_sub(1);
            let xr = (x + 1).min(w - 1);
            tmp[row + x] = 0.25 * luma[row + xl] + 0.5 * luma[row + x] + 0.25 * luma[row + xr];
        }
    }

    let mut blurred = vec![0.0f32; total];
    for y in 0..h {
        let yu = y.saturating_sub(1) * w;
        let yc = y * w;
        let yd = (y + 1).min(h - 1) * w;
        for x in 0..w {
            blurred[yc + x] = 0.25 * tmp[yu + x] + 0.5 * tmp[yc + x] + 0.25 * tmp[yd + x];
        }
    }

    let mut out = raw.to_vec();
    for (i, px) in out.chunks_exact_mut(4).enumerate() {
        let diff = luma[i] - blurred[i];
        if diff.abs() >= threshold {
            let delta = diff * amount;
            px[0] = ((px[0] as f32) + delta).round().clamp(0.0, 255.0) as u8;
            px[1] = ((px[1] as f32) + delta).round().clamp(0.0, 255.0) as u8;
            px[2] = ((px[2] as f32) + delta).round().clamp(0.0, 255.0) as u8;
        }
    }

    RgbaImage::from_raw(img.width(), img.height(), out).unwrap_or_else(|| img.clone())
}

pub async fn download_realesrgan(app: &AppHandle) -> Result<PathBuf, String> {
    let bin_root = get_bin_dir();
    let target_dir = bin_root.join("realesrgan");
    fs::create_dir_all(&target_dir)
        .map_err(|e| format!("No se pudo crear carpeta {}: {e}", target_dir.display()))?;

    let _ = app.emit(
        "engine-download-progress",
        DownloadProgressEvent {
            percent: 2,
            status: "Conectando con GitHub Releases (Real-ESRGAN Vulkan)...".into(),
        },
    );

    let client = reqwest::Client::builder()
        .user_agent("UpScreen/0.1")
        .build()
        .map_err(|e| format!("Error iniciando cliente HTTP: {e}"))?;

    let resp = client
        .get(REALESRGAN_URL)
        .send()
        .await
        .map_err(|e| format!("Error descargando Real-ESRGAN: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Error HTTP {} descargando Real-ESRGAN",
            resp.status()
        ));
    }

    let total_size = resp.content_length().unwrap_or(0);
    let zip_path = bin_root.join("realesrgan-vulkan.zip");
    let mut file = File::create(&zip_path)
        .map_err(|e| format!("No se pudo crear archivo zip temporal: {e}"))?;

    let mut downloaded: u64 = 0;
    let mut last_pct: u8 = 0;
    let mut stream = resp.bytes_stream();

    while let Some(chunk_res) = stream.next().await {
        let chunk = chunk_res.map_err(|e| format!("Error en descarga: {e}"))?;
        file.write_all(&chunk)
            .map_err(|e| format!("Error escribiendo descarga: {e}"))?;
        downloaded += chunk.len() as u64;

        if total_size > 0 {
            let pct = ((downloaded * 85) / total_size).min(85) as u8;
            if pct >= last_pct.saturating_add(3) || pct == 85 {
                last_pct = pct;
                let mb_done = downloaded as f64 / (1024.0 * 1024.0);
                let mb_tot = total_size as f64 / (1024.0 * 1024.0);
                let _ = app.emit(
                    "engine-download-progress",
                    DownloadProgressEvent {
                        percent: pct.max(5),
                        status: format!("Descargando modelos y motor Vulkan ({mb_done:.1} / {mb_tot:.1} MB)..."),
                    },
                );
            }
        }
    }
    drop(file);

    let _ = app.emit(
        "engine-download-progress",
        DownloadProgressEvent {
            percent: 90,
            status: "Extrayendo binarios y modelos Real-ESRGAN...".into(),
        },
    );

    let extract_dir = target_dir.clone();
    let zip_for_extract = zip_path.clone();
    tokio::task::spawn_blocking(move || extract_zip(&zip_for_extract, &extract_dir))
        .await
        .map_err(|e| format!("Error en tarea de extracción: {e}"))??;

    let _ = fs::remove_file(&zip_path);

    let exe_path = find_realesrgan_exe()
        .ok_or_else(|| "Extracción completada pero no se encontró realesrgan-ncnn-vulkan.exe".to_string())?;

    let _ = app.emit(
        "engine-download-progress",
        DownloadProgressEvent {
            percent: 100,
            status: "Real-ESRGAN Vulkan listo para usar".into(),
        },
    );

    Ok(exe_path)
}

fn extract_zip(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|e| format!("No se pudo abrir ZIP: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("ZIP inválido: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Error leyendo entrada ZIP: {e}"))?;

        let enclosed = match entry.enclosed_name() {
            Some(p) => p.to_owned(),
            None => continue,
        };

        let out_path = dest_dir.join(enclosed);
        if entry.is_dir() {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("No se pudo crear directorio {}: {e}", out_path.display()))?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("No se pudo crear directorio padre: {e}"))?;
            }
            let mut out_file = File::create(&out_path)
                .map_err(|e| format!("No se pudo crear {}: {e}", out_path.display()))?;
            io::copy(&mut entry, &mut out_file)
                .map_err(|e| format!("No se pudo extraer {}: {e}", out_path.display()))?;
        }
    }

    Ok(())
}

/// Removes Vulkan FP16 / tile-stitching square artifacts on completely flat solid-color regions
/// while keeping 100% of Real-ESRGAN AI output on edges, text, icons, gradients, and photos.
fn clean_flat_color_regions(src: &RgbaImage, upscaled: &RgbaImage) -> RgbaImage {
    let sw = src.width() as usize;
    let sh = src.height() as usize;
    let tw = upscaled.width() as usize;
    let th = upscaled.height() as usize;
    if sw == 0 || sh == 0 || tw == 0 || th == 0 {
        return upscaled.clone();
    }

    let sraw = src.as_raw();
    let total_src = sw * sh;
    let mut raw_flat = vec![0.0f32; total_src];

    for y in 0..sh {
        for x in 0..sw {
            let mut min_r = 255u8;
            let mut max_r = 0u8;
            let mut min_g = 255u8;
            let mut max_g = 0u8;
            let mut min_b = 255u8;
            let mut max_b = 0u8;

            for dy in -2isize..=2 {
                let yy = (y as isize + dy).clamp(0, sh as isize - 1) as usize;
                let row = yy * sw;
                for dx in -2isize..=2 {
                    let xx = (x as isize + dx).clamp(0, sw as isize - 1) as usize;
                    let idx = (row + xx) * 4;
                    let r = sraw[idx];
                    let g = sraw[idx + 1];
                    let b = sraw[idx + 2];
                    if r < min_r { min_r = r; }
                    if r > max_r { max_r = r; }
                    if g < min_g { min_g = g; }
                    if g > max_g { max_g = g; }
                    if b < min_b { min_b = b; }
                    if b > max_b { max_b = b; }
                }
            }

            let range = (max_r - min_r)
                .max(max_g - min_g)
                .max(max_b - min_b);

            raw_flat[y * sw + x] = if range <= 3 {
                1.0
            } else if range < 10 {
                (10 - range) as f32 / 7.0
            } else {
                0.0
            };
        }
    }

    // Smooth flatness mask with a 3x3 box blur for invisible transitions
    let mut flat_mask = vec![0.0f32; total_src];
    for y in 0..sh {
        for x in 0..sw {
            let mut sum = 0.0f32;
            for dy in -1isize..=1 {
                let yy = (y as isize + dy).clamp(0, sh as isize - 1) as usize;
                let row = yy * sw;
                for dx in -1isize..=1 {
                    let xx = (x as isize + dx).clamp(0, sw as isize - 1) as usize;
                    sum += raw_flat[row + xx];
                }
            }
            flat_mask[y * sw + x] = sum / 9.0;
        }
    }

    let uraw = upscaled.as_raw();
    let mut out = uraw.to_vec();
    let scale_x = sw as f32 / tw as f32;
    let scale_y = sh as f32 / th as f32;

    for y in 0..th {
        let sy = ((y as f32 + 0.5) * scale_y - 0.5).clamp(0.0, (sh - 1) as f32);
        let y0 = sy.floor() as usize;
        let y1 = (y0 + 1).min(sh - 1);
        let wy = sy - y0 as f32;

        for x in 0..tw {
            let sx = ((x as f32 + 0.5) * scale_x - 0.5).clamp(0.0, (sw - 1) as f32);
            let x0 = sx.floor() as usize;
            let x1 = (x0 + 1).min(sw - 1);
            let wx = sx - x0 as f32;

            let f00 = flat_mask[y0 * sw + x0];
            let f10 = flat_mask[y0 * sw + x1];
            let f01 = flat_mask[y1 * sw + x0];
            let f11 = flat_mask[y1 * sw + x1];
            let fw = (f00 + (f10 - f00) * wx) * (1.0 - wy)
                + (f01 + (f11 - f01) * wx) * wy;

            if fw <= 0.001 {
                continue;
            }

            let i00 = (y0 * sw + x0) * 4;
            let i10 = (y0 * sw + x1) * 4;
            let i01 = (y1 * sw + x0) * 4;
            let i11 = (y1 * sw + x1) * 4;
            let oidx = (y * tw + x) * 4;
            let inv_fw = 1.0 - fw;

            for c in 0..3 {
                let c00 = sraw[i00 + c] as f32;
                let c10 = sraw[i10 + c] as f32;
                let c01 = sraw[i01 + c] as f32;
                let c11 = sraw[i11 + c] as f32;
                let clean = (c00 + (c10 - c00) * wx) * (1.0 - wy)
                    + (c01 + (c11 - c01) * wx) * wy;
                out[oidx + c] = (uraw[oidx + c] as f32 * inv_fw + clean * fw)
                    .round()
                    .clamp(0.0, 255.0) as u8;
            }
        }
    }

    RgbaImage::from_raw(upscaled.width(), upscaled.height(), out)
        .unwrap_or_else(|| upscaled.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    #[test]
    fn clean_flat_color_regions_removes_artifacts_on_solid_areas_while_keeping_detail() {
        let mut src = RgbaImage::new(32, 32);
        for y in 0..32 {
            for x in 0..32 {
                // Left half: completely flat solid dark color (#1E222A)
                // Right half: high-contrast detail
                let px = if x < 16 {
                    Rgba([30, 34, 42, 255])
                } else if (x + y) % 2 == 0 {
                    Rgba([240, 240, 240, 255])
                } else {
                    Rgba([20, 20, 20, 255])
                };
                src.put_pixel(x, y, px);
            }
        }

        // Simulate noisy square artifacts on the flat left half and enhanced pixels on the right half
        let mut fake_gan = image::imageops::resize(&src, 64, 64, FilterType::Nearest);
        fake_gan.put_pixel(10, 10, Rgba([60, 10, 80, 255]));
        fake_gan.put_pixel(50, 32, Rgba([180, 120, 220, 255]));

        let cleaned = clean_flat_color_regions(&src, &fake_gan);
        // Flat region artifact must be wiped back to exact solid color
        assert_eq!(cleaned.get_pixel(10, 10), &Rgba([30, 34, 42, 255]));
        // Detailed region must keep 100% of GAN pixel untouched
        assert_eq!(cleaned.get_pixel(50, 32), &Rgba([180, 120, 220, 255]));
    }

    #[test]
    fn upscale_rejects_oversized_output() {
        let img = RgbaImage::new(2048, 2048);
        let res = upscale_image(&img, 10, "realesrgan-x4plus", "supersample");
        assert!(res.is_err());
    }

    #[test]
    fn upscale_realesrgan_produces_ai_upscaled_output() {
        let mut img = RgbaImage::new(64, 64);
        for y in 0..64 {
            for x in 0..64 {
                let r = ((x * 4) % 255) as u8;
                let g = ((y * 4) % 255) as u8;
                let b = if (x > 16 && x < 48) && (y == 24 || y == 40) {
                    255
                } else {
                    40
                };
                img.put_pixel(x, y, Rgba([r, g, b, 255]));
            }
        }

        let (up, engine) = upscale_image(&img, 4, "realesrgan-x4plus", "supersample")
            .expect("upscale_image should succeed");
        assert_eq!(up.width(), 256);
        assert_eq!(up.height(), 256);
        if find_realesrgan_exe().is_some() {
            assert!(engine.contains("realesrgan-vulkan"), "engine was {engine}");
            // Verify pixels differ from plain Lanczos3 (proving Real-ESRGAN neural network ran)
            let lanczos = image::imageops::resize(&img, 256, 256, FilterType::Lanczos3);
            let mut diffs = 0usize;
            for (a, b) in up.as_raw().chunks_exact(4).zip(lanczos.as_raw().chunks_exact(4)) {
                if (a[0] as i16 - b[0] as i16).abs() > 2
                    || (a[1] as i16 - b[1] as i16).abs() > 2
                    || (a[2] as i16 - b[2] as i16).abs() > 2
                {
                    diffs += 1;
                }
            }
            assert!(diffs > 100, "expected Real-ESRGAN AI enhancement, diffs={diffs}");
        }
    }
}
