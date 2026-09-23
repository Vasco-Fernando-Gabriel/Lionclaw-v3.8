import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const STREAMING_MARKDOWN_MAX_CHARS = 30_000;
const STREAMING_TAIL_CHARS = 40_000;

export function StreamingMarkdown({ content, isStreaming }: { content: string; isStreaming: boolean }) {
  if (isStreaming && content.length > STREAMING_MARKDOWN_MAX_CHARS) {
    const hiddenChars = content.length - STREAMING_TAIL_CHARS;
    return (
      <div className="whitespace-pre-wrap break-words">
        {hiddenChars > 0 && (
          <p className="italic opacity-60">
            … {Math.round(hiddenChars / 1024)} KB anteriores ocultos durante o streaming …
          </p>
        )}
        {content.slice(-STREAMING_TAIL_CHARS)}
      </div>
    );
  }
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>;
}
