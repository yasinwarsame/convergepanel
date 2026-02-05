/**
 * Route-level loading UI
 * 
 * This renders immediately while the page is loading, providing a skeleton
 * instead of a blank screen. The shell (header/nav) is already rendered
 * by the layout, so this only shows in the content area.
 */

export default function Loading() {
  return (
    <main className="max-w-4xl mx-auto px-4 py-10">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 px-6 py-5 md:px-8 md:py-6">
        {/* Skeleton for header */}
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-6">
          <div className="h-10 w-64 bg-slate-200 rounded animate-pulse" />
          <div className="h-8 w-32 bg-slate-200 rounded-full animate-pulse" />
        </div>
        
        {/* Skeleton for question input */}
        <div className="bg-slate-100 rounded-2xl p-6 md:p-8 mb-6">
          <div className="h-6 w-32 bg-slate-200 rounded animate-pulse mb-4" />
          <div className="h-24 bg-slate-200 rounded-lg animate-pulse mb-3" />
          <div className="h-4 w-48 bg-slate-200 rounded animate-pulse" />
        </div>

        {/* Skeleton for model picker */}
        <div className="mb-6">
          <div className="h-6 w-40 bg-slate-200 rounded animate-pulse mb-4" />
          <div className="flex gap-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 w-24 bg-slate-200 rounded-lg animate-pulse" />
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}

