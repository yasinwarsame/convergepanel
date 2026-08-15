/**
 * Phase 5D — proves the `HistoryGovernanceChip` -> `GovernanceChip`
 * extraction (moving a pure, presentation-only component from `app/page.tsx`
 * to `components/shared/GovernanceChip.tsx`) is genuinely mechanical: the
 * local definition is gone, the one call site now imports the shared
 * component with an unchanged prop, and — critically — no other Phase 5D
 * file (the runs hook, card, or list) is imported into `app/page.tsx` at
 * all. Source-level (regex) assertions, matching this repo's established
 * no-jsdom convention for `app/page.tsx` (it has no test harness capable of
 * actually rendering its 2872-line `Home` component).
 */

import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");

describe("app/page.tsx — HistoryGovernanceChip extraction is mechanical", () => {
  it("no longer defines HistoryGovernanceChip locally", () => {
    expect(source).not.toMatch(/function HistoryGovernanceChip/);
  });

  it("imports the shared GovernanceChip from its new location", () => {
    expect(source).toMatch(/import \{ GovernanceChip \} from "@\/components\/shared\/GovernanceChip"/);
  });

  it("the one call site still passes the exact same prop, unchanged", () => {
    expect(source).toMatch(/<GovernanceChip status=\{item\.governanceStatus\} \/>/);
  });
});

describe("app/page.tsx — zero coupling to Phase 5D beyond the one extraction", () => {
  it("never imports useWorkspaceRuns, WorkspaceRunCard, or WorkspaceResearchList", () => {
    expect(source).not.toMatch(/useWorkspaceRuns/);
    expect(source).not.toMatch(/WorkspaceRunCard/);
    expect(source).not.toMatch(/WorkspaceResearchList/);
  });

  it("never references the Phase 5B/5D runs endpoint", () => {
    expect(source).not.toMatch(/\/api\/user\/workspace\/runs/);
  });

  it("History's own state/handlers (historyItems, openHistoryItem, loadHistoryPage) are still present, unmodified in name/shape", () => {
    expect(source).toMatch(/const \[historyItems, setHistoryItems\]/);
    expect(source).toMatch(/const openHistoryItem = async \(item: HistoryItem\)/);
    expect(source).toMatch(/const loadHistoryPage = useCallback/);
  });

  it("the existing /?openResearchRun= deep-link mechanism Phase 5D reuses is still present and untouched", () => {
    expect(source).toMatch(/openResearchRun/);
    expect(source).toMatch(/router\.replace\("\/", \{ scroll: false \}\)/);
  });
});
