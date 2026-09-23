export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const CONTEXT_TABLE: ReadonlyArray<readonly [string, number]> = [
  ['qwen2.5:27b', 130000],
  ['qwen2.5-72b', 131072],
  ['qwen2.5-32b', 131072],
  ['qwen2.5-14b', 131072],
  ['qwen2.5-7b', 131072],
  ['qwen2.5', 131072],
  ['qwen', 131072],
  ['llama-3.3', 131072],
  ['llama-3.2', 131072],
  ['llama-3.1', 131072],
  ['llama3', 131072],
  ['llama-3', 131072],
  ['deepseek-r1', 131072],
  ['deepseek-v3', 131072],
  ['deepseek-coder', 128000],
  ['deepseek', 128000],
  ['mistral-small', 131072],
  ['mistral-large', 131072],
  ['mixtral', 32768],
  ['mistral', 32768],
  ['gemma3', 131072],
  ['gemma2', 8192],
  ['gemma', 8192],
  ['phi-4', 16384],
  ['phi3.5', 131072],
  ['phi3', 131072],
  ['command-r-plus', 131072],
  ['command-r', 131072],
  ['starcoder2', 16384],
  ['starcoder', 8192],
  ['gemini-3.1-pro-preview-customtools', 1048576],
  ['gemini-3.1-pro-preview', 1048576],
  ['gemini-3-pro-preview', 1048576],
  ['gemini-3-flash-preview', 1048576],
  ['gemini-3.1-flash-lite', 1048576],
  ['gemini-2.5-pro', 1048576],
  ['gemini-2.5-flash-lite', 1048576],
  ['gemini-2.5-flash', 1048576],
  ['gemini-2.0-flash-lite', 1048576],
  ['gemini-2.0-flash', 1048576],
];

export function getMaxContext(_provider: string, model: string): number {
  const lower = model.toLowerCase();
  for (const [key, ctx] of CONTEXT_TABLE) {
    if (lower.includes(key)) return ctx;
  }
  return 32768;
}
