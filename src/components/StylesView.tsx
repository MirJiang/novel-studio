import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { IMAGE_PRESETS, VIDEO_PRESETS } from "../lib/stylePresets";
import { AiMarkdown } from "./Markdown";
import type { ChatMsg, ChatSession, FqBook, Style } from "../types";

interface UiMsg {
  role: "user" | "ai";
  text: string;
}

/** 风格对话会话的 draft（存 chat_sessions.draft，场景 style） */
interface StyleChatDraft {
  card: string;
  name: string;
  kind: "text" | "image" | "video";
  /** 优化现有风格模式：被优化的风格 id（无 = 新风格） */
  editStyleId?: number;
  /** 优化模式的底卡（每次发送垫作上下文，恢复会话时仍要用） */
  baseCard?: string;
}

/** 对话开场白（按页签类型） */
const GEN_GREETINGS = {
  text: "想调一个什么样的写作风格？说说感觉就行——像哪位作家、什么题材用、要爽感还是要细腻，我帮你把它做成一张可执行的风格卡。",
  image: "想要什么画风？说说参考感觉就行，比如「吉卜力水彩」「暗黑油画」「日系赛璐璐」，我帮你提炼成一组生图锚点词。",
  video: "想要什么运镜气质？比如「手持呼吸感」「缓慢推近」「环绕上升」，我帮你提炼成图生视频的运动提示词。",
} as const;

/** 从完整回复里拆 [CARD] 风格卡（流式 done 后调用）；无标记或卡为空则整段当普通回复 */
function parseCardReply(raw: string): { reply: string; card: string | null } {
  const pos = raw.indexOf("[CARD]");
  if (pos < 0) return { reply: raw.trim(), card: null };
  const reply = raw.slice(0, pos).trim();
  let card = raw.slice(pos + 6);
  const end = card.indexOf("[/CARD]");
  if (end >= 0) card = card.slice(0, end);
  const cardText = card.trim();
  if (!cardText) return { reply: raw.trim(), card: null };
  return { reply: reply || "风格卡好了，看看右边：", card: cardText };
}

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
  /** 页签：写作风格（蒸馏/对话生成）/ 图片画风 / 视频运镜 */
  const [tab, setTab] = useState<"text" | "image" | "video">("text");

  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [distilling, setDistilling] = useState(false);

  // 对话生成风格（多轮流式对话，[CARD] 出卡）
  const [genMessages, setGenMessages] = useState<UiMsg[]>([]);
  const [genInput, setGenInput] = useState("");
  const [genBusy, setGenBusy] = useState(false);
  const [cardPreview, setCardPreview] = useState<string | null>(null);
  const [cardGenerating, setCardGenerating] = useState(false); // [CARD] 已出现，卡内容生成中
  const [cardName, setCardName] = useState("");
  const [genOpen, setGenOpen] = useState(false); // 对话生成弹层
  const [distillOpen, setDistillOpen] = useState(false); // 上传蒸馏弹层
  const genChatRef = useRef<HTMLDivElement>(null);
  // 会话归档（scene=style）：关闭后可从历史恢复
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [history, setHistory] = useState<ChatSession[] | null>(null);
  /** 优化现有风格模式：被优化的风格 id（null = 从零生成新风格） */
  const [editStyleId, setEditStyleId] = useState<number | null>(null);
  /** 优化模式的底卡（每次发送垫作上下文，不进 UI 气泡） */
  const [baseCard, setBaseCard] = useState<string | null>(null);

  // 番茄在线搜书（搜索 → 直接蒸馏 / 下载 txt）
  const [fqOpen, setFqOpen] = useState(false);
  const [fqQuery, setFqQuery] = useState("");
  const [fqResults, setFqResults] = useState<FqBook[] | null>(null);
  const [fqBusy, setFqBusy] = useState(false); // 搜索中
  const [fqAction, setFqAction] = useState<string | null>(null); // 进行中的操作
  const [fqProgress, setFqProgress] = useState<string | null>(null); // 下载进度
  const [fqInfo, setFqInfo] = useState<string | null>(null);
  /** 正在确认样本字数的书（行内展开确认条） */
  const [fqPickId, setFqPickId] = useState<string | null>(null);
  const [fqChars, setFqChars] = useState(15000); // 蒸馏样本目标字数

  /** 风格详情弹层（点卡片打开） */
  const [detail, setDetail] = useState<Style | null>(null);

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
      setDistillOpen(false);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setDistilling(false);
    }
  };

  /** 开新会话（当前会话已归档到历史，可回看） */
  const startFreshGen = () => {
    setGenMessages([{ role: "ai", text: GEN_GREETINGS[tab] }]);
    setCardPreview(null);
    setCardName("");
    setGenInput("");
    setEditStyleId(null);
    setBaseCard(null);
    setSessionId(null);
    setHistory(null);
    setError(null);
  };

  /** 打开对话生成弹层：恢复当前页签类型的最近会话，没有则开新会话 */
  const openGen = () => {
    startFreshGen();
    setGenOpen(true);
    void api
      .getLatestChatSession("style")
      .then((s) => {
        if (!s) return;
        try {
          const msgs = JSON.parse(s.messages) as UiMsg[];
          const d = s.draft ? (JSON.parse(s.draft) as StyleChatDraft) : null;
          // 只恢复与当前页签同类型的会话（写作/画风/运镜互不串）
          if (msgs.length === 0 || (d?.kind ?? "text") !== tab) return;
          setGenMessages(msgs);
          setCardPreview(d?.card || null);
          setCardName(d?.name ?? "");
          setEditStyleId(d?.editStyleId ?? null);
          setBaseCard(d?.baseCard ?? null);
          setSessionId(s.id);
        } catch {
          /* 数据损坏当新会话 */
        }
      })
      .catch(console.error);
  };

  /** 从现有风格卡发起「对话优化」：底卡垫作上下文，保存时可改回原卡 */
  const openEdit = (s: Style) => {
    setGenMessages([
      {
        role: "ai",
        text: `已载入「${s.name}」的当前风格卡（在右侧）。告诉我想怎么改——比如「节奏再快点」「对话多些潜台词」，我会出一张完整的新卡。`,
      },
    ]);
    setCardPreview(s.guide);
    setCardName(s.name);
    setGenInput("");
    setEditStyleId(s.id);
    setBaseCard(s.guide);
    setSessionId(null);
    setHistory(null);
    setError(null);
    setGenOpen(true);
  };

  /** 持久化当前风格会话（归档即此：旧会话留在库里，新会话另起一行） */
  const persistGen = (
    msgs: UiMsg[],
    card: string | null,
    nameVal: string,
    editId: number | null,
    base: string | null,
    sid: number | null,
  ) => {
    const clean = msgs.filter((m) => m.text.trim());
    if (clean.length <= 1) return; // 只有开场白没什么可存的
    const title =
      editId != null
        ? `优化：${nameVal || "未命名风格"}`
        : (clean.find((m) => m.role === "user")?.text.slice(0, 20) ?? "新会话");
    const draft: StyleChatDraft = {
      card: card ?? "",
      name: nameVal,
      kind: tab,
      ...(editId != null ? { editStyleId: editId } : {}),
      ...(base ? { baseCard: base } : {}),
    };
    void api
      .saveChatSession(sid, title, JSON.stringify(clean), JSON.stringify(draft), "style")
      .then((id) => setSessionId(id))
      .catch(console.error);
  };

  const toggleGenHistory = async () => {
    if (history != null) {
      setHistory(null);
      return;
    }
    try {
      setHistory(await api.listChatSessions("style"));
    } catch (e) {
      setError(String(e));
    }
  };

  const loadGenSession = (s: ChatSession) => {
    try {
      const msgs = JSON.parse(s.messages) as UiMsg[];
      const d = s.draft ? (JSON.parse(s.draft) as StyleChatDraft) : null;
      if ((d?.kind ?? "text") !== tab) return; // 类型不匹配不载（列表已过滤，双保险）
      setGenMessages(msgs.length > 0 ? msgs : [{ role: "ai", text: GEN_GREETINGS[tab] }]);
      setCardPreview(d?.card || null);
      setCardName(d?.name ?? "");
      setEditStyleId(d?.editStyleId ?? null);
      setBaseCard(d?.baseCard ?? null);
      setSessionId(s.id);
      setHistory(null);
      setError(null);
    } catch {
      setError("该会话数据损坏，无法恢复");
    }
  };

  // 卡内容/名称手改自动落库（防抖 800ms）
  const genDraftTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!genOpen || genMessages.length <= 1) return;
    if (genDraftTimer.current != null) window.clearTimeout(genDraftTimer.current);
    genDraftTimer.current = window.setTimeout(() => {
      persistGen(genMessages, cardPreview, cardName, editStyleId, baseCard, sessionId);
    }, 800);
  }, [cardPreview, cardName]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 历史列表只显示与当前页签同类型的会话 */
  const visibleHistory = history?.filter((s) => {
    try {
      const d = s.draft ? (JSON.parse(s.draft) as StyleChatDraft) : null;
      return (d?.kind ?? "text") === tab;
    } catch {
      return false;
    }
  });

  // 对话消息滚到底部
  useEffect(() => {
    genChatRef.current?.scrollTo({ top: genChatRef.current.scrollHeight });
  }, [genMessages]);

  /** 对话生成：多轮流式对话；AI 回复带 [CARD] 时右侧出卡（后续微调会重新出整卡覆盖） */
  const sendGen = async (text: string) => {
    const content = text.trim();
    if (!content || genBusy) return;
    setError(null);
    const historyMsgs: ChatMsg[] = [
      ...genMessages,
      { role: "user" as const, text: content },
    ].map((m) => ({
      role: (m.role === "ai" ? "assistant" : "user") as "user" | "assistant",
      content: m.text,
    }));
    // 先上屏：用户消息 + 空的 AI 气泡（流式填充）
    setGenMessages((prev) => [
      ...prev,
      { role: "user", text: content },
      { role: "ai", text: "" },
    ]);
    setGenInput("");
    setGenBusy(true);
    setCardGenerating(false);
    let acc = "";
    try {
      await api.generateStyleCardStream(historyMsgs, tab, baseCard ?? undefined, (ev) => {
        if (ev.type === "delta") {
          acc += ev.text;
          // [CARD] 之后的卡内容不上屏：气泡只显示说明，卡收起为生成状态
          const pos = acc.indexOf("[CARD]");
          const generating = pos >= 0;
          setCardGenerating(generating);
          const visible = generating ? acc.slice(0, pos).trimEnd() : acc;
          setGenMessages((prev) => {
            const next = [...prev];
            next[next.length - 1] = {
              role: "ai",
              text: visible + (generating ? "\n\n*风格卡生成中…*" : ""),
            };
            return next;
          });
        } else if (ev.type === "error") {
          setError(ev.message);
        }
      });
      // 流结束：拆卡；会话落库归档
      const { reply, card } = parseCardReply(acc);
      const finalMsgs: UiMsg[] = [
        ...genMessages,
        { role: "user", text: content },
        { role: "ai", text: reply },
      ];
      setGenMessages(finalMsgs);
      const nextCard = card ?? cardPreview;
      let nextName = cardName;
      if (card) {
        setCardPreview(card);
        if (!nextName.trim()) {
          const firstUser =
            genMessages.find((m) => m.role === "user")?.text ?? content;
          nextName = firstUser.slice(0, 12);
          setCardName(nextName);
        }
      }
      persistGen(finalMsgs, nextCard, nextName, editStyleId, baseCard, sessionId);
    } catch (e) {
      setError(String(e));
    } finally {
      setGenBusy(false);
      setCardGenerating(false);
    }
  };

  /** 保存：优化模式改回原卡；否则存为新风格 */
  const saveCard = async () => {
    if (!cardPreview?.trim() || !cardName.trim()) return;
    try {
      if (editStyleId != null) {
        await api.updateStyle(editStyleId, cardName.trim(), cardPreview.trim());
      } else {
        const firstUser =
          genMessages.find((m) => m.role === "user")?.text.trim() ?? "";
        await api.saveStyleCard(
          cardName.trim(),
          firstUser ? `对话生成：${firstUser.slice(0, 30)}` : "对话生成",
          cardPreview.trim(),
          tab
        );
      }
      setCardPreview(null);
      setGenOpen(false);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  /** 优化模式下的「另存为新卡」：原卡不动，当前卡面存成一个新风格 */
  const saveAsNew = async () => {
    if (!cardPreview?.trim() || !cardName.trim()) return;
    try {
      await api.saveStyleCard(
        cardName.trim(),
        `对话优化自：${baseCard?.slice(0, 20) ?? "现有风格"}`,
        cardPreview.trim(),
        tab
      );
      setCardPreview(null);
      setGenOpen(false);
      await refresh();
    } catch (e) {
      setError(String(e));
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

  const tabStyles = styles.filter((s) =>
    tab === "text" ? s.kind === "text" || !s.kind : s.kind === tab,
  );
  const presets = tab === "image" ? IMAGE_PRESETS : VIDEO_PRESETS;

  const removeStyle = async (id: number) => {
    if (!window.confirm("确定删除这个风格吗？引用它的作品会恢复为不指定风格。"))
      return;
    await api.deleteStyle(id);
    await refresh();
    onApplied();
  };

  // ---------- 番茄在线搜书 ----------

  const fqDoSearch = async () => {
    const q = fqQuery.trim();
    if (!q || fqBusy) return;
    setFqBusy(true);
    setError(null);
    setFqInfo(null);
    try {
      setFqResults(await api.fqSearch(q));
    } catch (e) {
      setError(String(e));
      setFqResults(null);
    } finally {
      setFqBusy(false);
    }
  };

  /** 直接蒸馏：按自选字数抓样本 → 走既有蒸馏管线入库 */
  const fqDistill = async (b: FqBook, maxChars: number) => {
    if (fqAction) return;
    setError(null);
    setFqInfo(null);
    setFqPickId(null);
    setFqAction(
      `正在抓《${b.name}》样本（目标 ${maxChars.toLocaleString()} 字，样本越大抓取越久）…`
    );
    try {
      const sample = await api.fqDistillSample(b.book_id, maxChars);
      setFqAction(`样本 ${sample.chars.toLocaleString()} 字，蒸馏中…`);
      await api.distillStyle(
        sample.name,
        `番茄《${sample.name}》${sample.author}（在线样本）`,
        sample.text
      );
      setFqInfo(
        `《${sample.name}》已蒸馏入库（样本 ${sample.chars.toLocaleString()} 字）`
      );
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setFqAction(null);
    }
  };

  /** 下载全本 txt：先选保存路径，再按章下载（进度条） */
  const fqDownloadBook = async (b: FqBook) => {
    if (fqAction) return;
    const path = await api.saveTextPath(`${b.name}.txt`);
    if (!path) return;
    setError(null);
    setFqInfo(null);
    setFqAction(`下载《${b.name}》中…`);
    try {
      const msg = await api.fqDownload(b.book_id, path, (ev) => {
        if (ev.type === "progress") {
          setFqProgress(`下载中 ${ev.current}/${ev.total}：${ev.label}`);
        } else if (ev.type === "error") {
          setError(ev.message);
        }
      });
      setFqInfo(msg);
    } catch (e) {
      setError(String(e));
    } finally {
      setFqAction(null);
      setFqProgress(null);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl px-10 pt-10 pb-16">
        <div className="flex items-center gap-3.5">
          <h1 className="text-[26px] font-bold tracking-tight text-ink">
            风格库
          </h1>
          <span className="text-xs text-muted">{styles.length} 个风格</span>
          <div className="ml-auto flex gap-1 rounded-[10px] bg-track p-[3px]">
            {(
              [
                ["text", "小说写作"],
                ["image", "图片画风"],
                ["video", "视频运镜"],
              ] as const
            ).map(([t, label]) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-md px-4 py-1 text-xs font-medium transition-colors ${
                  tab === t
                    ? "bg-surface text-ink shadow-card"
                    : "text-muted hover:text-body"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {/* 创建入口（弹层，避免长卡片占列表位） */}
        <div className="mt-5 flex gap-2">
          <button
            className="flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h"
            onClick={openGen}
          >
            <svg viewBox="0 0 12 12" className="h-3 w-3">
              <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.8" />
            </svg>
            对话生成风格
          </button>
          {tab === "text" && (
            <>
              <button
                className="flex items-center gap-1.5 rounded-full bg-card/70 px-4 py-2 text-[13px] text-body shadow-card transition-colors hover:bg-surface"
                onClick={() => setDistillOpen(true)}
              >
                上传小说蒸馏
              </button>
              <button
                className="flex items-center gap-1.5 rounded-full bg-card/70 px-4 py-2 text-[13px] text-body shadow-card transition-colors hover:bg-surface"
                onClick={() => setFqOpen(true)}
              >
                番茄搜书
              </button>
            </>
          )}
        </div>

        {/* 图片/视频页签：内置预设（直接可用，无需添加） */}
        {tab !== "text" && (
          <div className="mt-5 grid grid-cols-2 gap-3 xl:grid-cols-3">
            {presets.map((p) => (
              <div
                key={p.name}
                className="rounded-2xl bg-surface p-4 shadow-card"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-bold text-ink">
                    {p.name}
                  </span>
                  <span className="ml-auto rounded-full bg-track px-2 py-0.5 text-[10px] text-muted">
                    内置
                  </span>
                </div>
                <p className="mt-1.5 text-[12px] leading-5 text-body">
                  {p.guide}
                </p>
                <p className="mt-1 text-[11px] text-faint">{p.desc}</p>
              </div>
            ))}
          </div>
        )}

        {/* 风格卡列表（按页签过滤，小卡片网格；点卡片看详情） */}
        <div className="mt-5 grid grid-cols-2 gap-3 xl:grid-cols-3">
          {tabStyles.map((s) => (
            <div
              key={s.id}
              onClick={() => setDetail(s)}
              title="点击查看完整风格卡"
              className="flex cursor-pointer flex-col rounded-2xl bg-surface p-4 shadow-card transition-shadow hover:shadow-lift"
            >
              <div className="flex items-center gap-2">
                <span className="truncate text-[14px] font-bold text-ink">{s.name}</span>
                {s.source === "内置" && (
                  <span className="rounded-full bg-track px-2 py-0.5 text-[10px] text-muted">
                    内置
                  </span>
                )}
                {s.sample_chars > 0 && (
                  <span className="text-[11px] text-faint">
                    样本 {s.sample_chars.toLocaleString()} 字
                  </span>
                )}
                <div
                  className="ml-auto flex items-center gap-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  {tab === "text" &&
                    currentProjectId != null &&
                    (currentProjectStyleId === s.id ? (
                      <span className="rounded-full bg-pgreen px-2.5 py-1 text-[11px] text-pgreen-t">
                        当前作品使用中
                      </span>
                    ) : (
                      <button
                        onClick={() => void applyToCurrent(s.id)}
                        className="rounded-full bg-card/70 px-3 py-1.5 text-xs text-body shadow-card transition-colors hover:bg-surface"
                      >
                        应用
                      </button>
                    ))}
                  <button
                    title="在对话中调整优化这张卡"
                    onClick={() => openEdit(s)}
                    className="rounded-full bg-card/70 px-3 py-1.5 text-xs text-body shadow-card transition-colors hover:bg-surface"
                  >
                    对话优化
                  </button>
                  <button
                    title="删除风格"
                    onClick={() => void removeStyle(s.id)}
                    className="text-faint hover:text-pred-t"
                  >
                    ×
                  </button>
                </div>
              </div>
              <p className="mt-1.5 line-clamp-3 flex-1 text-[12px] leading-5 text-body">
                {s.guide}
              </p>
              {s.example && (
                <p className="mt-1.5 line-clamp-1 rounded-lg bg-canvas px-2.5 py-1.5 text-[11px] leading-4 text-faint">
                  示例：{s.example}
                </p>
              )}
            </div>
          ))}
          {tabStyles.length === 0 && (
            <p className="col-span-full py-10 text-center text-[13px] text-faint">
              {tab === "text"
                ? "还没有风格，导入一本参考小说蒸馏一个"
                : "内置预设可直接用；对话生成的自定义风格会列在这里"}
            </p>
          )}
        </div>
      </div>

      {/* 对话生成弹层：左侧多轮对话，右侧风格卡面板（同 AI 起书向导的交互） */}
      {genOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          onClick={() => setGenOpen(false)}
        >
          <div
            className="mx-4 flex h-[82vh] w-full max-w-4xl flex-col rounded-2xl bg-surface shadow-float"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center px-5 pt-4">
              <p className="text-[14px] font-semibold text-ink">
                {editStyleId != null ? "对话优化风格" : "对话生成风格"}
              </p>
              <span className="ml-2 text-[11px] text-faint">
                {tab === "text"
                  ? "写作风格卡"
                  : tab === "image"
                    ? "画风锚点词"
                    : "运镜锚点词"}
                ·聊清楚再出卡，可边聊边改；会话自动保存
              </span>
              <div className="ml-auto flex items-center gap-2">
                <button
                  className="rounded-full bg-card/70 px-3 py-1 text-[12px] text-body shadow-card transition-colors hover:bg-surface2"
                  onClick={() => void toggleGenHistory()}
                >
                  历史
                </button>
                <button
                  className="rounded-full bg-card/70 px-3 py-1 text-[12px] text-body shadow-card transition-colors hover:bg-surface2"
                  onClick={startFreshGen}
                  title="当前会话自动归档到历史，可回看"
                >
                  新会话
                </button>
                <button
                  className="text-faint hover:text-body"
                  onClick={() => setGenOpen(false)}
                >
                  ×
                </button>
              </div>
            </div>

            {/* 历史会话面板（只列当前页签类型的会话） */}
            {visibleHistory != null && (
              <div className="mx-5 mt-2.5 max-h-36 shrink-0 overflow-y-auto rounded-2xl bg-canvas p-2.5">
                {visibleHistory.length === 0 && (
                  <p className="py-2.5 text-center text-xs text-faint">
                    还没有历史会话
                  </p>
                )}
                {visibleHistory.map((s) => (
                  <div
                    key={s.id}
                    className={`flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 transition-colors hover:bg-surface ${
                      s.id === sessionId ? "bg-surface" : ""
                    }`}
                    onClick={() => loadGenSession(s)}
                  >
                    <span className="min-w-0 flex-1 truncate text-[13px] text-body">
                      {s.title}
                    </span>
                    {s.draft && (
                      <span className="rounded-full bg-accent-soft px-2 py-px text-[10px] text-accent">
                        有风格卡
                      </span>
                    )}
                    <span className="text-[10px] text-faint">
                      {new Date(s.updated_at * 1000).toLocaleString("zh-CN", {
                        month: "numeric",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    <button
                      className="text-faint hover:text-pred-t"
                      title="删除这条会话"
                      onClick={(e) => {
                        e.stopPropagation();
                        void api.deleteChatSession(s.id).then(() => {
                          setHistory(
                            (h) => h?.filter((x) => x.id !== s.id) ?? null,
                          );
                          // 删的是当前会话：重置 id，下次归档另起一行
                          if (s.id === sessionId) setSessionId(null);
                        });
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-3 flex min-h-0 flex-1 gap-3 px-5 pb-5">
              {/* 左：对话 */}
              <div className="flex min-w-0 flex-1 flex-col">
                <div
                  ref={genChatRef}
                  className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto rounded-2xl bg-canvas p-4"
                >
                  {genMessages.map((m, i) => (
                    <div
                      key={i}
                      className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-6 ${
                        m.role === "ai"
                          ? "self-start bg-surface text-body shadow-card"
                          : "self-end whitespace-pre-wrap bg-accent text-surface"
                      }`}
                    >
                      {m.role === "ai" ? (
                        m.text ? (
                          <AiMarkdown text={m.text} />
                        ) : genBusy && i === genMessages.length - 1 ? (
                          "…"
                        ) : null
                      ) : (
                        m.text
                      )}
                    </div>
                  ))}
                </div>
                <div className="mt-2.5 flex shrink-0 gap-2">
                  <input
                    className="min-w-0 flex-1 rounded-[10px] bg-canvas px-3 py-2.5 text-[13px] outline-none placeholder:text-faint focus:bg-surface2"
                    placeholder="描述你想要的风格，或回复它的问题…"
                    value={genInput}
                    disabled={genBusy}
                    onChange={(e) => setGenInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void sendGen(genInput)}
                  />
                  <button
                    disabled={genBusy || !genInput.trim()}
                    onClick={() => void sendGen(genInput)}
                    className="shrink-0 rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
                  >
                    发送
                  </button>
                  <button
                    disabled={genBusy}
                    title="跳过问答，按现有描述直接出卡"
                    onClick={() => void sendGen("信息够了，直接生成风格卡")}
                    className="shrink-0 rounded-full bg-card/70 px-3.5 py-2 text-[13px] text-body shadow-card transition-colors hover:bg-surface disabled:opacity-40"
                  >
                    直接生成
                  </button>
                </div>
                {error && (
                  <p className="mt-2.5 shrink-0 rounded-xl bg-pred px-3.5 py-2.5 text-xs leading-5 text-pred-t">
                    {error}
                  </p>
                )}
              </div>

              {/* 右：风格卡面板（可编辑，保存入库） */}
              <div className="flex w-[320px] shrink-0 flex-col rounded-2xl bg-canvas p-4">
                <p className="shrink-0 text-xs font-medium text-muted">风格卡</p>
                {cardPreview == null ? (
                  <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center">
                    {cardGenerating ? (
                      <p className="text-[12px] leading-6 text-faint">
                        <span className="mb-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                        <br />
                        风格卡生成中，生成完自动填充…
                      </p>
                    ) : (
                      <p className="text-[12px] leading-6 text-faint">
                        聊清楚后，风格卡会出现在这里；
                        <br />
                        出卡后继续聊，可以反复微调
                      </p>
                    )}
                  </div>
                ) : (
                  <>
                    <textarea
                      className="mt-2 min-h-0 flex-1 resize-none rounded-[10px] bg-surface px-3 py-2.5 text-[12px] leading-6 text-body outline-none focus:bg-surface2"
                      value={cardPreview}
                      onChange={(e) => setCardPreview(e.target.value)}
                    />
                    <input
                      className="mt-2 shrink-0 rounded-[10px] bg-surface px-3 py-2 text-[13px] text-ink outline-none placeholder:text-faint focus:bg-surface2"
                      placeholder="风格名称"
                      value={cardName}
                      onChange={(e) => setCardName(e.target.value)}
                    />
                    <button
                      disabled={!cardName.trim() || !cardPreview.trim()}
                      onClick={() => void saveCard()}
                      className="mt-2 shrink-0 rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
                    >
                      {editStyleId != null ? "保存修改" : "保存到风格库"}
                    </button>
                    {editStyleId != null && (
                      <button
                        disabled={!cardName.trim() || !cardPreview.trim()}
                        onClick={() => void saveAsNew()}
                        className="mt-2 shrink-0 rounded-full bg-card/70 px-4 py-2 text-[13px] text-body shadow-card transition-colors hover:bg-surface disabled:opacity-40"
                      >
                        另存为新卡（原卡不动）
                      </button>
                    )}
                    <p className="mt-1.5 shrink-0 text-[10px] leading-4 text-faint">
                      {editStyleId != null
                        ? "保存修改会直接覆盖原风格卡；想保留原卡就点另存为新卡"
                        : "卡内容可直接编辑；继续对话微调会出新卡覆盖"}
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 上传蒸馏弹层 */}
      {distillOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          onClick={() => setDistillOpen(false)}
        >
          <div className="mx-4 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        {/* 创建风格卡片（上传文本蒸馏，仅写作页签） */}
        <div className="w-full max-w-lg rounded-2xl bg-surface p-5 shadow-float">
          <div className="mb-2 flex items-center">
            <p className="text-[13px] font-semibold text-ink">上传小说蒸馏</p>
            <button
              className="ml-auto text-faint hover:text-body"
              onClick={() => setDistillOpen(false)}
            >
              ×
            </button>
          </div>
          <div className="flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-[10px] bg-canvas px-3 py-2 text-[13px] outline-none placeholder:text-faint focus:bg-surface2"
              placeholder="风格名称，如：古龙风"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              onClick={() => fileRef.current?.click()}
              className="shrink-0 rounded-full bg-card/70 px-4 py-2 text-[13px] text-body shadow-card transition-colors hover:bg-surface"
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

          </div>
        </div>
      )}

      {/* 番茄在线搜书弹层：搜索 → 直接蒸馏 / 下载 txt */}
      {fqOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          onClick={() => setFqOpen(false)}
        >
          <div
            className="mx-4 flex max-h-[80vh] w-full max-w-xl flex-col rounded-2xl bg-surface p-5 shadow-float"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center">
              <p className="text-[14px] font-semibold text-ink">番茄在线搜书</p>
              <button
                className="ml-auto text-faint hover:text-body"
                onClick={() => setFqOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="mt-3 flex shrink-0 gap-2">
              <input
                className="min-w-0 flex-1 rounded-[10px] bg-canvas px-3 py-2 text-[13px] outline-none placeholder:text-faint focus:bg-surface2"
                placeholder="书名 / 作者关键词"
                value={fqQuery}
                onChange={(e) => setFqQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void fqDoSearch()}
              />
              <button
                disabled={fqBusy || !fqQuery.trim()}
                onClick={() => void fqDoSearch()}
                className="shrink-0 rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
              >
                {fqBusy ? "搜索中…" : "搜索"}
              </button>
            </div>
            <p className="mt-2 shrink-0 text-[11px] leading-4 text-faint">
              内容来自番茄小说公开接口，仅供个人学习与风格分析，请勿传播或商用；蒸馏默认抓前 1.5
              万字样本，可自选——样本越大，头/中/尾三段取样越全面
            </p>

            {(fqAction || fqProgress) && (
              <p className="mt-2 shrink-0 rounded-xl bg-accent-soft px-3.5 py-2.5 text-xs text-accent">
                {fqProgress ?? fqAction}
              </p>
            )}
            {fqInfo && !fqAction && (
              <p className="mt-2 shrink-0 rounded-xl bg-pgreen px-3.5 py-2.5 text-xs text-pgreen-t">
                {fqInfo}
              </p>
            )}
            {error && (
              <p className="mt-2 shrink-0 rounded-xl bg-pred px-3.5 py-2.5 text-xs leading-5 text-pred-t">
                {error}
              </p>
            )}

            <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
              {fqResults == null ? (
                <p className="py-10 text-center text-[13px] text-faint">
                  搜一本想研究风格的书，如「十日终焉」
                </p>
              ) : fqResults.length === 0 ? (
                <p className="py-10 text-center text-[13px] text-faint">
                  没有找到，换个关键词试试
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {fqResults.map((b) => (
                    <div key={b.book_id} className="rounded-2xl bg-canvas p-3.5">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[14px] font-bold text-ink">
                          《{b.name}》
                        </span>
                        <span className="shrink-0 text-[11px] text-muted">
                          {b.author}
                          {b.category && ` · ${b.category}`}
                          {b.word_number > 0 &&
                            ` · ${(b.word_number / 10000).toFixed(0)} 万字`}
                        </span>
                      </div>
                      {b.abstract && (
                        <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-muted">
                          {b.abstract}
                        </p>
                      )}
                      <div className="mt-2 flex gap-2">
                        {fqPickId === b.book_id ? (
                          /* 蒸馏确认条：自选样本字数 */
                          <div className="flex flex-1 flex-wrap items-center gap-1.5">
                            <span className="text-[11px] text-muted">样本字数</span>
                            {[5000, 15000, 30000, 50000].map((n) => (
                              <button
                                key={n}
                                onClick={() => setFqChars(n)}
                                className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                                  fqChars === n
                                    ? "bg-accent text-surface shadow-glow"
                                    : "bg-card/70 text-body shadow-card hover:bg-surface"
                                }`}
                              >
                                {n / 10000 >= 1 ? `${n / 10000} 万` : `${n / 1000} 千`}
                              </button>
                            ))}
                            <input
                              className="w-20 rounded-full bg-surface px-2.5 py-1 text-[11px] text-ink outline-none placeholder:text-faint focus:bg-surface2"
                              inputMode="numeric"
                              placeholder="自定义"
                              value={fqChars > 0 ? fqChars : ""}
                              onChange={(e) => {
                                const n = parseInt(e.target.value, 10);
                                setFqChars(Number.isFinite(n) ? n : 0);
                              }}
                            />
                            <button
                              disabled={fqChars < 2000 || fqChars > 300000 || fqAction != null}
                              onClick={() => void fqDistill(b, fqChars)}
                              className="rounded-full bg-accent px-3.5 py-1.5 text-[12px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
                            >
                              开始蒸馏
                            </button>
                            <button
                              onClick={() => setFqPickId(null)}
                              className="px-1.5 text-[12px] text-muted hover:text-body"
                            >
                              取消
                            </button>
                          </div>
                        ) : (
                          <>
                            <button
                              disabled={fqAction != null}
                              onClick={() => {
                                setFqPickId(b.book_id);
                                setFqChars(15000);
                              }}
                              className="rounded-full bg-accent px-3.5 py-1.5 text-[12px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
                            >
                              蒸馏风格
                            </button>
                            <button
                              disabled={fqAction != null}
                              onClick={() => void fqDownloadBook(b)}
                              className="rounded-full bg-card/70 px-3.5 py-1.5 text-[12px] text-body shadow-card transition-colors hover:bg-surface disabled:opacity-40"
                            >
                              下载 txt
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {/* 风格详情弹层：完整风格卡 + 元信息 + 操作聚合 */}
      {detail && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          onClick={() => setDetail(null)}
        >
          <div
            className="mx-4 flex max-h-[82vh] w-full max-w-2xl flex-col rounded-2xl bg-surface p-5 shadow-float"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center gap-2">
              <p className="text-[15px] font-bold text-ink">{detail.name}</p>
              <span className="rounded-full bg-track px-2 py-0.5 text-[10px] text-muted">
                {detail.kind === "image"
                  ? "图片画风"
                  : detail.kind === "video"
                    ? "视频运镜"
                    : "小说写作"}
              </span>
              {detail.source === "内置" && (
                <span className="rounded-full bg-track px-2 py-0.5 text-[10px] text-muted">
                  内置
                </span>
              )}
              <button
                className="ml-auto text-faint hover:text-body"
                onClick={() => setDetail(null)}
              >
                ×
              </button>
            </div>
            <p className="mt-1.5 shrink-0 text-[11px] text-faint">
              来源：{detail.source || "未知"}
              {detail.sample_chars > 0 &&
                ` · 样本 ${detail.sample_chars.toLocaleString()} 字`}
              {` · 更新于 ${new Date(detail.updated_at * 1000).toLocaleString("zh-CN", {
                year: "numeric",
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}`}
            </p>
            <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-2xl bg-canvas p-4">
              <p className="text-xs font-medium text-muted">
                {detail.kind === "text" || !detail.kind
                  ? "风格卡（写作时注入 prompt）"
                  : "锚点词（生成时注入 prompt）"}
              </p>
              <p className="mt-1.5 text-[13px] leading-6 whitespace-pre-wrap text-body">
                {detail.guide}
              </p>
              {detail.example && (
                <>
                  <p className="mt-4 text-xs font-medium text-muted">示例片段</p>
                  <p className="mt-1.5 text-[12px] leading-6 whitespace-pre-wrap text-muted">
                    {detail.example}
                  </p>
                </>
              )}
            </div>
            <div className="mt-3 flex shrink-0 items-center gap-2">
              {(detail.kind === "text" || !detail.kind) &&
                currentProjectId != null &&
                (currentProjectStyleId === detail.id ? (
                  <span className="rounded-full bg-pgreen px-3 py-1.5 text-[12px] text-pgreen-t">
                    当前作品使用中
                  </span>
                ) : (
                  <button
                    onClick={() => {
                      void applyToCurrent(detail.id);
                      setDetail(null);
                    }}
                    className="rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h"
                  >
                    应用到当前作品
                  </button>
                ))}
              <button
                onClick={() => {
                  const s = detail;
                  setDetail(null);
                  openEdit(s);
                }}
                className="rounded-full bg-card/70 px-4 py-2 text-[13px] text-body shadow-card transition-colors hover:bg-surface"
              >
                对话优化
              </button>
              <button
                onClick={() => {
                  const s = detail;
                  setDetail(null);
                  void removeStyle(s.id);
                }}
                className="ml-auto rounded-full bg-card/70 px-4 py-2 text-[13px] text-pred-t shadow-card transition-colors hover:bg-pred"
              >
                删除风格
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
