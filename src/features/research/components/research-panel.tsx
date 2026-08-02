import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";

function invokeWithTimeout<T>(cmd: string, args?: Record<string, unknown>, ms = 15000): Promise<T> {
  return Promise.race([
    invoke<T>(cmd, args),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${cmd} timed out`)), ms)),
  ]);
}
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/ui/scroll-area";
import { useProjectStore } from "@/features/project/stores/project-store";
import { logEvent } from "@/features/log/lib/log";
import {
  Search,
  FileText,
  ExternalLink,
  Loader2,
  Calendar,
  Tag,
  ChevronDown,
  Download,
  Brain,
  TrendingUp,
  Check,
} from "lucide-react";

interface ArxivPaper {
  id: string;
  title: string;
  authors: string[];
  summary: string;
  published: string;
  pdf_url: string;
  link: string;
  categories: string[];
}

type SearchSource = "arxiv" | "semantic-scholar";

export function ResearchPanel() {
  const currentProject = useProjectStore.use.currentProject();
  const queryClient = useQueryClient();

  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SearchSource>("arxiv");
  const [activeQuery, setActiveQuery] = useState<{ q: string; src: SearchSource } | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set());
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());

  // Trending papers — cached for 10 min, fetched once
  const trending = useQuery({
    queryKey: ["research", "trending"],
    queryFn: () => invokeWithTimeout<ArxivPaper[]>("fetch_trending_papers"),
    staleTime: 10 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
  });

  // Search results — only runs when user submits a search
  const search = useQuery({
    queryKey: ["research", "search", activeQuery?.src, activeQuery?.q],
    queryFn: () => {
      if (!activeQuery) return [];
      const command = activeQuery.src === "semantic-scholar" ? "search_semantic_scholar" : "search_arxiv";
      return invokeWithTimeout<ArxivPaper[]>(command, { query: activeQuery.q, maxResults: 15 });
    },
    enabled: !!activeQuery,
    staleTime: 5 * 60 * 1000,
  });

  const handleSearch = () => {
    if (!query.trim()) return;
    setActiveQuery({ q: query.trim(), src: source });
  };

  const handleDownloadPdf = async (paper: ArxivPaper) => {
    if (!currentProject || !paper.pdf_url) return;
    setDownloadingIds((s) => new Set(s).add(paper.id));
    try {
      await invoke<string>("download_paper", {
        pdfUrl: paper.pdf_url,
        projectPath: currentProject.path,
        paperId: paper.id,
        paperTitle: paper.title,
      });
    } catch {
      // Download failures are reflected by the cleared in-flight state below.
    }
    setDownloadingIds((s) => { const n = new Set(s); n.delete(paper.id); return n; });
  };

  const handleSaveToKnowledge = async (paper: ArxivPaper) => {
    if (!currentProject) return;
    try {
      await invoke("save_paper_to_knowledge", {
        projectPath: currentProject.path,
        paperId: paper.id,
        title: paper.title,
        authors: paper.authors,
        summary: paper.summary,
        link: paper.link,
        categories: paper.categories,
      });
      await invoke("log_interaction", {
        projectPath: currentProject.path,
        interactionType: "paper_save",
        summary: `Saved paper: ${paper.title.slice(0, 80)}`,
      });
      logEvent({
        source: "research",
        kind: "paper-save",
        summary: paper.title.slice(0, 120),
        payload: { id: paper.id, link: paper.link, authors: paper.authors },
      });
      const { useKnowledgeStore } = await import("@/features/knowledge/stores/knowledge-store");
      useKnowledgeStore.getState().actions.loadEntries(currentProject.path);
      setSavedIds((s) => new Set(s).add(paper.id));
    } catch {
      // Saving is best-effort; the research view remains usable if it fails.
    }
  };

  const openInBrowser = (url: string) => {
    import("@tauri-apps/plugin-opener")
      .then(({ openUrl }) => openUrl(url))
      .catch(() => window.open(url, "_blank"));
  };

  const papers = search.data && search.data.length > 0 ? search.data : null;
  const showTrending = !papers && !search.isFetching;

  return (
    <div className="h-full flex flex-col">
      {/* Search bar */}
      <div className="px-3 py-2 border-b border-border-subtle bg-bg-primary shrink-0 space-y-1.5">
        <div className="flex items-center gap-1">
          <SourceButton label="arXiv" active={source === "arxiv"} onClick={() => setSource("arxiv")} />
          <SourceButton label="Semantic Scholar" active={source === "semantic-scholar"} onClick={() => setSource("semantic-scholar")} />
        </div>
        <div className="flex gap-1.5">
          <div className="flex-1 flex items-center gap-2 h-7 rounded border border-border-default bg-bg-secondary px-2 focus-within:ring-1 focus-within:ring-border-focus">
            <Search size={12} className="text-text-tertiary shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder={source === "arxiv" ? "Search arXiv papers..." : "Search Semantic Scholar..."}
              className="flex-1 bg-transparent outline-none text-[11px] text-text-primary placeholder:text-text-tertiary"
            />
          </div>
          <button
            onClick={handleSearch}
            disabled={search.isFetching || !query.trim()}
            className={cn(
              "h-7 px-3 rounded text-[10px] font-medium transition-colors",
              query.trim() && !search.isFetching
                ? "bg-accent text-text-inverse hover:bg-accent-hover"
                : "bg-bg-elevated text-text-tertiary"
            )}
          >
            {search.isFetching ? <Loader2 size={11} className="animate-spin" /> : "Search"}
          </button>
        </div>
      </div>

      {/* Results or Trending */}
      <ScrollArea className="flex-1">
        {showTrending && (
          <div>
            <div className="flex items-center gap-1.5 px-4 py-2 border-b border-border-subtle">
              <TrendingUp size={12} className="text-accent" />
              <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-wide">
                Trending in AI & Math
              </span>
              <button
                onClick={() => queryClient.invalidateQueries({ queryKey: ["research", "trending"] })}
                className="ml-auto text-[9px] text-text-tertiary hover:text-text-secondary"
              >
                {trending.isFetching ? <Loader2 size={9} className="animate-spin" /> : "Refresh"}
              </button>
            </div>
            {trending.isFetching && !trending.data && (
              <div className="flex items-center justify-center py-12">
                <Loader2 size={16} className="animate-spin text-accent" />
              </div>
            )}
            {trending.error && (
              <div className="px-4 py-6 text-[11px] text-text-tertiary text-center">
                Failed to load trending papers. <button onClick={() => trending.refetch()} className="text-accent underline">Retry</button>
              </div>
            )}
            {trending.data?.map((paper) => (
              <PaperCard
                key={paper.id}
                paper={paper}
                expanded={expandedId === paper.id}
                onToggle={() => setExpandedId(expandedId === paper.id ? null : paper.id)}
                onOpenBrowser={openInBrowser}
                onDownload={() => handleDownloadPdf(paper)}
                onSaveToKnowledge={() => handleSaveToKnowledge(paper)}
                downloading={downloadingIds.has(paper.id)}
                saved={savedIds.has(paper.id)}
                hasProject={!!currentProject}
              />
            ))}
          </div>
        )}

        {search.error && (
          <div className="px-4 py-6 text-[11px] text-text-tertiary text-center">
            Search failed. <button onClick={() => search.refetch()} className="text-accent underline">Retry</button>
          </div>
        )}

        {papers?.map((paper) => (
          <PaperCard
            key={paper.id}
            paper={paper}
            expanded={expandedId === paper.id}
            onToggle={() => setExpandedId(expandedId === paper.id ? null : paper.id)}
            onOpenBrowser={openInBrowser}
            onDownload={() => handleDownloadPdf(paper)}
            onSaveToKnowledge={() => handleSaveToKnowledge(paper)}
            downloading={downloadingIds.has(paper.id)}
            saved={savedIds.has(paper.id)}
            hasProject={!!currentProject}
          />
        ))}
      </ScrollArea>
    </div>
  );
}

function PaperCard({
  paper,
  expanded,
  onToggle,
  onOpenBrowser,
  onDownload,
  onSaveToKnowledge,
  downloading,
  saved,
  hasProject,
}: {
  paper: ArxivPaper;
  expanded: boolean;
  onToggle: () => void;
  onOpenBrowser: (url: string) => void;
  onDownload: () => void;
  onSaveToKnowledge: () => void;
  downloading: boolean;
  saved: boolean;
  hasProject: boolean;
}) {
  return (
    <div className="border-b border-border-subtle hover:bg-bg-hover/50 transition-colors">
      <button onClick={onToggle} className="w-full text-left px-4 py-3">
        <div className="flex items-start gap-2">
          <FileText size={14} className="text-accent shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <h3 className="text-[12px] font-medium text-text-primary leading-snug">
              {paper.title}
            </h3>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className="text-[10px] text-text-tertiary flex items-center gap-1">
                <Calendar size={9} />
                {paper.published}
              </span>
              <span className="text-[10px] text-text-secondary truncate">
                {paper.authors.slice(0, 3).join(", ")}
                {paper.authors.length > 3 && ` +${paper.authors.length - 3}`}
              </span>
            </div>
            {paper.categories.length > 0 && (
              <div className="flex gap-1 mt-1 flex-wrap">
                {paper.categories.slice(0, 3).map((cat) => (
                  <span
                    key={cat}
                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-accent-muted text-[8px] text-accent font-mono"
                  >
                    <Tag size={7} />
                    {cat}
                  </span>
                ))}
              </div>
            )}
          </div>
          <ChevronDown
            size={12}
            className={cn(
              "text-text-tertiary shrink-0 transition-transform mt-1",
              expanded && "rotate-180"
            )}
          />
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          <p className="text-[11px] text-text-secondary leading-relaxed pl-6">
            {paper.summary.slice(0, 600)}
            {paper.summary.length > 600 && "..."}
          </p>
          <div className="flex flex-wrap gap-1.5 pl-6">
            {paper.pdf_url && (
              <ActionButton
                onClick={() => onOpenBrowser(paper.pdf_url)}
                icon={<FileText size={10} />}
                label="View PDF"
              />
            )}
            <ActionButton
              onClick={() => onOpenBrowser(paper.link)}
              icon={<ExternalLink size={10} />}
              label="arXiv"
            />
            {hasProject && paper.pdf_url && (
              <ActionButton
                onClick={onDownload}
                icon={downloading ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}
                label={downloading ? "Downloading..." : "Download PDF"}
                accent
              />
            )}
            {hasProject && (
              <ActionButton
                onClick={onSaveToKnowledge}
                icon={saved ? <Check size={10} /> : <Brain size={10} />}
                label={saved ? "Saved" : "Save to Knowledge"}
                accent={!saved}
                disabled={saved}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ActionButton({
  onClick,
  icon,
  label,
  accent,
  disabled,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  accent?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors",
        accent
          ? "bg-accent-muted text-accent hover:bg-accent/20"
          : "bg-bg-elevated border border-border-default text-text-secondary hover:text-text-primary hover:bg-bg-hover",
        disabled && "opacity-50 cursor-default"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function SourceButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "px-2 py-0.5 rounded text-[9px] font-medium transition-colors",
        active
          ? "bg-accent text-text-inverse"
          : "bg-bg-elevated text-text-tertiary border border-border-default hover:text-text-secondary hover:bg-bg-hover"
      )}
    >
      {label}
    </button>
  );
}
