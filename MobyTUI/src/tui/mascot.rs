//! The vector-derived logo for image-capable terminals, with portable text art.
use super::paint::{BACKGROUND, GOLD};
use image::{DynamicImage, imageops::FilterType};
use ratatui::{
    Frame,
    layout::{Rect, Size},
    style::Style,
    widgets::Paragraph,
};
use ratatui_image::{
    FontSize, Image, Resize,
    picker::ProtocolType,
    protocol::{Protocol, kitty::Kitty, sixel::Sixel},
};
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicU32, Ordering},
};

// A watch process creates only a few dozen images. Keep IDs within RGB so every
// placeholder carries the complete ID while neighboring cells move or disappear.
static NEXT_IMAGE_ID: AtomicU32 = AtomicU32::new(1);

const KITTY_PLACEHOLDER: char = '\u{10eeee}';
// The first 42 entries of Kitty's rowcolumn-diacritics.txt, enough for our
// largest artwork (42 columns × 10 rows). These are protocol coordinates,
// not visible text: https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders
const KITTY_COORDINATES: [char; 42] = [
    '\u{305}', '\u{30d}', '\u{30e}', '\u{310}', '\u{312}', '\u{33d}', '\u{33e}', '\u{33f}',
    '\u{346}', '\u{34a}', '\u{34b}', '\u{34c}', '\u{350}', '\u{351}', '\u{352}', '\u{357}',
    '\u{35b}', '\u{363}', '\u{364}', '\u{365}', '\u{366}', '\u{367}', '\u{368}', '\u{369}',
    '\u{36a}', '\u{36b}', '\u{36c}', '\u{36d}', '\u{36e}', '\u{36f}', '\u{483}', '\u{484}',
    '\u{485}', '\u{486}', '\u{487}', '\u{592}', '\u{593}', '\u{594}', '\u{595}', '\u{597}',
    '\u{598}', '\u{599}',
];

#[derive(Default)]
pub(super) struct Mascot {
    normal: Option<Protocol>,
    compact: Option<Protocol>,
    swimmer: Option<Swimmer>,
}

struct Swimmer {
    image: DynamicImage,
    font: FontSize,
    size: Size,
    protocol: ProtocolType,
    // Reuse each visible crop while the whale moves across a screen edge.
    crops: BTreeMap<(u16, u16, u16, u16), Protocol>,
}

fn encode(image: DynamicImage, size: Size, protocol: ProtocolType) -> Option<Protocol> {
    match protocol {
        ProtocolType::Kitty
            if usize::from(size.width.max(size.height)) <= KITTY_COORDINATES.len() =>
        {
            Kitty::new(
                image,
                size,
                NEXT_IMAGE_ID.fetch_add(1, Ordering::Relaxed),
                false,
                false,
            )
            .map(Protocol::Kitty)
            .ok()
        }
        ProtocolType::Sixel => Sixel::new(image, size, false).map(Protocol::Sixel).ok(),
        _ => None,
    }
}

impl Mascot {
    /// Use terminal metadata only: never read stdin to detect a decorative image.
    pub(super) fn from_terminal() -> Self {
        let term = std::env::var("TERM").unwrap_or_default();
        let program = std::env::var("TERM_PROGRAM").unwrap_or_default();
        // Keep artwork portable in multiplexers without changing pane settings.
        // Kitty image IDs use colors, which Crossterm suppresses with NO_COLOR.
        if std::env::var_os("TMUX").is_some()
            || std::env::var_os("NO_COLOR").is_some_and(|value| !value.is_empty())
            || term.starts_with("tmux")
            || term.starts_with("screen")
            || program == "tmux"
            || term == "dumb"
        {
            return Self::default();
        }
        let protocol = if matches!(term.as_str(), "xterm-ghostty" | "xterm-kitty")
            || matches!(program.as_str(), "ghostty" | "kitty")
        {
            ProtocolType::Kitty
        } else if matches!(term.as_str(), "foot" | "foot-extra") {
            ProtocolType::Sixel
        } else {
            return Self::default();
        };
        let Ok(size) = crossterm::terminal::window_size() else {
            return Self::default();
        };
        if size.columns == 0 || size.rows == 0 {
            return Self::default();
        }
        let font = FontSize::new(size.width / size.columns, size.height / size.rows);
        if !(1..=128).contains(&font.width) || !(1..=256).contains(&font.height) {
            return Self::default();
        }
        Self::from_font(font, protocol)
    }

    fn from_font(font: FontSize, protocol: ProtocolType) -> Self {
        let Ok(logo) = image::load_from_memory(include_bytes!("../../assets/whale.png")) else {
            return Self::default();
        };
        let background = match BACKGROUND {
            ratatui::style::Color::Rgb(r, g, b) => Some(image::Rgba([r, g, b, 255])),
            _ => None,
        };
        let prepare = |width, height| {
            let resize = Resize::Fit(Some(FilterType::Lanczos3));
            let size = resize.size_for(&logo, font, Size::new(width, height));
            let image = resize.resize(&logo, font, size, background);
            (image, size)
        };
        // Encode the two fixed header sizes once, outside the draw loop.
        let header = |width, height| {
            let (image, size) = prepare(width, height);
            encode(image, size, protocol)
        };
        let (image, size) = prepare(42, 10);
        Self {
            normal: header(14, 3),
            compact: header(10, 2),
            swimmer: Some(Swimmer {
                image,
                font,
                size,
                protocol,
                crops: BTreeMap::new(),
            }),
        }
    }

    pub(super) fn swimmer_size(&self) -> Option<Size> {
        self.swimmer.as_ref().map(|s| s.size)
    }

    /// Crop the source pixels, not the terminal escape sequences, at screen edges.
    pub(super) fn swim(&mut self, frame: &mut Frame, area: Rect, x: i32, y: i32) -> bool {
        let Some(swimmer) = &mut self.swimmer else {
            return false;
        };
        let Some((source, target)) = visible_crop(swimmer.size, area, x, y) else {
            return true;
        };
        let key = (source.x, source.y, source.width, source.height);
        if let std::collections::btree_map::Entry::Vacant(entry) = swimmer.crops.entry(key) {
            let image = swimmer.image.crop_imm(
                u32::from(source.x) * u32::from(swimmer.font.width),
                u32::from(source.y) * u32::from(swimmer.font.height),
                u32::from(source.width) * u32::from(swimmer.font.width),
                u32::from(source.height) * u32::from(swimmer.font.height),
            );
            let Some(image) = encode(image, source.as_size(), swimmer.protocol) else {
                return false;
            };
            entry.insert(image);
        }
        render_image(frame, &swimmer.crops[&key], target);
        true
    }

    pub(super) fn finish_intro(&mut self) {
        self.swimmer = None;
    }

    pub(super) fn draw(&self, frame: &mut Frame, area: Rect) {
        if area.is_empty() {
            return;
        }
        let (image, text) = if area.height >= 3 {
            (&self.normal, include_str!("../../assets/whale-header.txt"))
        } else {
            (
                &self.compact,
                include_str!("../../assets/whale-header-compact.txt"),
            )
        };
        if let Some(image) = image {
            render_image(frame, image, area);
        } else {
            frame.render_widget(
                Paragraph::new(text).style(Style::default().fg(GOLD).bg(BACKGROUND)),
                area,
            );
        }
    }
}

fn render_image(frame: &mut Frame, image: &Protocol, area: Rect) {
    frame.render_widget(Image::new(image), area);
    if !matches!(image, Protocol::Kitty(_)) {
        return;
    }
    let size = image.size();
    if size.width > area.width || size.height > area.height {
        return;
    }
    // ratatui-image can omit coordinates after the first cell in each row.
    // That inheritance breaks when the waves cover a neighbor, or a frame diff
    // moves only part of the image. Make every cell independent, retaining the
    // upload sequence on the first cell and its existing image ID/color.
    let buffer = frame.buffer_mut();
    for (y, row) in KITTY_COORDINATES
        .iter()
        .take(size.height as usize)
        .enumerate()
    {
        let first = buffer[(area.x, area.y + y as u16)].symbol();
        let Some(id) = first
            .rsplit_once(KITTY_PLACEHOLDER)
            .and_then(|(_, suffix)| suffix.chars().nth(2))
        else {
            continue;
        };
        for (x, column) in KITTY_COORDINATES
            .iter()
            .take(size.width as usize)
            .enumerate()
        {
            let cell = &mut buffer[(area.x + x as u16, area.y + y as u16)];
            if let Some((upload, _)) = cell.symbol().rsplit_once(KITTY_PLACEHOLDER) {
                let symbol = format!("{upload}{KITTY_PLACEHOLDER}{row}{column}{id}");
                cell.set_symbol(&symbol);
            }
        }
    }
}

fn visible_crop(size: Size, area: Rect, x: i32, y: i32) -> Option<(Rect, Rect)> {
    let left = x.max(0);
    let top = y.max(0);
    let right = (x + i32::from(size.width)).min(i32::from(area.width));
    let bottom = (y + i32::from(size.height)).min(i32::from(area.height));
    if left >= right || top >= bottom {
        return None;
    }
    let width = (right - left) as u16;
    let height = (bottom - top) as u16;
    Some((
        Rect::new((left - x) as u16, (top - y) as u16, width, height),
        Rect::new(area.x + left as u16, area.y + top as u16, width, height),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{Terminal, backend::TestBackend};

    #[test]
    fn kitty_image_coordinates_survive_water_covering_neighboring_cells() {
        let image = encode(
            DynamicImage::new_rgba8(64, 80),
            Size::new(8, 5),
            ProtocolType::Kitty,
        )
        .unwrap();
        let mut terminal = Terminal::new(TestBackend::new(20, 12)).unwrap();
        let columns = [
            '\u{305}', '\u{30d}', '\u{30e}', '\u{310}', '\u{312}', '\u{33d}', '\u{33e}', '\u{33f}',
        ];
        // The water can overwrite both the first cell of an image row and cells
        // in its middle. Each surviving cell must still address row 3, not 0.
        for left in [5, 4, 3] {
            terminal
                .draw(|frame| {
                    render_image(frame, &image, Rect::new(left, 2, 8, 5));
                    for column in [0, 3] {
                        frame.render_widget(Paragraph::new("·"), Rect::new(left + column, 5, 1, 1));
                    }
                })
                .unwrap();
            for column in [1, 2, 4, 5, 6, 7] {
                let symbol = terminal.backend().buffer()[(left + column, 5)].symbol();
                let (_, coordinates) = symbol.rsplit_once('\u{10eeee}').unwrap();
                assert_eq!(
                    coordinates.chars().collect::<Vec<_>>(),
                    ['\u{310}', columns[column as usize], '\u{305}'],
                    "image coordinates were lost at column {column}"
                );
            }
        }
    }

    #[test]
    fn swimming_image_crops_the_correct_pixels_on_all_edges() {
        let size = Size::new(42, 10);
        let area = Rect::new(3, 2, 80, 24);
        assert_eq!(visible_crop(size, area, 80, 5), None);
        assert_eq!(visible_crop(size, area, -42, 5), None);
        assert_eq!(
            visible_crop(size, area, 75, 5),
            Some((Rect::new(0, 0, 5, 10), Rect::new(78, 7, 5, 10)))
        );
        assert_eq!(
            visible_crop(size, area, -8, 5),
            Some((Rect::new(8, 0, 34, 10), Rect::new(3, 7, 34, 10)))
        );
        assert_eq!(
            visible_crop(size, area, -8, -3),
            Some((Rect::new(8, 3, 34, 7), Rect::new(3, 2, 34, 7)))
        );
        assert_eq!(
            visible_crop(size, area, 0, 20),
            Some((Rect::new(0, 0, 42, 4), Rect::new(3, 22, 42, 4)))
        );
        assert_eq!(visible_crop(size, Rect::new(0, 0, 0, 0), 0, 0), None);
    }
}
