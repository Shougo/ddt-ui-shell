import { relative } from "@std/path/relative";
import { expandGlob } from "@std/fs/expand-glob";
import { assertEquals } from "@std/assert/equals";

type EnvMap = Record<string, string>;

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
  const tokens = splitArgs(input);
  const env: EnvMap = {};

  let i = 0;
  for (; i < tokens.length; i++) {
    const tok = tokens[i];

    const m = tok.match(/^\$?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
    if (!m) break;

    const key = m[1];
    let val = m[2];

    if (val === "" && i + 1 < tokens.length) {
      i++;
      val = tokens[i];
    } else {
      while (val.endsWith("\\") && i + 1 < tokens.length) {
        i++;

        val += " " + tokens[i];
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
  let resultArgs: string[] = [];
  for (const arg of remaining) {
    const expanded = await expandArg(cwd, arg);
    resultArgs = [...resultArgs, ...expanded];
  }

  return { env, args: resultArgs };
}

export function splitArgs(input: string): string[] {
  // Use a regular expression to split the input string by spaces, handling
  // quotes
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
      const home = Deno.env.get("HOME");
      if (home) {
        expanded += home;
      }
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

Deno.test("parseCommandLine wrapper preserves existing behaviour (env discarded)", async () => {
  const args = await parseCommandLine(Deno.cwd(), "X=1 a b");
  assertEquals(args, ["a", "b"]);
});
