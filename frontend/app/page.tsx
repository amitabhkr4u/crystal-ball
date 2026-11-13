import { ApprovalsList } from "../components/ApprovalsList";
import { ChatPanel } from "../components/ChatPanel";
import { LoginBar } from "../components/LoginBar";
import { LiveAlertFeed } from "../components/LiveAlertFeed";

// Renders the dashboard page with alerts, approvals and the assistant.
export default function Page() {
  return (
    <>
      <main className="page" id="main">
        <header className="command-header">
          <div>
            <span className="eyebrow">CRYSTAL BALL · COMMAND CENTRE</span>
            <h1>Operations overview</h1>
            <p className="muted">Approval workflow and tenant-scoped AI alert operations.</p>
          </div>
        </header>
        <LoginBar />
        <LiveAlertFeed />
        <ApprovalsList />
      </main>
      <ChatPanel />
    </>
  );
}
