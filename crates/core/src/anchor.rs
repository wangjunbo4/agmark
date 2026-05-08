use crate::types::{AnchorType, CommentAnchor};
use pulldown_cmark::{Parser, Event, Tag, TagEnd, HeadingLevel};
use sha2::{Sha256, Digest};

#[derive(Debug, Clone)]
pub struct Paragraph {
    pub index: usize,
    pub heading_path: Vec<String>,
    pub content: String,
}

pub fn parse_paragraphs(markdown: &str) -> Vec<Paragraph> {
    let parser = Parser::new(markdown);
    let mut paragraphs = vec![];
    let mut heading_stack: Vec<String> = vec![];
    let mut current_text = String::new();
    let mut para_index = 0;
    let mut in_para = false;

    for event in parser {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                // Flush previous paragraph
                if in_para && !current_text.trim().is_empty() {
                    paragraphs.push(Paragraph {
                        index: para_index,
                        heading_path: heading_stack.clone(),
                        content: current_text.trim().to_string(),
                    });
                    para_index += 1;
                    current_text.clear();
                    in_para = false;
                }
                // Pop headings at or above this level
                let level_num = heading_level_num(&level);
                while heading_stack.len() >= level_num {
                    heading_stack.pop();
                }
            }
            Event::End(TagEnd::Heading(level)) => {
                let level_num = heading_level_num(&level);
                let hashes = "#".repeat(level_num);
                heading_stack.push(format!("{} {}", hashes, current_text.trim()));
                current_text.clear();
            }
            Event::Text(text) | Event::Code(text) => {
                current_text.push_str(&text);
                in_para = true;
            }
            Event::SoftBreak | Event::HardBreak => {
                current_text.push('\n');
            }
            Event::Start(Tag::Paragraph)
            | Event::Start(Tag::CodeBlock(_))
            | Event::Start(Tag::List(_))
            | Event::Start(Tag::Item) => {
                // Block-level starts — continue accumulating
            }
            Event::End(TagEnd::Paragraph)
            | Event::End(TagEnd::CodeBlock)
            | Event::End(TagEnd::List(_))
            | Event::End(TagEnd::Item) => {
                // Flush paragraph
                if in_para && !current_text.trim().is_empty() {
                    paragraphs.push(Paragraph {
                        index: para_index,
                        heading_path: heading_stack.clone(),
                        content: current_text.trim().to_string(),
                    });
                    para_index += 1;
                    current_text.clear();
                    in_para = false;
                }
            }
            _ => {}
        }
    }

    if in_para && !current_text.trim().is_empty() {
        paragraphs.push(Paragraph {
            index: para_index,
            heading_path: heading_stack,
            content: current_text.trim().to_string(),
        });
    }

    paragraphs
}

fn heading_level_num(level: &HeadingLevel) -> usize {
    match level {
        HeadingLevel::H1 => 1, HeadingLevel::H2 => 2, HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4, HeadingLevel::H5 => 5, HeadingLevel::H6 => 6,
    }
}

pub fn content_hash(content: &str) -> String {
    let mut h = Sha256::new();
    h.update(content.as_bytes());
    hex::encode(&h.finalize())[..8].to_string()
}

pub fn text_fingerprint(content: &str) -> String {
    content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(150)
        .collect()
}

pub fn build_anchor(paragraphs: &[Paragraph], para_index: usize) -> Option<CommentAnchor> {
    let para = paragraphs.iter().find(|p| p.index == para_index)?;
    Some(CommentAnchor {
        anchor_type: AnchorType::HeadingPath,
        heading_path: para.heading_path.clone(),
        paragraph_index: para.index,
        content_hash: content_hash(&para.content),
        text_fingerprint: text_fingerprint(&para.content),
        confidence: 1.0,
        start_offset: None,
        end_offset: None,
        end_paragraph_index: None,
        selected_text: None,
    })
}

pub fn build_selection_anchor(
    paragraphs: &[Paragraph],
    para_index: usize,
    start_offset: usize,
    end_offset: usize,
    selected_text: &str,
    end_paragraph_index: Option<usize>,
) -> Option<CommentAnchor> {
    let para = paragraphs.iter().find(|p| p.index == para_index)?;
    Some(CommentAnchor {
        anchor_type: AnchorType::Selection,
        heading_path: para.heading_path.clone(),
        paragraph_index: para.index,
        content_hash: content_hash(&para.content),
        text_fingerprint: text_fingerprint(selected_text),
        confidence: 1.0,
        start_offset: Some(start_offset),
        end_offset: Some(end_offset),
        end_paragraph_index,
        selected_text: Some(selected_text.to_string()),
    })
}
