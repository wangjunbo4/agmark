use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommentFile {
    pub version: u32,
    pub document: String,
    pub snapshot: Snapshot,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub threads: Vec<CommentThread>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    #[serde(rename = "gitCommit")]
    pub git_commit: Option<String>,
    #[serde(rename = "documentHash")]
    pub document_hash: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommentThread {
    pub id: String,
    pub status: ThreadStatus,
    pub anchor: CommentAnchor,
    #[serde(default)]
    pub tags: Vec<String>,
    pub comments: Vec<Comment>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ThreadStatus {
    Open,
    Resolved,
    #[serde(rename = "wontfix")]
    WontFix,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Comment {
    pub id: String,
    pub author: String,
    pub body: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "editedAt", default)]
    pub edited_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommentAnchor {
    #[serde(rename = "type")]
    pub anchor_type: AnchorType,
    #[serde(rename = "headingPath", default)]
    pub heading_path: Vec<String>,
    #[serde(rename = "paragraphIndex")]
    pub paragraph_index: usize,
    #[serde(rename = "contentHash")]
    pub content_hash: String,
    #[serde(rename = "textFingerprint")]
    pub text_fingerprint: String,
    pub confidence: f64,
    #[serde(rename = "startOffset")]
    pub start_offset: Option<usize>,
    #[serde(rename = "endOffset")]
    pub end_offset: Option<usize>,
    #[serde(rename = "endParagraphIndex")]
    pub end_paragraph_index: Option<usize>,
    #[serde(rename = "selectedText")]
    pub selected_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum AnchorType {
    #[serde(rename = "heading-path")]
    HeadingPath,
    #[serde(rename = "selection")]
    Selection,
}

#[derive(Debug)]
pub struct AnnotationStats {
    pub total: usize,
    pub open: usize,
    pub resolved: usize,
    pub wontfix: usize,
}
