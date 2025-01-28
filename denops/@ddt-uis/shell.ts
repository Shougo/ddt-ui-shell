import type {
  BaseParams,
  DdtOptions,
  UiOptions,
} from "jsr:@shougo/ddt-vim@~1.0.0/types";
import { BaseUi, type UiActions } from "jsr:@shougo/ddt-vim@~1.0.0/ui";
import { printError } from "jsr:@shougo/ddt-vim@~1.0.0/utils";

import type { Denops } from "jsr:@denops/std@~7.4.0";
import * as fn from "jsr:@denops/std@~7.4.0/function";
import * as vars from "jsr:@denops/std@~7.4.0/variable";
import { batch } from "jsr:@denops/std@~7.4.0/batch";
import * as autocmd from "jsr:@denops/std@~7.4.0/autocmd";

import { join } from "jsr:@std/path@~1.0.3/join";
import { resolve } from "jsr:@std/path@~1.0.3/resolve";
import { isAbsolute } from "jsr:@std/path@~1.0.2/is-absolute";
import { assertEquals } from "jsr:@std/assert@~1.0.2/equals";
import { Pty } from "jsr:@sigma/pty-ffi@~0.26.4";

export type Params = {
  cwd: string;
  floatingBorder: string;
  prompt: string;
  promptHighlight: string;
  promptPattern: string;
  shellHistoryMax: number;
  shellHistoryPath: string;
  split: string;
  startInsert: boolean;
  toggle: boolean;
  winCol: number;
  winHeight: number;
  winRow: number;
  winWidth: number;
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

export type BuiltinCallback = (
  args: BuiltinArguments<Params>,
) => Promise<number>;

export class Ui extends BaseUi<Params> {
  #bufNr = -1;
  #cwd = "";
  #prompt = "";
  #pty: Pty | null = null;

  override async redraw(args: {
    denops: Denops;
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

    if (await fn.bufexists(args.denops, this.#bufNr)) {
      await this.#switchBuffer(args.denops, args.uiParams, cwd);
    } else {
      await this.#newBuffer(args.denops, args.options, args.uiParams);
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

        const commandLine = await getCommandLine(
          args.denops,
          args.uiParams.promptPattern,
          this.#prompt,
        );

        await this.#execute(
          args.denops,
          args.options,
          args.uiOptions,
          args.uiParams,
          commandLine,
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
        if (
          await fn.bufnr(args.denops, "%") != this.#bufNr
        ) {
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
    send: {
      description: "Send the string to shell",
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
  };

  override params(): Params {
    return {
      cwd: "",
      floatingBorder: "",
      prompt: "%",
      promptHighlight: "Identifier",
      promptPattern: "",
      shellHistoryMax: 500,
      shellHistoryPath: "",
      split: "",
      startInsert: false,
      toggle: false,
      winCol: 50,
      winHeight: 15,
      winRow: 20,
      winWidth: 80,
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

        return 0;
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

        return 0;
      },
    },
  };

  async #switchBuffer(denops: Denops, params: Params, newCwd: string) {
    await denops.call("ddt#ui#shell#_split", params);

    await denops.cmd(`buffer ${this.#bufNr}`);

    // Check current directory
    if (this.#cwd !== "" && newCwd !== this.#cwd) {
      await this.#newCdPrompt(denops, params, newCwd);
      await this.#cd(denops, params, newCwd);
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

    const bufferName = `ddt-shell-${options.name}`;
    this.#bufNr = await fn.bufadd(denops, bufferName);

    await denops.cmd(`buffer ${this.#bufNr}`);

    if (params.startInsert) {
      await denops.cmd("startinsert");
    }

    await fn.matchadd(
      denops,
      params.promptHighlight,
      "^" + params.promptPattern,
    );

    await this.#initOptions(denops);

    await autocmd.group(
      denops,
      "ddt-shell",
      (helper: autocmd.GroupHelper) => {
        helper.define(
          "CursorMovedI",
          "<buffer>",
          "call ddt#ui#shell#_check_prompt()",
        );
      },
    );

    await this.#newPrompt(denops, params);
  }

  async #newPrompt(denops: Denops, params: Params, commandLine: string = "") {
    this.#prompt = `${params.prompt} ${commandLine}`;
    const promptLines = [this.#cwd, this.#prompt];
    const lastLine = await fn.getline(denops, "$");

    if (lastLine.length === 0 || lastLine === params.prompt + " ") {
      await fn.deletebufline(
        denops,
        this.#bufNr,
        await fn.line(denops, "$") - 1,
      );
      await fn.setline(denops, "$", promptLines);
    } else {
      await fn.append(denops, "$", promptLines);
    }

    await fn.setbufvar(denops, this.#bufNr, "&modified", false);

    await this.#moveCursorLast(denops);
  }

  async #moveCursorLast(denops: Denops) {
    await fn.cursor(
      denops,
      await fn.line(denops, "$"),
      0,
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

    await vars.g.set(
      denops,
      "ddt_ui_last_winid",
      await fn.win_getid(denops),
    );
  }

  async #cd(denops: Denops, params: Params, directory: string) {
    const stat = await safeStat(directory);
    if (!stat || !stat.isDirectory) {
      printError(denops, `${directory} is not directory.`);
      return;
    }

    await vars.t.set(
      denops,
      "ddt_ui_last_directory",
      directory,
    );
    this.#cwd = directory;

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
    if (commandLine.length === 0) {
      await this.#newPrompt(denops, uiParams);
      return;
    }

    await appendHistory(denops, uiParams, commandLine);

    if (!this.#pty) {
      const [cmd, ...cmdArgs] = parseCommandLine(commandLine);

      // Builtin commands
      if (this.#builtins[cmd]) {
        await this.#builtins[cmd].callback({
          denops,
          options,
          uiOptions,
          uiParams,
          cmdArgs,
        });

        await this.#newPrompt(denops, uiParams);

        return;
      }

      // cmd is Directory?
      const isAbs = isAbsolute(cmd);
      if (isAbs || cmd.startsWith("./") || cmd.startsWith("..")) {
        const dirPath = isAbs ? cmd : resolve(join(this.#cwd, cmd));
        const stat = await safeStat(dirPath);
        if (stat && stat.isDirectory) {
          // auto_cd
          await this.#cd(denops, uiParams, dirPath);
          return;
        }
      }

      this.#pty = new Pty({
        cmd,
        args: cmdArgs,
        env: [],
        cwd: this.#cwd,
      });

      while (true) {
        if (!this.#pty) {
          break;
        }

        const { data, done } = await this.#pty.read();
        if (done) {
          this.#pty.close();
          this.#pty = null;
          break;
        }

        if (data.length > 0) {
          // Replace ANSI escape sequence.
          // deno-lint-ignore no-control-regex
          const ansiEscapePattern = /\x1b\[[0-9;]*m/g;

          await fn.appendbufline(
            denops,
            this.#bufNr,
            "$",
            data.replace(ansiEscapePattern, "").split(/\r?\n/).filter((str) =>
              str.length > 0
            ),
          );

          await this.#moveCursorLast(denops);
          this.#prompt = await fn.getline(denops, "$");
        }

        await new Promise((r) => setTimeout(r, 20));
      }

      await this.#newPrompt(denops, uiParams);
    } else {
      await this.#pty.write(commandLine + "\n");
    }
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

async function getCommandLine(
  denops: Denops,
  promptPattern: string,
  lastPrompt: string,
  lineNr: string | number = ".",
) {
  const currentLine = await fn.getline(denops, lineNr);
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

function parseCommandLine(input: string): string[] {
  // Use a regular expression to split the input string by spaces, handling
  // quotes
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/gi;
  const result: string[] = [];

  let match = regex.exec(input);
  while (match) {
    result.push(expandArg(match[1] ?? match[2] ?? match[0]));
    match = regex.exec(input);
  }

  return result;
}

function expandArg(arg: string): string {
  const home = Deno.env.get("HOME");
  if (home && home !== "") {
    // Replace home directory
    arg = arg.replace(/^~/, home);
  }

  return arg;
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
    return content.split("\n").filter((line: string) => line.trim() !== "");
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

const safeStat = async (path: string): Promise<Deno.FileInfo | null> => {
  // NOTE: Deno.stat() may be failed
  try {
    const stat = await Deno.lstat(path);
    if (stat.isSymlink) {
      try {
        const stat = await Deno.stat(path);
        stat.isSymlink = true;
        return stat;
      } catch (_: unknown) {
        // Ignore stat exception
      }
    }
    return stat;
  } catch (_: unknown) {
    // Ignore stat exception
  }
  return null;
};

Deno.test("parseCommandLine should split a simple command", () => {
  assertEquals(parseCommandLine("ls -la"), ["ls", "-la"]);
});

Deno.test("parseCommandLine should handle double quotes", () => {
  assertEquals(parseCommandLine('echo "Hello World"'), ["echo", "Hello World"]);
});

Deno.test("parseCommandLine should handle single quotes", () => {
  assertEquals(parseCommandLine("echo 'Hello World'"), ["echo", "Hello World"]);
});

Deno.test("parseCommandLine should handle multiple spaces", () => {
  assertEquals(parseCommandLine("  ls    -la   "), ["ls", "-la"]);
});

Deno.test("parseCommandLine should handle empty input", () => {
  assertEquals(parseCommandLine(""), []);
});
