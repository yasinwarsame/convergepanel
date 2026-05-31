"use client";

import { useRef, useState } from "react";
import { Paperclip, X, Loader2 } from "lucide-react";
import { extractFileText, isFileSupported } from "@/lib/client/extractFileText";

interface FileAttachButtonProps {
  onExtracted: (text: string, fileName: string) => void;
  onError: (message: string) => void;
  disabled?: boolean;
  attachedFileName?: string;
  onClear?: () => void;
}

export default function FileAttachButton({
  onExtracted,
  onError,
  disabled,
  attachedFileName,
  onClear,
}: FileAttachButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [extracting, setExtracting] = useState(false);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset input so the same file can be re-selected after clearing
    e.target.value = "";

    if (!isFileSupported(file)) {
      onError(`Unsupported file type. Please upload a .txt, .md, .pdf, or .docx file.`);
      return;
    }

    setExtracting(true);
    try {
      const text = await extractFileText(file);
      if (!text.trim()) {
        onError("The file appears to be empty or could not be read.");
        return;
      }
      onExtracted(text, file.name);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to read file.");
    } finally {
      setExtracting(false);
    }
  }

  if (attachedFileName) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-800">
        <Paperclip className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="max-w-[160px] truncate" title={attachedFileName}>
          {attachedFileName}
        </span>
        {onClear && (
          <button
            type="button"
            onClick={onClear}
            className="ml-0.5 rounded-full p-0.5 hover:bg-sky-200 transition-colors"
            aria-label="Remove attached file"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </span>
    );
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".txt,.md,.pdf,.docx"
        className="hidden"
        onChange={handleFileChange}
        disabled={disabled || extracting}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || extracting}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        title="Attach a file (.txt, .md, .pdf, .docx)"
      >
        {extracting ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            Reading…
          </>
        ) : (
          <>
            <Paperclip className="h-3.5 w-3.5" aria-hidden />
            Attach file
          </>
        )}
      </button>
    </>
  );
}
