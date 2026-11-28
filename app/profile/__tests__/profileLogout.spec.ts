/**
 * ZCA L-2 / P3 R2 — the profile page's logout uses the shared local-only sequence, including the
 * AuthProvider's cancelLogout for a throwing sign-out.
 */
import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");
const handler = source.slice(source.indexOf("const handleLogout = async"), source.indexOf("};", source.indexOf("const handleLogout = async")));

describe("Profile page — logout (ZCA L-2, P3 R2)", () => {
  it("delegates to performLogout with the AuthProvider's beginLogout AND cancelLogout", () => {
    expect(source).toMatch(/import\s*\{\s*performLogout,\s*LOGIN_HREF_AFTER_LOGOUT\s*\}\s*from\s*["']@\/lib\/client\/logout["']/);
    expect(source).toMatch(/const \{[^}]*\bbeginLogout\b[^}]*\bcancelLogout\b[^}]*\} = useAuth\(\);/);
    expect(handler).toMatch(/await performLogout\(\{ auth, beginLogout, cancelLogout \}\)/);
  });

  it("navigates only after a completed logout, to the plain signed-out login URL", () => {
    expect(handler.indexOf("if (!result.signedOut)")).toBeGreaterThan(handler.indexOf("await performLogout("));
    expect(handler.indexOf("router.replace(LOGIN_HREF_AFTER_LOGOUT)")).toBeGreaterThan(handler.indexOf("if (!result.signedOut)"));
  });

  it("no longer calls Firebase signOut directly", () => {
    expect(source).not.toMatch(/\bsignOut\s*\(\s*auth\s*\)/);
    expect(source).not.toMatch(/from\s+["']firebase\/auth["']/);
  });
});
