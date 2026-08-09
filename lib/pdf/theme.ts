/**
 * Adaptive Research Export, Phase 1 — shared PDF styling. Uses react-pdf's
 * built-in standard fonts only (Helvetica family) — no `Font.register()`,
 * no remote font/image fetches at generation time (Part 11), so the
 * pipeline stays deterministic and works identically offline/in CI.
 */

import { StyleSheet } from "@react-pdf/renderer";

export const COLORS = {
  text: "#18181B",
  muted: "#65656E",
  faint: "#9A9AA2",
  border: "#E4E3DD",
  borderSoft: "#EFEEE9",
  surface: "#FFFFFF",
  raised: "#FBFBF9",
  accent: "#2563EB",
  accentSoft: "#EEF3FE",
  warning: "#B45309",
  warningSoft: "#FCF0E6",
  danger: "#B91C1C",
  dangerSoft: "#FEF2F2",
  success: "#15803D",
  successSoft: "#F0FDF4",
};

export const pdfStyles = StyleSheet.create({
  page: {
    paddingTop: 48,
    paddingBottom: 56,
    paddingHorizontal: 44,
    fontSize: 10,
    fontFamily: "Helvetica",
    color: COLORS.text,
  },
  pageFooter: {
    position: "absolute",
    bottom: 24,
    left: 44,
    right: 44,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 8,
    color: COLORS.faint,
    borderTopWidth: 1,
    borderTopColor: COLORS.borderSoft,
    paddingTop: 6,
  },
  brandRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 18,
  },
  brandName: { fontSize: 12, fontFamily: "Helvetica-Bold", color: COLORS.text },
  brandTagline: { fontSize: 8, color: COLORS.faint },
  title: { fontSize: 18, fontFamily: "Helvetica-Bold", marginBottom: 4 },
  subtitle: { fontSize: 10, color: COLORS.muted, marginBottom: 14 },
  sectionLabel: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: COLORS.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  card: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 6,
    padding: 12,
    marginBottom: 10,
    backgroundColor: COLORS.surface,
  },
  bodyText: { fontSize: 10, lineHeight: 1.5, color: COLORS.text },
  mutedText: { fontSize: 9, lineHeight: 1.4, color: COLORS.muted },
  bulletRow: { flexDirection: "row", marginBottom: 3 },
  bulletMark: { width: 10, fontSize: 10, color: COLORS.muted },
  bulletText: { flex: 1, fontSize: 10, lineHeight: 1.4, color: COLORS.text },
  fieldGrid: { flexDirection: "row", flexWrap: "wrap", marginBottom: 8 },
  fieldCell: { width: "50%", marginBottom: 8, paddingRight: 8 },
  fieldLabel: { fontSize: 7.5, fontFamily: "Helvetica-Bold", color: COLORS.muted, textTransform: "uppercase", marginBottom: 2 },
  fieldValue: { fontSize: 10, color: COLORS.text },
  badge: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    paddingVertical: 3,
    paddingHorizontal: 7,
    borderRadius: 10,
    alignSelf: "flex-start",
  },
  table: { borderWidth: 1, borderColor: COLORS.border, borderRadius: 4, overflow: "hidden" },
  tableHeaderRow: { flexDirection: "row", backgroundColor: COLORS.raised, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  tableRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: COLORS.borderSoft },
  tableCellHeader: { flex: 1, fontSize: 8, fontFamily: "Helvetica-Bold", color: COLORS.muted, padding: 6, textTransform: "uppercase" },
  tableCell: { flex: 1, fontSize: 9, color: COLORS.text, padding: 6 },
  divider: { borderBottomWidth: 1, borderBottomColor: COLORS.borderSoft, marginVertical: 8 },
  modelChip: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: COLORS.text,
    backgroundColor: COLORS.raised,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingVertical: 2,
    paddingHorizontal: 6,
    marginRight: 4,
    marginBottom: 4,
  },
});

export function badgeStyle(tone: "success" | "warning" | "danger" | "neutral" | "accent") {
  const map = {
    success: { backgroundColor: COLORS.successSoft, color: COLORS.success },
    warning: { backgroundColor: COLORS.warningSoft, color: COLORS.warning },
    danger: { backgroundColor: COLORS.dangerSoft, color: COLORS.danger },
    accent: { backgroundColor: COLORS.accentSoft, color: COLORS.accent },
    neutral: { backgroundColor: COLORS.raised, color: COLORS.muted },
  } as const;
  return { ...pdfStyles.badge, ...map[tone] };
}
