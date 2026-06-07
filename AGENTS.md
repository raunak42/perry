# AGENTS.md

Guidance for future coding agents working in this repo.

## Perry self manifest maintenance

Perry has a built-in self manifest at `SELF_MANIFEST.md`. The manifest is loaded into Perry's developer/system prompt at startup so Perry can accurately answer questions about its own capabilities even when the Perry source tree is not available.

When changing Perry's user-visible behavior, slash commands, tools, settings, permission model, MCP support, plan mode, TUI behavior, session/context behavior, or major architecture, update `SELF_MANIFEST.md` in the same change. Keep it concise but accurate. Do not leave it stale after adding, renaming, or removing features.

## Current TUI streaming/input-box fix context

A recent regression investigation involved Perry's terminal UI while assistant text/thinking/tool traces stream into the terminal.

Observed user-facing problems were real, not imagined:

- assistant/thinking traces streamed, but the input box and session details appeared to flash;
- after an over-aggressive anti-flash patch, the loader/spinner stopped animating normally;
- the busy timer got stuck at `0s`;
- during thinking/streaming, the input box/session details could vanish until the stream finished.

The root issue was that high-frequency events were coupled to full prompt-frame redraws:

- stream chunks/tool output had to hide the transient input frame to print output above it;
- spinner ticks were redrawing the whole prompt/session frame;
- attempts to suppress those redraws made the prompt disappear and froze the loader/timer.

The current fix separates these responsibilities. Preserve that separation.

## Important invariants: do not break these

When the persistent input prompt is active and Perry is working:

1. **The input box must remain effectively visible/usable while output streams.**
   - Stream/tool output may temporarily hide the prompt only to insert output above it.
   - The prompt must be restored immediately after the output write.
   - Do not defer prompt restoration until the stream finishes.

2. **The loader/spinner must keep animating.**
   - Do not stop spinner ticks just because the input prompt is active.

3. **The busy timer must advance past `0s`.**
   - If busy state remains active, the visible status should update, e.g. `Thinking · 1s`, then `Thinking · 1m 5s` after one minute.

4. **Spinner/timer updates must not redraw the full input/session frame every 100ms.**
   - Update only the busy/status line inside the transient prompt frame when possible.
   - Do not clear/redraw the border, input line, and session details for every spinner frame.

5. **Session details below the input box must not appear/disappear repeatedly during streaming.**
   - Lifecycle redraws are fine: initial prompt render, session detail updates, busy start/stop, stream finish, cleanup.
   - Repainting the whole prompt/session block on every token or spinner frame is not fine.

## Key files and symbols

Relevant implementation files:

- `src/ui/terminal-ui.ts`
- `src/ui/bottom-area.ts`
- `test/terminal-ui.test.ts`

Important code paths/symbols:

- `TerminalUi.printDuringBusy(...)`
  - Handles output insertion while busy/input UI may be active.
  - Should batch hide/output/restore operations so the terminal is less likely to paint an intermediate blank prompt state.

- `BottomArea.withHiddenTransient(...)`
  - Temporarily hides the active transient prompt/choice frame.
  - Be careful with `restore: false`; if used, the caller must restore/redraw the active prompt at the correct time.

- `TerminalUi.requestActiveSessionRedraw(...)`
  - Responsible for redrawing the active prompt session.
  - Do not use debounce/defer logic in a way that leaves the input hidden during active streaming.

- `BottomArea.updateTransientBusyStatusLine(...)`
  - Preferred path for spinner/timer updates while the input prompt is active.
  - It should rewrite only the busy status row inside the already-visible transient frame.

- `TransientFrame.busyStatusRow`
  - Identifies where the busy status lives inside the prompt frame.

- `TransientFrame.width`
  - Use the transient frame width when rewriting rows, not an unrelated terminal/output width.

## What not to do

If flicker/flashing is reported again, avoid these tempting but wrong fixes:

- **Do not simply suppress spinner redraws while input is active.**
  - That causes the loader/timer to freeze at `0s`.

- **Do not leave the prompt hidden until streaming finishes.**
  - That makes the input box/session details vanish during thinking/streaming.

- **Do not redraw the entire prompt frame on every spinner tick.**
  - That causes constant flashing of the input box and session details.

- **Do not rely only on raw write counts.**
  - Some cursor movement is unavoidable in a scrollback-first TUI.
  - The important behavior is visible stability: prompt restored promptly, spinner alive, timer advancing, no 10Hz full-frame redraw loop.

- **Do not fix streaming by appending newlines after every chunk.**
  - That can corrupt streamed text layout and chunk boundaries.

## Correct mental model

The TUI is scrollback-first and keeps a persistent prompt visible while work is happening. Output is inserted above the transient prompt. That means output writes generally need this shape:

1. hide transient prompt frame;
2. write assistant/tool/thinking output;
3. restore active prompt frame immediately;
4. keep spinner/timer updates localized to the busy row.

The prompt can be momentarily hidden inside a batched terminal write, but it should not remain hidden across streamed chunks or tool activity.

Spinner/timer updates should be treated as small in-place status-line changes, not as a reason to rebuild the whole input UI.

## Retained-history resize/reflow context

Perry used to be purely scrollback-first: committed blocks were printed once and forgotten, so old chat history kept the wrapping/borders from the terminal width it was originally printed at. New content adapted after resize, but historical content did not.

The TUI now keeps retained source blocks for committed history and automatically redraws them on terminal resize:

- user messages, assistant messages, thinking blocks, warnings, generic markdown, startup card, worked-duration lines, and tool trace cards are retained as structured/source data;
- resize events clear the viewport/scrollback and replay retained blocks at the new width;
- the active prompt/busy state is then restored;
- live streaming blocks are replayed from their current raw text so mid-response resize does not lose visible output.

Important symbols:

- `TerminalUi.retainedHistory`
- `TerminalUi.redrawRetainedHistoryForResize()`
- `TerminalUi.replayRetainedHistoryBlock(...)`
- `TerminalUi.replayLiveStreamingBlocksAfterResize()`
- `BottomArea.forgetRenderedState()`

Do not revert `refreshHistory()` to manual/user-triggered behavior as the only fix. The user explicitly wants resize adaptation to happen automatically, not through `/refresh`.

Be careful when adding new visible block types: if a block is committed to history and should survive/adapt across resize, store source data in `retainedHistory` and teach `replayRetainedHistoryBlock(...)` how to render it.

## Regression tests to run

After touching TUI streaming, busy status, prompt redraw, retained history, resize handling, or bottom-area behavior, run at least:

```bash
bun test ./test/terminal-ui.test.ts
bun x tsc
```

Prefer also running the full suite:

```bash
bun test
```

Important regression coverage in `test/terminal-ui.test.ts` includes tests around:

- resize replays retained history at the new width;
- active prompt streaming restores the input frame;
- active prompt busy spinner does not redraw the full prompt every tick;
- active prompt busy timer advances;
- active prompt slow streaming keeps session details visible;
- streaming does not replay prefixes into scrollback;
- cumulative snapshot deltas do not print repeated prefixes.

If these tests fail after a UI change, do not paper over them by weakening the visibility/timer assertions. First reproduce the terminal behavior with stdout capture and confirm whether the input box stays visible, whether the spinner animates, and whether the timer advances.

## Suggested debugging approach for future agents

When investigating similar TUI bugs:

1. Reproduce with a stdout-capture harness or terminal-emulation helper.
2. Test three separate cases:
   - active prompt + busy spinner, no streaming;
   - active prompt + fast streaming;
   - active prompt + slow streaming with chunks spaced over debounce thresholds.
3. Count/inspect:
   - full prompt frame writes;
   - session detail line writes;
   - `ESC[J` tail clears;
   - cursor-up moves;
   - visible busy states like `Thinking · 0s`, `Thinking · 1s`, and `Thinking · 1m 5s`.
4. Verify the final visible screen before cleanup/cancel, not only after `ui.destroy()`.
5. Keep fixes targeted: localize spinner updates, batch transient hide/output/restore, and avoid broad suppression of redraws.

## Summary

The correct fix is not "never redraw" and not "redraw everything".

The correct fix is:

- restore the input prompt immediately after streamed/tool output;
- keep loader/timer alive;
- update only the busy status row for spinner/timer ticks;
- avoid full input/session-frame redraw loops.
