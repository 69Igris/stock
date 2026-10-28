/**
 * Icon Map
 *
 * Maps string names to Lucide icon components for use in chat blocks.
 */

import {
  Activity,
  ArrowUpRight,
  ArrowDownRight,
  BarChart3,
  BookOpen,
  Brain,
  Briefcase,
  Calculator,
  ChevronRight,
  FileSpreadsheet,
  Flame,
  GraduationCap,
  Home,
  Layers,
  Link2,
  MessageSquare,
  PieChart,
  Search,
  Settings,
  Sparkles,
  Target,
  TrendingUp,
  TrendingDown,
  Wallet,
  Zap,
  type LucideIcon,
} from "lucide-react";

const ICON_MAP: Record<string, LucideIcon> = {
  Activity,
  ArrowUpRight,
  ArrowDownRight,
  BarChart3,
  BookOpen,
  Brain,
  Briefcase,
  Calculator,
  ChevronRight,
  FileSpreadsheet,
  Flame,
  GraduationCap,
  Home,
  Layers,
  Link2,
  MessageSquare,
  PieChart,
  Search,
  Settings,
  Sparkles,
  Target,
  TrendingUp,
  TrendingDown,
  Wallet,
  Zap,
};

/**
 * Get a Lucide icon component by string name
 */
export function getIcon(name: string | undefined): LucideIcon | undefined {
  if (!name) return undefined;
  return ICON_MAP[name];
}
