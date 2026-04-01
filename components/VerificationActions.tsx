"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, FileDown, RotateCcw, ScrollText, Share2 } from "lucide-react";

const buttonClass =
  "px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-1.5 transition-colors";

export interface VerificationActionsProps {
  type: "claim" | "video" | "research";
  /** Return a Promise if copy is async; copied feedback runs after it settles successfully. */
  onCopy: () => void | Promise<void>;
  onExportMemo: () => void;
  onShareLinkedIn?: () => void;
  onShareX?: () => void;
  onGenerateLinkedIn?: () => void;
  onGenerateX?: () => void;
  onViewAuditTrail?: () => void;
  onVerifyAnother?: () => void;
  showAuditTrail?: boolean;
  copyLabel?: string;
  verifyAnotherLabel?: string;
}

export function VerificationActions({
  type: _resultType,
  onCopy,
  onExportMemo,
  onShareLinkedIn,
  onShareX,
  onGenerateLinkedIn,
  onGenerateX,
  onViewAuditTrail,
  onVerifyAnother,
  showAuditTrail = false,
  copyLabel,
  verifyAnotherLabel,
}: VerificationActionsProps) {
  void _resultType;
  const [copied, setCopied] = useState(false);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyResetRef.current) clearTimeout(copyResetRef.current);
    };
  }, []);

  const handleCopy = useCallback(() => {
    void (async () => {
      try {
        const r = onCopy();
        if (r != null && typeof (r as Promise<void>).then === "function") {
          await r;
        }
      } catch {
        return;
      }
      setCopied(true);
      if (copyResetRef.current) clearTimeout(copyResetRef.current);
      copyResetRef.current = setTimeout(() => setCopied(false), 2000);
    })();
  }, [onCopy]);

  return (
    <div className="flex flex-wrap gap-2 mb-6">
      <button type="button" onClick={handleCopy} className={buttonClass}>
        {copied ? (
          <>
            <Check className="h-4 w-4 shrink-0 text-green-500" aria-hidden />
            <span className="text-green-600 dark:text-green-400">Copied!</span>
          </>
        ) : (
          <>
            <Copy className="h-4 w-4 shrink-0" aria-hidden />
            {copyLabel || "Copy"}
          </>
        )}
      </button>

      <button type="button" onClick={onExportMemo} className={buttonClass}>
        <FileDown className="h-4 w-4 shrink-0" aria-hidden />
        Export memo
      </button>

      {onGenerateLinkedIn ? (
        <button type="button" onClick={onGenerateLinkedIn} className={buttonClass}>
          <Share2 className="h-4 w-4 shrink-0" aria-hidden />
          Generate LinkedIn post
        </button>
      ) : onShareLinkedIn ? (
        <button type="button" onClick={onShareLinkedIn} className={buttonClass}>
          <Share2 className="h-4 w-4 shrink-0" aria-hidden />
          LinkedIn
        </button>
      ) : null}

      {onGenerateX ? (
        <button type="button" onClick={onGenerateX} className={buttonClass}>
          <span className="font-bold text-sm" aria-hidden>
            𝕏
          </span>
          Generate 𝕏 post
        </button>
      ) : onShareX ? (
        <button type="button" onClick={onShareX} className={buttonClass}>
          <span className="font-bold text-sm" aria-hidden>
            𝕏
          </span>
          Post
        </button>
      ) : null}

      {onViewAuditTrail ? (
        <button
          type="button"
          onClick={onViewAuditTrail}
          aria-pressed={showAuditTrail}
          className={`${buttonClass} ${showAuditTrail ? "bg-blue-600 text-white border-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:border-blue-600 dark:hover:bg-blue-700" : ""}`}
        >
          <ScrollText className="h-4 w-4 shrink-0" aria-hidden />
          {showAuditTrail ? "Hide audit trail" : "View audit trail"}
        </button>
      ) : null}

      {onVerifyAnother ? (
        <button type="button" onClick={onVerifyAnother} className={buttonClass}>
          <RotateCcw className="h-4 w-4 shrink-0" aria-hidden />
          {verifyAnotherLabel || "Verify another"}
        </button>
      ) : null}
    </div>
  );
}
