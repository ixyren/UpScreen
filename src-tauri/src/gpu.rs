use serde::Serialize;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, DXGI_ADAPTER_DESC1};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub name: String,
    pub vendor: String,
    pub vram_mb: u64,
    pub recommended_codec: String,
    pub supports_nvenc: bool,
    pub supports_amf: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HardwareEncoders {
    pub hevc_nvenc: bool,
    pub h264_nvenc: bool,
    pub hevc_amf: bool,
    pub h264_amf: bool,
}

pub fn detect_gpu() -> GpuInfo {
    unsafe {
        if let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() {
            let mut best: Option<(u64, DXGI_ADAPTER_DESC1)> = None;
            let mut idx = 0u32;

            while let Ok(adapter) = factory.EnumAdapters1(idx) {
                idx += 1;
                let adapter: IDXGIAdapter1 = adapter;
                if let Ok(desc) = adapter.GetDesc1() {
                    // Skip Microsoft Basic Render Driver (0x1414) unless nothing else exists
                    let is_software = desc.VendorId == 0x1414;
                    let vram = desc.DedicatedVideoMemory as u64;
                    let score = if is_software {
                        0
                    } else {
                        vram.saturating_add(match desc.VendorId {
                            0x10DE | 0x1002 => 10_000_000_000, // Prefer discrete NVIDIA / AMD
                            _ => 0,
                        })
                    };

                    if best.as_ref().map_or(true, |(best_score, _)| score > *best_score) {
                        best = Some((score, desc));
                    }
                }
            }

            if let Some((_, desc)) = best {
                let raw_name = &desc.Description;
                let end = raw_name.iter().position(|&c| c == 0).unwrap_or(raw_name.len());
                let name = String::from_utf16_lossy(&raw_name[..end]).trim().to_string();
                let (vendor, recommended_codec) = match desc.VendorId {
                    0x10DE => ("NVIDIA".to_string(), "nvenc".to_string()),
                    0x1002 => ("AMD".to_string(), "amf".to_string()),
                    0x8086 => ("Intel".to_string(), "qsv".to_string()),
                    _ => ("Unknown".to_string(), "cpu".to_string()),
                };
                let vram_mb = (desc.DedicatedVideoMemory as u64) / (1024 * 1024);
                return GpuInfo {
                    name: if name.is_empty() {
                        "GPU Windows".to_string()
                    } else {
                        name
                    },
                    supports_nvenc: vendor == "NVIDIA",
                    supports_amf: vendor == "AMD",
                    vendor,
                    vram_mb,
                    recommended_codec,
                };
            }
        }
    }

    GpuInfo {
        name: "Adaptador estándar".to_string(),
        vendor: "Unknown".to_string(),
        vram_mb: 0,
        recommended_codec: "cpu".to_string(),
        supports_nvenc: false,
        supports_amf: false,
    }
}

pub fn detect_ffmpeg_encoders(ffmpeg_path: &Path) -> HardwareEncoders {
    let mut result = HardwareEncoders::default();

    let output = Command::new(ffmpeg_path)
        .args(["-hide_banner", "-encoders"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    if let Ok(out) = output {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            result.hevc_nvenc = text.contains("hevc_nvenc");
            result.h264_nvenc = text.contains("h264_nvenc");
            result.hevc_amf = text.contains("hevc_amf");
            result.h264_amf = text.contains("h264_amf");
        }
    }

    result
}
