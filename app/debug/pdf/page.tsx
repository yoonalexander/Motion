import { notFound } from "next/navigation";
import { TextExtractionDebug } from "@/components/pdf-viewer/TextExtractionDebug";

export default function PDFDebugPage() {
  if (process.env.NODE_ENV !== "development") notFound();

  return (
    <main className="mx-auto min-h-screen w-full max-w-7xl px-6 py-10">
      <header className="mb-6 space-y-2">
        <p className="text-sm font-medium uppercase tracking-wide text-slate-500">
          Development tool
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">PDF extraction debugger</h1>
        <p className="max-w-3xl text-sm leading-6 text-slate-600">
          PDFs, extracted text, and parsed rows stay in this browser session and are cleared when
          you reset or leave this page.
        </p>
      </header>
      <TextExtractionDebug />
    </main>
  );
}
