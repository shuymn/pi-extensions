import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  skillPackagedWorkflowRootsFromSkills,
  skillPackagedWorkflowRootsFromSystemPromptOptions,
} from "./skill-packaged";

describe("skill-packaged workflow roots", () => {
  test("maps loaded Pi skills to their workflows directories", () => {
    const deepResearchBaseDir = "/pkg/skills/deep-research";
    const repoAuditBaseDir = "/pkg/skills/repo-audit";

    expect(
      skillPackagedWorkflowRootsFromSystemPromptOptions({
        skills: [
          { baseDir: deepResearchBaseDir },
          { baseDir: deepResearchBaseDir },
          { baseDir: repoAuditBaseDir },
          { baseDir: undefined },
          { baseDir: 42 },
        ],
      }),
    ).toEqual([join(deepResearchBaseDir, "workflows"), join(repoAuditBaseDir, "workflows")]);
  });

  test("returns no roots when no skills are loaded", () => {
    expect(skillPackagedWorkflowRootsFromSkills(undefined)).toEqual([]);
    expect(skillPackagedWorkflowRootsFromSystemPromptOptions(undefined)).toEqual([]);
  });
});
