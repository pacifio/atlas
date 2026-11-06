//! Colour maths for the importers and for base-token derivation.
//!
//! Two layers, kept apart on purpose:
//!
//!  - **Judgements** ([`lightness`], [`is_dark`]) that an importer makes about
//!    a colour it will write back in the author's own notation — decision 15
//!    is a one-time conversion, so an oklch theme stays oklch. They need an ordering, not a colorimetric number, so they mix
//!    scales: WCAG luminance for sRGB, the `L` channel as-is for `hsl()` and
//!    `oklch()`. Safe only because every caller compares colours from one file
//!    in one notation.
//!  - **Arithmetic** ([`parse`], [`mix`], [`with_alpha`], [`readable`]) for the
//!    `[[base]]` rules (`derive.rs`). This is a port of `@tryatlas/design`'s
//!    `src/theme/color.ts`, operation for operation, and the golden
//!    fixture `base-derivation.json` holds the two to the same output — so
//!    change both or neither.

/// A rough lightness in `0.0..=1.0`, or `None` for a notation we do not read.
pub fn lightness(value: &str) -> Option<f64> {
    let value = value.trim();
    if let Some(hex) = value.strip_prefix('#') {
        let (r, g, b) = parse_hex(hex)?;
        return Some(relative_luminance(r, g, b));
    }
    let (name, body) = split_function(value)?;
    let parts = channels(&body);
    match name {
        "rgb" | "rgba" => {
            let [r, g, b] = first_three(&parts)?;
            Some(relative_luminance(
                scale_channel(r, &parts[0]),
                scale_channel(g, &parts[1]),
                scale_channel(b, &parts[2]),
            ))
        }
        // `hsl()`'s third channel and `oklch()`'s first are both a lightness.
        "hsl" | "hsla" => parts
            .get(2)
            .and_then(|part| number(part))
            .map(percent_to_unit),
        "oklch" => parts
            .first()
            .and_then(|part| number(part))
            .map(percent_to_unit),
        _ => None,
    }
}

/// Is `value` a dark colour? Unreadable notations answer `None`.
pub fn is_dark(value: &str) -> Option<bool> {
    lightness(value).map(|light| light < 0.5)
}

fn split_function(value: &str) -> Option<(&str, String)> {
    let open = value.find('(')?;
    let close = value.rfind(')')?;
    if close < open {
        return None;
    }
    Some((&value[..open], value[open + 1..close].to_string()))
}

fn channels(body: &str) -> Vec<String> {
    body.replace(',', " ")
        .split('/')
        .next()
        .unwrap_or("")
        .split_whitespace()
        .map(ToOwned::to_owned)
        .collect()
}

fn first_three(parts: &[String]) -> Option<[f64; 3]> {
    if parts.len() < 3 {
        return None;
    }
    Some([number(&parts[0])?, number(&parts[1])?, number(&parts[2])?])
}

fn number(part: &str) -> Option<f64> {
    part.trim_end_matches('%')
        .trim_end_matches("deg")
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite())
}

/// `50%` is a half; a bare number in `rgb()` is 0–255.
fn scale_channel(value: f64, raw: &str) -> f64 {
    if raw.ends_with('%') {
        (value / 100.0).clamp(0.0, 1.0)
    } else {
        (value / 255.0).clamp(0.0, 1.0)
    }
}

fn percent_to_unit(value: f64) -> f64 {
    let unit = if value > 1.0 { value / 100.0 } else { value };
    unit.clamp(0.0, 1.0)
}

fn parse_hex(hex: &str) -> Option<(f64, f64, f64)> {
    let digits: Vec<u8> = hex
        .bytes()
        .map(|b| (b as char).to_digit(16).map(|d| d as u8))
        .collect::<Option<_>>()?;
    let (r, g, b) = match digits.len() {
        3 | 4 => (digits[0] * 17, digits[1] * 17, digits[2] * 17),
        6 | 8 => (
            digits[0] * 16 + digits[1],
            digits[2] * 16 + digits[3],
            digits[4] * 16 + digits[5],
        ),
        _ => return None,
    };
    Some((
        f64::from(r) / 255.0,
        f64::from(g) / 255.0,
        f64::from(b) / 255.0,
    ))
}

fn relative_luminance(r: f64, g: f64, b: f64) -> f64 {
    0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)
}

fn linearize(channel: f64) -> f64 {
    if channel <= 0.039_28 {
        channel / 12.92
    } else {
        ((channel + 0.055) / 1.055).powf(2.4)
    }
}

// ─── Arithmetic: the port of `color.ts` ─────────────────────────────────────

/// An sRGB colour: channels `0.0..=255.0`, alpha `0.0..=1.0`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rgba {
    pub r: f64,
    pub g: f64,
    pub b: f64,
    pub a: f64,
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

/// JavaScript's `parseFloat`: the longest leading decimal number, so `120deg`
/// is 120 and `50%` is 50. `None` where `parseFloat` would give `NaN`.
fn parse_float(text: &str) -> Option<f64> {
    let text = text.trim_start();
    let bytes = text.as_bytes();
    let mut end = 0;
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        end = 1;
    }
    let digits_from = end;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    if end < bytes.len() && bytes[end] == b'.' {
        end += 1;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
    }
    if !text[digits_from..end].bytes().any(|b| b.is_ascii_digit()) {
        return None;
    }
    if end < bytes.len() && matches!(bytes[end], b'e' | b'E') {
        let mut exponent = end + 1;
        if matches!(bytes.get(exponent), Some(b'+' | b'-')) {
            exponent += 1;
        }
        let start = exponent;
        while exponent < bytes.len() && bytes[exponent].is_ascii_digit() {
            exponent += 1;
        }
        if exponent > start {
            end = exponent;
        }
    }
    text[..end].parse().ok()
}

fn parse_channel(value: &str) -> Option<f64> {
    let number = parse_float(value)?;
    Some(if value.ends_with('%') {
        number / 100.0 * 255.0
    } else {
        number
    })
}

fn parse_alpha(value: Option<&str>) -> f64 {
    let Some(value) = value else { return 1.0 };
    let number = parse_float(value).unwrap_or(f64::NAN);
    let unit = if value.ends_with('%') {
        number / 100.0
    } else {
        number
    };
    clamp(unit, 0.0, 1.0)
}

fn hsl_to_rgb(hue: f64, saturation: f64, lightness: f64) -> Rgba {
    // Into [0, 1): see `hslToRgb` in color.ts for why the second `%` matters.
    let h = hue.rem_euclid(360.0) / 360.0;
    let s = clamp(saturation, 0.0, 1.0);
    let l = clamp(lightness, 0.0, 1.0);
    if s == 0.0 {
        return Rgba {
            r: l * 255.0,
            g: l * 255.0,
            b: l * 255.0,
            a: 1.0,
        };
    }
    let q = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let p = 2.0 * l - q;
    let channel = |offset: f64| {
        let mut t = h + offset;
        if t < 0.0 {
            t += 1.0;
        }
        if t > 1.0 {
            t -= 1.0;
        }
        if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 1.0 / 2.0 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        }
    };
    Rgba {
        r: channel(1.0 / 3.0) * 255.0,
        g: channel(0.0) * 255.0,
        b: channel(-1.0 / 3.0) * 255.0,
        a: 1.0,
    }
}

fn to_linear(channel: f64) -> f64 {
    let value = channel / 255.0;
    if value <= 0.04045 {
        value / 12.92
    } else {
        ((value + 0.055) / 1.055).powf(2.4)
    }
}

fn from_linear(value: f64) -> f64 {
    255.0
        * if value <= 0.003_130_8 {
            12.92 * value
        } else {
            1.055 * value.powf(1.0 / 2.4) - 0.055
        }
}

fn to_oklab(color: Rgba) -> [f64; 3] {
    let (r, g, b) = (to_linear(color.r), to_linear(color.g), to_linear(color.b));
    let l = (0.412_221_470_8 * r + 0.536_332_536_3 * g + 0.051_445_992_9 * b).cbrt();
    let m = (0.211_903_498_2 * r + 0.680_699_545_1 * g + 0.107_396_956_6 * b).cbrt();
    let s = (0.088_302_461_9 * r + 0.281_718_837_6 * g + 0.629_978_700_5 * b).cbrt();
    [
        0.210_454_255_3 * l + 0.793_617_785 * m - 0.004_072_046_8 * s,
        1.977_998_495_1 * l - 2.428_592_205 * m + 0.450_593_709_9 * s,
        0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766 * s,
    ]
}

fn from_oklab([lightness, a, b]: [f64; 3], alpha: f64) -> Rgba {
    let l = (lightness + 0.396_337_777_4 * a + 0.215_803_757_3 * b).powi(3);
    let m = (lightness - 0.105_561_345_8 * a - 0.063_854_172_8 * b).powi(3);
    let s = (lightness - 0.089_484_177_5 * a - 1.291_485_548 * b).powi(3);
    Rgba {
        r: clamp(
            from_linear(4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s),
            0.0,
            255.0,
        ),
        g: clamp(
            from_linear(-1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s),
            0.0,
            255.0,
        ),
        b: clamp(
            from_linear(-0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701 * s),
            0.0,
            255.0,
        ),
        a: alpha,
    }
}

/// Any colour a theme may hold, as sRGB: hex (3, 4, 6 or 8 digits), `rgb()`,
/// `rgba()`, `hsl()`, `hsla()` and `oklch()`. `None` for anything else.
pub fn parse(value: &str) -> Option<Rgba> {
    let value = value.trim();
    if let Some(hex) = value.strip_prefix('#') {
        if !(3..=8).contains(&hex.len()) || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let expanded: String = if hex.len() <= 4 {
            hex.chars().flat_map(|c| [c, c]).collect()
        } else {
            hex.to_string()
        };
        if expanded.len() != 6 && expanded.len() != 8 {
            return None;
        }
        let byte =
            |at: usize| f64::from(u8::from_str_radix(&expanded[at..at + 2], 16).unwrap_or(0));
        return Some(Rgba {
            r: byte(0),
            g: byte(2),
            b: byte(4),
            a: if expanded.len() == 8 {
                byte(6) / 255.0
            } else {
                1.0
            },
        });
    }
    let open = value.find('(')?;
    if !value.ends_with(')') {
        return None;
    }
    let name = value[..open].to_ascii_lowercase();
    if !matches!(name.as_str(), "rgb" | "rgba" | "hsl" | "hsla" | "oklch") {
        return None;
    }
    let body = value[open + 1..value.len() - 1]
        .replace(',', " ")
        .replacen('/', " / ", 1);
    let pieces: Vec<&str> = body.split_whitespace().collect();
    let (mut channels, mut alpha): (Vec<&str>, Option<&str>) =
        match pieces.iter().position(|piece| *piece == "/") {
            Some(slash) => (pieces[..slash].to_vec(), pieces.get(slash + 1).copied()),
            None => (pieces.clone(), None),
        };
    if alpha.is_none() && channels.len() == 4 {
        alpha = channels.pop();
    }
    if channels.len() != 3 {
        return None;
    }
    let alpha = parse_alpha(alpha);
    if name.starts_with("rgb") {
        let [r, g, b] = [
            parse_channel(channels[0])?,
            parse_channel(channels[1])?,
            parse_channel(channels[2])?,
        ];
        return Some(Rgba {
            r: clamp(r, 0.0, 255.0),
            g: clamp(g, 0.0, 255.0),
            b: clamp(b, 0.0, 255.0),
            a: alpha,
        });
    }
    let float = |piece: &str| parse_float(piece).unwrap_or(f64::NAN);
    if name.starts_with("hsl") {
        let color = hsl_to_rgb(
            float(channels[0]),
            float(channels[1]) / 100.0,
            float(channels[2]) / 100.0,
        );
        return Some(Rgba { a: alpha, ..color });
    }
    let lightness = if channels[0].ends_with('%') {
        float(channels[0]) / 100.0
    } else {
        float(channels[0])
    };
    let radians = float(channels[2]).to_radians();
    let chroma = float(channels[1]);
    let color = from_oklab(
        [lightness, chroma * radians.cos(), chroma * radians.sin()],
        1.0,
    );
    Some(Rgba { a: alpha, ..color })
}

/// `#rrggbb` when opaque, else `rgba(r, g, b, a)` with alpha to three places:
/// exactly what `colorToCss` writes.
pub fn to_css(color: Rgba) -> String {
    let channel = |value: f64| clamp(value, 0.0, 255.0).round() as u8;
    let (r, g, b) = (channel(color.r), channel(color.g), channel(color.b));
    let alpha = (clamp(color.a, 0.0, 1.0) * 1000.0).round() / 1000.0;
    if alpha == 1.0 {
        format!("#{r:02x}{g:02x}{b:02x}")
    } else {
        format!("rgba({r}, {g}, {b}, {alpha})")
    }
}

/// `amount` of the way from `left` to `right`, in OKLab; alpha moves linearly.
/// `left` unchanged when either side does not parse.
pub fn mix(left: &str, right: &str, amount: f64) -> String {
    let (Some(a), Some(b)) = (parse(left), parse(right)) else {
        return left.to_string();
    };
    let t = clamp(amount, 0.0, 1.0);
    let (x, y) = (to_oklab(a), to_oklab(b));
    to_css(from_oklab(
        [
            x[0] + (y[0] - x[0]) * t,
            x[1] + (y[1] - x[1]) * t,
            x[2] + (y[2] - x[2]) * t,
        ],
        a.a + (b.a - a.a) * t,
    ))
}

/// The colour with its alpha replaced; unchanged when it does not parse.
pub fn with_alpha(value: &str, alpha: f64) -> String {
    match parse(value) {
        Some(color) => to_css(Rgba {
            a: clamp(alpha, 0.0, 1.0),
            ..color
        }),
        None => value.to_string(),
    }
}

fn luminance(color: Rgba) -> f64 {
    0.2126 * to_linear(color.r) + 0.7152 * to_linear(color.g) + 0.0722 * to_linear(color.b)
}

/// WCAG 2 contrast ratio, 1 to 21. Unreadable input answers 1.
pub fn contrast_ratio(left: &str, right: &str) -> f64 {
    let (Some(a), Some(b)) = (parse(left), parse(right)) else {
        return 1.0;
    };
    let (x, y) = (luminance(a), luminance(b));
    (x.max(y) + 0.05) / (x.min(y) + 0.05)
}

/// Of `a` and `b`, the one that reads better on `surface`; `a` on a tie.
pub fn readable<'a>(surface: &str, a: &'a str, b: &'a str) -> &'a str {
    if contrast_ratio(surface, b) > contrast_ratio(surface, a) {
        b
    } else {
        a
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_notation_a_theme_may_use() {
        assert!(is_dark("#000000").unwrap());
        assert!(!is_dark("#ffffff").unwrap());
        assert!(is_dark("#191724ff").unwrap(), "zed writes 8-digit hex");
        assert!(
            !is_dark("oklch(0.98 0.01 90)").unwrap(),
            "tweakcn writes oklch"
        );
        assert!(is_dark("hsl(240 5% 6%)").unwrap());
        assert!(is_dark("rgb(20 20 20)").unwrap());
        assert!(!is_dark("rgb(90% 90% 90%)").unwrap());
        assert_eq!(is_dark("var(--nope)"), None);
    }

    #[test]
    fn parses_what_color_ts_parses() {
        assert_eq!(to_css(parse("#abc").unwrap()), "#aabbcc");
        assert_eq!(to_css(parse("#00000080").unwrap()), "rgba(0, 0, 0, 0.502)");
        assert_eq!(
            to_css(parse("rgb(255 0 0 / 50%)").unwrap()),
            "rgba(255, 0, 0, 0.5)"
        );
        assert_eq!(
            to_css(parse("rgba(10, 20, 30, 0.25)").unwrap()),
            "rgba(10, 20, 30, 0.25)"
        );
        assert_eq!(to_css(parse("hsl(0 100% 50%)").unwrap()), "#ff0000");
        // Past 240° the red channel wraps twice; a negative hue wraps up.
        assert_eq!(to_css(parse("hsl(300 100% 50%)").unwrap()), "#ff00ff");
        assert_eq!(to_css(parse("hsl(-60 100% 50%)").unwrap()), "#ff00ff");
        assert_eq!(to_css(parse("hsl(660 100% 50%)").unwrap()), "#ff00ff");
        assert_eq!(to_css(parse("oklch(1 0 0)").unwrap()), "#ffffff");
        assert_eq!(
            to_css(parse("oklch(62.8% 0.2577 29.23deg)").unwrap()),
            "#ff0000"
        );
        assert_eq!(parse("var(--x)"), None);
        assert_eq!(parse("#12345"), None);
    }

    #[test]
    fn mixes_in_oklab() {
        assert_eq!(mix("#000000", "#ffffff", 0.0), "#000000");
        assert_eq!(mix("#000000", "#ffffff", 1.0), "#ffffff");
        // OKLab's midpoint of black and white is perceptual mid-grey, not #808080.
        assert_eq!(mix("#000000", "#ffffff", 0.5), "#636363");
        assert_eq!(mix("var(--x)", "#ffffff", 0.5), "var(--x)");
    }

    #[test]
    fn picks_the_readable_ink() {
        assert_eq!(readable("#f5f5f5", "#ffffff", "#000000"), "#000000");
        assert_eq!(readable("#1e3a8a", "#ffffff", "#000000"), "#ffffff");
        assert!((contrast_ratio("#000000", "#ffffff") - 21.0).abs() < 1e-9);
    }
}
