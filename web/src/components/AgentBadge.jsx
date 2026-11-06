/**
 * Visible marker for anything the re-engagement agent created
 * (records carry applied_by_agent: true).
 *
 * Render it next to a notification title in the notifications tray / page:
 *   <AgentBadge item={notification} />
 */
export default function AgentBadge({ item, appliedByAgent }) {
  const applied =
    appliedByAgent === true ||
    (item && (item.applied_by_agent === true || item.appliedByAgent === true));
  if (!applied) return null;
  return (
    <span
      className="badge badge-agent"
      title="Sent automatically by the re-engagement agent"
      style={{
        marginLeft: '0.5rem',
        padding: '0.1rem 0.4rem',
        borderRadius: '0.5rem',
        fontSize: '0.75rem',
        lineHeight: 1.6,
        border: '1px solid currentColor',
        whiteSpace: 'nowrap'
      }}
    >
      Applied by agent
    </span>
  );
}

export { AgentBadge };