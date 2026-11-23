use image::{Rgba, RgbaImage};
use serde::{Deserialize, Serialize};

fn default_border_radius() -> f32 {
    18.0
}

fn default_padding() -> u32 {
    44
}

fn default_shadow_strength() -> String {
    "medium".to_string()
}

fn default_subtle_border() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameOptions {
    pub enabled: bool,
    #[serde(default = "default_border_radius")]
    pub border_radius: f32,
    #[serde(default = "default_padding")]
    pub padding: u32,
    #[serde(default = "default_shadow_strength")]
    pub shadow_strength: String,
    #[serde(default = "default_subtle_border")]
    pub subtle_border: bool,
}

impl Default for FrameOptions {
    fn default() -> Self {
        Self {
            enabled: false,
            border_radius: 18.0,
            padding: 44,
            shadow_strength: "medium".to_string(),
            subtle_border: true,
        }
    }
}

#[inline]
fn sd_rounded_rect(px: f32, py: f32, left: f32, top: f32, w: f32, h: f32, r: f32) -> f32 {
    let cx = left + w * 0.5;
    let cy = top + h * 0.5;
    let hx = w * 0.5;
    let hy = h * 0.5;
    let qx = (px - cx).abs() - (hx - r);
    let qy = (py - cy).abs() - (hy - r);
    qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - r
}

fn box_blur_3pass(buf: &mut [f32], w: usize, h: usize, radius: usize) {
    if radius == 0 || w == 0 || h == 0 {
        return;
    }

    let win = (radius * 2 + 1) as f32;
    let inv_win = 1.0 / win;
    let mut tmp = vec![0.0f32; w * h];
    let r_i = radius as isize;
    let w_max = w as isize - 1;
    let h_max = h as isize - 1;

    for _ in 0..3 {
        // Horizontal pass: buf -> tmp
        for y in 0..h {
            let row = y * w;
            let mut acc = 0.0f32;
            for k in -r_i..=r_i {
                let idx = k.clamp(0, w_max) as usize;
                acc += buf[row + idx];
            }
            tmp[row] = acc * inv_win;
            for x in 1..w {
                let out_x = ((x as isize) - 1 - r_i).clamp(0, w_max) as usize;
                let in_x = ((x as isize) + r_i).clamp(0, w_max) as usize;
                acc += buf[row + in_x] - buf[row + out_x];
                tmp[row + x] = acc * inv_win;
            }
        }

        // Vertical pass: tmp -> buf
        for x in 0..w {
            let mut acc = 0.0f32;
            for k in -r_i..=r_i {
                let idy = k.clamp(0, h_max) as usize;
                acc += tmp[idy * w + x];
            }
            buf[x] = acc * inv_win;
            for y in 1..h {
                let out_y = ((y as isize) - 1 - r_i).clamp(0, h_max) as usize;
                let in_y = ((y as isize) + r_i).clamp(0, h_max) as usize;
                acc += tmp[in_y * w + x] - tmp[out_y * w + x];
                buf[y * w + x] = acc * inv_win;
            }
        }
    }
}

pub fn apply_rounded_shadow_frame(
    img: &RgbaImage,
    opts: &FrameOptions,
    scale_factor: f32,
) -> RgbaImage {
    if !opts.enabled {
        return img.clone();
    }

    let w = img.width();
    let h = img.height();
    if w == 0 || h == 0 {
        return img.clone();
    }

    let sf = scale_factor.clamp(1.0, 16.0);
    let max_dim = w.max(h);
    let (base_alpha, base_blur, base_offset_y) = match opts.shadow_strength.as_str() {
        "soft" => (0.42f32, 16.0f32, 8.0f32),
        "strong" => (0.84f32, 34.0f32, 18.0f32),
        _ => (0.65f32, 24.0f32, 12.0f32),
    };

    let mut blur_r = base_blur * sf;
    let mut offset_y = base_offset_y * sf;
    let mut pad = ((opts.padding as f32) * sf)
        .round()
        .max((blur_r * 1.5 + offset_y).ceil()) as u32;

    // Keep final dimensions safely within 16384 px
    if max_dim + pad.saturating_mul(2) > 16384 {
        let avail_pad = (16384u32.saturating_sub(max_dim)) / 2;
        if avail_pad < 4 {
            return img.clone();
        }
        let ratio = avail_pad as f32 / (pad.max(1) as f32);
        pad = avail_pad;
        blur_r *= ratio;
        offset_y *= ratio;
    }

    let out_w = w + pad * 2;
    let out_h = h + pad * 2;
    let out_wu = out_w as usize;
    let out_hu = out_h as usize;

    let wf = w as f32;
    let hf = h as f32;
    let pad_f = pad as f32;
    let rad = (opts.border_radius.max(0.0) * sf).min(wf.min(hf) * 0.45);

    // 1. Build shadow mask shifted by (pad, pad + offset_y)
    let mut shadow = vec![0.0f32; out_wu * out_hu];
    let shadow_top = pad_f + offset_y;
    let x_min = (pad_f - 2.0).floor().max(0.0) as usize;
    let x_max = (pad_f + wf + 2.0).ceil().min(out_wu as f32) as usize;
    let y_min = (shadow_top - 2.0).floor().max(0.0) as usize;
    let y_max = (shadow_top + hf + 2.0).ceil().min(out_hu as f32) as usize;

    for y in y_min..y_max {
        let py = y as f32 + 0.5;
        let row = y * out_wu;
        for x in x_min..x_max {
            let px = x as f32 + 0.5;
            let sdf = sd_rounded_rect(px, py, pad_f, shadow_top, wf, hf, rad);
            let cov = (0.5 - sdf).clamp(0.0, 1.0);
            shadow[row + x] = cov * base_alpha;
        }
    }

    let box_r = (blur_r * 0.42).round().max(1.0) as usize;
    box_blur_3pass(&mut shadow, out_wu, out_hu, box_r);

    // 2. Render output canvas: shadow first, then rounded foreground + optional crisp glass rim
    let mut out = RgbaImage::new(out_w, out_h);
    let bw = (1.5 * sf).clamp(1.0, 4.0);

    for y in 0..out_hu {
        let row = y * out_wu;
        let py = y as f32 + 0.5;
        let in_y = y >= pad as usize && y < (pad + h) as usize;

        for x in 0..out_wu {
            let bg_a = shadow[row + x].clamp(0.0, 1.0);

            if in_y && x >= pad as usize && x < (pad + w) as usize {
                let src_px = img.get_pixel((x as u32) - pad, (y as u32) - pad);
                let px = x as f32 + 0.5;
                let sdf = sd_rounded_rect(px, py, pad_f, pad_f, wf, hf, rad);
                let cov = (0.5 - sdf).clamp(0.0, 1.0);
                let src_a_norm = (src_px[3] as f32) / 255.0;
                let fg_a = (src_a_norm * cov).clamp(0.0, 1.0);

                let b_a = if opts.subtle_border {
                    let inner_cov = (0.5 - (sdf + bw)).clamp(0.0, 1.0);
                    (cov - inner_cov).clamp(0.0, 1.0) * 0.24 * src_a_norm
                } else {
                    0.0
                };

                let fg_pm_r = (src_px[0] as f32) * fg_a * (1.0 - b_a) + 255.0 * b_a;
                let fg_pm_g = (src_px[1] as f32) * fg_a * (1.0 - b_a) + 255.0 * b_a;
                let fg_pm_b = (src_px[2] as f32) * fg_a * (1.0 - b_a) + 255.0 * b_a;
                let fg_total_a = (b_a + fg_a * (1.0 - b_a)).clamp(0.0, 1.0);

                let out_a = (fg_total_a + bg_a * (1.0 - fg_total_a)).clamp(0.0, 1.0);
                if out_a > 1e-5 {
                    let r = (fg_pm_r / out_a).round().clamp(0.0, 255.0) as u8;
                    let g = (fg_pm_g / out_a).round().clamp(0.0, 255.0) as u8;
                    let b = (fg_pm_b / out_a).round().clamp(0.0, 255.0) as u8;
                    let a = (out_a * 255.0).round().clamp(0.0, 255.0) as u8;
                    out.put_pixel(x as u32, y as u32, Rgba([r, g, b, a]));
                }
            } else if bg_a > 1e-4 {
                let a = (bg_a * 255.0).round().clamp(0.0, 255.0) as u8;
                out.put_pixel(x as u32, y as u32, Rgba([0, 0, 0, a]));
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounded_frame_has_transparent_corners_and_soft_shadow() {
        let mut src = RgbaImage::new(120, 80);
        for p in src.pixels_mut() {
            *p = Rgba([34, 211, 238, 255]);
        }

        let opts = FrameOptions {
            enabled: true,
            border_radius: 18.0,
            padding: 44,
            shadow_strength: "medium".to_string(),
            subtle_border: true,
        };

        let out = apply_rounded_shadow_frame(&src, &opts, 1.0);
        assert!(out.width() > 120);
        assert!(out.height() > 80);

        // Outer corner must be fully transparent
        assert_eq!(out.get_pixel(0, 0)[3], 0);

        // Rounded corner cutout right inside pad boundary has no foreground color (only tiny shadow tail)
        let pad = (out.width() - 120) / 2;
        let corner = out.get_pixel(pad, pad);
        assert_eq!(corner[0], 0);
        assert_eq!(corner[1], 0);
        assert_eq!(corner[2], 0);
        assert!(corner[3] < 32, "corner alpha was {}", corner[3]);

        // Center pixel preserves original color
        let center = out.get_pixel(out.width() / 2, out.height() / 2);
        assert_eq!(center, &Rgba([34, 211, 238, 255]));

        // Area below the bottom edge has soft semi-transparent black shadow
        let below = out.get_pixel(out.width() / 2, pad + 80 + 10);
        assert_eq!(below[0], 0);
        assert_eq!(below[1], 0);
        assert_eq!(below[2], 0);
        assert!(below[3] > 10 && below[3] < 255, "shadow alpha was {}", below[3]);
    }
}
