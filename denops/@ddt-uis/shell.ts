import type {
  BaseParams,
  Context,
  DdtOptions,
  UiOptions,
} from "jsr:@shougo/ddt-vim@~1.1.0/types";
import { BaseUi, type UiActions } from "jsr:@shougo/ddt-vim@~1.1.0/ui";
import { printError, safeStat } from "jsr:@shougo/ddt-vim@~1.1.0/utils";

import type { Denops } from "jsr:@denops/std@~7.5.0";
import * as fn from "jsr:@denops/std@~7.5.0/function";
import * as vars from "jsr:@denops/std@~7.5.0/variable";
import { batch } from "jsr:@denops/std@~7.5.0/batch";
import * as autocmd from "jsr:@denops/std@~7.5.0/autocmd";

import { is } from "jsr:@core/unknownutil@~4.3.0/is";
import { join } from "jsr:@std/path@~1.0.3/join";
import { resolve } from "jsr:@std/path@~1.0.3/resolve";
import { relative } from "jsr:@std/path@~1.0.3/relative";
import { isAbsolute } from "jsr:@std/path@~1.0.2/is-absolute";
import { assertEquals } from "jsr:@std/assert@~1.0.2/equals";
import { expandGlob } from "jsr:@std/fs@~1.0.2/expand-glob";
import { Pty } from "jsr:@sigma/pty-ffi@~0.36.0";
import {
  type Annotation,
  trimAndParse,
} from "jsr:@lambdalisue/ansi-escape-code@~1.0.4";

//import { parse } from 'jsr:@fcrozatier/monarch@~2.3.2';

type ExprNumber = string | number;

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

type CdParams = {
  directory: string;
};

type SendParams = {
  str: string;
};

type BuiltinCommand = {
  description: string;
  callback: BuiltinCallback;
};

type BuiltinArguments<Params extends BaseParams> = {
  denops: Denops;
  options: DdtOptions;
  uiOptions: UiOptions;
  uiParams: Params;
  cmdArgs: string[];
};

export type BuiltinResult = {
  skipPrompt?: boolean;
  value: number;
};

export type BuiltinCallback = (
  args: BuiltinArguments<Params>,
) => Promise<BuiltinResult>;

export class Ui extends BaseUi<Params> {
  #bufNr = -1;
  #oldCwd = "";
  #cwd = "";
  #prompt = "";
  #pty: Pty | null = null;

  override async redraw(args: {
    denops: Denops;
    context: Context;
    options: DdtOptions;
    uiOptions: UiOptions;
    uiParams: Params;
  }): Promise<void> {
    const cwd = args.uiParams.cwd === ""
      ? await fn.getcwd(args.denops)
      : args.uiParams.cwd;
    const stat = await safeStat(cwd);
    if (!stat || !stat.isDirectory) {
      // TODO: Create the directory.
      const result = await fn.confirm(
        args.denops,
        `${cwd} is not directory.  Create?`,
        "&Yes\n&No\n&Cancel",
      );
      if (result != 1) {
        return;
      }

      await fn.mkdir(args.denops, cwd, "p");
    }

    this.#cwd = cwd;

    const uiParams = await this.#resolveParams(
      args.denops,
      args.uiParams,
      args.context,
    );

    if (await fn.bufexists(args.denops, this.#bufNr)) {
      await this.#switchBuffer(args.denops, uiParams, cwd);
    } else {
      await this.#newBuffer(args.denops, args.options, uiParams);
    }

    await this.#initVariables(
      args.denops,
      args.options.name,
      cwd,
      args.uiParams.promptPattern,
    );
  }

  override async getInput(args: {
    denops: Denops;
    uiParams: Params;
  }): Promise<string> {
    if (
      args.uiParams.promptPattern === "" ||
      await fn.bufnr(args.denops, "%") != this.#bufNr
    ) {
      return "";
    }

    const commandLine = await getCommandLine(
      args.denops,
      args.uiParams.promptPattern,
      this.#prompt,
    );

    const col = await fn.col(args.denops, ".");
    const mode = await fn.mode(args.denops);

    return commandLine.slice(0, mode == "n" ? col - 2 : col - 3);
  }

  override actions: UiActions<Params> = {
    cd: {
      description: "Change current directory",
      callback: async (args: {
        denops: Denops;
        options: DdtOptions;
        uiParams: Params;
        actionParams: BaseParams;
      }) => {
        if (await fn.bufnr(args.denops, "%") != this.#bufNr) {
          return;
        }

        const params = args.actionParams as CdParams;

        await this.#newCdPrompt(args.denops, args.uiParams, params.directory);
        await this.#cd(args.denops, args.uiParams, params.directory);
      },
    },
    executeLine: {
      description: "Execute the command line",
      callback: async (args: {
        denops: Denops;
        options: DdtOptions;
        uiOptions: UiOptions;
        uiParams: Params;
      }) => {
        if (
          args.uiParams.promptPattern === "" ||
          await fn.bufnr(args.denops, "%") != this.#bufNr
        ) {
          return;
        }

        let commandLine = await getCommandLine(
          args.denops,
          args.uiParams.promptPattern,
          this.#prompt,
        );

        if (commandLine.length === 0) {
          // Check <cfile> is directory.
          const expandedCfile = await expandDirectory(
            args.denops,
            this.#cwd,
            await fn.expand(args.denops, "<cfile>") as string,
          );

          if (expandedCfile) {
            commandLine = expandedCfile;
          }
        }

        if (
          await fn.line(args.denops, ".") !== await fn.line(args.denops, "$")
        ) {
          // History execution.
          await this.#newPrompt(args.denops, args.uiParams, commandLine);
        }

        await this.#execute(
          args.denops,
          args.options,
          args.uiOptions,
          args.uiParams,
          commandLine,
        );
      },
    },
    insert: {
      description: "Insert the string to shell",
      callback: async (args: {
        denops: Denops;
        options: DdtOptions;
        uiOptions: UiOptions;
        uiParams: Params;
        actionParams: BaseParams;
      }) => {
        const params = args.actionParams as SendParams;

        if (!this.#pty) {
          await this.#newPrompt(args.denops, args.uiParams, params.str);
        } else {
          this.#pty.write(params.str);
        }
      },
    },
    nextPrompt: {
      description: "Move to the next prompt from cursor",
      callback: async (args: {
        denops: Denops;
        options: DdtOptions;
        uiParams: Params;
        actionParams: BaseParams;
      }) => {
        if (
          args.uiParams.promptPattern === "" ||
          await fn.bufnr(args.denops, "%") != this.#bufNr
        ) {
          return;
        }

        await searchPrompt(
          args.denops,
          args.uiParams.promptPattern,
          "Wn",
        );
      },
    },
    pastePrompt: {
      description: "Paste the history to the command line",
      callback: async (args: {
        denops: Denops;
        options: DdtOptions;
        uiParams: Params;
      }) => {
        if (
          args.uiParams.promptPattern === "" ||
          await fn.bufnr(args.denops, "%") != this.#bufNr
        ) {
          return;
        }

        const commandLine = await getCommandLine(
          args.denops,
          args.uiParams.promptPattern,
          this.#prompt,
        );

        await this.#newPrompt(args.denops, args.uiParams, commandLine);
      },
    },
    previousPrompt: {
      description: "Move to the previous prompt from cursor",
      callback: async (args: {
        denops: Denops;
        options: DdtOptions;
        uiParams: Params;
        actionParams: BaseParams;
      }) => {
        if (
          args.uiParams.promptPattern === "" ||
          await fn.bufnr(args.denops, "%") != this.#bufNr
        ) {
          return;
        }

        await searchPrompt(
          args.denops,
          args.uiParams.promptPattern,
          "bWn",
        );
      },
    },
    redraw: {
      description: "Redraw the UI prompt",
      callback: async (args: {
        denops: Denops;
        options: DdtOptions;
        uiParams: Params;
      }) => {
        if (await fn.bufnr(args.denops, "%") != this.#bufNr) {
          return;
        }

        const lastLine = await fn.getbufoneline(args.denops, this.#bufNr, "$");
        if (lastLine === args.uiParams.prompt + " ") {
          // Redraw the prompt
          await this.#newPrompt(args.denops, args.uiParams);
        }
      },
    },
    send: {
      description: "Send and execute the string to shell",
      callback: async (args: {
        denops: Denops;
        options: DdtOptions;
        uiOptions: UiOptions;
        uiParams: Params;
        actionParams: BaseParams;
      }) => {
        const params = args.actionParams as SendParams;

        if (!this.#pty) {
          await this.#newPrompt(args.denops, args.uiParams, params.str);
        }

        await this.#execute(
          args.denops,
          args.options,
          args.uiOptions,
          args.uiParams,
          params.str,
        );
      },
    },
    terminate: {
      description: "Terminate the current command",
      callback: async (args: {
        denops: Denops;
        options: DdtOptions;
        uiParams: Params;
      }) => {
        if (await fn.bufnr(args.denops, "%") != this.#bufNr) {
          return;
        }

        if (this.#pty) {
          this.#pty.close();
          this.#pty = null;
        } else {
          await this.#newPrompt(args.denops, args.uiParams);
        }
      },
    },
  };

  override params(): Params {
    return {
      aliases: {},
      ansiColorHighlights: {},
      cwd: "",
      exprParams: [
        "winCol",
        "winRow",
        "winHeight",
        "winWidth",
      ],
      floatingBorder: "",
      noSaveHistoryCommands: [],
      passwordPattern: "(Enter |Repeat |[Oo]ld |[Nn]ew |login " +
        "|Kerberos |EncFS |CVS |UNIX | SMB |LDAP |\\[sudo\\] )" +
        "([Pp]assword|[Pp]assphrase)",
      prompt: "%",
      promptHighlight: "Identifier",
      promptPattern: "% ",
      shellHistoryMax: 500,
      shellHistoryPath: "",
      split: "",
      startInsert: false,
      toggle: false,
      userPrompt: "",
      userPromptHighlight: "Special",
      userPromptPattern: "| .*",
      winCol: "(&columns - eval(uiParams.winWidth)) / 2",
      winHeight: 20,
      winRow: "&lines / 2 - 10",
      winWidth: "&columns / 2",
    };
  }

  #builtins: Record<string, BuiltinCommand> = {
    cd: {
      description: "Change current directory",
      callback: async (args: {
        denops: Denops;
        options: DdtOptions;
        uiParams: Params;
        cmdArgs: string[];
      }) => {
        await this.#cd(
          args.denops,
          args.uiParams,
          args.cmdArgs.length > 0
            ? args.cmdArgs[0]
            : Deno.env.get("HOME") ?? "",
        );

        return {
          value: 0,
        };
      },
    },
    history: {
      description: "Print current history list",
      callback: async (args: {
        denops: Denops;
        options: DdtOptions;
        uiParams: Params;
        cmdArgs: string[];
      }) => {
        for await (
          const history of await getHistory(args.denops, args.uiParams)
        ) {
          await fn.append(args.denops, "$", history);
        }

        return {
          value: 0,
        };
      },
    },
    vim: {
      description: "Edit the file",
      callback: async (args: {
        denops: Denops;
        options: DdtOptions;
        uiParams: Params;
        cmdArgs: string[];
      }) => {
        if (args.cmdArgs.length === 0) {
          return {
            value: 0,
          };
        }

        // Print prompt before edit.
        await this.#newPrompt(args.denops, args.uiParams);

        const abspath = isAbsolute(args.cmdArgs[0])
          ? args.cmdArgs[0]
          : resolve(join(this.#cwd, args.cmdArgs[0]));
        await args.denops.cmd(
          `edit ${await fn.fnameescape(args.denops, abspath)}`,
        );

        await args.denops.cmd("stopinsert");

        return {
          skipPrompt: true,
          value: 0,
        };
      },
    },
  };

  async #switchBuffer(denops: Denops, params: Params, newCwd: string) {
    await denops.call("ddt#ui#shell#_split", params);

    await denops.cmd(`buffer ${this.#bufNr}`);

    const lastLine = await fn.getbufoneline(denops, this.#bufNr, "$");
    if (this.#cwd !== "" && newCwd !== this.#cwd) {
      // Current directory is changed
      await this.#newCdPrompt(denops, params, newCwd);
      await this.#cd(denops, params, newCwd);
    } else if (lastLine === params.prompt + " ") {
      // Redraw the prompt
      await this.#newPrompt(denops, params);
    }
  }

  async #newBuffer(denops: Denops, options: DdtOptions, params: Params) {
    if (params.prompt.length === 0) {
      printError(denops, "prompt param must be set.");
      return;
    }

    if (params.promptPattern.length === 0) {
      printError(denops, "promptPattern param must be set.");
      return;
    }

    await denops.call("ddt#ui#shell#_split", params);

    const prevBufnr = await fn.bufnr(denops);

    const bufferName = `ddt-shell-${options.name}`;
    this.#bufNr = await fn.bufadd(denops, bufferName);

    await denops.cmd(`buffer ${this.#bufNr}`);

    const removeCurrentBuffer = params.split.length === 0 &&
      (await fn.bufname(denops, prevBufnr)).length === 0 &&
      await fn.bufexists(denops, prevBufnr) &&
      (await fn.getbufvar(denops, prevBufnr, "&modified")) === 0;

    // Remove current buffer when empty buffer.
    if (removeCurrentBuffer) {
      await denops.cmd(`silent! bwipeout! ${prevBufnr}`);
    }

    if (params.startInsert) {
      await denops.cmd("startinsert");
    }

    await this.#initOptions(denops);

    await autocmd.group(
      denops,
      "ddt-shell",
      (helper: autocmd.GroupHelper) => {
        helper.define(
          "CursorMovedI,TextChangedI,TextChangedP,InsertEnter",
          "<buffer>",
          "call ddt#ui#shell#_check_prompt()",
        );
      },
    );

    await this.#newPrompt(denops, params);
  }

  async #newPrompt(denops: Denops, params: Params, commandLine: string = "") {
    if (this.#pty) {
      this.#pty.close();
      this.#pty = null;
    }

    await this.#updatePrompt(denops, params.prompt + " ");

    let promptLines: string[] = [];
    const userPrompts = params.userPrompt.length !== 0
      ? (await denops.eval(params.userPrompt) as string).split("\n")
      : [];
    promptLines = promptLines.concat(userPrompts);
    promptLines.push(`${params.prompt} ${commandLine}`);

    const lastLine = await fn.getbufoneline(denops, this.#bufNr, "$");
    if (lastLine === params.prompt + " ") {
      const userPromptPos = await searchUserPrompt(
        denops,
        params.userPromptPattern,
        (await fn.getbufline(denops, this.#bufNr, 1, "$")).length - 1,
      );

      if (userPromptPos > 0) {
        // Remove previous userPrompt
        await fn.deletebufline(
          denops,
          this.#bufNr,
          userPromptPos + 1,
          "$",
        );
      }
    }

    if (lastLine.length === 0 || lastLine === params.prompt + " ") {
      // Overwrite current prompt
      await fn.setbufline(denops, this.#bufNr, "$", promptLines);
    } else {
      await fn.appendbufline(denops, this.#bufNr, "$", promptLines);
    }

    await fn.setbufvar(denops, this.#bufNr, "&modified", false);

    // Highlight prompts
    const promises = [];
    const promptLineNr =
      (await fn.getbufline(denops, this.#bufNr, 1, "$")).length;
    let userPromptLine = promptLineNr - 1;
    for (const _userPrompt of userPrompts) {
      promises.push(
        denops.call(
          "ddt#ui#shell#_highlight",
          params.userPromptHighlight,
          "userPrompt",
          1,
          this.#bufNr,
          userPromptLine,
          1,
          0,
        ),
      );

      userPromptLine -= 1;
    }
    promises.push(
      denops.call(
        "ddt#ui#shell#_highlight",
        params.promptHighlight,
        "prompt",
        1,
        this.#bufNr,
        promptLineNr,
        1,
        params.prompt.length,
      ),
    );

    await Promise.all(promises);

    await this.#moveCursorLast(denops);
  }

  async #updatePrompt(denops: Denops, prompt: string) {
    this.#prompt = prompt;
    await vars.b.set(denops, "ddt_ui_shell_prompt", prompt);
  }

  async #moveCursorLast(denops: Denops) {
    await fn.cursor(
      denops,
      await fn.line(denops, "$"),
      1,
    );

    await fn.cursor(
      denops,
      0,
      await fn.col(denops, "$") + 1,
    );
  }

  async #winId(denops: Denops): Promise<number> {
    const winIds = await fn.win_findbuf(denops, this.#bufNr) as number[];
    return winIds.length > 0 ? winIds[0] : -1;
  }

  async #initOptions(denops: Denops) {
    const winid = await this.#winId(denops);
    const existsStatusColumn = await fn.exists(denops, "+statuscolumn");

    await batch(denops, async (denops: Denops) => {
      // Set options
      await fn.setwinvar(denops, winid, "&list", 0);
      await fn.setwinvar(denops, winid, "&foldenable", 0);
      await fn.setwinvar(denops, winid, "&number", 0);
      await fn.setwinvar(denops, winid, "&relativenumber", 0);
      await fn.setwinvar(denops, winid, "&spell", 0);
      await fn.setwinvar(denops, winid, "&wrap", 0);
      await fn.setwinvar(denops, winid, "&colorcolumn", "");
      await fn.setwinvar(denops, winid, "&foldcolumn", 0);
      await fn.setwinvar(denops, winid, "&signcolumn", "no");
      if (existsStatusColumn) {
        await fn.setwinvar(denops, winid, "&statuscolumn", "");
      }

      await fn.setbufvar(denops, this.#bufNr, "&buftype", "nofile");
      await fn.setbufvar(denops, this.#bufNr, "&bufhidden", "hide");
      await fn.setbufvar(denops, this.#bufNr, "&swapfile", 0);
      await fn.setbufvar(denops, this.#bufNr, "&modified", false);
    });

    await fn.setbufvar(denops, this.#bufNr, "&filetype", "ddt-shell");
  }

  async #initVariables(
    denops: Denops,
    name: string,
    cwd: string,
    promptPattern: string,
  ) {
    await vars.b.set(denops, "ddt_ui_name", name);
    await vars.b.set(denops, "ddt_ui_shell_prompt_pattern", promptPattern);

    await vars.t.set(denops, "ddt_ui_last_bufnr", this.#bufNr);
    await vars.t.set(denops, "ddt_ui_last_directory", cwd);
    await vars.t.set(denops, "ddt_ui_shell_last_name", name);

    await vars.g.set(
      denops,
      "ddt_ui_last_winid",
      await fn.win_getid(denops),
    );
  }

  async #resolveParams(
    denops: Denops,
    uiParams: Params,
    context: Record<string, unknown>,
  ): Promise<Params> {
    const defaults = this.params();

    context = {
      uiParams,
      ...context,
    };

    const params = Object.assign(uiParams);
    for (const name of uiParams.exprParams) {
      if (name in uiParams) {
        params[name] = await evalExprParam(
          denops,
          name,
          params[name],
          defaults[name],
          context,
        );
      } else {
        await printError(
          denops,
          `Invalid expr param: ${name}`,
        );
      }
    }

    return params;
  }

  async #cd(denops: Denops, params: Params, directory: string) {
    const abspath = directory.length === 0
      ? Deno.env.get("HOME") ?? ""
      : directory === "-"
      ? this.#oldCwd
      : isAbsolute(directory)
      ? directory
      : resolve(join(this.#cwd, directory));
    const stat = await safeStat(abspath);
    if (!stat || !stat.isDirectory) {
      printError(denops, `${directory} is not directory.`);
      return;
    }

    this.#oldCwd = this.#cwd;

    await vars.t.set(
      denops,
      "ddt_ui_last_directory",
      abspath,
    );
    this.#cwd = abspath;

    await fn.chdir(denops, this.#cwd);

    await this.#newPrompt(denops, params);
  }

  async #newCdPrompt(denops: Denops, params: Params, directory: string) {
    const quote = await fn.has(denops, "win32") ? '"' : "'";
    const commandLine = `cd ${quote}${directory}${quote}`;
    await this.#newPrompt(denops, params, commandLine);

    await appendHistory(denops, params, commandLine);
  }

  async #execute(
    denops: Denops,
    options: DdtOptions,
    uiOptions: UiOptions,
    uiParams: Params,
    commandLine: string,
  ) {
    if (!this.#pty) {
      if (commandLine.length === 0) {
        return;
      }

      let [cmd, ...cmdArgs] = await parseCommandLine(
        this.#cwd,
        commandLine,
      );

      if (uiParams.aliases[cmd]) {
        // TODO: More improved parse.
        [cmd, ...cmdArgs] = await parseCommandLine(
          this.#cwd,
          commandLine.replace(cmd, uiParams.aliases[cmd]),
        );
      }

      if (!uiParams.noSaveHistoryCommands.includes(cmd)) {
        await appendHistory(denops, uiParams, commandLine);
      }

      // Builtin commands
      if (this.#builtins[cmd]) {
        const result = await this.#builtins[cmd].callback({
          denops,
          options,
          uiOptions,
          uiParams,
          cmdArgs,
        });

        const skipPrompt = result.skipPrompt ?? false;
        if (!skipPrompt) {
          await this.#newPrompt(denops, uiParams);
        }

        return;
      }

      // cmd is Directory?
      const expandedCmd = await expandDirectory(denops, this.#cwd, commandLine);
      if (expandedCmd) {
        await this.#cd(denops, uiParams, expandedCmd);
        return;
      }

      const env = {
        ...(await fn.environ(denops) as Record<string, string>),
        GIT_PAGER: "cat",
        MANPAGER: "cat",
        PAGER: "cat",
        TERM: "xterm",
      };

      this.#pty = new Pty(cmd, {
        args: cmdArgs,
        env,
        cwd: this.#cwd,
      });

      await this.#moveCursorLast(denops);

      const passwordRegex = new RegExp(uiParams.passwordPattern);

      let currentLineNr =
        (await fn.getbufline(denops, this.#bufNr, 1, "$")).length;

      const promptLineNr = currentLineNr;

      for await (const data of this.#pty.readable) {
        for (
          const line of data.split(/\r|\n/).filter((str) => str.length > 0)
        ) {
          await fn.appendbufline(
            denops,
            this.#bufNr,
            "$",
            "",
          );

          const [trimmed, annotations] = trimAndParse(line);

          currentLineNr += 1;
          let currentCol = 1;
          let currentText = await fn.getbufoneline(denops, this.#bufNr, "$");

          type CurrentHighlight = {
            highlight: string;
            name: string;
            priority: number;
          };

          type ANSIHighlight = {
            highlight: string;
            name: string;
            priority: number;
            col: number;
            length: number;
          };

          const currentHighlights: CurrentHighlight[] = [];
          const ansiHighlights: ANSIHighlight[] = [];

          let overwrite = false;

          for (const annotation of transformAnnotations(trimmed, annotations)) {
            //console.log(annotation);

            const foreground = annotation.csi?.sgr?.foreground;
            const background = annotation.csi?.sgr?.background;
            const italic = annotation.csi?.sgr?.italic;
            const bold = annotation.csi?.sgr?.bold;
            const underline = annotation.csi?.sgr?.underline;

            if (
              (is.Number(annotation.csi?.cha) && annotation.csi?.cha === 0) ||
              (is.Number(annotation.csi?.el) && annotation.csi?.el >= 0) ||
              (is.Number(annotation.csi?.ed) && annotation.csi?.ed >= 0) ||
              is.String(annotation.text) && annotation.text.match(/\s\d+%/)
            ) {
              // Overwrite current line
              overwrite = true;
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
                currentText = annotation.text;
              } else {
                currentText += annotation.text;
              }

              // Add highlights
              for (const highlight of currentHighlights) {
                ansiHighlights.push({
                  ...highlight,
                  col: currentCol,
                  length: annotation.text.length,
                });
              }

              currentCol = currentText.length + 1;
            }
          }

          await batch(denops, async (denops: Denops) => {
            if (overwrite && currentLineNr > promptLineNr + 1) {
              // Remove previous line
              await fn.deletebufline(
                denops,
                this.#bufNr,
                currentLineNr,
              );
              currentLineNr -= 1;
            }

            await fn.setbufline(
              denops,
              this.#bufNr,
              currentLineNr,
              currentText,
            );

            for (const highlight of ansiHighlights) {
              await denops.call(
                "ddt#ui#shell#_highlight",
                highlight.highlight,
                highlight.name,
                highlight.priority,
                this.#bufNr,
                currentLineNr,
                highlight.col,
                highlight.length,
              );
            }
          });

          this.#updatePrompt(denops, currentText);
        }

        if (passwordRegex.exec(data)) {
          // NOTE: Move the cursor to make the output more visible.
          await denops.cmd("normal! zz");

          const secret = await fn.inputsecret(denops, "Password: ");
          if (secret.length > 0) {
            this.#pty.write(`${secret}\n`);
          }
        } else if (await fn.bufnr(denops) === this.#bufNr) {
          // NOTE: Move the cursor to view output.
          await fn.cursor(
            denops,
            await fn.line(denops, "$"),
            await fn.col(denops, "$"),
          );
        } else {
          // NOTE: It is not ddt-ui-shell buffer.
          await denops.cmd("stopinsert");
        }
      }

      if (this.#pty) {
        this.#pty.close();
        this.#pty = null;
      }

      await this.#newPrompt(denops, uiParams);
    } else {
      this.#pty.write(`${commandLine}\n`);
    }
  }
}

async function evalExprParam(
  denops: Denops,
  name: string,
  expr: string | unknown,
  defaultExpr: string | unknown,
  context: Record<string, unknown>,
): Promise<unknown> {
  if (!is.String(expr)) {
    return expr;
  }

  try {
    return await denops.eval(expr, context);
  } catch (e) {
    await printError(
      denops,
      e,
      `[ddt-ui-shell] invalid expression in option: ${name}`,
    );

    // Fallback to default param.
    return is.String(defaultExpr)
      ? await denops.eval(defaultExpr, context)
      : defaultExpr;
  }
}

async function searchPrompt(
  denops: Denops,
  promptPattern: string,
  flags: string,
) {
  await fn.cursor(denops, 0, 1);
  const pattern = `^\\%(${promptPattern}\\m\\).\\?`;
  const pos = await fn.searchpos(denops, pattern, flags) as number[];
  if (pos[0] == 0) {
    return;
  }

  const col = await fn.matchend(
    denops,
    await fn.getline(denops, pos[0]),
    pattern,
  );
  await fn.cursor(
    denops,
    pos[0],
    col,
  );
}

async function searchUserPrompt(
  denops: Denops,
  promptPattern: string,
  start: number,
): Promise<number> {
  const userPromptPattern = `^${promptPattern}`;

  let result = -1;
  let check = start;
  while (check > 0) {
    const checkLine = await fn.getline(denops, check);

    if (await fn.match(denops, checkLine, userPromptPattern) < 0) {
      break;
    }

    result = check;
    check -= 1;
  }

  return result;
}

async function getCommandLine(
  denops: Denops,
  promptPattern: string,
  lastPrompt: string,
  lineNr: "." | number = ".",
) {
  const currentLine = await fn.getline(denops, lineNr);
  if (
    !currentLine.match(promptPattern) &&
    await fn.line(denops, ".") !== await fn.line(denops, "$")
  ) {
    return "";
  }

  const substitute = await fn.substitute(
    denops,
    currentLine,
    promptPattern,
    "",
    "",
  );
  return currentLine === substitute
    ? currentLine.slice(lastPrompt.length)
    : substitute;
}

async function parseCommandLine(
  cwd: string,
  input: string,
): Promise<string[]> {
  let result: string[] = [];
  for (const arg of splitArgs(input)) {
    result = result.concat(await expandArg(cwd, arg));
  }
  return result;
}

function splitArgs(input: string): string[] {
  // Use a regular expression to split the input string by spaces, handling
  // quotes
  // TODO: use monarch instead.
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/gi;
  const result: string[] = [];

  let match = regex.exec(input);
  while (match) {
    result.push(match[1] ?? match[2] ?? match[0]);
    match = regex.exec(input);
  }

  return result;
}

async function expandArg(
  cwd: string,
  arg: string,
): Promise<string[]> {
  let expanded = "";

  for (const c of arg) {
    if (expanded.length === 0 && c === "~") {
      // Replace home directory
      expanded += Deno.env.get("HOME");
    } else {
      expanded += c;
    }
  }

  if (
    expanded.includes("*") || expanded.includes("?") || expanded.includes("[")
  ) {
    const glob = await Array.fromAsync(expandGlob(expanded, { root: cwd }));
    if (glob.length > 0) {
      return glob.map((entry) =>
        cwd === entry.path ? entry.path : relative(cwd, entry.path)
      );
    }
  }

  return [expanded];
}

async function getHistory(denops: Denops, params: Params): Promise<string[]> {
  if (params.shellHistoryPath.length === 0) {
    return [];
  }

  const stat = await safeStat(params.shellHistoryPath);
  if (!stat) {
    return [];
  }

  try {
    const content = await Deno.readTextFile(params.shellHistoryPath);
    const lines = content.split("\n").filter((line: string) =>
      line.trim() !== ""
    );

    // Remove duplicated lines
    return lines.filter((line, index, array) => {
      return index === 0 || line !== array[index - 1];
    });
  } catch (error) {
    printError(denops, "Error reading history file:", error);
    return [];
  }
}

async function appendHistory(
  denops: Denops,
  params: Params,
  commandLine: string,
) {
  try {
    let history = await getHistory(denops, params);
    history.push(commandLine);
    history = history.slice(-params.shellHistoryMax);
    await Deno.writeTextFile(params.shellHistoryPath, history.join("\n"));
  } catch (error) {
    printError(denops, "Error reading history file:", error);
    throw error;
  }
}

async function expandDirectory(
  denops: Denops,
  cwd: string,
  path: string,
): Promise<string | null> {
  const expandedPath = await fn.expand(denops, path) as string;
  const isAbs = isAbsolute(expandedPath);
  if (
    isAbs || path.startsWith("./") || path.startsWith("..") ||
    path.endsWith("/")
  ) {
    const dirPath = isAbs ? expandedPath : resolve(join(cwd, path));
    const stat = await safeStat(dirPath);
    if (stat && stat.isDirectory) {
      return dirPath;
    }
  }

  return null;
}

function* transformAnnotations(trimmed: string, annotations: Annotation[]) {
  let offset = 0;
  for (const annotation of annotations) {
    if (offset < annotation.offset) {
      yield { text: trimmed.slice(offset, annotation.offset) };
      offset = annotation.offset;
    }
    yield {
      raw: annotation.raw,
      csi: annotation.csi,
    };
  }
  if (offset < trimmed.length) {
    yield { text: trimmed.slice(offset) };
  }
}

Deno.test("splitArgs should split a simple command", () => {
  assertEquals(splitArgs("ls -la"), ["ls", "-la"]);
});

Deno.test("splitArgs should handle double quotes", () => {
  assertEquals(splitArgs('echo "Hello World"'), ["echo", "Hello World"]);
});

Deno.test("splitArgs should handle single quotes", () => {
  assertEquals(splitArgs("echo 'Hello World'"), ["echo", "Hello World"]);
});

Deno.test("splitArgs should handle multiple spaces", () => {
  assertEquals(splitArgs("  ls    -la   "), ["ls", "-la"]);
});

Deno.test("splitArgs should handle empty input", () => {
  assertEquals(splitArgs(""), []);
});

Deno.test("transformAnnotations()", () => {
  const [trimmed, annotations] = trimAndParse(
    "Hello\x1b[2KWorld\x1b[2KGoodbye",
  );

  assertEquals(trimmed, "HelloWorldGoodbye");
  assertEquals(annotations, [
    { offset: 5, raw: "\x1b[2K", csi: { el: 2 } },
    { offset: 10, raw: "\x1b[2K", csi: { el: 2 } },
  ]);

  assertEquals(Array.from(transformAnnotations(trimmed, annotations)), [
    { text: "Hello" },
    {
      csi: { el: 2 },
      raw: "\x1b[2K",
    },
    { text: "World" },
    {
      csi: { el: 2 },
      raw: "\x1b[2K",
    },
    { text: "Goodbye" },
  ]);
});
