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
          <code className="rounded bg-track px-1 py-0.5 text-[12px]">{children}</code>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

/** 报告类 Markdown 渲染（体检报告等）：## 分节出真标题，结构感更强 */
export function ReportMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      components={{
        p: ({ children }) => (
          <p className="my-2 text-[13px] leading-6 text-body">{children}</p>
        ),
        strong: ({ children }) => (
          <strong className="font-semibold text-ink">{children}</strong>
        ),
        ul: ({ children }) => (
          <ul className="my-2 list-disc space-y-1.5 pl-5">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="my-2 list-decimal space-y-1.5 pl-5">{children}</ol>
        ),
        li: ({ children }) => (
          <li className="text-[13px] leading-6 text-body">{children}</li>
        ),
        h1: ({ children }) => (
          <h2 className="mt-6 border-b border-line pb-1.5 text-[15px] font-bold text-ink first:mt-0">
            {children}
          </h2>
        ),
        h2: ({ children }) => (
          <h2 className="mt-6 border-b border-line pb-1.5 text-[15px] font-bold text-ink first:mt-0">
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3 className="mt-4 text-[13px] font-semibold text-ink">{children}</h3>
        ),
        code: ({ children }) => (
          <code className="rounded bg-track px-1 py-0.5 text-[12px]">{children}</code>
        ),
        blockquote: ({ children }) => (
          <blockquote className="my-2 border-l-2 border-accent/40 pl-3 text-muted">
            {children}
          </blockquote>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
