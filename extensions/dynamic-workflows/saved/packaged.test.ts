import { describe, expect, test } from "bun:test";
import { basename, dirname } from "node:path";
import {
  EXTENSION_PACKAGED_WORKFLOWS_DIRNAME,
  extensionPackagedWorkflowRoot,
  extensionPackagedWorkflowRootDescriptors,
} from "./packaged";

describe("extension-packaged workflow root", () => {
  test("resolves to the dynamic-workflows package workflows directory", () => {
    const root = extensionPackagedWorkflowRoot();
    expect(basename(root)).toBe(EXTENSION_PACKAGED_WORKFLOWS_DIRNAME);
    expect(basename(dirname(root))).toBe("dynamic-workflows");
  });

  test("exposes the packaged root tagged with the extension source", () => {
    expect(extensionPackagedWorkflowRootDescriptors()).toEqual([
      { path: extensionPackagedWorkflowRoot(), source: "extension" },
    ]);
  });
});
