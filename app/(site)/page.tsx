import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const foundations = [
  { label: "Next.js App Router + TypeScript", status: "Ready" },
  { label: "Tailwind CSS component shell", status: "Ready" },
  { label: "Zod transaction and statement schemas", status: "Ready" },
  { label: "Synthetic PDF fixtures", status: "Ready" },
  { label: "PDF extraction and review workflow", status: "Phase 1" },
] as const;

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col justify-center gap-8 px-6 py-16">
      <header className="space-y-4">
        <Badge>Phase 0 · Foundations complete</Badge>
        <div className="space-y-3">
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Notion Expense Importer
          </h1>
          <p className="max-w-2xl text-lg leading-8 text-slate-600">
            Turn credit card statement PDFs into accurate, categorized Notion transactions while
            keeping raw statements in your browser.
          </p>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Foundation status</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-slate-200">
            {foundations.map((item) => (
              <li key={item.label} className="flex items-center justify-between gap-4 py-3 text-sm">
                <span className="text-slate-700">{item.label}</span>
                <span className="font-medium text-slate-950">{item.status}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <p className="text-sm leading-6 text-slate-500">
        The import workflow, PDF viewer, and Notion connection are intentionally not implemented
        yet. See <code className="rounded bg-slate-200 px-1.5 py-0.5">docs/motion-roadmap.md</code>{" "}
        for the next milestone.
      </p>
    </main>
  );
}
