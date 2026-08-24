import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadDone, DownloadProgress, ModelStatus } from "../lib/models-api";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  progressHandler: undefined as ((progress: DownloadProgress) => void) | undefined,
  doneHandler: undefined as ((done: DownloadDone) => void) | undefined,
  changedHandler: undefined as (() => void) | undefined,
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("../lib/models-api", () => ({
  models: {
    list: mocks.list,
    download: vi.fn(),
    remove: vi.fn(),
    select: vi.fn(),
  },
  listenModelProgress: vi.fn((handler: (progress: DownloadProgress) => void) => {
    mocks.progressHandler = handler;
    return Promise.resolve(vi.fn());
  }),
  listenModelDone: vi.fn((handler: (done: DownloadDone) => void) => {
    mocks.doneHandler = handler;
    return Promise.resolve(vi.fn());
  }),
  listenModelsChanged: vi.fn((handler: () => void) => {
    mocks.changedHandler = handler;
    return Promise.resolve(vi.fn());
  }),
}));

const embeddingModel: ModelStatus = {
  id: "all-MiniLM-L6-v2",
  kind: "embedding",
  name: "MiniLM-L6-v2",
  repo: "sentence-transformers/all-MiniLM-L6-v2",
  files: [],
  dim: 384,
  sizeMb: 90,
  description: "Fast embeddings",
  compatible: true,
  downloaded: false,
  selected: false,
};

let useModelsStore: typeof import("./models-store").useModelsStore;

beforeAll(async () => {
  mocks.list.mockResolvedValue([embeddingModel]);
  ({ useModelsStore } = await import("./models-store"));
  await useModelsStore.getState().actions.init();
});

beforeEach(() => {
  mocks.success.mockClear();
  mocks.error.mockClear();
});

describe("model download completion notifications", () => {
  it("shows exactly one success toast for an embedding model", () => {
    mocks.doneHandler?.({ id: embeddingModel.id, success: true, error: null });

    expect(mocks.success).toHaveBeenCalledExactlyOnceWith("MiniLM-L6-v2 downloaded");
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("shows the download error for an embedding model", () => {
    mocks.doneHandler?.({ id: embeddingModel.id, success: false, error: "network offline" });

    expect(mocks.error).toHaveBeenCalledExactlyOnceWith("MiniLM-L6-v2 download failed", {
      description: "network offline",
    });
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("does not notify for an event outside the embedding catalog", () => {
    mocks.doneHandler?.({ id: "unknown-model", success: true, error: null });

    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
