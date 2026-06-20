import { join } from "node:path";

export type WorkflowSkillSource = {
  skills?: readonly WorkflowSkillLike[];
};

export type WorkflowSkillLike = {
  baseDir?: unknown;
};

export function skillPackagedWorkflowRootsFromSystemPromptOptions(
  options: WorkflowSkillSource | undefined,
): string[] {
  return skillPackagedWorkflowRootsFromSkills(options?.skills);
}

export function skillPackagedWorkflowRootsFromSkills(
  skills: readonly WorkflowSkillLike[] | undefined,
): string[] {
  if (skills === undefined) return [];

  const roots = skills
    .map((skill) =>
      typeof skill.baseDir === "string" ? join(skill.baseDir, "workflows") : undefined,
    )
    .filter((root): root is string => root !== undefined);
  return [...new Set(roots)];
}
