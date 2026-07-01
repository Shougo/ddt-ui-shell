import { relative } from "@std/path/relative";
import { expandGlob } from "@std/fs/expand-glob";
import { assertEquals, assertThrows } from "@std/assert";

type EnvMap = Record<string, string>;
type QuoteKind = "none" | "single" | "double";
type TokenSegment = { text: string; quote: QuoteKind };
type ParsedToken = { text: string; segments: TokenSegment[] };
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VARIABLE_START_CHAR = /^[A-Za-z_]$/;
const VARIABLE_CHAR = /^[A-Za-z0-9_]$/;

export async function parseCommandLine(
  cwd: string,
  input: string,
): Promise<string[]> {
  const { args } = await parseCommandLineWithEnv(cwd, input);
  return args;
}

export async function parseCommandLineWithEnv(
  cwd: string,
  input: string,
): Promise<{ env: EnvMap; args: string[] }> {
  const tokens = parseTokens(input);
  const env: EnvMap = {};

  let i = 0;
  for (; i < tokens.length; i++) {
    const tok = tokens[i].text;

    const m = tok.match(/^\$?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
    if (!m) break;

    const key = m[1];
    let val = m[2];

    if (val === "" && i + 1 < tokens.length) {
      i++;
      val = tokens[i].text;
    } else {
      while (val.endsWith("\\") && i + 1 < tokens.length) {
        i++;

        val += " " + tokens[i].text;
      }
    }

    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      const quote = val[0];
      val = val.slice(1, -1);
      if (quote === '"') {
        val = val.replace(/\\(["\\$`nrt])/g, (_m, ch) => {
          switch (ch) {
            case "n":
              return "\n";
            case "r":
              return "\r";
            case "t":
              return "\t";
            default:
              return ch;
          }
        });
      } else {
        val = val.replace(/\\(')/g, "$1");
      }
    } else {
      val = val.replace(/\\([ \t\\])/g, "$1");
    }

    env[key] = val;
  }

  const remaining = tokens.slice(i);
  const resultArgs: string[] = [];
  for (const arg of remaining) {
    const expanded = await expandArg(cwd, arg, env);
    resultArgs.push(...expanded);
  }

  return { env, args: resultArgs };
}

export class ParseError extends Error {
  constructor(message: string, public position: number) {
    super(message);
    this.name = "ParseError";
  }
}

type State =
  | "NORMAL"
  | "IN_DOUBLE_QUOTE"
  | "IN_SINGLE_QUOTE"
  | "ESCAPED_NORMAL"
  | "ESCAPED_DOUBLE_QUOTE"
  | "ESCAPED_SINGLE_QUOTE";

export function splitArgs(input: string): string[] {
  return parseTokens(input).map((token) => token.text);
}

function parseTokens(input: string): ParsedToken[] {
  const result: ParsedToken[] = [];
  let segments: TokenSegment[] = [];
  let buffer = "";
  let inToken = false;
  let state: State = "NORMAL";
  let quoteStart = -1;
  let currentQuote: QuoteKind = "none";
  let forceSegment = false;

  const flushSegment = () => {
    if (buffer !== "" || forceSegment) {
      segments.push({ text: buffer, quote: currentQuote });
      buffer = "";
      forceSegment = false;
    }
  };

  const pushToken = () => {
    flushSegment();
    result.push({
      text: segments.map((segment) => segment.text).join(""),
      segments: [...segments],
    });
    segments = [];
    currentQuote = "none";
    buffer = "";
    forceSegment = false;
    inToken = false;
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i];

    switch (state) {
      case "NORMAL":
        if (c === '"') {
          flushSegment();
          currentQuote = "double";
          forceSegment = true;
          state = "IN_DOUBLE_QUOTE";
          quoteStart = i;
          inToken = true;
        } else if (c === "'") {
          flushSegment();
          currentQuote = "single";
          forceSegment = true;
          state = "IN_SINGLE_QUOTE";
          quoteStart = i;
          inToken = true;
        } else if (c === "\\") {
          currentQuote = "none";
          state = "ESCAPED_NORMAL";
          inToken = true;
        } else if (c === " " || c === "\t") {
          if (inToken) {
            pushToken();
          }
        } else {
          if (currentQuote !== "none") {
            flushSegment();
            currentQuote = "none";
          }
          buffer += c;
          inToken = true;
        }
        break;

      case "IN_DOUBLE_QUOTE":
        if (c === '"') {
          flushSegment();
          currentQuote = "none";
          state = "NORMAL";
        } else if (c === "\\") {
          state = "ESCAPED_DOUBLE_QUOTE";
        } else {
          buffer += c;
        }
        break;

      case "IN_SINGLE_QUOTE":
        if (c === "'") {
          flushSegment();
          currentQuote = "none";
          state = "NORMAL";
        } else if (c === "\\") {
          state = "ESCAPED_SINGLE_QUOTE";
        } else {
          buffer += c;
        }
        break;

      case "ESCAPED_NORMAL":
        if (c === "\n") {
          // line continuation - discard newline
        } else if (c === "t") {
          buffer += "\t";
        } else {
          buffer += c;
        }
        state = "NORMAL";
        break;

      case "ESCAPED_DOUBLE_QUOTE":
        switch (c) {
          case '"':
            buffer += '"';
            break;
          case "\\":
            buffer += "\\";
            break;
          case "n":
            buffer += "\n";
            break;
          case "r":
            buffer += "\r";
            break;
          case "t":
            buffer += "\t";
            break;
          default:
            buffer += c;
            break;
        }
        state = "IN_DOUBLE_QUOTE";
        break;

      case "ESCAPED_SINGLE_QUOTE":
        if (c === "'") {
          buffer += "'";
        } else {
          buffer += "\\" + c;
        }
        state = "IN_SINGLE_QUOTE";
        break;
    }
  }

  if (
    state === "IN_DOUBLE_QUOTE" ||
    state === "IN_SINGLE_QUOTE" ||
    state === "ESCAPED_DOUBLE_QUOTE" ||
    state === "ESCAPED_SINGLE_QUOTE"
  ) {
    throw new ParseError("Unclosed quote", quoteStart);
  }

  if (state === "ESCAPED_NORMAL") {
    buffer += "\\";
  }

  if (inToken) {
    pushToken();
  }

  return result;
}

async function expandArg(
  cwd: string,
  arg: ParsedToken,
  env: EnvMap,
): Promise<string[]> {
  const expandedArg = arg.segments.map((segment) =>
    segment.quote === "single"
      ? segment.text
      : expandVariables(segment.text, env)
  ).join("");
  const expanded = expandedArg.startsWith("~")
    ? (Deno.env.get("HOME") ?? "~") + expandedArg.slice(1)
    : expandedArg;

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

/**
 * Expands $VAR and ${VAR} references using parsed leading assignments first
 * and then the process environment. Invalid variable syntax is left unchanged.
 */
function expandVariables(text: string, env: EnvMap): string {
  let result = "";

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== "$") {
      result += c;
      continue;
    }

    if (i + 1 >= text.length) {
      result += c;
      continue;
    }

    if (text[i + 1] === "{") {
      const end = text.indexOf("}", i + 2);
      if (end < 0) {
        result += c;
        continue;
      }

      const name = text.slice(i + 2, end);
      if (!VARIABLE_NAME.test(name)) {
        result += text.slice(i, end + 1);
        i = end;
        continue;
      }

      result += getEnvValue(name, env);
      i = end;
      continue;
    }

    if (!VARIABLE_START_CHAR.test(text[i + 1])) {
      result += c;
      continue;
    }

    let end = i + 2;
    while (end < text.length && VARIABLE_CHAR.test(text[end])) {
      end++;
    }

    const candidate = text.slice(i + 1, end);
    const name = resolveVariableName(candidate, env);
    result += getEnvValue(name, env);
    i += name.length;
  }

  return result;
}

/**
 * Prefers an exact variable name, but can fall back from "$HOGEbar" to the
 * shorter name "HOGE" when the unresolved suffix starts with lowercase text.
 * The caller keeps scanning after the returned name, so the "bar" suffix
 * remains as literal text in the final expanded argument.
 */
function resolveVariableName(candidate: string, env: EnvMap): string {
  if (hasEnvValue(candidate, env)) {
    return candidate;
  }

  // Scan backward so the first match is the longest defined prefix.
  for (let i = candidate.length - 1; i > 0; i--) {
    const suffixChar = candidate[i];
    if (suffixChar < "a" || suffixChar > "z") {
      continue;
    }

    const name = candidate.slice(0, i);
    if (hasEnvValue(name, env)) {
      return name;
    }
  }

  return candidate;
}

function hasEnvValue(name: string, env: EnvMap): boolean {
  return Object.hasOwn(env, name) || Deno.env.get(name) !== undefined;
}

function getEnvValue(name: string, env: EnvMap): string {
  return env[name] ?? Deno.env.get(name) ?? "";
}

async function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(env)) {
    previous.set(key, Deno.env.get(key));
    if (value === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, value);
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
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

Deno.test("no leading env assignments -> env empty and args returned", async () => {
  const res = await parseCommandLineWithEnv(Deno.cwd(), "arg1 arg2");
  assertEquals(res.env, {});
  assertEquals(res.args, ["arg1", "arg2"]);
});

Deno.test("single simple assignment and remaining args", async () => {
  const res = await parseCommandLineWithEnv(
    Deno.cwd(),
    "FOO=bar echo file.txt",
  );
  assertEquals(res.env, { FOO: "bar" });
  assertEquals(res.args, ["echo", "file.txt"]);
});

Deno.test("dollar-prefixed name and quoted value with space", async () => {
  const res = await parseCommandLineWithEnv(
    Deno.cwd(),
    '$BAZ="qux quux" cmd --opt',
  );
  assertEquals(res.env, { BAZ: "qux quux" });
  assertEquals(res.args, ["cmd", "--opt"]);
});

Deno.test("escaped space in unquoted value", async () => {
  const res = await parseCommandLineWithEnv(
    Deno.cwd(),
    "FOO=foo\\ bar run",
  );
  assertEquals(res.env, { FOO: "foo bar" });
  assertEquals(res.args, ["run"]);
});

Deno.test("stop parsing envs when non-assignment token encountered", async () => {
  const res = await parseCommandLineWithEnv(Deno.cwd(), "A=1 B=2 -- cmd");
  assertEquals(res.env, { A: "1", B: "2" });
  assertEquals(res.args, ["--", "cmd"]);
});

Deno.test("glob expansion in args (integration)", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${tmp}/a.txt`, "a");
    await Deno.writeTextFile(`${tmp}/b.txt`, "b");

    const res = await parseCommandLineWithEnv(tmp, "FOO=bar ls *.txt");
    assertEquals(res.env, { FOO: "bar" });
    assertEquals(res.args[0], "ls");

    const gotFiles = res.args.slice(1).slice().sort();
    assertEquals(gotFiles, ["a.txt", "b.txt"]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("environment variable expansion in args", async () => {
  await withEnv({ DDT_UI_SHELL_TEST_HOGE: "world" }, async () => {
    const res = await parseCommandLineWithEnv(
      Deno.cwd(),
      "echo $DDT_UI_SHELL_TEST_HOGE",
    );
    assertEquals(res.env, {});
    assertEquals(res.args, ["echo", "world"]);
  });
});

Deno.test("braced environment variable expansion in args", async () => {
  await withEnv({ DDT_UI_SHELL_TEST_HOGE: "world" }, async () => {
    const res = await parseCommandLineWithEnv(
      Deno.cwd(),
      'echo "${DDT_UI_SHELL_TEST_HOGE}"',
    );
    assertEquals(res.env, {});
    assertEquals(res.args, ["echo", "world"]);
  });
});

Deno.test("single-quoted args suppress environment variable expansion", async () => {
  await withEnv({ DDT_UI_SHELL_TEST_HOGE: "world" }, async () => {
    const res = await parseCommandLineWithEnv(
      Deno.cwd(),
      "echo '$DDT_UI_SHELL_TEST_HOGE'",
    );
    assertEquals(res.env, {});
    assertEquals(res.args, ["echo", "$DDT_UI_SHELL_TEST_HOGE"]);
  });
});

Deno.test("environment variable expansion works within words", async () => {
  await withEnv({ DDT_UI_SHELL_TEST_HOGE: "world" }, async () => {
    const res = await parseCommandLineWithEnv(
      Deno.cwd(),
      "echo foo$DDT_UI_SHELL_TEST_HOGEbar",
    );
    assertEquals(res.env, {});
    assertEquals(res.args, ["echo", "fooworldbar"]);
  });
});

Deno.test("leading env assignments are visible to command arg expansion", async () => {
  await withEnv({ HOGE: "process" }, async () => {
    const res = await parseCommandLineWithEnv(
      Deno.cwd(),
      "HOGE=world echo $HOGE",
    );
    assertEquals(res.env, { HOGE: "world" });
    assertEquals(res.args, ["echo", "world"]);
  });
});

Deno.test("tilde expansion in args (integration)", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await withEnv({ HOME: tmp }, async () => {
      const res = await parseCommandLineWithEnv(Deno.cwd(), "echo ~/file.txt");
      assertEquals(res.env, {});
      assertEquals(res.args, ["echo", `${tmp}/file.txt`]);
    });
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("parseCommandLine wrapper preserves existing behaviour (env discarded)", async () => {
  const args = await parseCommandLine(Deno.cwd(), "X=1 a b");
  assertEquals(args, ["a", "b"]);
});

Deno.test("splitArgs: escaped double quotes", () => {
  assertEquals(splitArgs('echo "foo\\"bar"'), ["echo", 'foo"bar']);
});

Deno.test("splitArgs: escaped single quotes", () => {
  assertEquals(splitArgs("echo 'don\\'t'"), ["echo", "don't"]);
});

Deno.test("splitArgs: unclosed double quote", () => {
  assertThrows(
    () => splitArgs('echo "unclosed'),
    ParseError,
    "Unclosed quote",
  );
  // Trailing backslash inside double quote also counts as unclosed
  assertThrows(
    () => splitArgs('echo "foo\\'),
    ParseError,
    "Unclosed quote",
  );
});

Deno.test("splitArgs: unclosed single quote", () => {
  assertThrows(
    () => splitArgs("echo 'unclosed"),
    ParseError,
    "Unclosed quote",
  );
  // Trailing backslash inside single quote also counts as unclosed
  assertThrows(
    () => splitArgs("echo 'foo\\"),
    ParseError,
    "Unclosed quote",
  );
});

Deno.test("splitArgs: mixed quotes", () => {
  assertEquals(
    splitArgs(`echo "foo'bar" 'baz"qux'`),
    ["echo", "foo'bar", 'baz"qux'],
  );
});

Deno.test("splitArgs: consecutive backslashes", () => {
  assertEquals(splitArgs('echo "\\\\"'), ["echo", "\\"]);
  assertEquals(splitArgs('echo "\\\\\\\\"'), ["echo", "\\\\"]);
});

Deno.test("splitArgs: escaped spaces", () => {
  assertEquals(splitArgs("echo foo\\ bar"), ["echo", "foo bar"]);
});

Deno.test("splitArgs: complex escaping", () => {
  assertEquals(
    splitArgs('cmd "arg with \\"quotes\\"" \'single\\\'s\''),
    ["cmd", 'arg with "quotes"', "single's"],
  );
});

Deno.test("splitArgs: empty quotes", () => {
  assertEquals(splitArgs("echo \"\" ''"), ["echo", "", ""]);
});

Deno.test("splitArgs: escape sequences", () => {
  assertEquals(splitArgs('echo "line1\\nline2"'), ["echo", "line1\nline2"]);
  assertEquals(splitArgs('echo "tab\\there"'), ["echo", "tab\there"]);
});
