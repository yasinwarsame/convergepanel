"use client";

export type PanelViewMode = "list" | "compare" | "synthesis";

const TABS: { mode: PanelViewMode; label: string }[] = [
  { mode: "list", label: "List View" },
  { mode: "compare", label: "Compare View" },
  { mode: "synthesis", label: "Synthesis Report" },
];

export default function PanelViewTabs({
  viewMode,
  onChange,
}: {
  viewMode: PanelViewMode;
  onChange: (mode: PanelViewMode) => void;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-slate-200 pb-2">
      {TABS.map(({ mode, label }) => (
        <button
          key={mode}
          type="button"
          onClick={() => onChange(mode)}
          className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
            viewMode === mode ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
