import { useEffect, useState } from "react";
import { User } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage, Icon, initialsOf } from "@tryatlas/design";
import { cn } from "@/lib/utils";
import { useGitStore } from "../stores/git-store";
import { useGithubAvatars } from "../lib/git-avatars-api";

// Module-level cache so we don't recompute the same hash repeatedly while
// scrolling through the virtualized list.
const hashCache = new Map<string, string>();

async function sha256(text: string): Promise<string> {
  const cached = hashCache.get(text);
  if (cached) return cached;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const bytes = Array.from(new Uint8Array(buf));
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  hashCache.set(text, hex);
  return hex;
}

/** GitHub's private-email form `<id>+<login>@users.noreply.github.com` names
 *  the account outright — no lookup needed. */
const NOREPLY = /^(\d+)\+[^@]+@users\.noreply\.github\.com$/;

function withSize(url: string, px: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}s=${px}`;
}

interface CommitAvatarProps {
  email: string | null | undefined;
  /** The author's name, for the initials shown when there is no face. */
  name?: string;
  /** The repository the commit belongs to; defaults to the active one. */
  repoPath?: string;
  /** Pixels. Commit rows are denser than the control ladder the package
   *  `Avatar` sizes to, so the face is sized here. */
  size?: number;
  className?: string;
}

/**
 * A commit author's face: their GitHub avatar when GitHub knows the email,
 * else Gravatar, else a generic glyph. Each source that fails to load falls
 * through to the next.
 */
export function CommitAvatar({ email, name, repoPath, size = 16, className }: CommitAvatarProps) {
  const key = email?.trim().toLowerCase() ?? "";
  const [hash, setHash] = useState<string | null>(() =>
    key ? (hashCache.get(key) ?? null) : null,
  );
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const activeRepo = useGitStore.use.repoPath();
  const byEmail = useGithubAvatars(repoPath ?? activeRepo ?? "");

  useEffect(() => {
    let cancelled = false;
    setFailed(new Set());
    if (!key) {
      setHash(null);
      return;
    }
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
  }, [key]);

  const noreplyId = key.match(NOREPLY)?.[1];
  const github =
    (key && byEmail?.[key]) ||
    (noreplyId ? `https://avatars.githubusercontent.com/u/${noreplyId}?v=4` : null);
  const src = [
    github ? withSize(github, size * 2) : null,
    hash ? `https://www.gravatar.com/avatar/${hash}?s=${size * 2}&d=404` : null,
  ].find((url): url is string => !!url && !failed.has(url));
  // No face anywhere: the author's initials, else the email's; the glyph
  // only when neither gives a letter.
  const fallback = initialsOf(name ?? "", email ?? undefined);

  return (
    <Avatar size="xs" className={className} style={{ width: size, height: size }}>
      {src ? (
        <AvatarImage
          key={src}
          src={src}
          alt=""
          onLoadingStatusChange={(status) => {
            if (status === "error") setFailed((prev) => new Set(prev).add(src));
          }}
        />
      ) : null}
      <AvatarFallback>
        {fallback === "?" ? (
          <Icon icon={User} size="xs" className="text-muted-foreground" />
        ) : (
          <span
            aria-hidden
            className={cn(
              "font-medium leading-none text-muted-foreground",
              size >= 28 ? "text-xs" : "text-3xs",
            )}
          >
            {/* Two letters don't fit a row-sized face; one does. */}
            {size >= 20 ? fallback : fallback.slice(0, 1)}
          </span>
        )}
      </AvatarFallback>
    </Avatar>
  );
}
