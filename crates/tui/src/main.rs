use std::io;
use std::path::PathBuf;

use agmark_core::types::*;
use agmark_core::{CommentEngine, Storage};

use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use crossterm::terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen};
use crossterm::ExecutableCommand;
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap};
use ratatui::{Frame, Terminal};

struct App {
    engine: CommentEngine,
    storage: Storage,
    document_name: String,
    document_content: String,
    comments: CommentFile,
    doc_scroll: u16,
    thread_state: ListState,
    active_pane: Pane,
    status_msg: String,
    should_quit: bool,
}

#[derive(PartialEq)]
enum Pane {
    Document,
    Threads,
}

fn main() -> io::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: agmark-tui <file.md>");
        std::process::exit(1);
    }

    let file_path = PathBuf::from(&args[1]);
    let file_name = file_path.file_name().unwrap_or_default().to_string_lossy();
    let content = std::fs::read_to_string(&file_path)?;

    let root = Storage::find_project_root(&file_path)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let engine = CommentEngine::new(&root);
    let storage = Storage::new(&root);
    let comments = engine.get_or_create(&file_name, &content).unwrap_or_else(|_| {
        // Fallback: empty comments
        CommentFile {
            version: 1,
            document: file_name.to_string(),
            snapshot: agmark_core::types::Snapshot {
                git_commit: None,
                document_hash: String::new(),
                created_at: String::new(),
            },
            updated_at: String::new(),
            threads: vec![],
        }
    });

    let mut app = App {
        engine,
        storage,
        document_name: file_name.to_string(),
        document_content: content,
        comments,
        doc_scroll: 0,
        thread_state: ListState::default(),
        active_pane: Pane::Document,
        status_msg: String::new(),
        should_quit: false,
    };

    if !app.comments.threads.is_empty() {
        app.thread_state.select(Some(0));
    }

    // Setup terminal
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    stdout.execute(EnterAlternateScreen)?;
    let backend = ratatui::backend::CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let result = run(&mut terminal, &mut app);

    disable_raw_mode()?;
    terminal.backend_mut().execute(LeaveAlternateScreen)?;

    if let Err(e) = result {
        eprintln!("Error: {}", e);
    }
    Ok(())
}

fn run(terminal: &mut Terminal<impl ratatui::backend::Backend>, app: &mut App) -> io::Result<()> {
    while !app.should_quit {
        terminal.draw(|f| ui(f, app))?;
        handle_input(app)?;
    }
    Ok(())
}

fn ui(f: &mut Frame, app: &App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(1)])
        .split(f.area());

    let main = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(60), Constraint::Percentage(40)])
        .split(chunks[0]);

    // ── Document pane ──
    let doc_style = if app.active_pane == Pane::Document {
        Style::default().fg(Color::White)
    } else {
        Style::default().fg(Color::Gray)
    };

    let doc_paragraphs: Vec<Line> = app
        .document_content
        .lines()
        .enumerate()
        .map(|(i, line)| {
            let has_thread = app
                .comments
                .threads
                .iter()
                .any(|t| t.anchor.paragraph_index == i);
            if has_thread {
                let status = &app.comments.threads.iter().find(|t| t.anchor.paragraph_index == i).unwrap().status;
                let color = match status {
                    ThreadStatus::Open => Color::Yellow,
                    ThreadStatus::Resolved => Color::Green,
                    ThreadStatus::WontFix => Color::Gray,
                };
                Line::from(Span::styled(
                    format!("💬 {}", line),
                    Style::default().fg(color),
                ))
            } else {
                Line::from(Span::styled(line.to_string(), doc_style))
            }
        })
        .collect();

    let doc_block = Block::default()
        .title(format!(" {} ", app.document_name))
        .borders(Borders::ALL)
        .border_style(doc_style);

    // Calculate visible height for scroll
    let visible_height = main[0].height.saturating_sub(2) as usize;
    let max_scroll = app.document_content.lines().count().saturating_sub(visible_height);
    let scroll = (app.doc_scroll as usize).min(max_scroll);

    let visible_lines: Vec<Line> = doc_paragraphs.into_iter().skip(scroll).take(visible_height).collect();

    let doc = Paragraph::new(Text::from(visible_lines))
        .block(doc_block)
        .wrap(Wrap { trim: false })
        .scroll((0, 0));

    f.render_widget(doc, main[0]);

    // ── Threads pane ──
    let thread_style = if app.active_pane == Pane::Threads {
        Style::default().fg(Color::White)
    } else {
        Style::default().fg(Color::Gray)
    };

    let thread_items: Vec<ListItem> = app
        .comments
        .threads
        .iter()
        .map(|t| {
            let status = match t.status {
                ThreadStatus::Open => "●",
                ThreadStatus::Resolved => "✓",
                ThreadStatus::WontFix => "✗",
            };
            let color = match t.status {
                ThreadStatus::Open => Color::Yellow,
                ThreadStatus::Resolved => Color::Green,
                ThreadStatus::WontFix => Color::Gray,
            };
            let heading = t.anchor.heading_path.last().map(|h| h.as_str()).unwrap_or("¶");
            let first_comment = t.comments.first().map(|c| c.body.as_str()).unwrap_or("");
            let preview: String = first_comment.chars().take(60).collect();

            ListItem::new(Line::from(vec![
                Span::styled(format!("{} ", status), Style::default().fg(color)),
                Span::styled(heading, Style::default().add_modifier(Modifier::BOLD)),
                Span::raw("  "),
                Span::styled(preview, Style::default().fg(Color::DarkGray)),
            ]))
        })
        .collect();

    let thread_block = Block::default()
        .title(format!(
            " Threads ({}/{}) ",
            app.comments.threads.iter().filter(|t| t.status == ThreadStatus::Open).count(),
            app.comments.threads.len(),
        ))
        .borders(Borders::ALL)
        .border_style(thread_style);

    let mut list_state = app.thread_state.clone();
    let list = List::new(thread_items).block(thread_block).highlight_style(
        Style::default().bg(Color::DarkGray).add_modifier(Modifier::BOLD),
    );

    f.render_stateful_widget(list, main[1], &mut list_state);

    // ── Status bar ──
    let status = if !app.status_msg.is_empty() {
        app.status_msg.clone()
    } else {
        match app.active_pane {
            Pane::Document => "j/k:scroll  Tab:switch  c:comment  q:quit".into(),
            Pane::Threads => "j/k:nav  Enter:select  r:reply  v:resolve  d:delete  Tab:switch  q:quit".into(),
        }
    };

    let bar = Paragraph::new(Line::from(Span::styled(status, Style::default().fg(Color::White))))
        .block(Block::default().style(Style::default().bg(Color::DarkGray)));

    f.render_widget(bar, chunks[1]);
}

fn handle_input(app: &mut App) -> io::Result<()> {
    if let Event::Key(key) = event::read()? {
        if key.kind != KeyEventKind::Press {
            return Ok(());
        }
        app.status_msg.clear();

        match key.code {
            KeyCode::Char('q') => app.should_quit = true,
            KeyCode::Tab => {
                app.active_pane = match app.active_pane {
                    Pane::Document => Pane::Threads,
                    Pane::Threads => Pane::Document,
                };
            }
            KeyCode::Char('j') | KeyCode::Down => match app.active_pane {
                Pane::Document => {
                    let max = app.document_content.lines().count().saturating_sub(10);
                    app.doc_scroll = (app.doc_scroll + 1).min(max as u16);
                }
                Pane::Threads => {
                    if !app.comments.threads.is_empty() {
                        let i = app.thread_state.selected().unwrap_or(0);
                        let next = (i + 1).min(app.comments.threads.len() - 1);
                        app.thread_state.select(Some(next));
                    }
                }
            },
            KeyCode::Char('k') | KeyCode::Up => match app.active_pane {
                Pane::Document => {
                    app.doc_scroll = app.doc_scroll.saturating_sub(1);
                }
                Pane::Threads => {
                    let i = app.thread_state.selected().unwrap_or(0);
                    let prev = if i > 0 { i - 1 } else { 0 };
                    app.thread_state.select(Some(prev));
                }
            },
            KeyCode::Char('r') if app.active_pane == Pane::Threads => {
                if let Some(idx) = app.thread_state.selected() {
                    let thread_id = app.comments.threads.get(idx).map(|t| t.id.clone());
                    if let Some(tid) = thread_id {
                        match app.engine.add_reply(&app.document_name, &tid, "[replied via TUI]", "user") {
                            Ok(cf) => { app.comments = cf; app.status_msg = format!("Replied to {}", tid); }
                            Err(e) => app.status_msg = format!("Error: {}", e),
                        }
                    }
                }
            }
            KeyCode::Char('v') if app.active_pane == Pane::Threads => {
                if let Some(idx) = app.thread_state.selected() {
                    let info = app.comments.threads.get(idx).map(|t| (t.id.clone(), t.status.clone()));
                    if let Some((tid, status)) = info {
                        let new_status = match status { ThreadStatus::Open => ThreadStatus::Resolved, _ => ThreadStatus::Open };
                        match app.engine.set_status(&app.document_name, &tid, new_status) {
                            Ok(cf) => { app.comments = cf; app.status_msg = format!("Thread {} resolved", tid); }
                            Err(e) => app.status_msg = format!("Error: {}", e),
                        }
                    }
                }
            }
            KeyCode::Char('d') if app.active_pane == Pane::Threads => {
                if let Some(idx) = app.thread_state.selected() {
                    let thread_id = app.comments.threads.get(idx).map(|t| t.id.clone());
                    if let Some(tid) = thread_id {
                        match app.engine.delete_thread(&app.document_name, &tid) {
                            Ok(cf) => {
                                app.comments = cf;
                                app.status_msg = format!("Deleted {}", tid);
                                if app.comments.threads.is_empty() { app.thread_state.select(None); }
                                else if idx >= app.comments.threads.len() { app.thread_state.select(Some(app.comments.threads.len() - 1)); }
                            }
                            Err(e) => app.status_msg = format!("Error: {}", e),
                        }
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}
