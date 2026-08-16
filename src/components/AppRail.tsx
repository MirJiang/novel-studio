interface AppRailProps {
  /** 是否在书架页 */
  onShelf: boolean;
  /** 是否已打开作品（决定书籍相关项是否可用） */
  hasProject: boolean;
  /** 当前主视图（体检/视频/发布整页工坊；写作态无导航项——书架点书即进写作） */
  activeView: "check" | "video" | "publish" | null;
  /** 设置页是否打开 */
  settingsActive?: boolean;
  /** 风格库页是否打开 */
  stylesActive?: boolean;
  /** 任务面板是否打开 */
  tasksActive?: boolean;
  /** 有进行中/排队任务（显示蓝点） */
  tasksRunning?: boolean;
  onGoShelf: () => void;
  onGoCheck: () => void;
  onGoVideo: () => void;
  onGoPublish: () => void;
  onGoTasks: () => void;
  onGoStyles: () => void;
  onExport: () => void;
  onOpenSettings: () => void;
}

/**
 * 应用级导航栏：贯穿书架与写作态。
 * 新功能（视频/发布…）在这里加一项即可，顶部不再堆按钮。
 */
export function AppRail(props: AppRailProps) {
  const book = props.hasProject;
  return (
    <nav className="flex h-full w-[60px] shrink-0 flex-col items-center gap-1 self-stretch pt-2 pb-3">
      <RailItem
        label="书架"
        active={props.onShelf}
        onClick={props.onGoShelf}
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M5 4v16M10 4v16M15 4v16" />
            <path d="M3 4h18M3 20h18" />
          </svg>
        }
      />
      <RailItem
        label="体检"
        active={!props.onShelf && props.activeView === "check"}
        onClick={props.onGoCheck}
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12h4l3 8 4-16 3 8h4" />
          </svg>
        }
      />

      <RailItem
        label="风格"
        active={props.stylesActive}
        onClick={props.onGoStyles}
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 4V2M15 12v-2M11.5 8h-2M20.5 8h-2M17.8 5.2l-1.4 1.4M17.8 10.8l-1.4-1.4M12.2 5.2l1.4 1.4M12.2 10.8l1.4-1.4" />
            <path d="M3 21l8.5-8.5" />
          </svg>
        }
      />

      <div className="my-1 h-px w-7 bg-track" />

      <RailItem
        label="视频"
        active={!props.onShelf && props.activeView === "video"}
        onClick={props.onGoVideo}
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="4" width="20" height="16" rx="3" />
            <path d="M10 9l5 3-5 3V9z" />
          </svg>
        }
      />

      <RailItem
        label="发布"
        active={!props.onShelf && props.activeView === "publish"}
        onClick={props.onGoPublish}
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 2 11 13" />
            <path d="M22 2l-7 20-4-9-9-4 20-7z" />
          </svg>
        }
      />

      <RailItem
        label="任务"
        active={props.tasksActive}
        badge={props.tasksRunning}
        onClick={props.onGoTasks}
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 6h12M9 12h12M9 18h12" />
            <path d="M4 5l1 1 2-2M4 11l1 1 2-2M4 17l1 1 2-2" />
          </svg>
        }
      />

      {/* 底部：动作 + 设置 */}
      <div className="mt-auto flex flex-col items-center gap-1">
        <RailItem
          label="导出"
          disabled={!book}
          onClick={props.onExport}
          icon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="M7 10l5 5 5-5M12 15V3" />
            </svg>
          }
        />
        <RailItem
          label="设置"
          active={props.settingsActive}
          onClick={props.onOpenSettings}
          icon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
              <path d="M1 14h6M9 8h6M17 16h6" />
            </svg>
          }
        />
      </div>
    </nav>
  );
}

function RailItem({
  label,
  icon,
  active,
  disabled,
  soon,
  badge,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  /** 规划中标记 */
  soon?: boolean;
  /** 有进行中任务的蓝点 */
  badge?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      title={soon ? `${label}（规划中）` : label}
      disabled={disabled}
      onClick={onClick}
      className={`relative flex w-12 flex-col items-center gap-1 rounded-xl py-2 transition-colors ${
        active
          ? "bg-surface text-accent shadow-card"
          : disabled
            ? "text-faint/70"
            : "text-muted hover:bg-hover hover:text-body"
      }`}
    >
      <span className="h-5 w-5">{icon}</span>
      <span className="text-[10px] leading-none">{label}</span>
      {soon && (
        <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-faint" />
      )}
      {badge && (
        <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-accent" />
      )}
    </button>
  );
}
