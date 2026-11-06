/**
 * Visible marker for anything created by the re-engagement agent
 * (records carry `applied_by_agent: true`).
 *
 * Render next to the title of an inbox notification, e.g.
 *   <AgentNudgeBadge item={notification} />
 */
export default function AgentNudgeBadge({ item }) {
  const applied = Boolean(item?.applied_by_agent ?? item?.appliedByAgent);
  if (!applied) return null;
  return (
    <span
      className="badge badge-agent"
      title="This message was created automatically by the re-engagement agent"
    >
      Applied by agent
    </span>
  );
}

export { AgentNudgeBadge };