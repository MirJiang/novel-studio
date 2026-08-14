import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { Style } from "../types";

interface StylesViewProps {
  /** 当前打开的作品（有则风格卡可一键应用） */
  currentProjectId: number | null;
  currentProjectStyleId: number;
  onApplied: () => void;
}

/**
 * 风格库：上传/粘贴参考小说文本 → LLM 蒸馏风格卡。
 * 风格全局复用，创建作品时选择，注入到 AI 续写/批量写章/划词处理。
 * 样本仅在本地分析，建议使用公版或免费授权作品。
 */
export function StylesView({
  currentProjectId,
  currentProjectStyleId,
  onApplied,
}: StylesViewProps) {
  const [styles, setStyles] = useState<Style[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [distilling, setDistilling] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStyles(await api.listStyles());
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pickFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      setText(String(reader.result ?? ""));
      if (!name.trim()) setName(file.name.replace(/\.[^.]+$/, ""));
    };
    reader.readAsText(file);
  };

  const doDistill = async () => {
    if (distilling) return;
    setDistilling(true);
    setError(null);
    try {
      await api.distillStyle(name.trim(), "本地文本", text);
      setText("");
      setName("");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setDistilling(false);
    }
  };

  const applyToCurrent = async (styleId: number) => {
    if (currentProjectId == null) return;
    try {
      await api.setProjectStyle(currentProjectId, styleId);
      onApplied();
    } catch (e) {
      setError(String(e));
    }
  };

  const removeStyle = async (id: number) => {
    if (!window.confirm("确定删除这个风格吗？引用它的作品会恢复为不指定风格。"))
      return;
    await api.deleteStyle(id);
    await refresh();
    onApplied();
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-10 pt-10 pb-16">
        <div className="flex items-center gap-3.5">
          <h1 className="text-[26px] font-bold tracking-tight text-ink">
            风格库
          </h1>
          <span className="text-xs text-muted">{styles.length} 个风格</span>
        </div>
        <p className="mt-1.5 text-xs leading-5 text-muted">
          上传参考小说，蒸馏出写作风格；创建作品时选用，AI
          写正文时会模仿该风格。样本仅在本地分析，建议使用公版或免费授权作品。
        </p>

        {/* 创建风格卡片 */}
        <div className="mt-6 rounded-2xl bg-surface p-5 shadow-card">
          <div className="flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-[10px] bg-canvas px-3 py-2 text-[13px] outline-none placeholder:text-faint focus:bg-surface2"
              placeholder="风格名称，如：古龙风"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              onClick={() => fileRef.current?.click()}
              className="shrink-0 rounded-full bg-white/70 px-4 py-2 text-[13px] text-body shadow-card transition-colors hover:bg-surface"
            >
              导入 txt
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".txt"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) pickFile(f);
                e.target.value = "";
              }}
            />
          </div>
          <textarea
            className="mt-2 h-36 w-full resize-none rounded-[10px] bg-canvas px-3 py-2 text-[13px] leading-6 outline-none placeholder:text-faint focus:bg-surface2"
            placeholder="或直接粘贴参考文本（至少 500 字，建议几千字以上，蒸馏更准）"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-faint">
              {text.length > 0 ? `已粘贴 ${text.length.toLocaleString()} 字` : ""}
            </span>
            <button
              disabled={distilling || !name.trim() || text.trim().length < 500}
              onClick={() => void doDistill()}
              className="rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
            >
              {distilling ? "蒸馏中…" : "蒸馏风格"}
            </button>
          </div>

          {error && (
            <p className="mt-3 rounded-xl bg-pred px-3.5 py-2.5 text-xs leading-5 text-pred-t">
              {error}
            </p>
          )}
        </div>

        {/* 风格卡列表 */}
        <div className="mt-6 flex flex-col gap-3">
          {styles.map((s) => (
            <div key={s.id} className="rounded-2xl bg-surface p-5 shadow-card">
              <div className="flex items-center gap-2.5">
                <span className="text-[15px] font-bold text-ink">{s.name}</span>
                <span className="text-[11px] text-faint">
                  样本 {s.sample_chars.toLocaleString()} 字
                </span>
                <div className="ml-auto flex items-center gap-2">
                  {currentProjectId != null &&
                    (currentProjectStyleId === s.id ? (
                      <span className="rounded-full bg-pgreen px-2.5 py-1 text-[11px] text-pgreen-t">
                        当前作品使用中
                      </span>
                    ) : (
                      <button
                        onClick={() => void applyToCurrent(s.id)}
                        className="rounded-full bg-white/70 px-3 py-1.5 text-xs text-body shadow-card transition-colors hover:bg-surface"
                      >
                        应用到当前作品
                      </button>
                    ))}
                  <button
                    title="删除风格"
                    onClick={() => void removeStyle(s.id)}
                    className="text-faint hover:text-pred-t"
                  >
                    ×
                  </button>
                </div>
              </div>
              <p className="mt-2.5 whitespace-pre-wrap text-[13px] leading-6 text-body">
                {s.guide}
              </p>
              {s.example && (
                <p className="mt-2 line-clamp-2 rounded-lg bg-canvas px-3 py-2 text-[11px] leading-4 text-faint">
                  示例：{s.example}
                </p>
              )}
            </div>
          ))}
          {styles.length === 0 && (
            <p className="py-10 text-center text-[13px] text-faint">
              还没有风格，导入一本参考小说蒸馏一个
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
