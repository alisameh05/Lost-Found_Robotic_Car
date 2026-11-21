import { useEffect, useState } from "react";
import { normalizeReference } from "@/lib/reference-image";

export function useReference(file?: File) {
  const [result, setResult] = useState<
    { file: File; url: string; width: number; height: number } | { file: File; error: string }
  >();
  useEffect(() => {
    if (!file) return;
    const controller = new AbortController();
    let url: string | undefined;
    void normalizeReference(file, controller.signal, true).then(({ blob, width, height }) => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setResult({ file, url, width, height });
    }, (error: unknown) => {
      if (!controller.signal.aborted) setResult({ file, error: error instanceof Error ? error.message : "Image could not be read." });
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [file]);
  const current = file && result?.file === file ? result : undefined;
  return {
    image: current && "url" in current ? current : undefined,
    imageError: current && "error" in current ? current.error : undefined,
    loading: Boolean(file && !current),
  };
}
