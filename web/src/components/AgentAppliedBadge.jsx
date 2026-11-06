/**
 * Visible marker for anything created by the re-engagement agent
 * (records carry `applied_by_agent: true`).
 *
 * Use in the notifications list / Bell with one line, e.g.
 *   <AgentAppliedBadge item={notification} />
 */
export default function AgentAppliedBadge({ item, applied }) {
  const isAgent = applied ?? Boolean(item && (item.applied_by_agent || item.appliedByAgent));
  if (!isAgent) return null;

  return (
    <span
      className="badge badge-agent"
      title="This message was drafted and sent automatically by the re-engagement agent"
      style={{
        display: "inline-block",
        marginLeft: "0.5rem",
        padding: "0.1rem 0.45rem",
        borderRadius: "999px",
        border: "1px solid currentColor",
        fontSize: "0.72rem",
        lineHeight: 1.6,
        whiteSpace: "nowrap"
      }}
    >
      Applied by agent
    </span>
  );
}

export { AgentAppliedBadge };