/**
 * Known-bad layout used ONLY by scripts/verify-pdf-layout.mjs to prove the
 * rendered-PDF check is not blind: two consecutive non-breaking cards, each
 * taller than one page — the construct that overlapped cards in Production
 * exports (model cards with `wrap={false}`). The check MUST report violations
 * for it; if it ever reports none, the script fails ("checker blind"). Never
 * imported by application code.
 */
import { Document, Page, Text, View } from "@react-pdf/renderer";
import { pdfStyles } from "@/lib/pdf/theme";

export const CANARY_MARKERS = Array.from({ length: 90 }, (_, i) => `#C${String(i + 1).padStart(3, "0")}#`);

export function LayoutCanaryDocument() {
  return (
    <Document>
      <Page size="A4" style={pdfStyles.page} wrap>
        <Text style={pdfStyles.bodyText}>Canary preamble line</Text>
        {[CANARY_MARKERS.slice(0, 45), CANARY_MARKERS.slice(45)].map((group, g) => (
          <View key={g} style={pdfStyles.card} wrap={false}>
            {group.map((m) => (
              <View key={m} style={{ marginBottom: 6 }}>
                <Text style={pdfStyles.fieldLabel}>Field</Text>
                <Text style={pdfStyles.bodyText}>{`Non-breaking canary line ${m} that cannot fit on a single page`}</Text>
              </View>
            ))}
          </View>
        ))}
        <Text style={pdfStyles.bodyText}>Canary trailing line</Text>
      </Page>
    </Document>
  );
}
