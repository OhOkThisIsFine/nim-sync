import fs from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";

describe("release automation", () => {
  it("defines a tag-driven GitHub Actions publish workflow using npm trusted publishing", async () => {
    const workflow = (await fs.readFile(
      path.join(process.cwd(), ".github", "workflows", "publish.yml"),
      "utf-8",
    )).replace(/\r\n/g, "\n");

    expect(workflow).toContain("tags:\n      - 'v*'");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("node-version: '24'");
    expect(workflow).toContain("npm ci");
    expect(workflow).toContain("npm publish");
    expect(workflow).toContain("verify-release-tag.mjs");
    expect(workflow).toContain("if: github.event_name == 'push'");
  });

  it("documents the steady-state trusted publishing flow", async () => {
    const readme = await fs.readFile(
      path.join(process.cwd(), "README.md"),
      "utf-8",
    );

    expect(readme).toContain("## Release Automation");
    expect(readme).toContain("Trusted Publisher");
    expect(readme).toContain("nim-sync");
    expect(readme).toContain("npm version patch");
    expect(readme).toContain("git push origin HEAD --follow-tags");
    expect(readme).toContain("git tag v1.0.1");
    expect(readme).toContain("git push origin v1.0.1");
    expect(readme).toContain("git remote set-url origin");
    expect(readme).toContain("Repository: `nim-sync`");
    expect(readme).toContain("already published");
    expect(readme).toContain("already configured");
    expect(readme).toContain("npm trust list nim-sync");
    expect(readme).toContain("Run workflow");
    expect(readme).toContain("validation-only");
    expect(readme).toContain("Node 22.14.0 or higher");
    expect(readme).toContain("E404");
    expect(readme).not.toContain("opencode-nim-sync");
  });

  it("captures release metadata needed for provenance and tag validation", async () => {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(process.cwd(), "package.json"), "utf-8"),
    ) as {
      name?: string;
      repository?: {
        type?: string;
        url?: string;
      };
      scripts?: Record<string, string>;
    };

    expect(packageJson.name).toBe("nim-sync");
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/OhOkThisIsFine/nim-sync.git",
    });
    expect(packageJson.scripts?.["release:check"]).toBe(
      "node scripts/verify-release-tag.mjs",
    );
  });
});
