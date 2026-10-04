import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function observeClaudeInput(socket: string, pane: string, version: string | null) {
  if (version !== '2.1.289') return { state: 'unknown', reason: `Unsupported or unrecorded Claude terminal version ${version ?? 'unknown'}; validated version is 2.1.289`, prompt: '', x: -1, y: -1 };
  const [capture, joined, geometry] = await Promise.all([
    exec('tmux', ['-S', socket, 'capture-pane', '-p', '-t', pane], { timeout: 2000 }),
    exec('tmux', ['-S', socket, 'capture-pane', '-p', '-J', '-t', pane], { timeout: 2000 }),
    exec('tmux', ['-S', socket, 'display-message', '-p', '-t', pane, '#{cursor_x}\t#{cursor_y}\t#{pane_in_mode}\t#{pane_input_off}'], { timeout: 2000 }),
  ]);
  const lines = capture.stdout.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  const [x, y, inMode, inputOff] = geometry.stdout.trim().split('\t').map(Number);
  const recent = lines.filter((line) => line.trim()).slice(-16).join('\n');
  const result = { prompt: '', x, y };
  if (inMode !== 0 || inputOff !== 0) return { ...result, state: 'blocked', reason: 'Terminal input is disabled or in copy mode' };
  if (/Do you want to (?:proceed|continue|trust|allow)|Do you trust|^[❯›]\s*\d+[.)]\s/m.test(lines.join('\n')))
    return { ...result, state: 'blocked', reason: 'Permission dialog or selection menu' };
  if (/esc to interrupt|\bthinking\b.*…|-- NORMAL --/i.test(recent)) return { ...result, state: 'blocked', reason: 'Claude is busy or outside insert mode' };
  const borders = lines.map((line, index) => /^─{8,}\s*$/.test(line) ? index : -1).filter((index) => index >= 0);
  const end = borders.at(-1) ?? -1;
  const start = borders.at(-2) ?? -1;
  const footer = lines.slice(end + 1).join('\n');
  const pasteHint = /^❯[ \u00a0]*\[Pasted text #\d+ \+\d+ lines\]\s*$/.test(lines.slice(start + 1, end).join('\n')) && /^\s*paste again to expand\s*$/m.test(footer);
  if (start < 0 || end <= start || (!/(?:-- INSERT --|shift\+tab to cycle)/.test(footer) && !pasteHint)
    || lines.slice(end + 1).filter((line) => line.trim()).length > 6 || y <= start || y >= end)
    return { ...result, state: 'unknown', reason: `Unrecognized Claude input screen or cursor position (cursor ${x},${y}; input rows ${start + 1}..${end - 1}; footer rows ${lines.slice(end + 1).filter((line) => line.trim()).length})` };
  const joinedLines = joined.stdout.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  const joinedBorders = joinedLines.map((line, index) => /^─{8,}\s*$/.test(line) ? index : -1).filter((index) => index >= 0);
  const prompt = joinedLines.slice((joinedBorders.at(-2) ?? -1) + 1, joinedBorders.at(-1) ?? -1).map((line) => line.trimEnd()).join('\n');
  const rawPrompt = lines.slice(start + 1, end).map((line) => line.trimEnd()).join('\n');
  if (/^❯[ \u00a0]*(?:\n\s*)*$/.test(prompt) !== /^❯[ \u00a0]*(?:\n\s*)*$/.test(rawPrompt))
    return { ...result, prompt, state: 'unknown', reason: 'Input screen changed during observation' };
  if (!/^❯[ \u00a0]*(?:\n\s*)*$/.test(prompt)) return { ...result, prompt, state: 'draft', reason: 'Existing input draft or suggestion cannot be confirmed empty' };
  if (x !== 2) return { ...result, prompt, state: 'unknown', reason: 'Input cursor is not at the empty prompt' };
  return { ...result, prompt, state: 'empty', reason: null };
}
