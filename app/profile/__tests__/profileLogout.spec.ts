/**
 * ZCA L-2 — the profile page's logout uses the shared sequence. It used to call only Firebase
 * `signOut`, sending no clear of its own (it relied on the AuthProvider's defensive DELETE alone).
 */
import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");
const handler = source.slice(source.indexOf("const handleLogout = async"), source.indexOf("};", source.indexOf("const handleLogout = async")));

describe("Profile page — logout (ZCA L-2)", () => {
  it("delegates to performLogout with the AuthProvider's beginLogout", () => {
    expect(source).toMatch(/import\s*\{\s*performLogout,\s*loginHrefAfterLogout\s*\}\s*from\s*["']@\/lib\/client\/logout["']/);
    expect(source).toMatch(/const \{[^}]*\bbeginLogout\b[^}]*\} = useAuth\(\);/);
    expect(handler).toMatch(/await performLogout\(\{ auth, beginLogout \}\)/);
  });

  it("navigates only after a successful local sign-out, to the outcome-specific login URL", () => {
    expect(handler.indexOf("if (!result.signedOut)")).toBeGreaterThan(handler.indexOf("await performLogout("));
    expect(handler.indexOf("router.replace(loginHrefAfterLogout(result))")).toBeGreaterThan(handler.indexOf("if (!result.signedOut)"));
  });

  it("no longer calls Firebase signOut directly", () => {
    expect(source).not.toMatch(/\bsignOut\s*\(\s*auth\s*\)/);
    expect(source).not.toMatch(/from\s+["']firebase\/auth["']/);
  });
});
