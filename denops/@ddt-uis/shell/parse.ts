import { relative } from "@std/path/relative";
import { expandGlob } from "@std/fs/expand-glob";
import { assertEquals } from "@std/assert/equals";

export async function parseCommandLine(
  cwd: string,
  input: string,
): Promise<string[]> {
  let result: string[] = [];
  for (const arg of splitArgs(input)) {
    result = [...result, ...await expandArg(cwd, arg)];
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

