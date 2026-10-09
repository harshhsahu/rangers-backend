import crypto from "crypto";
import { getRangerSchedulesCollection } from "../models/rangerSchedule.model.js";
import { getChannelDetailsCollection } from "../models/channelDetails.model.js";
import { streamGtwyCompletion, humanizeGtwyError } from "./gtwyChannelHelpers.js";
import { decryptSecret } from "./crypto.js";
import { sendLongMessage } from "./telegramApi.js";

/**
 * Run a schedule row the same way EasyCron would: treat its message as an
 * inbound completion, optionally deliver to Telegram, then write last_run.
 *
 * Callers decide whether a disabled row should run (cron skips; "Run now"
 * for testing does not).
 */
export async function executeScheduleRun(row) {
  const schedules = await getRangerSchedulesCollection();
  const startedAt = Date.now();

  // Every run (cron or test "Run now") gets its own thread so history stays
  // separate and prior context is never reused across executions.
  const threadId = `cron_${String(row._id)}_${crypto.randomBytes(4).toString("hex")}`;

  try {
    const { text } = await streamGtwyCompletion({
      versionId: row.version_id,
      userText: row.message,
      threadId,
      logPrefix: "[cron]",
    });

    if (row.delivery?.type === "telegram" && row.delivery.chat_id) {
      try {
        const channels = await getChannelDetailsCollection();
        const channel = await channels.findOne({ version_id: row.version_id });
        const botToken = channel?.telegram?.botToken ? decryptSecret(channel.telegram.botToken) : null;
        if (botToken) {
          await sendLongMessage(botToken, row.delivery.chat_id, text || "…");
        } else {
          console.error("[cron] telegram delivery skipped: no bot token", { schedule: String(row._id) });
        }
      } catch (error) {
        console.error("[cron] telegram delivery failed", {
          schedule: String(row._id),
          error: error?.message || error,
        });
      }
    }

    await schedules.updateOne(
      { _id: row._id },
      {
        $set: {
          last_run: {
            at: new Date(),
            ok: true,
            duration_ms: Date.now() - startedAt,
            thread_id: threadId,
            // Kept short: this is a status line in the UI, not a transcript.
            preview: (text || "").slice(0, 400),
          },
          fail_streak: 0,
        },
        $inc: { run_count: 1 },
      }
    );
  } catch (error) {
    console.error("[cron] run failed", { schedule: String(row._id), error: error?.message || error });
    await schedules.updateOne(
      { _id: row._id },
      {
        $set: {
          last_run: {
            at: new Date(),
            ok: false,
            duration_ms: Date.now() - startedAt,
            thread_id: threadId,
            error: humanizeGtwyError(String(error?.message || error)).slice(0, 500),
          },
        },
        $inc: { run_count: 1, fail_streak: 1 },
      }
    );
  }
}
