export type WorkflowPhaseOutputForPrompt = {
  phaseIndex: number;
  phaseFile: string;
  notes: string;
};

export type RenderUntrustedPhaseOutputsOptions = {
  controlTagName: string;
  occurrenceLabels?: boolean;
};

export function renderUntrustedPhaseOutputs(
  phaseOutputs: WorkflowPhaseOutputForPrompt[],
  options: RenderUntrustedPhaseOutputsOptions,
): string {
  if (phaseOutputs.length === 0) return "No previous phase outputs yet.";

  const phaseOccurrences = new Map<string, number>();
  const renderedOutputs = phaseOutputs.map((output, outputIndex) => {
    const occurrence = (phaseOccurrences.get(output.phaseFile) ?? 0) + 1;
    phaseOccurrences.set(output.phaseFile, occurrence);

    const notes = escapeWorkflowOutputTags(output.notes, options.controlTagName);
    const fence = markdownFenceFor(notes);
    const occurrenceLabel = options.occurrenceLabels ? ` (occurrence ${occurrence})` : "";

    return `## Output #${outputIndex + 1} — Completed phase ${output.phaseIndex + 1}: ${output.phaseFile}${occurrenceLabel}\n\n${fence}text\n${notes}\n${fence}`;
  });

  return `<previous_phase_outputs untrusted="true">\n${renderedOutputs.join("\n\n")}\n</previous_phase_outputs>`;
}

export function parseLastJsonControlBlock<T = Record<string, unknown>>(
  text: string | undefined,
  tagName: string,
): T | undefined {
  if (!text) return undefined;

  const pattern = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, "g");
  const matches = [...text.matchAll(pattern)];
  const lastMatch = matches.at(-1);
  if (!lastMatch?.[1]) return undefined;

  try {
    const parsed = JSON.parse(lastMatch[1]) as T;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function escapeWorkflowOutputTags(text: string, controlTagName: string): string {
  return text
    .replaceAll("</previous_phase_outputs>", "<\\/previous_phase_outputs>")
    .replaceAll(`<${controlTagName}>`, `<${controlTagName} escaped>`)
    .replaceAll(`</${controlTagName}>`, `<\\/${controlTagName}>`);
}

function markdownFenceFor(text: string): string {
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(text.matchAll(/`+/g), (match) => match[0].length),
  );
  return "`".repeat(Math.max(3, longestBacktickRun + 1));
}
