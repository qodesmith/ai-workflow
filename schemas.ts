#!/usr/bin/env bun

// ─────────────────────────────────────────────
// Workflow Schemas
// ArkType schemas for every JSON artifact in the workflow.
// Defines the structural contract between agents.
//
// Usage as a library:
//   import { manifest, taskFile, ... } from "./schemas"
//
// Usage as a CLI validator:
//   bun schemas.ts manifest
//   bun schemas.ts task T01
//   bun schemas.ts task-all
//   bun schemas.ts specs
// ─────────────────────────────────────────────

import { type } from "arktype";
import { join, resolve } from "path";

// ─── Shared primitives ──────────────────────

const driftTypeAll = type(
  "'none' | 'local' | 'structural' | 'decision' | 'additive'"
);

const driftTypeActive = type(
  "'local' | 'structural' | 'decision' | 'additive'"
);

const taskStatus = type(
  "'pending' | 'in_progress' | 'complete' | 'failed' | 'skipped'"
);

const fileAction = type("'create' | 'modify' | 'delete'");

// ─── Behavioral Spec ────────────────────────

const actor = type({
  name: "string",
  description: "string",
});

const scenario = type({
  id: "string",
  title: "string",
  actor: "string",
  "background?": "string[]",
  given: "string[]",
  when: "string[]",
  then: "string[]",
});

export const behavioralSpec = type({
  initiative: "string",
  goal: "string",
  actors: actor.array(),
  scenarios: scenario.array(),
  out_of_scope: "string[]",
});

export type BehavioralSpec = typeof behavioralSpec.infer;

// ─── Technical Spec ─────────────────────────

const techDecision = type({
  area: "string",
  decision: "string",
  rationale: "string",
  alternatives_considered: "string[]",
  affected_scenarios: "string[]",
});

export const technicalSpec = type({
  decisions: techDecision.array(),
  open_risks: "string[]",
});

export type TechnicalSpec = typeof technicalSpec.infer;

// ─── Codebase Audit Index ───────────────────

const indexDocument = type({
  file: "string",
  description: "string",
});

export const codebaseIndex = type({
  documents: indexDocument.array(),
});

export type CodebaseIndex = typeof codebaseIndex.infer;

// ─── Task File ──────────────────────────────

const taskAssumption = type({
  id: "string",
  description: "string",
});

const taskScenario = type({
  id: "string",
  actor: "string",
  title: "string",
  "background?": "string[]",
  given: "string[]",
  when: "string[]",
  then: "string[]",
});

const taskDecision = type({
  area: "string",
  decision: "string",
  rationale: "string",
});

const taskFileEntry = type({
  path: "string",
  action: fileAction,
  description: "string",
});

export const taskFile = type({
  id: "string",
  title: "string",
  type: "string",
  depends_on: "string[]",
  assumptions: taskAssumption.array(),
  scenarios: taskScenario.array(),
  decisions: taskDecision.array(),
  files: taskFileEntry.array(),
  codebase_context: "string[]",
  commit_type: "string",
  test_files: "string[]",
  notes: "string | null",
});

export type TaskFile = typeof taskFile.infer;

// ─── Manifest ───────────────────────────────

const progressEntry = type({
  iteration: "number",
  completed_files: "string[]",
  remaining_files: "string[]",
  notes: "string",
});

export type ProgressEntry = typeof progressEntry.infer;

const brokenAssumption = type({
  assumption_id: "string",
  assumption: "string",
  reality: "string",
});

export type BrokenAssumption = typeof brokenAssumption.infer;

const completionRecord = type({
  summary: "string",
  matched_plan: "boolean",
  drift_type: driftTypeAll,
  broken_assumptions: brokenAssumption.array(),
  notes: "string | null",
});

export type CompletionRecord = typeof completionRecord.infer;

const driftLogEntry = type({
  triggered_by: "string",
  drift_type: driftTypeActive,
  tasks_updated: "string[]",
  engineer_flagged: "boolean",
  summary: "string",
});

export type DriftLogEntry = typeof driftLogEntry.infer;

const manifestTask = type({
  id: "string",
  file: "string",
  title: "string",
  depends_on: "string[]",
  status: taskStatus,
  "failed_reason?": "string | null",
  "progress?": progressEntry.array(),
  "completion?": completionRecord.or(type("null")),
  "loop_verified?": "boolean",
});

export type ManifestTask = typeof manifestTask.infer;

export const manifest = type({
  tasks: manifestTask.array(),
  drift_log: driftLogEntry.array(),
});

export type Manifest = typeof manifest.infer;

// ─── Validation helpers ─────────────────────

export interface ValidationResult {
  ok: boolean;
  path: string;
  errors: string[];
}

function validate(
  schema: { (data: unknown): unknown },
  data: unknown,
  label: string
): ValidationResult {
  const result = schema(data);
  if (result instanceof type.errors) {
    return {
      ok: false,
      path: label,
      errors: result.map((e) => `  ${e.path}: ${e.message}`),
    };
  }
  return { ok: true, path: label, errors: [] };
}

export function validateManifest(data: unknown): ValidationResult {
  return validate(manifest, data, "manifest.json");
}

export function validateTaskFile(data: unknown, label?: string): ValidationResult {
  return validate(taskFile, data, label ?? "task file");
}

export function validateBehavioralSpec(data: unknown): ValidationResult {
  return validate(behavioralSpec, data, "behavioral-spec.json");
}

export function validateTechnicalSpec(data: unknown): ValidationResult {
  return validate(technicalSpec, data, "technical-spec.json");
}

export function validateCodebaseIndex(data: unknown): ValidationResult {
  return validate(codebaseIndex, data, "index.json");
}

// ─── CLI ────────────────────────────────────

async function cli() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage:");
    console.log("  bun schemas.ts manifest           Validate manifest.json");
    console.log("  bun schemas.ts task <ID>           Validate a single task file");
    console.log("  bun schemas.ts task-all            Validate all task files");
    console.log("  bun schemas.ts specs               Validate both spec files");
    console.log("  bun schemas.ts index               Validate codebase index.json");
    console.log("  bun schemas.ts all                 Validate everything");
    process.exit(0);
  }

  const PROJECT_ROOT = resolve(".");
  const PLANNING = join(PROJECT_ROOT, ".planning");
  const command = args[0];
  const results: ValidationResult[] = [];

  async function readAndValidate(
    path: string,
    validator: (data: unknown) => ValidationResult
  ): Promise<ValidationResult> {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return { ok: false, path, errors: [`  File not found: ${path}`] };
    }
    try {
      const data = await file.json();
      return validator(data);
    } catch {
      return { ok: false, path, errors: [`  Invalid JSON: ${path}`] };
    }
  }

  // ── manifest ──
  if (command === "manifest" || command === "all") {
    results.push(
      await readAndValidate(
        join(PLANNING, "tasks/manifest.json"),
        validateManifest
      )
    );
  }

  // ── task <ID> ──
  if (command === "task") {
    const id = args[1];
    if (!id) {
      console.error("Usage: bun schemas.ts task <ID>  (e.g., bun schemas.ts task T01)");
      process.exit(1);
    }
    const path = join(PLANNING, `tasks/${id}.json`);
    results.push(
      await readAndValidate(path, (d) => validateTaskFile(d, `${id}.json`))
    );
  }

  // ── task-all ──
  if (command === "task-all" || command === "all") {
    const manifestPath = join(PLANNING, "tasks/manifest.json");
    const manifestFile = Bun.file(manifestPath);
    if (await manifestFile.exists()) {
      try {
        const m = await manifestFile.json();
        if (Array.isArray(m.tasks)) {
          for (const t of m.tasks) {
            const taskPath = join(PROJECT_ROOT, t.file);
            results.push(
              await readAndValidate(taskPath, (d) =>
                validateTaskFile(d, t.file)
              )
            );
          }
        }
      } catch {
        results.push({
          ok: false,
          path: manifestPath,
          errors: ["  Cannot read manifest to enumerate task files"],
        });
      }
    }
  }

  // ── specs ──
  if (command === "specs" || command === "all") {
    results.push(
      await readAndValidate(
        join(PLANNING, "behavioral-spec.json"),
        validateBehavioralSpec
      )
    );
    results.push(
      await readAndValidate(
        join(PLANNING, "technical-spec.json"),
        validateTechnicalSpec
      )
    );
  }

  // ── index ──
  if (command === "index" || command === "all") {
    results.push(
      await readAndValidate(
        join(PLANNING, "codebase/index.json"),
        validateCodebaseIndex
      )
    );
  }

  // ── Report ──
  if (results.length === 0) {
    console.error(`Unknown command: ${command}`);
    console.error("Run 'bun schemas.ts' for usage.");
    process.exit(1);
  }

  let hasFailure = false;
  for (const r of results) {
    if (r.ok) {
      console.log(`✓ ${r.path}`);
    } else {
      hasFailure = true;
      console.error(`✗ ${r.path}`);
      for (const e of r.errors) {
        console.error(e);
      }
    }
  }

  process.exit(hasFailure ? 1 : 0);
}

// Run CLI only when executed directly
const isDirectRun = process.argv[1]?.endsWith("schemas.ts");
if (isDirectRun) {
  cli();
}
