# Pi Extensions

This context describes the language for a pi extension package that collects personal workflow extensions for the pi coding agent.

## Language

**Pi Extension Package**:
A package that groups multiple **Pi Extensions** so pi can load them from one declared package resource.
_Avoid_: Pi extensions repository, extension collection

**Pi Extension**:
An individual capability under the package that adds commands, tools, shortcuts, UI behavior, or workflow automation to pi.
_Avoid_: Extension, tool

**Workflow**:
A multi-step unit of agent work that progresses through ordered **Phases** and may continue across multiple turns.
_Avoid_: Run, command

**Phase**:
An ordered part of a **Workflow** with a focused responsibility and a handoff to the next Phase.
_Avoid_: Step, stage

**Workflow Run**:
A single execution of a **Workflow** with a specific input, target, progress state, and collected Phase outputs.
_Avoid_: Run, session

**Target Scope**:
The set of files, diffs, branch comparisons, staged changes, or pull requests that a **Workflow Run** is responsible for inspecting or changing.
_Avoid_: Target, input

**LLM Tool**:
A structured capability exposed to the agent so it can request a bounded action with typed parameters.
_Avoid_: Tool, function

**Slash Command**:
A user-facing entry point invoked from pi's input with a slash-prefixed name.
_Avoid_: Command, prompt command

**TUI Widget**:
A status or progress display rendered inside pi's terminal UI, such as above or below the editor.
_Avoid_: Widget, status UI

**State**:
The current data that represents a **Workflow Run**, todo list, or UI component at a point in time.
_Avoid_: Progress, memory

**Todo Item**:
An individual unit of planned work tracked by the todo extension.
_Avoid_: Todo, task

**Subagent Session**:
An isolated agent session delegated from the parent session to complete a focused task.
_Avoid_: Subagent, worker

**Research Task**:
A question or investigation request that a research **Workflow Run** is expected to answer with sourced evidence.
_Avoid_: Task, question

**Research Source**:
An external URL, document, or page collected as evidence for a **Research Task**.
_Avoid_: Source, evidence

**Questionnaire**:
A structured interaction that asks the user one or more questions and returns their selected or custom answers.
_Avoid_: Question, clarification UI

## Example dialogue

Dev: Should this Pi Extension expose an LLM Tool, a Slash Command, or both?
Domain expert: Use both when the agent and the user need the same capability. Use only a Slash Command for user-driven actions, and only an LLM Tool for bounded agent actions.

Dev: The review Workflow Run is still active. Should the todo TUI Widget stay visible?
Domain expert: No. Suppress the todo TUI Widget while the review Workflow is running so the active Phase remains the primary status display.

Dev: Does a Research Task include the Research Sources collected later?
Domain expert: No. The Research Task is the request being investigated; Research Sources are evidence collected while answering it.

Dev: Can we call `review` a tool in docs?
Domain expert: Be precise. `review` is a Pi Extension that exposes an LLM Tool and a Slash Command, and that starts a review Workflow Run.
