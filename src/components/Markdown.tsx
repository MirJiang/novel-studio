import ReactMarkdown from "react-markdown";

/** AI 消息的 Markdown 渲染（加粗/列表/标题按设计系统排） */
export function AiMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      components={{
        p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
        strong: ({ children }) => (
          <strong className="font-semibold text-ink">{children}</strong>
        ),
        ul: ({ children }) => (
          <ul className="my-1.5 list-disc space-y-1 pl-5">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="my-1.5 list-decimal space-y-1 pl-5">{children}</ol>
        ),
        li: ({ children }) => <li className="leading-6">{children}</li>,
        h1: ({ children }) => <p className="mt-2 font-bold text-ink">{children}</p>,
        h2: ({ children }) => <p className="mt-2 font-bold text-ink">{children}</p>,
        h3: ({ children }) => <p className="mt-2 font-semibold text-ink">{children}</p>,
        code: ({ children }) => (
          <code className="rounded bg-black/6 px-1 py-0.5 text-[12px]">{children}</code>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
