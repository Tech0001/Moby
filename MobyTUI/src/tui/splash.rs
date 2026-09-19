//! The swimming logo, with a text silhouette when terminal graphics are unavailable.
use super::{
    mascot::Mascot,
    paint::{AQUA, BACKGROUND, DIM, GOLD, WHITE},
};
use ratatui::{
    Frame,
    layout::{Alignment, Rect},
    style::{Color, Style},
    text::{Line, Span},
    widgets::Paragraph,
};

const WHALE: &str = include_str!("../../assets/whale-launch.txt");

pub(super) fn draw(frame: &mut Frame, progress: f64, mascot: &mut Mascot) {
    let area = frame.area();
    let size = mascot.swimmer_size().unwrap_or_else(|| {
        ratatui::layout::Size::new(
            WHALE
                .lines()
                .map(|line| line.chars().count())
                .max()
                .unwrap_or(0) as u16,
            WHALE.lines().count() as u16,
        )
    });
    let width = i32::from(size.width);
    let height = i32::from(size.height);
    let x = area.width as i32
        - (progress.clamp(0.0, 1.0) * (f64::from(area.width) + f64::from(width))).round() as i32;
    let bob = (progress * std::f64::consts::TAU).sin().round() as i32;
    let y = (area.height as i32 - height - 6) / 2 + bob;
    if !mascot.swim(frame, area, x, y) {
        for (row, line) in WHALE.lines().enumerate() {
            for (column, symbol) in line.chars().enumerate() {
                if symbol != ' ' {
                    put(
                        frame,
                        area,
                        x + column as i32,
                        y + row as i32,
                        &symbol.to_string(),
                        GOLD,
                        BACKGROUND,
                    );
                }
            }
        }
    }
    let water = (area.height as i32 + height - 6) / 2 + 1;
    for col in 0..area.width as i32 {
        let wave = ((f64::from(col) * 0.16 - progress * 9.0).sin() * 0.8).round() as i32;
        put(
            frame,
            area,
            col,
            water + wave,
            "·",
            Color::Rgb(39, 84, 103),
            BACKGROUND,
        );
    }
    for (offset, symbol) in [(3, "°"), (8, "·"), (14, ".")] {
        put(
            frame,
            area,
            x + width + offset,
            y + height / 2 + (offset % 3) - 1,
            symbol,
            AQUA,
            BACKGROUND,
        );
    }
    let label_y = (water + 3).clamp(0, area.height.saturating_sub(1) as i32) as u16;
    frame.render_widget(
        Paragraph::new(Line::from(vec![Span::styled(
            "M O B Y",
            Style::default().fg(WHITE),
        )]))
        .alignment(Alignment::Center),
        Rect::new(area.x, area.y + label_y, area.width, 1),
    );
    if label_y + 1 < area.height {
        frame.render_widget(
            Paragraph::new("Every fill. Every transfer.")
                .style(Style::default().fg(DIM))
                .alignment(Alignment::Center),
            Rect::new(area.x, area.y + label_y + 1, area.width, 1),
        );
    }
    if area.height > 3 {
        frame.render_widget(
            Paragraph::new("Your local Moby worker   /   Any key to skip")
                .style(Style::default().fg(DIM))
                .alignment(Alignment::Center),
            Rect::new(area.x, area.bottom() - 2, area.width, 1),
        );
    }
}

fn put(frame: &mut Frame, area: Rect, x: i32, y: i32, symbol: &str, fg: Color, bg: Color) {
    if x < 0 || y < 0 || x >= area.width as i32 || y >= area.height as i32 {
        return;
    }
    frame.render_widget(
        Paragraph::new(symbol).style(Style::default().fg(fg).bg(bg)),
        Rect::new(area.x + x as u16, area.y + y as u16, 1, 1),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{Terminal, backend::TestBackend};
    #[test]
    fn whale_crosses_viewport_and_clips_at_both_edges() {
        let mut counts = Vec::new();
        for progress in [0.0, 0.25, 0.5, 0.75, 1.0] {
            let mut terminal = Terminal::new(TestBackend::new(92, 30)).unwrap();
            terminal
                .draw(|f| draw(f, progress, &mut Mascot::default()))
                .unwrap();
            counts.push(
                terminal
                    .backend()
                    .buffer()
                    .content
                    .iter()
                    .filter(|c| c.fg == GOLD || c.bg == GOLD)
                    .count(),
            );
        }
        assert_eq!(counts[0], 0);
        assert!(counts[2] > 100);
        assert_eq!(counts[4], 0);
    }
}
