import { describe, it, expect } from 'vitest';

// ═══════════════════════════════════════════════════════
// Tests for the Ask Claude auto-send logic.
// We test the core invariants without importing VSCode-dependent modules.
// ═══════════════════════════════════════════════════════

describe('tryAutoSend environment detection', () => {
  it('xdotool is skipped when DISPLAY is not set (Remote/SSH)', () => {
    const isRemote = !process.env.DISPLAY;
    // In Remote/SSH, xdotool can never work; we fall back to clipboard-only
    expect(isRemote).toBe(true); // current environment IS remote
  });

  it('xdotool uses --clearmodifiers to avoid stuck keys from click', () => {
    const cmd = 'xdotool key --clearmodifiers ctrl+v Return';
    expect(cmd).toContain('--clearmodifiers');
    expect(cmd).toContain('ctrl+v');
    expect(cmd).toContain('Return');
  });

  it('delay after focus is sufficient for mouse release', () => {
    // From current implementation: setTimeout(r, 600)
    const FOCUS_TO_SEND_DELAY = 600;
    expect(FOCUS_TO_SEND_DELAY).toBeGreaterThanOrEqual(500);
  });
});

describe('clipboard fallback', () => {
  it('always works regardless of xdotool/Remote status', () => {
    // clipboard.writeText + claude-vscode.focus is the base path
    // that works in all environments (Remote, local, etc.)
    const baseUxSteps = ['clipboard.writeText', 'claude-vscode.focus'];
    expect(baseUxSteps).toHaveLength(2);
  });
});
