import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { invoke } from "@tauri-apps/api/core";

interface ResearchPaper {
  id: string;
  title: string;
  authors: string[];
  summary: string;
  published: string;
  pdf_url: string;
  link: string;
  categories: string[];
}

interface ProjectSession {
  lastResearchQuery: string;
  lastResearchSource: string;
  lastResearchResults: ResearchPaper[];
  lastTrendingPapers: ResearchPaper[];
  lastOpenedFiles: string[];
  knowledgeActiveNoteId: string | null;
  chatContext: string;
  searchHistory: string[];
}

interface SessionState {
  session: ProjectSession;
  actions: {
    setLastResearchQuery: (query: string) => void;
    setLastResearchSource: (source: string) => void;
    setLastResearchResults: (results: ResearchPaper[]) => void;
    setLastTrendingPapers: (papers: ResearchPaper[]) => void;
    setLastOpenedFiles: (files: string[]) => void;
    setKnowledgeActiveNote: (id: string | null) => void;
    setChatContext: (context: string) => void;
    addSearchHistory: (query: string) => void;
    removeSearchHistory: (query: string) => void;
    clearSearchHistory: () => void;
    saveSession: (projectPath: string) => Promise<void>;
    loadSession: (projectPath: string) => Promise<void>;
  };
}

const defaultSession: ProjectSession = {
  lastResearchQuery: "",
  lastResearchSource: "arxiv",
  lastResearchResults: [],
  lastTrendingPapers: [],
  lastOpenedFiles: [],
  knowledgeActiveNoteId: null,
  chatContext: "",
  searchHistory: [],
};

export const useSessionStore = createSelectors(
  create<SessionState>()((set, get) => ({
    session: { ...defaultSession },
    actions: {
      setLastResearchQuery: (query) =>
        set((s) => ({ session: { ...s.session, lastResearchQuery: query } })),
      setLastResearchSource: (source) =>
        set((s) => ({ session: { ...s.session, lastResearchSource: source } })),
      setLastResearchResults: (results) =>
        set((s) => ({
          session: { ...s.session, lastResearchResults: results },
        })),
      setLastTrendingPapers: (papers) =>
        set((s) => ({ session: { ...s.session, lastTrendingPapers: papers } })),
      setLastOpenedFiles: (files) =>
        set((s) => ({ session: { ...s.session, lastOpenedFiles: files } })),
      setKnowledgeActiveNote: (id) =>
        set((s) => ({ session: { ...s.session, knowledgeActiveNoteId: id } })),
      setChatContext: (context) =>
        set((s) => ({ session: { ...s.session, chatContext: context } })),
      addSearchHistory: (query) =>
        set((s) => ({
          session: {
            ...s.session,
            searchHistory: [
              query,
              ...s.session.searchHistory.filter((q) => q !== query),
            ].slice(0, 20),
          },
        })),
      removeSearchHistory: (query) =>
        set((s) => ({
          session: {
            ...s.session,
            searchHistory: s.session.searchHistory.filter((q) => q !== query),
          },
        })),
      clearSearchHistory: () =>
        set((s) => ({ session: { ...s.session, searchHistory: [] } })),
      saveSession: async (projectPath) => {
        try {
          const data = JSON.stringify(get().session);
          await invoke("save_project_session", {
            projectPath,
            sessionData: data,
          });
        } catch {
          // silent fail
        }
      },
      loadSession: async (projectPath) => {
        try {
          const raw = await invoke<string>("load_project_session", {
            projectPath,
          });
          const parsed = JSON.parse(raw) as Partial<ProjectSession>;
          set({
            session: { ...defaultSession, ...parsed },
          });
        } catch {
          set({ session: { ...defaultSession } });
        }
      },
    },
  })),
);
