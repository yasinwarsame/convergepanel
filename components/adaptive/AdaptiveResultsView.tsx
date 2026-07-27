"use client";

/**
 * Adaptive Results Dispatcher
 *
 * Picks the renderer for schema.renderHint. This is the single entry point
 * ResultsDisplay.tsx should render when an adaptive classification/schema is
 * present on the run (adaptiveSchemas flag on) — it replaces the legacy
 * List/Compare/Synthesis path entirely for that run.
 */

import { AdaptiveRendererProps } from "./types";
import ConsensusMapView from "./ConsensusMapView";
import RuleApplicationView from "./RuleApplicationView";
import MetricsGridView from "./MetricsGridView";
import VerdictCardView from "./VerdictCardView";
import StepDiffView from "./StepDiffView";
import EvidenceTiersView from "./EvidenceTiersView";
import ScenarioTreeView from "./ScenarioTreeView";
import GalleryView from "./GalleryView";
import GenericSectionsView from "./GenericSectionsView";

export default function AdaptiveResultsView(props: AdaptiveRendererProps) {
  switch (props.schema.renderHint) {
    case "consensus_map":
      return <ConsensusMapView {...props} />;
    case "rule_application":
      return <RuleApplicationView {...props} />;
    case "metrics_grid":
      return <MetricsGridView {...props} />;
    case "verdict_card":
      return <VerdictCardView {...props} />;
    case "step_diff":
      return <StepDiffView {...props} />;
    case "evidence_tiers":
      return <EvidenceTiersView {...props} />;
    case "scenario_tree":
      return <ScenarioTreeView {...props} />;
    case "gallery":
      return <GalleryView {...props} />;
    case "generic_sections":
    default:
      return <GenericSectionsView {...props} />;
  }
}
