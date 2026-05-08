use std::io;

use crate::anchor;
use crate::storage::Storage;
use crate::types::*;

fn gen_id(prefix: &str) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{}_{:x}", prefix, ts)
}

pub struct CommentEngine {
    storage: Storage,
}

impl CommentEngine {
    pub fn new(project_root: &std::path::Path) -> Self {
        Self {
            storage: Storage::new(project_root),
        }
    }

    pub fn get_or_create(&self, document: &str, content: &str) -> io::Result<CommentFile> {
        if let Some(file) = self.storage.read(document)? {
            return Ok(file);
        }
        let hash = anchor::content_hash(content);
        let file = CommentFile {
            version: 1,
            document: document.to_string(),
            snapshot: Snapshot {
                git_commit: None,
                document_hash: format!("sha256:{}", hash),
                created_at: now_iso(),
            },
            updated_at: now_iso(),
            threads: vec![],
        };
        self.storage.write(document, &file)?;
        Ok(file)
    }

    pub fn add_thread(
        &self,
        document: &str,
        content: &str,
        body: &str,
        paragraph_index: usize,
        selection: Option<(&str, usize, usize, Option<usize>)>,
    ) -> io::Result<CommentFile> {
        let mut file = self.get_or_create(document, content)?;
        let paragraphs = anchor::parse_paragraphs(content);

        let anchor_data = if let Some((sel_text, start, end, end_para)) = selection {
            anchor::build_selection_anchor(&paragraphs, paragraph_index, start, end, sel_text, end_para)
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "paragraph not found"))?
        } else {
            anchor::build_anchor(&paragraphs, paragraph_index)
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "paragraph not found"))?
        };

        let thread = CommentThread {
            id: gen_id("thr"),
            status: ThreadStatus::Open,
            anchor: anchor_data,
            tags: vec![],
            comments: vec![Comment {
                id: gen_id("cmt"),
                author: "user".to_string(),
                body: body.to_string(),
                created_at: now_iso(),
                edited_at: None,
            }],
            created_at: now_iso(),
            updated_at: now_iso(),
        };

        file.threads.push(thread);
        self.storage.write(document, &file)?;
        Ok(file)
    }

    pub fn add_reply(&self, document: &str, thread_id: &str, body: &str, author: &str) -> io::Result<CommentFile> {
        let mut file = self.storage.read(document)?.ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "no comment file found")
        })?;

        let thread = file.threads.iter_mut().find(|t| t.id == thread_id).ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "thread not found")
        })?;

        thread.comments.push(Comment {
            id: gen_id("cmt"),
            author: author.to_string(),
            body: body.to_string(),
            created_at: now_iso(),
            edited_at: None,
        });
        thread.updated_at = now_iso();

        self.storage.write(document, &file)?;
        Ok(file)
    }

    pub fn set_status(&self, document: &str, thread_id: &str, status: ThreadStatus) -> io::Result<CommentFile> {
        let mut file = self.storage.read(document)?.ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "no comment file found")
        })?;

        let thread = file.threads.iter_mut().find(|t| t.id == thread_id).ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "thread not found")
        })?;

        thread.status = status;
        thread.updated_at = now_iso();
        self.storage.write(document, &file)?;
        Ok(file)
    }

    pub fn delete_thread(&self, document: &str, thread_id: &str) -> io::Result<CommentFile> {
        let mut file = self.storage.read(document)?.ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "no comment file found")
        })?;

        file.threads.retain(|t| t.id != thread_id);
        self.storage.write(document, &file)?;
        Ok(file)
    }

    pub fn get_stats(&self, file: &CommentFile) -> AnnotationStats {
        let mut stats = AnnotationStats {
            total: 0, open: 0, resolved: 0, wontfix: 0,
        };
        for t in &file.threads {
            stats.total += 1;
            match t.status {
                ThreadStatus::Open => stats.open += 1,
                ThreadStatus::Resolved => stats.resolved += 1,
                ThreadStatus::WontFix => stats.wontfix += 1,
            }
        }
        stats
    }
}

fn now_iso() -> String {
    // Simple ISO 8601 without chrono dependency
    use std::time::SystemTime;
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // This is a simplification — proper ISO would need chrono
    // For the MVP, we store seconds and reconstruct
    let naive = secs;
    // Format: 2026-05-07T12:00:00Z
    // Using a simple calculation — not perfect but avoids chrono dependency
    let days_since_epoch = naive / 86400;
    let time_of_day = naive % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Approximate year/month/day from days since epoch
    let mut y = 1970i64;
    let mut d = days_since_epoch as i64;
    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if d < days_in_year { break; }
        d -= days_in_year;
        y += 1;
    }
    let m = month_from_day_of_year(d as u32, is_leap(y));
    let day = day_of_month(d as u32, is_leap(y));

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y, m, day, hours, minutes, seconds
    )
}

fn is_leap(y: i64) -> bool { (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 }

fn month_from_day_of_year(doy: u32, leap: bool) -> u32 {
    let months = if leap {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut remaining = doy;
    for (i, &days) in months.iter().enumerate() {
        if remaining < days {
            return (i + 1) as u32;
        }
        remaining -= days;
    }
    12
}

fn day_of_month(doy: u32, leap: bool) -> u32 {
    let months = if leap {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut remaining = doy;
    for &days in &months {
        if remaining < days {
            return remaining + 1;
        }
        remaining -= days;
    }
    1
}
