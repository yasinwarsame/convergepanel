import type { Metadata } from "next";
import AcceptInvitationClient from "./AcceptInvitationClient";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function AcceptWorkspaceInvitationPage() {
  return <AcceptInvitationClient />;
}
