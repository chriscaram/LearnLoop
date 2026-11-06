/**
 * Visible marker for anything the re-engagement agent created
 * (finding find_a431764685ac). Records carry `applied_by_agent: true`.
 *
 * Usage in the notifications list / bell tray:
 *   import AgentBadge from "../components/AgentBadge.jsx";
 *   <AgentBadge item={notification} />
 */
export default function AgentBadge({ item, className = "" }) {
  const applied =
    item?.applied_by_agent === true || item?.appliedByAgent === true;
  if (!applied) return null;

  return (
    <span
      className={`agent-badge ${className}`.trim()}
      title="This message was drafted and sent automatically by the re-engagement agent"
      style={{
        display: "inline-block",
        marginLeft: "0.5rem",
        padding: "0.1rem 0.4rem",
        borderRadius: "999px",
        border: "1px solid currentColor",
        fontSize: "0.75rem",
        lineHeight: 1.4,
        whiteSpace: "nowrap"
      }}
    >
      Applied by agent
    </span>
  );
}