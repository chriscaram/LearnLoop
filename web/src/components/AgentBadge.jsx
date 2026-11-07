export default function AgentBadge({ item }) {
  const byAgent = item?.applied_by_agent === true || item?.appliedByAgent === true;
  if (!byAgent) return null;

  return (
    <span className="agent-badge" title="This message was created automatically by the re-engagement agent">
      Applied by agent
    </span>
  );
}