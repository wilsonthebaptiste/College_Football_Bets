import { createApp } from './app';
import { runWarmers } from './cron/warm';
import type { Env } from './env';

const app = createApp();

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> =>
    app.fetch(request, env, ctx),

  /** The cron triggers in `wrangler.toml` (plan §5.4). See `cron/warm.ts`. */
  scheduled: (controller: ScheduledController, env: Env, ctx: ExecutionContext): void => {
    ctx.waitUntil(
      runWarmers(env, {
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
        defer: (work) => ctx.waitUntil(work),
      }),
    );
  },
} satisfies ExportedHandler<Env>;
