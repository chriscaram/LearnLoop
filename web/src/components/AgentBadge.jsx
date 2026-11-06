// Visible marker for anything the re-engagement agent created
// (records carry applied_by_agent: true).

export function isAppliedByAgent(item) {
  if (!item) return false;
  return item.applied_by_agent === true || item.appliedByAgent === true;
}

export function AgentBadge({ item, className = "" }) {
  if (item !== undefined && !isAppliedByAgent(item)) return null;
  return (
    <span className={`badge badge-agent ${className}`.trim()} title="Sent automatically by the re-engagement agent">
      Applied by agent
    </span>
  );
}

export default AgentBadge;