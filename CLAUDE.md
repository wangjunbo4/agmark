# AgentMark

This project uses AgentMark for document annotation. Annotations live in `.comments/` directory.

## MCP Tools (preferred)

Use these tools to interact with annotations directly — no file reading needed:

- `list_pending` — scan all pending annotations across the project
- `get_annotations(document, status?)` — get threads for a specific document
- `reply_to_annotation(document, threadId, body, resolve?)` — reply and resolve
- `get_stats(document?)` — annotation statistics

## When user mentions "annotations" or "review"

1. Call `get_annotations <document>` to see open threads
2. Address each thread by modifying the markdown document
3. Call `reply_to_annotation` for each thread to mark it resolved

## Slash command

- `/agmark review <file>` — shorthand for reviewing annotations on a file
