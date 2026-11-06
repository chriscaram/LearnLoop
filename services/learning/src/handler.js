import { createHandler } from "@learnloop/shared/http";

import { routes } from "./routes.js";
import { sendReengagementNudges } from "./jobs/reengagement.js";

export const handler = createHandler({
  service: "learning",
  routes,
  jobs: {
    // daily 09:00 UTC - re-engagement nudge agent (flag ga-find_a431764685ac)
    reengagement: sendReengagementNudges
  }
});

export default handler;