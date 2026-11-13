import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

/**
 * The blurred album-art wash behind the whole app.
 *
 * Keeps the outgoing cover mounted underneath the incoming one so a track
 * change dissolves between two images. A bare `key` swap on a single element
 * unmounted the old art in the same frame the new one appeared at opacity 0,
 * so every change flashed through the bare background before the next cover
 * arrived — which read as a cut, not a fade, however long the fade-in ran.
 */

/** How long one cover takes to replace the last. Handed to CSS as a custom
 *  property rather than duplicated in App.css, because the retire timer below
 *  has to outlast the animation — two numbers drifting apart would retire a
 *  layer mid-fade and flash the background again. Paired with the palette
 *  ramp in useAlbumPalette so the wash and the accent colors move together. */
const FADE_MS = 2200;
/** Margin on the retire timer. The animation starts on the frame after mount,
 *  so it finishes a little after FADE_MS from here. */
const RETIRE_MS = FADE_MS + 250;

/** One mounted cover. The React key is `id`, not the URL: skipping a track
 *  and straight back inside a dissolve stacks the same URL twice, and with
 *  duplicate keys React is free to reuse the first element, which is
 *  already opaque, so the return would cut instead of dissolving. */
interface Layer {
  src: string;
  id: number;
}
let nextLayerId = 0;

export function AlbumBackdrop({ url }: { url: string | null }) {
  const [layers, setLayers] = useState<Layer[]>(() => (url ? [{ src: url, id: nextLayerId++ }] : []));

  useEffect(() => {
    if (!url) {
      // No art, or the setting was switched off — a deliberate toggle, where
      // an instant answer is the right one.
      setLayers([]);
      return;
    }
    setLayers((prev) => (prev[prev.length - 1]?.src === url ? prev : [...prev, { src: url, id: nextLayerId++ }]));
    // Once the top layer is opaque, everything under it is invisible and
    // costing a 72px blur per frame.
    const retire = setTimeout(() => setLayers((prev) => prev.slice(-1)), RETIRE_MS);
    return () => clearTimeout(retire);
  }, [url]);

  if (layers.length === 0) return null;

  return (
    <>
      {layers.map(({ src, id }) => (
        <div
          className="album-backdrop"
          key={id}
          aria-hidden
          style={{ '--album-backdrop-fade-ms': `${FADE_MS}ms` } as CSSProperties}
        >
          <img src={src} alt="" />
        </div>
      ))}
    </>
  );
}
