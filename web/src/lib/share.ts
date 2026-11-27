/** Inline SVG markup as an <img> source. */
export function svgDataUrl(svg: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Save text as a file through a temporary blob link. */
export function downloadText(filename: string, text: string, type = "image/svg+xml") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Copy to the clipboard; falls back to a hidden textarea where the async API is missing (plain http). */
export async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("The browser blocked the clipboard. Select the text and copy it by hand.");
}

/** "acme/payments" → "acme-payments", safe for a file name. */
export function fileSlug(s: string) {
  return s.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "keel";
}
