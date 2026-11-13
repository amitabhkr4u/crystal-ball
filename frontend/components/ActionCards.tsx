import { BookOpen, CircleHelp, MessageCircle, Play, Sparkles } from "lucide-react";
import { useAssistantStore, type Mode } from "../store/assistantStore";

const ACTIONS = [
  {
    mode: "summary" as const,
    title: "Present me Summary",
    description: "A prioritised overview of your pending approvals.",
    Icon: Sparkles,
    tone: "violet"
  },
  {
    mode: "talk" as const,
    title: "Talk to me",
    description: "Chat about which item needs attention first.",
    Icon: MessageCircle,
    tone: "blue"
  },
  {
    mode: "help" as const,
    title: "Help me",
    description: "Answers grounded in the approvals policy note.",
    Icon: CircleHelp,
    tone: "teal"
  },
  {
    mode: "teach" as const,
    title: "Teach me",
    description: "Step-by-step: how to review and act on an approval.",
    Icon: BookOpen,
    tone: "amber"
  },
  {
    mode: "greeting" as const,
    title: "Replay Greeting",
    description: "A fresh greeting for your current queue.",
    Icon: Play,
    tone: "rose"
  }
];

// Shows the assistant action buttons.
export function ActionCards({ onSelect }: { onSelect: (mode: Mode) => void }) {
  const devMode = useAssistantStore((s) => s.devMode);
  return (
    <div className="cards">
      {ACTIONS.map(({ mode, title, description, Icon, tone }) => (
        <button key={mode} type="button" className="card" onClick={() => onSelect(mode)}>
          <span className={`card-icon tone-${tone}`} aria-hidden="true">
            <Icon size={18} />
          </span>
          <span className="card-copy">
            <strong>{title}</strong>
            <small>{description}</small>
            {devMode && <code className="endpoint">POST /api/ai/{mode}</code>}
          </span>
        </button>
      ))}
    </div>
  );
}
