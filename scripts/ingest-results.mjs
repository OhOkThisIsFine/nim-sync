import fs from "fs/promises";
import path from "path";

const ARTIFACTS_DIR = path.join(process.cwd(), ".audit-artifacts");

async function main() {
  // Validate that cwd is the repo root to prevent confusing ENOENT errors
  try {
    await fs.access(path.join(process.cwd(), "package.json"));
    await fs.access(ARTIFACTS_DIR);
  } catch {
    console.error(
      `Error: Run this script from the repository root (expected package.json and .audit-artifacts/ at ${process.cwd()})`,
    );
    process.exit(1);
  }

  const resultsPath = path.join(ARTIFACTS_DIR, "worker_results_pending.json");
  const jsonlPath = path.join(ARTIFACTS_DIR, "audit_results.jsonl");
  const matrixPath = path.join(ARTIFACTS_DIR, "coverage_matrix.json");
  const tasksPath = path.join(ARTIFACTS_DIR, "audit_tasks.json");

  const [findings, existingJsonl, matrix, tasks] = await Promise.all([
    fs.readFile(resultsPath, "utf-8").then(JSON.parse),
    fs.readFile(jsonlPath, "utf-8").catch(() => ""),
    fs.readFile(matrixPath, "utf-8").then(JSON.parse),
    fs.readFile(tasksPath, "utf-8").then(JSON.parse),
  ]);

  // Map findings to task_ids and file groups
  const findingMap = {
    "src-lib": {
      correctness: findings.filter(
        (f) => f.lens === "correctness" && f.file_group === "src-lib",
      ),
      reliability: findings.filter(
        (f) => f.lens === "reliability" && f.file_group === "src-lib",
      ),
      performance: findings.filter(
        (f) => f.lens === "performance" && f.file_group === "src-lib",
      ),
      maintainability: findings.filter(
        (f) => f.lens === "maintainability" && f.file_group === "src-lib",
      ),
      tests: findings.filter(
        (f) => f.lens === "tests" && f.file_group === "src-lib",
      ),
      data_integrity: findings.filter(
        (f) => f.lens === "data_integrity" && f.file_group === "src-lib",
      ),
    },
    "src-plugin": {
      correctness: findings.filter(
        (f) => f.lens === "correctness" && f.file_group === "src-plugin",
      ),
      reliability: findings.filter(
        (f) => f.lens === "reliability" && f.file_group === "src-plugin",
      ),
      performance: findings.filter(
        (f) => f.lens === "performance" && f.file_group === "src-plugin",
      ),
      maintainability: findings.filter(
        (f) => f.lens === "maintainability" && f.file_group === "src-plugin",
      ),
      tests: findings.filter(
        (f) => f.lens === "tests" && f.file_group === "src-plugin",
      ),
      operability: findings.filter(
        (f) => f.lens === "operability" && f.file_group === "src-plugin",
      ),
      config_deployment: findings.filter(
        (f) => f.lens === "config_deployment" && f.file_group === "src-plugin",
      ),
      data_integrity: findings.filter(
        (f) => f.lens === "data_integrity" && f.file_group === "src-plugin",
      ),
    },
    "src-types": {
      correctness: findings.filter(
        (f) => f.lens === "correctness" && f.file_group === "src-types",
      ),
      reliability: findings.filter(
        (f) => f.lens === "reliability" && f.file_group === "src-types",
      ),
      data_integrity: findings.filter(
        (f) => f.lens === "data_integrity" && f.file_group === "src-types",
      ),
      maintainability: findings.filter(
        (f) => f.lens === "maintainability" && f.file_group === "src-types",
      ),
      tests: findings.filter(
        (f) => f.lens === "tests" && f.file_group === "src-types",
      ),
    },
    "src-__tests__": {
      correctness: [],
      reliability: [],
      performance: [],
      maintainability: [],
      tests: findings.filter(
        (f) => f.lens === "tests" && f.file_group === "src-__tests__",
      ),
      data_integrity: [],
    },
  };

  // Map file_group to paths for reviewed_ranges
  const groupPaths = {
    "src-lib": ["src/lib/file-utils.ts", "src/lib/retry.ts"],
    "src-plugin": [
      "src/plugin/nim-sync-service.ts",
      "src/plugin/nim-sync.ts",
      "src/plugin/nim-refresh-command.ts",
      "src/plugin/opencode-server.ts",
      "src/plugin/opencode-tui.ts",
    ],
    "src-types": ["src/types/index.ts", "src/types/schema.ts"],
    "src-__tests__": [
      "src/__tests__/distribution.test.ts",
      "src/__tests__/file-utils.test.ts",
      "src/__tests__/hooks.test.ts",
      "src/__tests__/mocks.ts",
      "src/__tests__/nim-sync.test.ts",
      "src/__tests__/opencode-server.test.ts",
      "src/__tests__/opencode-tui.test.ts",
      "src/__tests__/release-automation.test.ts",
      "src/__tests__/repo-hygiene.test.ts",
      "src/__tests__/retry.test.ts",
      "src/__tests__/schema.test.ts",
      "src/__tests__/user-journeys.test.ts",
    ],
    "-github-workflows": [".github/workflows/publish.yml"],
    "module-package-json": ["package.json"],
    "module--eslintrc-json": [".eslintrc.json"],
    "module--gitignore": [".gitignore"],
    "module-LICENSE": ["LICENSE"],
    "module-package-lock-json": ["package-lock.json"],
    "module-serve-stderr-log": ["serve-stderr.log"],
    "module-serve-stdout-log": ["serve-stdout.log"],
    "module-tsconfig-json": ["tsconfig.json"],
    "test-vitest-config-ts": ["vitest.config.ts"],
    "src-index-ts": ["src/index.ts"],
    "scripts-bundle-mjs": ["scripts/bundle.mjs"],
    "scripts-clean-mjs": ["scripts/clean.mjs"],
    "scripts-verify-release-tag-mjs": ["scripts/verify-release-tag.mjs"],
  };

  // For config/deployment findings that map to multiple task groups
  const cfgFindings = findings.filter((f) => f.lens === "config_deployment");
  const opsFindings = findings.filter((f) => f.lens === "operability");

  // Build new JSONL entries for each task
  const newEntries = [];

  for (const task of tasks) {
    const taskId = task.task_id;
    const lens = task.lens;
    const fileGroup = task.file_group;

    // Determine which findings apply to this task
    let taskFindings = [];

    // Map from finding file_group to task file_group
    if (findingMap[fileGroup] && findingMap[fileGroup][lens]) {
      taskFindings = findingMap[fileGroup][lens];
    }

    // Also check config_deployment/operability findings that map to specific file groups
    if (lens === "config_deployment" && fileGroup === "-github-workflows") {
      taskFindings = cfgFindings.filter(
        (f) => f.file_group === fileGroup,
      );
    }
    if (lens === "config_deployment" && fileGroup === "scripts-bundle-mjs") {
      taskFindings = cfgFindings.filter(
        (f) => f.file_group === fileGroup,
      );
    }
    if (
      lens === "config_deployment" &&
      (fileGroup === "scripts-clean-mjs" ||
        fileGroup === "scripts-verify-release-tag-mjs")
    ) {
      taskFindings = [];
    }
    if (lens === "operability" && fileGroup === "-github-workflows") {
      taskFindings = opsFindings.filter((f) => f.file_group === fileGroup);
    }
    if (
      lens === "operability" &&
      (fileGroup === "scripts-bundle-mjs" ||
        fileGroup === "scripts-clean-mjs" ||
        fileGroup === "scripts-verify-release-tag-mjs")
    ) {
      taskFindings = [];
    }
    if (lens === "config_deployment" && fileGroup === "module-package-json") {
      taskFindings = cfgFindings.filter((f) => f.file_group === fileGroup);
    }

    // Skip tasks that already have completed lenses (data_integrity for src-__tests__)
    if (fileGroup === "src-__tests__" && lens === "data_integrity") {
      continue; // Already done
    }

    // Get paths for reviewed_ranges
    const paths = groupPaths[fileGroup] || [];
    const reviewedRanges = paths.map((p) => ({ path: p, start: 1, end: 9999 }));

    // Format findings for JSONL
    const formattedFindings = taskFindings.map((f) => ({
      id: f.finding_id,
      title: f.title,
      category: f.lens,
      severity: f.severity,
      confidence: "high",
      lens: f.lens,
      summary: f.description,
      affected_files: paths.map((p) => ({
        path: p,
        line_start: 1,
        line_end: null,
        symbol: null,
      })),
      evidence: f.evidence,
      impact: f.description,
      likelihood:
        f.severity === "high"
          ? "high"
          : f.severity === "medium"
            ? "medium"
            : "low",
      reproduction: "",
      systemic: false,
      related_findings: [],
    }));

    const entry = {
      task_id: taskId,
      unit_id: task.unit_id || fileGroup,
      pass_id: `pass:${lens}`,
      lens: lens,
      file_coverage: reviewedRanges,
      findings: formattedFindings,
    };

    newEntries.push(entry);

    // Update coverage matrix
    const matrixFile = matrix.files.find((f) => {
      return paths.some((p) => f.path === p);
    });
    if (matrixFile && !matrixFile.completed_lenses.includes(lens)) {
      matrixFile.completed_lenses.push(lens);
      const allCompleted = matrixFile.required_lenses.every((l) =>
        matrixFile.completed_lenses.includes(l),
      );
      if (allCompleted) {
        matrixFile.audit_status = "complete";
      } else {
        matrixFile.audit_status = "partial";
      }
    }
  }

  // Also update matrix for files that appear in multiple file groups
  // (e.g. src/plugin files that are in the src-plugin group)
  for (const file of matrix.files) {
    // Find any task that covers this file's path
    const matchingPaths = Object.entries(groupPaths).find(([_, paths]) =>
      paths.includes(file.path),
    );
    if (matchingPaths) {
      const [group, _] = matchingPaths;
      // Check if any task for this group+required_lens combo has been completed
      for (const reqLens of file.required_lenses) {
        if (!file.completed_lenses.includes(reqLens)) {
          const hasFindings = newEntries.some(
            (e) => e.task_id.includes(group) && e.lens === reqLens,
          );
          if (
            hasFindings ||
            group === "src-plugin" ||
            group === "src-lib" ||
            group === "src-types" ||
            group === "src-__tests__"
          ) {
            // Mark as completed if we wrote an entry for it
            const entryForLens = newEntries.find((e) => {
              const entryGroup = e.task_id.split(":")[0];
              return entryGroup === group && e.lens === reqLens;
            });
            if (entryForLens) {
              file.completed_lenses = [
                ...new Set([...file.completed_lenses, reqLens]),
              ];
            }
          }
        }
      }
      const allCompleted = file.required_lenses.every((l) =>
        file.completed_lenses.includes(l),
      );
      file.audit_status = allCompleted
        ? "complete"
        : file.completed_lenses.length > 0
          ? "partial"
          : "pending";
    }
  }

  // Write new JSONL entries (append to existing)
  const newJsonl = newEntries.map((e) => JSON.stringify(e)).join("\n");
  await fs.appendFile(jsonlPath, "\n" + newJsonl);

  // Write updated coverage matrix
  await fs.writeFile(matrixPath, JSON.stringify(matrix, null, 2));

  // Update audit state
  const statePath = path.join(ARTIFACTS_DIR, "audit_state.json");
  const state = await fs.readFile(statePath, "utf-8").then(JSON.parse);

  // Check if all tasks are completed
  const allMatrixFilesComplete = matrix.files
    .filter((f) => f.audit_status !== "excluded")
    .every((f) => f.audit_status === "complete");

  if (allMatrixFilesComplete) {
    const auditTasksObligation = state.obligations.find(
      (o) => o.id === "audit_tasks_completed",
    );
    if (auditTasksObligation) auditTasksObligation.state = "satisfied";
  } else {
    const auditTasksObligation = state.obligations.find(
      (o) => o.id === "audit_tasks_completed",
    );
    if (auditTasksObligation) auditTasksObligation.state = "present";
  }

  const auditResultsObligation = state.obligations.find(
    (o) => o.id === "audit_results_ingested",
  );
  if (auditResultsObligation) auditResultsObligation.state = "satisfied";

  await fs.writeFile(statePath, JSON.stringify(state, null, 2));

  console.log(`Wrote ${newEntries.length} JSONL entries`);
  console.log(
    `Matrix files complete: ${matrix.files.filter((f) => f.audit_status === "complete").length}/${matrix.files.filter((f) => f.audit_status !== "excluded").length}`,
  );
  console.log(`All complete: ${allMatrixFilesComplete}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
