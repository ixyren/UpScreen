use crate::frame::{apply_rounded_shadow_frame, FrameOptions};
use crate::gpu::{detect_ffmpeg_encoders, detect_gpu, GpuInfo, HardwareEncoders};
use crate::upscaler::{find_ffmpeg_exe, upscale_image};
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageFormat, RgbaImage};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::BufWriter;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;
use uuid::Uuid;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn default_text_protection() -> String {
    "supersample".to_string()
}

fn default_frame_scale() -> f32 {
    1.0
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOptions {
    pub path: String,
    pub format: String,            // "png" | "webp" | "jpg" | "hevc-hw"
    pub codec_preference: String,  // "auto" | "nvenc" | "amf" | "cpu"
    pub upscale_before_save: bool,
    pub scale: u32,
    pub model: String,
    #[serde(default = "default_text_protection")]
    pub text_protection: String,
    #[serde(default)]
    pub frame: Option<FrameOptions>,
    #[serde(default = "default_frame_scale")]
    pub frame_scale: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub elapsed_ms: u128,
    pub upscale_engine: Option<String>,
    pub codec_used: String,
}

pub fn save_processed_image(img: RgbaImage, opts: SaveOptions) -> Result<SaveResult, String> {
    let start = Instant::now();

    let (mut working_img, upscale_engine) = if opts.upscale_before_save {
        let (up, engine) = upscale_image(&img, opts.scale, &opts.model, &opts.text_protection)?;
        (up, Some(engine))
    } else {
        (img, None)
    };

    let mut frame_applied = false;
    if let Some(frame_opts) = opts.frame.as_ref() {
        if frame_opts.enabled {
            let eff_scale = if opts.upscale_before_save {
                opts.scale.max(1) as f32
            } else {
                opts.frame_scale.max(1.0)
            };
            working_img = apply_rounded_shadow_frame(&working_img, frame_opts, eff_scale);
            frame_applied = true;
        }
    }

    let final_w = working_img.width();
    let final_h = working_img.height();

    let out_path = PathBuf::from(&opts.path);
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("No se pudo crear la carpeta destino: {e}"))?;
    }

    let gpu = detect_gpu();
    let ffmpeg_opt = find_ffmpeg_exe();
    let encoders = ffmpeg_opt
        .as_deref()
        .map(detect_ffmpeg_encoders)
        .unwrap_or_default();

    let format = opts.format.to_lowercase();
    let mut codec_used = if format == "hevc-hw" {
        encode_hevc_hw(&working_img, &out_path, &opts.codec_preference, &gpu, ffmpeg_opt.as_deref(), &encoders)?
    } else {
        encode_image_format(&working_img, &out_path, &format, &opts.codec_preference, &gpu, ffmpeg_opt.as_deref(), &encoders)?
    };
    if frame_applied && format == "png" {
        codec_used.push_str(" + marco PNG");
    }

    Ok(SaveResult {
        path: out_path.to_string_lossy().to_string(),
        width: final_w,
        height: final_h,
        elapsed_ms: start.elapsed().as_millis(),
        upscale_engine,
        codec_used,
    })
}

fn resolve_hw_tag(pref: &str, gpu: &GpuInfo, encoders: &HardwareEncoders) -> String {
    match pref {
        "nvenc" if encoders.hevc_nvenc || encoders.h264_nvenc => "nvenc".to_string(),
        "amf" if encoders.hevc_amf || encoders.h264_amf => "amf".to_string(),
        "auto" => {
            if gpu.supports_nvenc && (encoders.hevc_nvenc || encoders.h264_nvenc) {
                "nvenc".to_string()
            } else if gpu.supports_amf && (encoders.hevc_amf || encoders.h264_amf) {
                "amf".to_string()
            } else if encoders.hevc_nvenc || encoders.h264_nvenc {
                "nvenc".to_string()
            } else if encoders.hevc_amf || encoders.h264_amf {
                "amf".to_string()
            } else {
                "cpu".to_string()
            }
        }
        _ => "cpu".to_string(),
    }
}

fn encode_hevc_hw(
    img: &RgbaImage,
    out_path: &Path,
    codec_pref: &str,
    gpu: &GpuInfo,
    ffmpeg_opt: Option<&Path>,
    encoders: &HardwareEncoders,
) -> Result<String, String> {
    let ffmpeg = ffmpeg_opt.ok_or_else(|| {
        "FFmpeg no está instalado en PATH ni en %LOCALAPPDATA%\\UpScreen\\bin para exportar MP4 HEVC (NVENC/AMF). Usa PNG/WebP/JPEG o instala FFmpeg.".to_string()
    })?;

    // Ensure even dimensions for YUV420 hardware encoders
    let even_w = (img.width() / 2) * 2;
    let even_h = (img.height() / 2) * 2;
    let adjusted = if even_w != img.width() || even_h != img.height() {
        image::imageops::crop_imm(img, 0, 0, even_w.max(2), even_h.max(2)).to_image()
    } else {
        img.clone()
    };

    let tmp_dir = std::env::temp_dir().join(format!("upscreen-enc-{}", Uuid::new_v4()));
    fs::create_dir_all(&tmp_dir)
        .map_err(|e| format!("No se pudo crear temp dir para FFmpeg: {e}"))?;
    let tmp_png = tmp_dir.join("frame.png");
    adjusted
        .save(&tmp_png)
        .map_err(|e| format!("Error guardando frame temporal: {e}"))?;

    let resolved = resolve_hw_tag(codec_pref, gpu, encoders);
    let (vcodec, label) = match resolved.as_str() {
        "nvenc" if encoders.hevc_nvenc => ("hevc_nvenc", "hevc_nvenc (NVIDIA NVENC)"),
        "nvenc" if encoders.h264_nvenc => ("h264_nvenc", "h264_nvenc (NVIDIA NVENC)"),
        "amf" if encoders.hevc_amf => ("hevc_amf", "hevc_amf (AMD AMF)"),
        "amf" if encoders.h264_amf => ("h264_amf", "h264_amf (AMD AMF)"),
        _ => ("libx265", "libx265 (CPU fallback)"),
    };

    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-y", "-i"])
        .arg(&tmp_png)
        .args(["-c:v", vcodec, "-pix_fmt", "yuv420p"]);

    if vcodec == "hevc_nvenc" || vcodec == "h264_nvenc" {
        cmd.args(["-preset", "p5", "-cq", "18"]);
    } else if vcodec == "hevc_amf" || vcodec == "h264_amf" {
        cmd.args(["-quality", "quality", "-qp_i", "18"]);
    } else {
        cmd.args(["-crf", "18"]);
    }

    cmd.arg(out_path).creation_flags(CREATE_NO_WINDOW);

    let out = cmd.output();
    let _ = fs::remove_dir_all(&tmp_dir);

    match out {
        Ok(o) if o.status.success() => Ok(label.to_string()),
        Ok(o) => Err(format!(
            "FFmpeg ({vcodec}) falló: {}",
            String::from_utf8_lossy(&o.stderr).trim()
        )),
        Err(e) => Err(format!("No se pudo ejecutar FFmpeg: {e}")),
    }
}

fn encode_image_format(
    img: &RgbaImage,
    out_path: &Path,
    format: &str,
    codec_pref: &str,
    gpu: &GpuInfo,
    ffmpeg_opt: Option<&Path>,
    encoders: &HardwareEncoders,
) -> Result<String, String> {
    let hw_note = if ffmpeg_opt.is_some() {
        match resolve_hw_tag(codec_pref, gpu, encoders).as_str() {
            "nvenc" => " + NVENC ready",
            "amf" => " + AMF ready",
            _ => "",
        }
    } else {
        ""
    };

    match format {
        "jpg" | "jpeg" => {
            let rgb = DynamicImage::ImageRgba8(img.clone()).to_rgb8();
            let file = File::create(out_path)
                .map_err(|e| format!("Error creando archivo JPEG: {e}"))?;
            let writer = BufWriter::new(file);
            let mut enc = JpegEncoder::new_with_quality(writer, 96);
            enc.encode_image(&rgb)
                .map_err(|e| format!("Error codificando JPEG: {e}"))?;
            Ok(format!("jpeg-q96{hw_note}"))
        }
        "webp" => {
            img.save_with_format(out_path, ImageFormat::WebP)
                .map_err(|e| format!("Error guardando WebP: {e}"))?;
            Ok(format!("webp-native{hw_note}"))
        }
        _ => {
            img.save_with_format(out_path, ImageFormat::Png)
                .map_err(|e| format!("Error guardando PNG: {e}"))?;
            Ok(format!("png-lossless{hw_note}"))
        }
    }
}
