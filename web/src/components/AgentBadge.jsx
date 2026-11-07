/**
 * Visible marker for anything created by the re-engagement agent
 * (records carry `applied_by_agent: true`).
 *
 * Usage in the notifications tray / list item:
 *   <AgentBadge item={notification} />
 */
export default function AgentBadge({ item, className = "" }) {
  const applied = Boolean(item && (item.applied_by_agent || item.appliedByAgent));
  if (!applied) return null;
  return (
    <span className={`badge badge-agent ${className}`.trim()} title="Created automatically by the re-engagement agent">
      Applied by agent
    </span>
  );
}