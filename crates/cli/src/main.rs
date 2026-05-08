use clap::{Parser, Subcommand};
use std::io;
use std::path::PathBuf;

use agmark_core::{CommentEngine, Storage};

#[derive(Parser)]
#[command(name = "agmark", about = "AgentMark — AI agent annotatable markdown system")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Initialize annotations for a markdown file
    Init {
        file: PathBuf,
    },
    /// Clean annotations (delete .comments entry)
    Clean {
        file: PathBuf,
        /// Force clean even if open threads exist
        #[arg(long)]
        force: bool,
    },
    /// View a document with annotations
    View {
        file: PathBuf,
    },
    /// List annotation threads
    List {
        file: PathBuf,
        /// Filter by status
        #[arg(long)]
        status: Option<String>,
    },
    /// Get annotation statistics
    Stats {
        /// Specific file or directory (default: current directory)
        path: Option<PathBuf>,
    },
    /// Add a comment thread
    Add {
        file: PathBuf,
        /// Paragraph index
        #[arg(long)]
        paragraph: usize,
        /// Comment text
        #[arg(long)]
        comment: String,
    },
    /// Reply to a thread
    Reply {
        file: PathBuf,
        /// Thread ID
        #[arg(long)]
        thread: String,
        /// Reply text
        #[arg(long)]
        comment: String,
    },
    /// Resolve a thread
    Resolve {
        file: PathBuf,
        /// Thread ID
        #[arg(long)]
        thread: String,
    },
    /// Reopen a resolved thread
    Reopen {
        file: PathBuf,
        /// Thread ID
        #[arg(long)]
        thread: String,
    },
    /// Check if document has changed since snapshot
    Check {
        file: PathBuf,
    },
}

fn resolve_file(file: &PathBuf) -> io::Result<PathBuf> {
    if file.is_absolute() {
        return Ok(file.clone());
    }
    std::env::current_dir().map(|d| d.join(file))
}

fn find_root(file: &PathBuf) -> io::Result<PathBuf> {
    let abs = resolve_file(file)?;
    let dir = abs.parent().unwrap_or(&abs);
    Storage::find_project_root(dir).ok_or_else(|| {
        io::Error::new(io::ErrorKind::NotFound, "no .comments/ directory found in project")
    })
}

fn main() -> io::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Init { file } => {
            let content = std::fs::read_to_string(&file)?;
            let file_name = file.file_name().unwrap_or_default().to_string_lossy();
            let root = Storage::find_project_root(&file).unwrap_or_else(|| {
                std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
            });
            let engine = CommentEngine::new(&root);
            let cf = engine.get_or_create(&file_name, &content)?;
            println!("Initialized annotations for {}", file_name);
            println!("Snapshot hash: {}", cf.snapshot.document_hash);
        }

        Commands::Clean { file, force } => {
            let root = find_root(&file)?;
            let file_name = file.file_name().unwrap_or_default().to_string_lossy();
            let storage = Storage::new(&root);

            if !force {
                if let Some(cf) = storage.read(&file_name)? {
                    let engine = CommentEngine::new(&root);
                    let stats = engine.get_stats(&cf);
                    if stats.open > 0 {
                        eprintln!("{} open thread(s) remain. Use --force to clean anyway.", stats.open);
                        return Ok(());
                    }
                }
            }

            if storage.delete(&file_name)? {
                println!("Cleaned annotations for {}", file_name);
            } else {
                println!("No annotations found for {}", file_name);
            }
        }

        Commands::View { file } => {
            let root = find_root(&file)?;
            let file_name = file.file_name().unwrap_or_default().to_string_lossy();
            let storage = Storage::new(&root);

            match storage.read(&file_name)? {
                None => println!("No annotations for {}", file_name),
                Some(cf) => {
                    let engine = CommentEngine::new(&root);
                    let stats = engine.get_stats(&cf);
                    println!("{}  {} open / {} resolved / {} total\n", file_name, stats.open, stats.resolved, stats.total);

                    for t in &cf.threads {
                        let status = match t.status {
                            agmark_core::types::ThreadStatus::Open => "●",
                            agmark_core::types::ThreadStatus::Resolved => "✓",
                            agmark_core::types::ThreadStatus::WontFix => "✗",
                        };
                        let fallback = format!("Paragraph {}", t.anchor.paragraph_index + 1);
                        let heading = t.anchor.heading_path.last()
                            .map(|h| h.as_str())
                            .unwrap_or(&fallback);

                        println!("  {} {} ({})", status, heading, t.anchor.paragraph_index);
                        if let Some(ref sel) = t.anchor.selected_text {
                            let preview: String = sel.chars().take(80).collect();
                            println!("    on: \"{}\"", preview);
                        }
                        for c in &t.comments {
                            let body: String = c.body.chars().take(120).collect();
                            println!("    {}: {}", c.author, body);
                        }
                        println!();
                    }
                }
            }
        }

        Commands::List { file, status } => {
            let root = find_root(&file)?;
            let file_name = file.file_name().unwrap_or_default().to_string_lossy();
            let storage = Storage::new(&root);

            match storage.read(&file_name)? {
                None => println!("No annotations for {}", file_name),
                Some(cf) => {
                    let threads: Vec<_> = cf.threads.iter().filter(|t| {
                        match status.as_deref() {
                            Some("open") => t.status == agmark_core::types::ThreadStatus::Open,
                            Some("resolved") => t.status == agmark_core::types::ThreadStatus::Resolved,
                            _ => true,
                        }
                    }).collect();

                    println!("{} threads", threads.len());
                    for t in threads {
                        println!("  [{}] {} — {}", t.id, status_name(&t.status), t.updated_at);
                    }
                }
            }
        }

        Commands::Stats { path } => {
            let dir = path.unwrap_or_else(|| PathBuf::from("."));
            let root = Storage::find_project_root(&dir).unwrap_or(dir);
            let storage = Storage::new(&root);

            let pending = storage.list_pending()?;
            println!("Project: {}", root.display());
            println!("Documents with open annotations: {}", pending.len());
            let total_open: usize = pending.iter().map(|p| p.open_count).sum();
            println!("Total open threads: {}", total_open);
            for p in &pending {
                println!("  {} - {} open / {} total", p.document, p.open_count, p.total_count);
            }
        }

        Commands::Add { file, paragraph, comment } => {
            let content = std::fs::read_to_string(&file)?;
            let file_name = file.file_name().unwrap_or_default().to_string_lossy();
            let root = find_root(&file)?;
            let engine = CommentEngine::new(&root);
            let cf = engine.add_thread(&file_name, &content, &comment, paragraph, None)?;
            println!("Added thread. Total: {}", cf.threads.len());
        }

        Commands::Reply { file, thread, comment } => {
            let file_name = file.file_name().unwrap_or_default().to_string_lossy();
            let root = find_root(&file)?;
            let engine = CommentEngine::new(&root);
            let cf = engine.add_reply(&file_name, &thread, &comment, "user")?;
            println!("Replied to {}", thread);
            let stats = engine.get_stats(&cf);
            println!("Status: {} open / {} resolved", stats.open, stats.resolved);
        }

        Commands::Resolve { file, thread } => {
            let file_name = file.file_name().unwrap_or_default().to_string_lossy();
            let root = find_root(&file)?;
            let engine = CommentEngine::new(&root);
            engine.set_status(&file_name, &thread, agmark_core::types::ThreadStatus::Resolved)?;
            println!("Resolved {}", thread);
        }

        Commands::Reopen { file, thread } => {
            let file_name = file.file_name().unwrap_or_default().to_string_lossy();
            let root = find_root(&file)?;
            let engine = CommentEngine::new(&root);
            engine.set_status(&file_name, &thread, agmark_core::types::ThreadStatus::Open)?;
            println!("Reopened {}", thread);
        }

        Commands::Check { file } => {
            let content = std::fs::read_to_string(&file)?;
            let file_name = file.file_name().unwrap_or_default().to_string_lossy();
            let root = find_root(&file)?;
            let storage = Storage::new(&root);

            match storage.read(&file_name)? {
                None => println!("No annotations for {}", file_name),
                Some(cf) => {
                    use agmark_core::anchor::content_hash;
                    let current_hash = content_hash(&content);
                    let snapshot_hash = cf.snapshot.document_hash.trim_start_matches("sha256:");
                    if current_hash == snapshot_hash {
                        println!("Document unchanged since snapshot.");
                    } else {
                        println!("⚠ Document changed since snapshot.");
                        println!("  Snapshot: sha256:{}", snapshot_hash);
                        println!("  Current:  sha256:{}", current_hash);
                    }
                }
            }
        }
    }

    Ok(())
}

fn status_name(status: &agmark_core::types::ThreadStatus) -> &str {
    match status {
        agmark_core::types::ThreadStatus::Open => "open",
        agmark_core::types::ThreadStatus::Resolved => "resolved",
        agmark_core::types::ThreadStatus::WontFix => "wontfix",
    }
}
