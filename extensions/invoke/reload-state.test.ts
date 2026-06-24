import { describe, expect, test } from "bun:test";
import {
  createArmedRuntimeReloadMarker,
  createConsumedRuntimeReloadMarker,
  createFailedRuntimeReloadMarker,
  findPendingRuntimeReloadMarker,
  RUNTIME_RELOAD_MARKER_CUSTOM_TYPE,
  RUNTIME_RELOAD_OPERATION_NAME,
  readRuntimeReloadMarker,
} from "./reload-state";

function customEntry(data: unknown) {
  return {
    type: "custom",
    customType: RUNTIME_RELOAD_MARKER_CUSTOM_TYPE,
    data,
  };
}

function customMessageEntry() {
  return {
    type: "custom_message",
    customType: RUNTIME_RELOAD_MARKER_CUSTOM_TYPE,
    content: "ignored",
    display: false,
  };
}

describe("runtime reload marker state", () => {
  test("creates and reads an armed marker", () => {
    const marker = createArmedRuntimeReloadMarker({
      invocationId: "reload-1",
      continuationPrompt: "Resume after reload",
      stopAfterReload: false,
      now: () => "2026-06-24T00:00:00.000Z",
    });

    expect(marker).toEqual({
      version: 1,
      operation: RUNTIME_RELOAD_OPERATION_NAME,
      status: "armed",
      invocationId: "reload-1",
      continuationPrompt: "Resume after reload",
      stopAfterReload: false,
      createdAt: "2026-06-24T00:00:00.000Z",
    });
    expect(readRuntimeReloadMarker(customEntry(marker))).toEqual(marker);
  });

  test("finds the latest unconsumed armed marker and ignores closed markers", () => {
    const oldArmed = createArmedRuntimeReloadMarker({
      invocationId: "old",
      stopAfterReload: false,
      now: () => "2026-06-24T00:00:00.000Z",
    });
    const oldConsumed = createConsumedRuntimeReloadMarker(
      oldArmed,
      () => "2026-06-24T00:00:01.000Z",
    );
    const latestFailed = createArmedRuntimeReloadMarker({
      invocationId: "failed",
      stopAfterReload: false,
      now: () => "2026-06-24T00:00:02.000Z",
    });
    const failedMarker = createFailedRuntimeReloadMarker(
      latestFailed,
      "reload failed",
      () => "2026-06-24T00:00:03.000Z",
    );
    const pending = createArmedRuntimeReloadMarker({
      invocationId: "pending",
      stopAfterReload: true,
      now: () => "2026-06-24T00:00:04.000Z",
    });

    expect(
      findPendingRuntimeReloadMarker([
        customEntry(oldArmed),
        customEntry(oldConsumed),
        customEntry(latestFailed),
        customEntry(failedMarker),
        { type: "custom", customType: "other", data: { status: "armed" } },
        customMessageEntry(),
        customEntry(pending),
      ]),
    ).toEqual(pending);
  });

  test("returns undefined when a reload marker has already been consumed", () => {
    const armed = createArmedRuntimeReloadMarker({
      invocationId: "reload-1",
      stopAfterReload: false,
      now: () => "2026-06-24T00:00:00.000Z",
    });
    const consumed = createConsumedRuntimeReloadMarker(armed, () => "2026-06-24T00:00:01.000Z");

    expect(
      findPendingRuntimeReloadMarker([customEntry(armed), customEntry(consumed)]),
    ).toBeUndefined();
  });

  test("does not resurrect armed markers superseded by a later closed reload", () => {
    const oldArmed = createArmedRuntimeReloadMarker({
      invocationId: "old",
      stopAfterReload: false,
      now: () => "2026-06-24T00:00:00.000Z",
    });
    const latestArmed = createArmedRuntimeReloadMarker({
      invocationId: "latest",
      stopAfterReload: false,
      now: () => "2026-06-24T00:00:01.000Z",
    });
    const latestConsumed = createConsumedRuntimeReloadMarker(
      latestArmed,
      () => "2026-06-24T00:00:02.000Z",
    );

    expect(
      findPendingRuntimeReloadMarker([
        customEntry(oldArmed),
        customEntry(latestArmed),
        customEntry(latestConsumed),
      ]),
    ).toBeUndefined();
  });

  test("ignores malformed marker entries", () => {
    expect(readRuntimeReloadMarker(null)).toBeUndefined();
    expect(readRuntimeReloadMarker("not an entry")).toBeUndefined();
    expect(readRuntimeReloadMarker(customEntry({ status: "armed" }))).toBeUndefined();
    expect(
      readRuntimeReloadMarker(
        customEntry({
          version: 1,
          operation: RUNTIME_RELOAD_OPERATION_NAME,
          status: "armed",
          invocationId: "reload-1",
          stopAfterReload: "no",
          createdAt: "2026-06-24T00:00:00.000Z",
        }),
      ),
    ).toBeUndefined();
  });
});
