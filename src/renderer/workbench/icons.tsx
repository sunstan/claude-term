/** Icons: Lucide (bundled, no icon font, no CDN). Same call shape everywhere: Icons.name(size?). */
import {
  Files, Search, Box, Plug, Puzzle, Cpu, Clock, Terminal, Plus, X, ChevronRight, ChevronDown, ChevronUp,
  Folder, File, Link, Info, ExternalLink, ArrowUp, List, Activity, Save, Settings, Image, Code, Columns2, Eye, Play, Camera, Sparkle,
  GitBranch, Minus, Check, SquareTerminal, Power, PowerOff, Download, RefreshCw, Gauge, Square, Filter,
  type LucideIcon,
} from 'lucide-react'

const wrap = (I: LucideIcon) => (size = 18) => <I size={size} strokeWidth={1.8} aria-hidden />

export const Icons = {
  files: wrap(Files), search: wrap(Search), box: wrap(Box), plug: wrap(Plug), puzzle: wrap(Puzzle), cpu: wrap(Cpu), clock: wrap(Clock),
  sparkle: wrap(Sparkle), terminal: wrap(Terminal), plus: wrap(Plus), x: wrap(X), chevron: wrap(ChevronRight), chevronDown: wrap(ChevronDown),
  chevronUp: wrap(ChevronUp), folder: wrap(Folder), file: wrap(File), link: wrap(Link), info: wrap(Info), external: wrap(ExternalLink),
  arrowUp: wrap(ArrowUp), list: wrap(List), activity: wrap(Activity), save: wrap(Save), gear: wrap(Settings), image: wrap(Image),
  code: wrap(Code), columns: wrap(Columns2), eye: wrap(Eye), play: wrap(Play), camera: wrap(Camera),
  terminalBox: wrap(SquareTerminal),
  /** Claude (tabs, sessions, processes…): the terminal icon, in orange */
  claude: (size = 18) => <span className="ico-claude"><Terminal size={size} strokeWidth={1.8} aria-hidden /></span>, git: wrap(GitBranch), minus: wrap(Minus), check: wrap(Check),
  power: wrap(Power), powerOff: wrap(PowerOff), download: wrap(Download), refresh: wrap(RefreshCw), gauge: wrap(Gauge), stop: wrap(Square),
  filter: wrap(Filter),
}
