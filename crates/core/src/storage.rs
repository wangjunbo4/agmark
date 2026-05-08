use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::types::CommentFile;

pub struct Storage {
    project_root: PathBuf,
}

impl Storage {
    pub fn new(project_root: &Path) -> Self {
        Self {
            project_root: project_root.to_path_buf(),
        }
    }

    pub fn find_project_root(start_dir: &Path) -> Option<PathBuf> {
        let mut dir = start_dir.to_path_buf();
        loop {
            if dir.join(".comments").is_dir() {
                return Some(dir);
            }
            if !dir.pop() {
                return None;
            }
        }
    }

    fn comments_dir(&self) -> PathBuf {
        self.project_root.join(".comments")
    }

    fn comment_path(&self, document: &str) -> PathBuf {
        let base = Path::new(document)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy();
        self.comments_dir().join(format!("{}.json", base))
    }

    pub fn exists(&self, document: &str) -> bool {
        self.comment_path(document).exists()
    }

    pub fn read(&self, document: &str) -> io::Result<Option<CommentFile>> {
        let path = self.comment_path(document);
        if !path.exists() {
            return Ok(None);
        }
        let data = fs::read_to_string(&path)?;
        serde_json::from_str(&data).map(Some).map_err(|e| {
            io::Error::new(io::ErrorKind::InvalidData, e)
        })
    }

    pub fn write(&self, document: &str, file: &CommentFile) -> io::Result<()> {
        let path = self.comment_path(document);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let data = serde_json::to_string_pretty(file)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        fs::write(&path, data)?;
        Ok(())
    }

    pub fn delete(&self, document: &str) -> io::Result<bool> {
        let path = self.comment_path(document);
        if path.exists() {
            fs::remove_file(&path)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn list_pending(&self) -> io::Result<Vec<PendingDoc>> {
        let dir = self.comments_dir();
        if !dir.is_dir() {
            return Ok(vec![]);
        }

        let mut results = vec![];
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".json") {
                continue;
            }
            let data = fs::read_to_string(entry.path())?;
            if let Ok(file) = serde_json::from_str::<CommentFile>(&data) {
                let open_count = file.threads.iter().filter(|t| t.status == crate::types::ThreadStatus::Open).count();
                if open_count > 0 {
                    results.push(PendingDoc {
                        document: file.document,
                        open_count,
                        total_count: file.threads.len(),
                    });
                }
            }
        }
        Ok(results)
    }
}

#[derive(Debug)]
pub struct PendingDoc {
    pub document: String,
    pub open_count: usize,
    pub total_count: usize,
}
