import { api } from "../lib/api";

/**
 * 无边框窗口的自制标题栏：左侧品牌 + 面包屑，右侧窗口控制。
 * 中间区域可拖拽（data-tauri-drag-region），双击切换最大化。
 */
export function Caption({ crumb }: { crumb?: string }) {
  return (
    <div className="flex h-11 shrink-0 items-center select-none">
      {/* 拖拽区（含品牌与面包屑） */}
      <div
        data-tauri-drag-region
        className="flex h-full min-w-0 flex-1 items-center pl-4"
        onDoubleClick={() => void api.winToggleMaximize()}
      >
        <div
          data-tauri-drag-region
          className="flex items-center gap-2.5"
        >
          <div
            className="flex h-[19px] w-[19px] items-center justify-center rounded-md text-[11px] font-bold text-white shadow-glow"
            style={{
              background: "linear-gradient(135deg,#5B8DEF,#7B61C9)",
            }}
          >
            N
          </div>
          <span className="text-[13px] font-semibold text-body">
            Novel Studio
          </span>
        </div>
        {crumb && (
          <span
            data-tauri-drag-region
            className="ml-4 truncate text-xs text-muted"
          >
            {crumb}
          </span>
        )}
      </div>

      {/* 窗口控制（不参与拖拽） */}
      <div className="flex h-full items-center">
        <WinBtn label="最小化" onClick={() => void api.winMinimize()}>
          <svg viewBox="0 0 12 12" className="h-3 w-3">
            <line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </WinBtn>
        <WinBtn label="最大化/还原" onClick={() => void api.winToggleMaximize()}>
          <svg viewBox="0 0 12 12" className="h-3 w-3">
            <rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </WinBtn>
        <WinBtn label="关闭" close onClick={() => void api.winClose()}>
          <svg viewBox="0 0 12 12" className="h-3 w-3">
            <path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </WinBtn>
      </div>
    </div>
  );
}

function WinBtn({
  children,
  label,
  close,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  close?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      title={label}
      onClick={onClick}
      className={`flex h-full w-11 items-center justify-center text-muted transition-colors ${
        close ? "hover:bg-[#E81123] hover:text-white" : "hover:bg-track hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}
