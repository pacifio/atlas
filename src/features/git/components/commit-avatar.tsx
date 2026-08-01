import { useEffect, useState } from "react";
import { User } from "lucide-react";

// Module-level cache so we don't recompute the same hash repeatedly while
// scrolling through the virtualized list.
const hashCache = new Map<string, string>();

async function sha256(text: string): Promise<string> {
  const cached = hashCache.get(text);
  if (cached) return cached;
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  const bytes = Array.from(new Uint8Array(buf));
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  hashCache.set(text, hex);
  return hex;
}

interface CommitAvatarProps {
  email: string | null | undefined;
  size?: number;
  className?: string;
}

export function CommitAvatar({
  email,
  size = 16,
  className,
}: CommitAvatarProps) {
  const [hash, setHash] = useState<string | null>(() => {
    if (!email) return null;
    return hashCache.get(email.trim().toLowerCase()) ?? null;
  });
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!email) {
      setHash(null);
      return;
    }
    const key = email.trim().toLowerCase();
    if (hashCache.has(key)) {
      setHash(hashCache.get(key)!);
      return;
    }
    sha256(key).then((h) => {
      if (!cancelled) setHash(h);
    });
    return () => {
      cancelled = true;
    };
  }, [email]);

  const showFallback = !email || !hash || errored;

  return (
    <span
      className={`relative inline-flex items-center justify-center rounded-full overflow-hidden shrink-0 bg-[var(--bg-elevated)] border border-[var(--border-default)] ${
        className ?? ""
      }`}
      style={{ width: size, height: size }}
    >
      {showFallback ? (
        <User
          size={Math.max(8, Math.floor(size * 0.55))}
          className="text-[var(--text-tertiary)]"
        />
      ) : (
        <img
          src={`https://www.gravatar.com/avatar/${hash}?s=${size * 2}&d=404`}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          onError={() => setErrored(true)}
          className="w-full h-full object-cover"
        />
      )}
    </span>
  );
}
