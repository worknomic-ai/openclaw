import { describe, expect, it } from "vitest";
import {
  INVALID_CRON_SESSION_TARGET_ID_ERROR,
  INVALID_CRON_SESSION_TARGET_PLUGIN_ID_ERROR,
  assertSafeCronSessionTargetId,
  assertSafeCronSessionTargetPluginId,
  isInvalidCronSessionTargetIdError,
  isInvalidCronSessionTargetPluginIdError,
} from "./session-target.js";

describe("assertSafeCronSessionTargetId", () => {
  it("rejects empty / whitespace-only ids", () => {
    expect(() => assertSafeCronSessionTargetId("")).toThrow(INVALID_CRON_SESSION_TARGET_ID_ERROR);
    expect(() => assertSafeCronSessionTargetId("   ")).toThrow(
      INVALID_CRON_SESSION_TARGET_ID_ERROR,
    );
  });

  it("rejects path / null bytes", () => {
    expect(() => assertSafeCronSessionTargetId("../etc/passwd")).toThrow(
      INVALID_CRON_SESSION_TARGET_ID_ERROR,
    );
    expect(() => assertSafeCronSessionTargetId("foo\\bar")).toThrow(
      INVALID_CRON_SESSION_TARGET_ID_ERROR,
    );
    expect(() => assertSafeCronSessionTargetId("foo\0bar")).toThrow(
      INVALID_CRON_SESSION_TARGET_ID_ERROR,
    );
  });

  it("trims and returns valid ids", () => {
    expect(assertSafeCronSessionTargetId("wa:peer:1234")).toBe("wa:peer:1234");
    expect(assertSafeCronSessionTargetId("  ok  ")).toBe("ok");
  });
});

describe("assertSafeCronSessionTargetPluginId", () => {
  it("accepts simple lowercase ids", () => {
    expect(assertSafeCronSessionTargetPluginId("clawsy")).toBe("clawsy");
    expect(assertSafeCronSessionTargetPluginId("my-plugin")).toBe("my-plugin");
    expect(assertSafeCronSessionTargetPluginId("plugin_123")).toBe("plugin_123");
  });

  it("normalizes case and trims", () => {
    expect(assertSafeCronSessionTargetPluginId("  Clawsy  ")).toBe("clawsy");
    expect(assertSafeCronSessionTargetPluginId("MY-PLUGIN")).toBe("my-plugin");
  });

  it("rejects empty / whitespace-only ids", () => {
    expect(() => assertSafeCronSessionTargetPluginId("")).toThrow(
      INVALID_CRON_SESSION_TARGET_PLUGIN_ID_ERROR,
    );
    expect(() => assertSafeCronSessionTargetPluginId("   ")).toThrow(
      INVALID_CRON_SESSION_TARGET_PLUGIN_ID_ERROR,
    );
  });

  it("rejects ids that start with a non-alphanumeric character", () => {
    expect(() => assertSafeCronSessionTargetPluginId("-foo")).toThrow(
      INVALID_CRON_SESSION_TARGET_PLUGIN_ID_ERROR,
    );
    expect(() => assertSafeCronSessionTargetPluginId("_foo")).toThrow(
      INVALID_CRON_SESSION_TARGET_PLUGIN_ID_ERROR,
    );
  });

  it("rejects ids with path / shell / colon characters", () => {
    for (const bad of [
      "foo/bar",
      "foo\\bar",
      "foo:bar",
      "foo bar",
      "foo.bar",
      "foo!bar",
      "foo\0bar",
      "foo;bar",
    ]) {
      expect(() => assertSafeCronSessionTargetPluginId(bad)).toThrow(
        INVALID_CRON_SESSION_TARGET_PLUGIN_ID_ERROR,
      );
    }
  });
});

describe("error classifiers", () => {
  it("isInvalidCronSessionTargetIdError matches only the session-id error", () => {
    try {
      assertSafeCronSessionTargetId("");
    } catch (err) {
      expect(isInvalidCronSessionTargetIdError(err)).toBe(true);
      expect(isInvalidCronSessionTargetPluginIdError(err)).toBe(false);
    }
  });

  it("isInvalidCronSessionTargetPluginIdError matches only the plugin-id error", () => {
    try {
      assertSafeCronSessionTargetPluginId("");
    } catch (err) {
      expect(isInvalidCronSessionTargetPluginIdError(err)).toBe(true);
      expect(isInvalidCronSessionTargetIdError(err)).toBe(false);
    }
  });
});
