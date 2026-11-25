/**
 * PC-1 (owner PP-02): the Privacy Policy cannot ship without its real publication date.
 *
 * INTENTIONALLY FAILING on the draft. While the date is the pending sentinel this spec fails, and so does the required
 * Quality Gate. The release commit, made on publication day after counsel review and owner authorization, sets the
 * real date, and that new exact head is then recorded and approved.
 */
import { PRIVACY_POLICY_LAST_UPDATED, PRIVACY_POLICY_LAST_UPDATED_PENDING } from "@/lib/legal/privacyPolicyDate";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

describe("PC-1 Privacy Policy publication date (PP-02)", () => {
  it("is set to a real publication date before release (fails while the pending sentinel is present)", () => {
    expect(PRIVACY_POLICY_LAST_UPDATED).not.toBe(PRIVACY_POLICY_LAST_UPDATED_PENDING);
  });

  it("uses the page's existing 'Month D, YYYY' format and is a real calendar date", () => {
    if (PRIVACY_POLICY_LAST_UPDATED === PRIVACY_POLICY_LAST_UPDATED_PENDING) return; // covered by the test above
    const m = /^([A-Z][a-z]+) ([1-9]|[12]\d|3[01]), (\d{4})$/.exec(PRIVACY_POLICY_LAST_UPDATED);
    expect(m).not.toBeNull();
    const month = MONTHS.indexOf(m![1]);
    expect(month).toBeGreaterThanOrEqual(0);
    const d = new Date(Date.UTC(Number(m![3]), month, Number(m![2])));
    expect(d.getUTCDate()).toBe(Number(m![2])); // rejects e.g. "February 30"
  });

  it("is never backdated to the superseded June 14, 2026 date, nor earlier than this correction", () => {
    if (PRIVACY_POLICY_LAST_UPDATED === PRIVACY_POLICY_LAST_UPDATED_PENDING) return;
    expect(PRIVACY_POLICY_LAST_UPDATED).not.toBe("June 14, 2026");
    const [mon, day, year] = PRIVACY_POLICY_LAST_UPDATED.replace(",", "").split(" ");
    const published = Date.UTC(Number(year), MONTHS.indexOf(mon), Number(day));
    expect(published).toBeGreaterThanOrEqual(Date.UTC(2026, 10, 25)); // PC-1 was authorized on 2026-11-25
  });

  it("the sentinel itself is distinctive, so it can never pass as a date", () => {
    expect(PRIVACY_POLICY_LAST_UPDATED_PENDING).toBe("PENDING-PUBLICATION-DATE");
  });
});
