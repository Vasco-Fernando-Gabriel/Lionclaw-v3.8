
import { beforeEach, describe, it, expect, vi } from "vitest";
import type { CliAgenticResponse } from "../../agent-runtime/cli-agentic/contract";
import type { ArtifactData, StreamChunk } from "../../../../src/types";

vi.mock("../../logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../../db", () => ({
  insertAuditEntry: vi.fn(),
  upsertActivityLog: vi.fn(),
}));

vi.mock("../../artifact-detector", () => ({
  captureToolUse: vi.fn(() => null),
  captureToolResult: vi.fn(() => null),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

const ALLOWED_STREAM_CHUNK_TYPES: ReadonlyArray<StreamChunk["type"]> = [
  "text",
  "tool_call",
  "tool_result",
  "error",
  "done",
  "usage",
  "session",
  "artifact",
  "activity",
];

function makeResponse(overrides?: Partial<CliAgenticResponse>): CliAgenticResponse {
  return {
    content: "hello world",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    toolUses: 1,
    status: "finished",
    ...overrides,
  };
}

describe("kimi stream-translator (S5 §6.1)", () => {
  it("emits only kimi-emittable StreamChunk types and drops onThinking", async () => {
    const { buildKimiUsageSnapshot, createKimiStreamTranslator } = await import("../stream-translator");
    const emitted: StreamChunk[] = [];
    const translator = createKimiStreamTranslator({
      sessionId: "sess-1",
      emit: (chunk) => emitted.push(chunk),
    });

    translator.callbacks.onText?.("hello ");
    translator.callbacks.onText?.("world");
    translator.callbacks.onThinking?.("thought: should drop");
    translator.callbacks.onToolUse?.("Bash");
    translator.callbacks.onToolUseComplete?.("Bash", {
      command: "node -v",
      exitCode: 0,
    });

    const response = makeResponse();
    translator.finalize(
      response,
      buildKimiUsageSnapshot(response, 'kimi-code/kimi-for-coding', 'kimi-k2.7-code', { inputTokens: 0, outputTokens: 0 }),
    );

    for (const chunk of emitted) {
      expect(ALLOWED_STREAM_CHUNK_TYPES).toContain(chunk.type);
    }
    expect(
      emitted.some((c) => c.type === ("thinking" as unknown as StreamChunk["type"])),
    ).toBe(false);
    expect(
      emitted.some((c) => c.type === ("reasoning" as unknown as StreamChunk["type"])),
    ).toBe(false);
    expect(
      emitted.some((c) => c.type === ("tool_start" as unknown as StreamChunk["type"])),
    ).toBe(false);

    expect(emitted).toHaveLength(8);

    expect(emitted[0]).toEqual({ type: "text", content: "hello " });
    expect(emitted[1]).toEqual({ type: "text", content: "world" });
    expect(emitted[2]).toEqual({
      type: "tool_call",
      tool: "Bash",
      toolCallId: expect.any(String),
      input: {},
    });
    expect(emitted[3].type).toBe("activity");
    expect(emitted[3].activity?.kind).toBe("tool");
    expect(emitted[3].activity?.phase).toBe("start");
    expect(emitted[3].activity?.label).toBe("Bash");
    expect(emitted[4].type).toBe("tool_result");
    expect(emitted[4].tool).toBe("Bash");
    expect(typeof emitted[4].result).toBe("string");
    expect(emitted[5].type).toBe("activity");
    expect(emitted[5].activity?.phase).toBe("end");
    expect(emitted[5].activity?.status).toBe("done");
    expect(emitted[5].activity?.command).toBe("node -v");
    expect(emitted[5].activity?.exitCode).toBe(0);
    expect(emitted[6].type).toBe("usage");
    expect(emitted[6].usage?.inputTokens).toBe(10);
    expect(emitted[6].usage?.outputTokens).toBe(5);
    expect(emitted[7]).toEqual({ type: "done", content: "sess-1" });
  });

  it("onThinking is audit-only: emits no chunk but records a kimi.reasoning audit entry", async () => {
    const db = await import("../../db");
    const { createKimiStreamTranslator } = await import("../stream-translator");
    const emitted: StreamChunk[] = [];
    const auditEntries: Array<Record<string, unknown>> = [];
    const translator = createKimiStreamTranslator({
      sessionId: "sess-audit",
      subagent: "kimi-agent",
      emit: (chunk) => emitted.push(chunk),
      onAuditEntry: (entry) => auditEntries.push(entry),
    });

    translator.callbacks.onThinking?.("delta");

    expect(emitted).toHaveLength(0);
    expect(db.insertAuditEntry).toHaveBeenCalledTimes(1);
    expect(auditEntries).toEqual([
      {
        sessionId: "sess-audit",
        subagent: "kimi-agent",
        eventType: "tool_call",
        toolName: "kimi.reasoning",
        input: "delta",
      },
    ]);
  });

  it("does not emit any chunk for onThinking calls regardless of count", async () => {
    const { createKimiStreamTranslator } = await import("../stream-translator");
    const emitted: StreamChunk[] = [];
    const translator = createKimiStreamTranslator({
      sessionId: "sess-3",
      emit: (chunk) => emitted.push(chunk),
    });

    translator.callbacks.onThinking?.("thought A");
    translator.callbacks.onThinking?.("thought B");
    translator.callbacks.onThinking?.("thought C");

    expect(emitted).toHaveLength(0);
  });

  it("streams audit entries through onAuditEntry for tools", async () => {
    const db = await import("../../db");
    const { createKimiStreamTranslator } = await import("../stream-translator");
    const emitted: StreamChunk[] = [];
    const auditEntries: Array<Record<string, unknown>> = [];
    const translator = createKimiStreamTranslator({
      sessionId: "sess-audit2",
      subagent: "kimi-agent",
      emit: (chunk) => emitted.push(chunk),
      onAuditEntry: (entry) => auditEntries.push(entry),
    });

    translator.callbacks.onThinking?.("reasoning text");
    translator.callbacks.onToolUse?.("Bash");
    translator.callbacks.onToolUseComplete?.("Bash", "ok");

    expect(db.insertAuditEntry).toHaveBeenCalledTimes(3);
    expect(auditEntries).toEqual([
      {
        sessionId: "sess-audit2",
        subagent: "kimi-agent",
        eventType: "tool_call",
        toolName: "kimi.reasoning",
        input: "reasoning text",
      },
      {
        sessionId: "sess-audit2",
        subagent: "kimi-agent",
        eventType: "tool_call",
        toolName: "Bash",
      },
      {
        sessionId: "sess-audit2",
        subagent: "kimi-agent",
        eventType: "tool_result",
        toolName: "Bash",
        output: "ok",
      },
    ]);
    expect(emitted).toHaveLength(4);
    expect(emitted[0]).toEqual({
      type: "tool_call",
      tool: "Bash",
      toolCallId: expect.any(String),
      input: {},
    });
    expect(emitted[1].type).toBe("activity");
    expect(emitted[1].activity?.phase).toBe("start");
    expect(emitted[1].activity?.label).toBe("Bash");
    expect(emitted[2]).toEqual({
      type: "tool_result",
      tool: "Bash",
      toolCallId: expect.any(String),
      result: "ok",
    });
    expect(emitted[3].type).toBe("activity");
    expect(emitted[3].activity?.phase).toBe("end");
  });

  it("fail() emits a single error chunk with the message", async () => {
    const { createKimiStreamTranslator } = await import("../stream-translator");
    const emitted: StreamChunk[] = [];
    const translator = createKimiStreamTranslator({
      sessionId: "sess-err",
      emit: (chunk) => emitted.push(chunk),
    });

    translator.fail(new Error("boom"));

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({ type: "error", error: "boom" });
  });

  it("mantem usage unilateral como estimado e desconhecido", async () => {
    const { buildKimiUsageSnapshot } = await import("../stream-translator");
    const snapshot = buildKimiUsageSnapshot(makeResponse({
      usage: {
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 7,
        cacheCreationTokens: 0,
      },
    }), 'kimi-code/kimi-for-coding', 'kimi-k2.7-code', { inputTokens: 12, outputTokens: 3 });

    expect(snapshot).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
      estimated: true,
      costUsd: null,
      costStatus: 'unknown',
      tokenStatus: 'not_reported',
      costUnknownReason: 'no-usage-reported',
    });
  });

  it("finalize emits an authoritative subscription-equivalent usage snapshot then done", async () => {
    const { buildKimiUsageSnapshot, createKimiStreamTranslator } = await import("../stream-translator");
    const emitted: StreamChunk[] = [];
    const translator = createKimiStreamTranslator({
      sessionId: "sess-usage",
      emit: (chunk) => emitted.push(chunk),
    });

    const response = makeResponse({
        usage: {
          inputTokens: 100,
          outputTokens: 40,
          cacheReadTokens: 7,
          cacheCreationTokens: 3,
        },
      });
    translator.finalize(
      response,
      buildKimiUsageSnapshot(response, 'kimi-code/kimi-for-coding', 'kimi-k2.7-code', { inputTokens: 0, outputTokens: 0 }),
    );

    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toEqual({
      type: "usage",
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 7,
        cacheCreationTokens: 3,
        runtime: 'kimi-sdk',
        provider: 'kimi',
        model: 'kimi-code/kimi-for-coding',
        costUsd: expect.any(Number),
        costStatus: 'known',
        tokenStatus: 'reported',
        costEstimationKind: 'subscription-equivalent-payg',
      },
    });
    expect(emitted[1]).toEqual({ type: "done", content: "sess-usage" });
  });

  it("emits final response artifacts and exposes them for persistence", async () => {
    const artifactDetector = await import("../../artifact-detector");
    const artifact: ArtifactData = {
      id: "artifact-1",
      type: "image",
      title: "Imagem: Kimi feliz",
      toolName: "nano-banana",
      data: {
        filePath: "/tmp/kimi-feliz.png",
        imageBase64: "abc",
        mimeType: "image/png",
      },
    };
    vi.mocked(artifactDetector.captureToolResult).mockReturnValueOnce(artifact);

    const { buildKimiUsageSnapshot, createKimiStreamTranslator } = await import("../stream-translator");
    const emitted: StreamChunk[] = [];
    const persistedArtifacts: ArtifactData[] = [];
    const translator = createKimiStreamTranslator({
      sessionId: "sess-4",
      emit: (chunk) => emitted.push(chunk),
      onArtifact: (found) => persistedArtifacts.push(found),
    });

    const response = makeResponse({ content: "Imagem pronta: ![Kimi feliz](/tmp/kimi-feliz.png)" });
    translator.finalize(
      response,
      buildKimiUsageSnapshot(response, 'kimi-code/kimi-for-coding', 'kimi-k2.7-code', { inputTokens: 0, outputTokens: 0 }),
    );

    expect(artifactDetector.captureToolResult).toHaveBeenCalledWith(
      "kimi-final-response",
      "Imagem pronta: ![Kimi feliz](/tmp/kimi-feliz.png)",
      false,
    );
    expect(emitted[0]).toEqual({ type: "artifact", artifact });
    expect(persistedArtifacts).toEqual([artifact]);
    expect(emitted.at(-1)).toEqual({ type: "done", content: "sess-4" });
  });
});
