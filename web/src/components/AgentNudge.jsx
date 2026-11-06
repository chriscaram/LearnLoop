/**
 * Provenance marker for messages created by the re-engagement agent
 * (finding find_a431764685ac, flag ga-find_a431764685ac).
 *
 * Usage in the notifications list / tray:
 *   import { AgentBadge } from '../components/AgentNudge.jsx'
 *   <AgentBadge notification={n} />
 */

export function isAppliedByAgent(notification) {
  if (!notification) return false;
  const meta = notification.metadata || notification.meta || {};
  return notification.applied_by_agent === true || meta.applied_by_agent === true;
}

export function AgentBadge({ notification }) {
  if (!isAppliedByAgent(notification)) return null;
  return (
    <span
      className="badge badge-agent"
      title="This message was drafted and sent automatically by the re-engagement agent"
      style={{
        display: 'inline-block',
        marginLeft: '0.5rem',
        padding: '0.1rem 0.45rem',
        borderRadius: '999px',
        border: '1px solid currentColor',
        fontSize: '0.72rem',
        lineHeight: 1.6,
        whiteSpace: 'nowrap'
      }}
    >
      Applied by agent
    </span>
  );
}

export default AgentBadge;