import { tmpdir } from "node:os";
import { join } from "node:path";

export function getCompanionSocketPath(): string {
  return join(tmpdir(), `pi-companion-${process.getuid?.() ?? "user"}`, "companion.sock");
}
