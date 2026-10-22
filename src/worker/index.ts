import { createApp } from './app';
import { runAutomation } from './scheduler';
import type { AutomationEnv } from './automation';
const app = createApp();
export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: AutomationEnv) {
    await runAutomation(env, controller.scheduledTime);
  },
};
