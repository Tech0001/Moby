use moby_tui::{
    engine::Engine,
    tui::{View, render},
};
use ratatui::{Terminal, backend::TestBackend};
use tempfile::TempDir;

#[test]
fn terminal_marks_unconnected_snapshots_stale_and_handles_small_windows() {
    let dir = TempDir::new().unwrap();
    let engine = Engine::open(dir.path(), 1000).unwrap();
    for (width, height) in [(120, 35), (80, 24), (70, 18), (40, 10), (1, 1)] {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        let mut view = View::default();
        view.state = Some(engine.snapshot(1000).unwrap());
        terminal.draw(|frame| render(frame, &mut view)).unwrap();
        let rendered = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect::<String>();
        if width >= 70 {
            assert!(rendered.contains("PAPER"));
            assert!(rendered.contains("STALE"));
            assert!(rendered.contains("BTC"));
        } else if width >= 40 {
            assert!(rendered.contains("Resize"));
        }
    }
}
