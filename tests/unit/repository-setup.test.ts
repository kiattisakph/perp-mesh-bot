import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("repository setup", () => {
  it("runs a placeholder test", () => {
    expect(true).toBe(true);
  });

  it("gitignores .env", () => {
    const gitignore = readFileSync(".gitignore", "utf8");
    const lines = gitignore.split(/\r?\n/).map((line) => line.trim());
    expect(lines).toContain(".env");
  });

  it("has no LICENSE file", () => {
    expect(existsSync("LICENSE")).toBe(false);
    expect(existsSync("LICENSE.md")).toBe(false);
  });

  it("does not declare a package license field", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      license?: string;
    };
    expect(pkg.license).toBeUndefined();
  });

  it("keeps example Binance credentials empty", () => {
    const example = readFileSync(".env.example", "utf8");
    expect(example).toMatch(/^BINANCE_API_KEY=$/m);
    expect(example).toMatch(/^BINANCE_API_SECRET=$/m);
  });
});
