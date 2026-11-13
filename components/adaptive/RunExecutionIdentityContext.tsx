"use client";

/**
 * The run's execution identity (lib/panel/executionIdentity.ts, the corrected D-4 gate) for the adaptive surfaces that
 * state a count or carry model-written text. Provided once by the component that holds the run's result rows
 * (ResultsDisplay), computed from those rows.
 *
 * `null` (the default) means the surface was not handed the run's rows: it renders exactly as before and states no
 * qualifier it could not derive. A verified, independent run (`rendersAsIndependent`) renders exactly as before too.
 */

import { createContext, useContext } from "react";
import type { RunExecutionIdentity } from "@/lib/panel/executionIdentity";

export const RunExecutionIdentityContext = createContext<RunExecutionIdentity | null>(null);

export function useRunExecutionIdentity(): RunExecutionIdentity | null {
  return useContext(RunExecutionIdentityContext);
}

/** The identity when the surface must qualify what it states, else null (render as before). */
export function useQualifiedExecutionIdentity(): RunExecutionIdentity | null {
  const identity = useContext(RunExecutionIdentityContext);
  return identity && identity.qualified ? identity : null;
}
