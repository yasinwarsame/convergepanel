/**
 * #290 Increment 1 — the layout seam: classic unless readable is asked for exactly, and the rollout switch is off.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { DEFAULT_REPORT_LAYOUT, reportLayoutFromSwitch, resolveReportLayout, resolveShellReportLayout } from "../layoutMode";
import { REPORT_READABLE_LAYOUT_ENABLED } from "../layoutRollout";

describe("layoutMode", () => {
  it("defaults to classic when nothing is requested (flag unset)", () => {
    expect(DEFAULT_REPORT_LAYOUT).toBe("classic");
    expect(resolveReportLayout(undefined)).toBe("classic");
    expect(resolveShellReportLayout(undefined)).toBe("classic");
  });

  it("the rollout switch ships off", () => {
    expect(REPORT_READABLE_LAYOUT_ENABLED).toBe(false);
    // Pinned in source too: enabling it is a reviewed code change, never configuration.
    expect(readFileSync(join(__dirname, "..", "layoutRollout.ts"), "utf8")).toMatch(/^export const REPORT_READABLE_LAYOUT_ENABLED = false as boolean;$/m);
  });

  it.each([null, "", "Readable", "READABLE", " readable", "classic", "compact", 1, true, {}, ["readable"]])("anything but exactly \"readable\" is classic: %p", (v) => {
    expect(resolveReportLayout(v)).toBe("classic");
    expect(resolveShellReportLayout(v)).toBe("classic");
  });

  it("readable only when asked for exactly", () => {
    expect(resolveReportLayout("readable")).toBe("readable");
    expect(resolveShellReportLayout("readable")).toBe("readable");
  });

  it.each([undefined, null, "true", 1, "yes", false])("the switch selects readable only for exactly true: %p", (v) => {
    expect(reportLayoutFromSwitch(v)).toBe("classic");
  });

  it("switch on → shells default to readable; an explicit request still wins", () => {
    jest.isolateModules(() => {
      jest.doMock("../layoutRollout", () => ({ REPORT_READABLE_LAYOUT_ENABLED: true }));
      const m = require("../layoutMode") as typeof import("../layoutMode");
      expect(m.resolveShellReportLayout(undefined)).toBe("readable");
      expect(m.resolveShellReportLayout("classic")).toBe("classic");
    });
  });

  it("both report shells resolve the layout the same way and forward it only when readable", () => {
    for (const rel of ["components/workspace/PersonalResearchDetailShell.tsx", "components/workspace/projects/TeamResearchDetailShell.tsx"]) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      expect([rel, (src.match(/resolveShellReportLayout\(reportLayout\)/g) ?? []).length]).toEqual([rel, 1]);
      expect([rel, (src.match(/\{\.\.\.\(layout === "readable" \? \{ reportLayout: layout \} : \{\}\)\}/g) ?? []).length]).toEqual([rel, 1]);
    }
  });

  it("the live composer passes no layout (classic)", () => {
    expect(readFileSync(join(process.cwd(), "app/page.tsx"), "utf8")).not.toMatch(/reportLayout|readableReport/);
  });
});
