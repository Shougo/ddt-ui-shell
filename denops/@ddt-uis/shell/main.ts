import type {
  BaseParams,
  Context,
  DdtOptions,
  UiOptions,
} from "@shougo/ddt-vim/types";
import { BaseUi, type UiActions } from "@shougo/ddt-vim/ui";
import { printError, safeStat } from "@shougo/ddt-vim/utils";
import { parseCommandLine, parseCommandLineWithEnv } from "./parse.ts";

import type { Denops } from "@denops/std";
import * as fn from "@denops/std/function";
import * as vars from "@denops/std/variable";
import { batch } from "@denops/std/batch";
import * as autocmd from "@denops/std/autocmd";

import { is } from "@core/unknownutil/is";
import { join } from "@std/path/join";
import { resolve } from "@std/path/resolve";
import { isAbsolute } from "@std/path/is-absolute";
import { assertEquals } from "@std/assert/equals";
import { Pty } from "@sigma/pty-ffi";
import { type Annotation, trimAndParse } from "@lambdalisue/ansi-escape-code";

type ExprNumber = string | number;

/**
 * Represents a byte length value.
 * NOTE: This must be a byte length, not character length.
 * Use `await fn.len(denops, str)` to get byte length in Vim.
 */
type ByteLength = number;

/**
 * Represents a 1-based line number in Vim/Neovim buffer.
 */
type LineNumber = number;

/**
 * Represents a 1-based column number in Vim/Neovim buffer.
 */
type ColumnNumber = number;

type ANSIHighlight = {
  highlight: string;
  name: string;
  priority: number;
  bufnr: number;
  row: LineNumber;
  col: ColumnNumber;
  length: ByteLength;
};

function debugLog(options: { debug?: boolean }, ...args: unknown[]): void {
  if (options.debug) {
    console.log(...args);
  }
}

const encoder = new TextEncoder();

export type ANSIColorHighlights = {
  bgs?: string[];
  bold?: string;
  fgs?: string[];
  italic?: string;
  underline?: string;
};

export type Params = {
  aliases: Record<string, string>;
  ansiColorHighlights: ANSIColorHighlights;
  cwd: string;
  exprParams: (keyof Params)[];
  floatingBorder: string;
  flushIntervalMs: number;
  noSaveHistoryCommands: string[];
  passwordPattern: string;
  prompt: string;
  promptHighlight: string;
  promptPattern: string;
  shellHistoryMax: number;
  shellHistoryPath: string;
  split: string;
  startInsert: boolean;
  toggle: boolean;
  userPrompt: string;
  userPromptHighlight: string;
  userPromptPattern: string;
  winCol: ExprNumber;
  winHeight: ExprNumber;
  winRow: ExprNumber;
  winWidth: ExprNumber;
};

// ... existing code unchanged until #flushOutput ...

function shouldOverwriteProgressLine(prev: string, next: string): boolean {
  if (prev === next) {
    return true;
  }

  const normalizedPrev = prev.replace(/\d+/g, "#");
  const normalizedNext = next.replace(/\d+/g, "#");
  if (normalizedPrev !== normalizedNext) {
    return false;
  }

  // Heuristic: treat progress-like lines as overwrite candidates.
  return /%|\b(eta|time|done|remaining|writing|counting|compressing|enumerating)\b/i
    .test(prev) ||
    /%|\b(eta|time|done|remaining|writing|counting|compressing|enumerating)\b/i
      .test(next);
}

// ... existing code unchanged until #checkOutput ...

  async #checkOutput(
    denops: Denops,
    options: DdtOptions,
    uiParams: Params,
  ) {
    if (!this.#pty) {
      return;
    }

    const passwordRegex = new RegExp(uiParams.passwordPattern);

    this.#promptLineNr =
      (await fn.getbufline(denops, this.#bufNr, 1, "$" )).length;
    let currentLineNr: LineNumber = this.#promptLineNr;

    // Reset output buffers for this command run.
    this.#outputQueue = [];
    this.#pendingHighlights = [];

    for await (const data of this.#pty.readable) {
      debugLog(options, `data = "${data}"`);

      type CurrentHighlight = Pick<
        ANSIHighlight,
        "highlight" | "name" | "priority"
      >;

      for (const line of data.split(/\r*\n/)) {
        if (line.length === 0) {
          continue;
        }

        const extract = extractLastOverwriteContent(line);

        debugLog(options, `line: "${line}" to "${extract}"`);

        const [trimmed, annotations] = trimAndParse(extract);

        currentLineNr += 1;
        let currentCol: ColumnNumber = 1;
        const currentIndex = currentLineNr - this.#promptLineNr;
        let currentText = currentIndex < this.#outputQueue.length
          ? this.#outputQueue[currentIndex]
          : "";
        debugLog(options, this.#outputQueue);

        const currentHighlights: CurrentHighlight[] = [];
        let overwrite = false;

        for (
          const annotation of transformAnnotations(trimmed, annotations)
        ) {
          debugLog(options, annotation);

          const foreground = annotation.csi?.sgr?.foreground;
          const background = annotation.csi?.sgr?.background;
          const italic = annotation.csi?.sgr?.italic;
          const bold = annotation.csi?.sgr?.bold;
          const underline = annotation.csi?.sgr?.underline;

          if (is.Number(annotation.csi?.cuu) && annotation.csi?.cuu > 0) {
            currentLineNr -= 1;
          }

          if (
            (is.Number(annotation.csi?.cha) && annotation.csi?.cha >= 0) ||
            (is.Number(annotation.csi?.el) && annotation.csi?.el > 0) ||
            (is.Number(annotation.csi?.cuu) && annotation.csi?.cuu > 0) ||
            (is.Number(annotation.csi?.ed) && annotation.csi?.ed >= 0)
          ) {
            // Overwrite current line
            if (!overwrite) {
              debugLog(options, "Overwrite current line");
            }

            overwrite = true;
          }

          if (is.String(annotation.text)) {
            annotation.text = annotation.text.replaceAll("\r", "");
          }

          if (annotation.csi?.sgr?.reset) {
            // Reset colors.
            currentHighlights.length = 0;
          }

          if (
            is.Number(background) && background > 0 && background < 16 &&
            uiParams.ansiColorHighlights.bgs
          ) {
            currentHighlights.push({
              highlight: uiParams.ansiColorHighlights.bgs[background],
              name: `ANSIColorBG${background}`,
              priority: 5,
            });
          }
          if (
            is.Boolean(bold) && uiParams.ansiColorHighlights.bold
          ) {
            currentHighlights.push({
              highlight: uiParams.ansiColorHighlights.bold,
              name: `ANSIColorBold`,
              priority: 100,
            });
          }
          if (
            is.Number(foreground) && foreground > 0 && foreground < 16 &&
            uiParams.ansiColorHighlights.fgs
          ) {
            currentHighlights.push({
              highlight: uiParams.ansiColorHighlights.fgs[foreground],
              name: `ANSIColorFG${foreground}`,
              priority: 10,
            });
          }
          if (
            is.Boolean(italic) && uiParams.ansiColorHighlights.italic
          ) {
            currentHighlights.push({
              highlight: uiParams.ansiColorHighlights.italic,
              name: `ANSIColorItalic`,
              priority: 100,
            });
          }
          if (
            is.Boolean(underline) && uiParams.ansiColorHighlights.underline
          ) {
            currentHighlights.push({
              highlight: uiParams.ansiColorHighlights.underline,
              name: `ANSIColorUnderline`,
              priority: 100,
            });
          }

          if (annotation.text) {
            if (overwrite) {
              debugLog(
                options,
                "Overwrite current line: " +
                  `"${currentText}" to "${annotation.text}"`,
              );

              currentText = annotation.text;
            } else {
              currentText += annotation.text;
            }

            debugLog(options, `currentText: "${currentText}"`);

            // Add highlights
            for (const highlight of currentHighlights) {
              this.#pendingHighlights.push({
                ...highlight,
                bufnr: this.#bufNr,
                row: currentLineNr,
                col: currentCol,
                length: encoder.encode(annotation.text).length,
              });
            }

            currentCol = encoder.encode(currentText).length + 1;
          }
        }

        const prevLine = this.#outputQueue[this.#outputQueue.length - 1];
        const progressOverwrite = !overwrite && prevLine !== undefined &&
          shouldOverwriteProgressLine(prevLine, currentText);

        if ((overwrite || progressOverwrite) && this.#outputQueue.length > 0) {
          this.#outputQueue[this.#outputQueue.length - 1] = currentText;
        } else {
          // Append new line.
          debugLog(options, `push: ${currentText}`);

          this.#outputQueue.push(currentText);
        }
      }

      // Schedule a periodic flush if not already pending.
      if (this.#flushTimer === null) {
        this.#flushTimer = setTimeout(() => {
          this.#flushTimer = null;
          this.#flushOutput(denops).catch((e) => {
            console.error("ddt-ui-shell: flush error:", e);
          });
        }, uiParams.flushIntervalMs);
      }

      if (passwordRegex.exec(data)) {
        // Flush immediately before asking for password.
        if (this.#flushTimer !== null) {
          clearTimeout(this.#flushTimer);
          this.#flushTimer = null;
        }
        await this.#flushOutput(denops);
        // NOTE: Move the cursor to make the output more visible.
        await denops.cmd("normal! zz");
        this.#pty.write(`${await fn.inputsecret(denops, "Password: ")}\n`);
      }
    }

    // Cancel any pending timer and flush remaining output.
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    await this.#flushOutput(denops);

    // Print exit code
    if (this.#pty?.exitCode && this.#pty.exitCode != 0) {
      await this.#printMessage(
        denops,
        `ddt-ui-shell: exit ${this.#pty.exitCode ?? ""}`,
      );
      // Move cursor after appending the exit-code message.
      await this.#moveCursorLast(denops);
    }
  }

// ... rest unchanged ...
