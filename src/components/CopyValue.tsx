'use client';

import { useCallback, useState } from 'react';

/** Renders a value that copies to the clipboard on click (raw `copy` string, not the display text). */
export default function CopyValue({ display, copy, mono }: { display: string; copy: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  const doCopy = useCallback(() => {
    void navigator.clipboard.writeText(copy).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, [copy]);
  return (
    <button
      type="button"
      onClick={doCopy}
      title="Click to copy"
      className={`inline-flex items-center gap-1 tabular-nums cursor-pointer rounded px-1 -mx-1 hover:bg-purple-500/15 ${
        mono ? 'font-mono' : ''
      }`}
    >
      {display}
      <span className={`text-[10px] ${copied ? 'text-green-600' : 'opacity-40'}`} aria-hidden>
        {copied ? '✓ copied' : '⧉'}
      </span>
    </button>
  );
}
