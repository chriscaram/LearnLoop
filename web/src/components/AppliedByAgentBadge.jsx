// Visible marker for inbox items created by the re-engagement agent
// (flag ga-find_a431764685ac). Render next to a notification title, e.g. in
// web/src/pages/Notifications.jsx and web/src/components/Bell.jsx:
//   <AppliedByAgentBadge notification={n} />
export function AppliedByAgentBadge({ notification }) {
  const applied = Boolean(
    notification?.applied_by_agent || notification?.metadata?.applied_by_agent
  );
  if (!applied) return null;
  return (
    <span
      className="badge badge-agent"
      title="This message was drafted and sent automatically by the re-engagement agent"
    >
      Applied by agent
    </span>
  );
}

export default AppliedByAgentBadge;
