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

fn default_border_width() -> f32 {
    1.5
}

fn default_border_color() -> String {
    "#FFFFFF".to_string()
}

fn default_border_opacity() -> f32 {
    0.24
}

fn default_shadow_color() -> String {
    "#000000".to_string()
}

fn default_border_position() -> String {
    "inside".to_string()
}

fn default_shadow_offset_x() -> f32 {
    0.0
}

fn default_shadow_offset_y() -> f32 {
    12.0
}

fn default_shadow_blur() -> f32 {
    24.0
}

fn default_shadow_spread() -> f32 {
    0.0
}

fn default_shadow_opacity() -> f32 {
    0.65
}

fn parse_hex_rgb(hex: &str, fallback: [f32; 3]) -> [f32; 3] {
    let s = hex.trim().trim_start_matches('#');
    if s.len() == 6 {
        if let (Ok(r), Ok(g), Ok(b)) = (
            u8::from_str_radix(&s[0..2], 16),
            u8::from_str_radix(&s[2..4], 16),
            u8::from_str_radix(&s[4..6], 16),
        ) {
            return [r as f32, g as f32, b as f32];
        }
    }
    fallback
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameOptions {
    pub enabled: bool,
    #[serde(default = "default_border_radius")]
    pub border_radius: f32,
    #[serde(default = "default_padding")]
    pub padding: u32,
    #[serde(default)]
    pub padding_top: Option<u32>,
    #[serde(default)]
    pub padding_right: Option<u32>,
    #[serde(default)]
    pub padding_bottom: Option<u32>,
    #[serde(default)]
    pub padding_left: Option<u32>,
    #[serde(default = "default_shadow_strength")]
    pub shadow_strength: String,
    #[serde(default = "default_subtle_border")]
    pub subtle_border: bool,
    #[serde(default = "default_border_width")]
    pub border_width: f32,
    #[serde(default = "default_border_color")]
    pub border_color: String,
    #[serde(default = "default_border_opacity")]
    pub border_opacity: f32,
    #[serde(default = "default_border_position")]
    pub border_position: String,
    #[serde(default = "default_shadow_color")]
    pub shadow_color: String,
    #[serde(default = "default_shadow_offset_x")]
    pub shadow_offset_x: f32,
    #[serde(default = "default_shadow_offset_y")]
    pub shadow_offset_y: f32,
    #[serde(default = "default_shadow_blur")]
    pub shadow_blur: f32,
    #[serde(default = "default_shadow_spread")]
    pub shadow_spread: f32,
    #[serde(default = "default_shadow_opacity")]
    pub shadow_opacity: f32,
}

impl Default for FrameOptions {
    fn default() -> Self {
        Self {
            enabled: false,
            border_radius: 18.0,
            padding: 44,
            padding_top: None,
            padding_right: None,
            padding_bottom: None,
            padding_left: None,
            shadow_strength: "medium".to_string(),
            subtle_border: true,
            border_width: 1.5,
            border_color: "#FFFFFF".to_string(),
            border_opacity: 0.24,
            border_position: "inside".to_string(),
            shadow_color: "#000000".to_string(),
            shadow_offset_x: 0.0,
            shadow_offset_y: 12.0,
            shadow_blur: 24.0,
            shadow_spread: 0.0,
            shadow_opacity: 0.65,
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
    let (base_alpha, base_blur, base_offset_x, base_offset_y, base_spread) =
        match opts.shadow_strength.as_str() {
            "none" => (0.0f32, 0.0f32, 0.0f32, 0.0f32, 0.0f32),
            "soft" => (0.42f32, 16.0f32, 0.0f32, 8.0f32, 0.0f32),
            "strong" => (0.84f32, 34.0f32, 0.0f32, 18.0f32, 0.0f32),
            "custom" => (
                opts.shadow_opacity.clamp(0.0, 1.0),
                opts.shadow_blur.clamp(0.0, 120.0),
                opts.shadow_offset_x.clamp(-80.0, 80.0),
                opts.shadow_offset_y.clamp(-80.0, 80.0),
                opts.shadow_spread.clamp(-24.0, 48.0),
            ),
            _ => (0.65f32, 24.0f32, 0.0f32, 12.0f32, 0.0f32),
        };

    let bw = (opts.border_width.clamp(0.0, 16.0) * sf).clamp(0.0, 64.0);
    let b_op = opts.border_opacity.clamp(0.0, 1.0);
    let draw_border = opts.subtle_border && bw > 0.05 && b_op > 0.005;
    let border_outer_extent = if !draw_border {
        0.0
    } else {
        match opts.border_position.as_str() {
            "outside" => bw,
            "center" => bw * 0.5,
            _ => 0.0,
        }
    };

    let mut blur_r = base_blur * sf;
    let mut offset_x = base_offset_x * sf;
    let mut offset_y = base_offset_y * sf;
    let mut spread = base_spread * sf;
    let shadow_pad = if base_alpha > 0.001 {
        (blur_r * 1.45 + offset_x.abs().max(offset_y.abs()) + spread.max(0.0)).ceil()
    } else {
        0.0
    };
    let min_pad = shadow_pad.max((border_outer_extent + 2.0).ceil());
    let has_custom_pads = opts.padding_top.is_some()
        || opts.padding_right.is_some()
        || opts.padding_bottom.is_some()
        || opts.padding_left.is_some();

    let mut pad_t = ((opts.padding_top.unwrap_or(opts.padding) as f32) * sf).round() as u32;
    let mut pad_r = ((opts.padding_right.unwrap_or(opts.padding) as f32) * sf).round() as u32;
    let mut pad_b = ((opts.padding_bottom.unwrap_or(opts.padding) as f32) * sf).round() as u32;
    let mut pad_l = ((opts.padding_left.unwrap_or(opts.padding) as f32) * sf).round() as u32;

    if !has_custom_pads {
        let uniform = (min_pad as u32).max(pad_t);
        pad_t = uniform;
        pad_r = uniform;
        pad_b = uniform;
        pad_l = uniform;
    } else {
        let min_border_pad = (border_outer_extent + 2.0).ceil() as u32;
        pad_t = pad_t.max(min_border_pad);
        pad_r = pad_r.max(min_border_pad);
        pad_b = pad_b.max(min_border_pad);
        pad_l = pad_l.max(min_border_pad);
    }

    // Keep final dimensions safely within 16384 px
    if w + pad_l + pad_r > 16384 || h + pad_t + pad_b > 16384 {
        let avail_x = 16384u32.saturating_sub(w) / 2;
        let avail_y = 16384u32.saturating_sub(h) / 2;
        if avail_x < 4 || avail_y < 4 {
            return img.clone();
        }
        pad_l = pad_l.min(avail_x);
        pad_r = pad_r.min(avail_x);
        pad_t = pad_t.min(avail_y);
        pad_b = pad_b.min(avail_y);
        let max_p = pad_l.max(pad_r).max(pad_t).max(pad_b).max(1) as f32;
        let ratio = (max_p / (min_pad.max(1.0))).min(1.0);
        blur_r *= ratio;
        offset_x *= ratio;
        offset_y *= ratio;
        spread *= ratio;
    }

    let out_w = w + pad_l + pad_r;
    let out_h = h + pad_t + pad_b;
    let out_wu = out_w as usize;
    let out_hu = out_h as usize;

    let wf = w as f32;
    let hf = h as f32;
    let pad_lf = pad_l as f32;
    let pad_tf = pad_t as f32;
    let rad = (opts.border_radius.max(0.0) * sf).min(wf.min(hf) * 0.45);

    // 1. Build shadow mask shifted by (pad_l + offset_x, pad_t + offset_y) with optional spread
    let mut shadow = vec![0.0f32; out_wu * out_hu];
    if base_alpha > 0.001 {
        let sw = (wf + spread * 2.0).max(2.0);
        let sh = (hf + spread * 2.0).max(2.0);
        let s_left = pad_lf + offset_x - spread;
        let s_top = pad_tf + offset_y - spread;
        let s_rad = (rad + spread.max(0.0)).min(sw.min(sh) * 0.45);

        let x_min = (s_left - 2.0).floor().max(0.0) as usize;
        let x_max = (s_left + sw + 2.0).ceil().min(out_wu as f32) as usize;
        let y_min = (s_top - 2.0).floor().max(0.0) as usize;
        let y_max = (s_top + sh + 2.0).ceil().min(out_hu as f32) as usize;

        for y in y_min..y_max {
            let py = y as f32 + 0.5;
            let row = y * out_wu;
            for x in x_min..x_max {
                let px = x as f32 + 0.5;
                let sdf = sd_rounded_rect(px, py, s_left, s_top, sw, sh, s_rad);
                let cov = (0.5 - sdf).clamp(0.0, 1.0);
                shadow[row + x] = cov * base_alpha;
            }
        }

        if blur_r >= 1.0 {
            let box_r = (blur_r * 0.42).round().max(1.0) as usize;
            box_blur_3pass(&mut shadow, out_wu, out_hu, box_r);
        }
    }

    // 2. Render output canvas: shadow first, then rounded foreground + inside/center/outside border
    let mut out = RgbaImage::new(out_w, out_h);
    let b_rgb = parse_hex_rgb(&opts.border_color, [255.0, 255.0, 255.0]);
    let s_rgb = parse_hex_rgb(&opts.shadow_color, [0.0, 0.0, 0.0]);
    let (b_inner, b_outer) = match opts.border_position.as_str() {
        "outside" => (0.0f32, bw),
        "center" => (-bw * 0.5, bw * 0.5),
        _ => (-bw, 0.0f32),
    };
    let ext_px = (border_outer_extent + 2.0).ceil() as usize;
    let bx_min = (pad_l as usize).saturating_sub(ext_px);
    let bx_max = ((pad_l + w) as usize + ext_px).min(out_wu);
    let by_min = (pad_t as usize).saturating_sub(ext_px);
    let by_max = ((pad_t + h) as usize + ext_px).min(out_hu);

    for y in 0..out_hu {
        let row = y * out_wu;
        let py = y as f32 + 0.5;
        let in_y = y >= pad_t as usize && y < (pad_t + h) as usize;
        let in_border_y = y >= by_min && y < by_max;

        for x in 0..out_wu {
            let bg_a = shadow[row + x].clamp(0.0, 1.0);
            let in_img = in_y && x >= pad_l as usize && x < (pad_l + w) as usize;
            let in_border_box = draw_border && in_border_y && x >= bx_min && x < bx_max;

            if in_img || in_border_box {
                let px = x as f32 + 0.5;
                let sdf = sd_rounded_rect(px, py, pad_lf, pad_tf, wf, hf, rad);

                let (src_r, src_g, src_b, fg_a, src_a_norm) = if in_img {
                    let src_px = img.get_pixel((x as u32) - pad_l, (y as u32) - pad_t);
                    let cov = (0.5 - sdf).clamp(0.0, 1.0);
                    let a_norm = (src_px[3] as f32) / 255.0;
                    (
                        src_px[0] as f32,
                        src_px[1] as f32,
                        src_px[2] as f32,
                        (a_norm * cov).clamp(0.0, 1.0),
                        a_norm,
                    )
                } else {
                    (0.0, 0.0, 0.0, 0.0, 1.0)
                };

                let b_a = if in_border_box {
                    let outer_cov = (0.5 - (sdf - b_outer)).clamp(0.0, 1.0);
                    let inner_cov = (0.5 - (sdf - b_inner)).clamp(0.0, 1.0);
                    (outer_cov - inner_cov).clamp(0.0, 1.0) * b_op * src_a_norm
                } else {
                    0.0
                };

                let fg_pm_r = src_r * fg_a * (1.0 - b_a) + b_rgb[0] * b_a;
                let fg_pm_g = src_g * fg_a * (1.0 - b_a) + b_rgb[1] * b_a;
                let fg_pm_b = src_b * fg_a * (1.0 - b_a) + b_rgb[2] * b_a;
                let fg_total_a = (b_a + fg_a * (1.0 - b_a)).clamp(0.0, 1.0);

                let out_a = (fg_total_a + bg_a * (1.0 - fg_total_a)).clamp(0.0, 1.0);
                if out_a > 1e-5 {
                    let pm_r = fg_pm_r + s_rgb[0] * bg_a * (1.0 - fg_total_a);
                    let pm_g = fg_pm_g + s_rgb[1] * bg_a * (1.0 - fg_total_a);
                    let pm_b = fg_pm_b + s_rgb[2] * bg_a * (1.0 - fg_total_a);
                    let r = (pm_r / out_a).round().clamp(0.0, 255.0) as u8;
                    let g = (pm_g / out_a).round().clamp(0.0, 255.0) as u8;
                    let b = (pm_b / out_a).round().clamp(0.0, 255.0) as u8;
                    let a = (out_a * 255.0).round().clamp(0.0, 255.0) as u8;
                    out.put_pixel(x as u32, y as u32, Rgba([r, g, b, a]));
                }
            } else if bg_a > 1e-4 {
                let a = (bg_a * 255.0).round().clamp(0.0, 255.0) as u8;
                out.put_pixel(
                    x as u32,
                    y as u32,
                    Rgba([s_rgb[0] as u8, s_rgb[1] as u8, s_rgb[2] as u8, a]),
                );
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
            padding_top: None,
            padding_right: None,
            padding_bottom: None,
            padding_left: None,
            shadow_strength: "medium".to_string(),
            subtle_border: true,
            ..FrameOptions::default()
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
