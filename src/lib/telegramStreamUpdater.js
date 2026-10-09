/**
 * Batches Telegram sendMessageDraft by GTWY delta count.
 * Keeps "Thinking…" (empty draft) until the first real answer text arrives —
 * never overwrites it with blank content.
 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class TelegramStreamUpdater {
  /**
   * @param {object} opts
   * @param {(text: string) => Promise<object>} opts.sendDraft
   * @param {number} [opts.chunkThreshold=1000]
   * @param {number} [opts.textLimit=4096]
   */
  constructor({ sendDraft, chunkThreshold = 1000, textLimit = 4096 }) {
    if (typeof sendDraft !== "function") {
      throw new Error("TelegramStreamUpdater requires sendDraft(text)");
    }
    this.sendDraft = sendDraft;
    this.chunkThreshold = Math.max(1, Number(chunkThreshold) || 1000);
    this.textLimit = textLimit;

    this.latestText = "";
    this.lastSent = "";
    this.chunksSinceFlush = 0;
    this.inFlight = false;
    this.dirty = false;
    this.closed = false;
    this.sentCount = 0;
    this.hasShownAnswer = false; // false → Thinking… still visible
    this._flushChain = Promise.resolve();
  }

  clip(text) {
    const t = String(text ?? "").trim();
    if (!t) return "";
    if (t.length <= this.textLimit) return t;
    return `${t.slice(0, this.textLimit - 1)}…`;
  }

  /**
   * Call on every GTWY delta with cleaned answer text (no reasoning).
   * Empty text is ignored so Thinking… is not cleared.
   */
  push(text) {
    if (this.closed) return;
    const clipped = this.clip(text);
    // No answer yet → keep Thinking… (do not send blank drafts)
    if (!clipped) return;

    this.latestText = clipped;
    this.chunksSinceFlush += 1;
    this.dirty = true;

    // First real answer: show immediately (kill the start→delta blank gap)
    if (!this.hasShownAnswer) {
      this.hasShownAnswer = true;
      this.chunksSinceFlush = 0;
      this.#enqueueFlush();
      return;
    }

    if (this.chunksSinceFlush >= this.chunkThreshold) {
      this.chunksSinceFlush = 0;
      this.#enqueueFlush();
    }
  }

  #enqueueFlush() {
    this._flushChain = this._flushChain.then(() => this.#flushOnce()).catch(() => {});
  }

  async #flushOnce() {
    if (this.closed) return;
    if (this.inFlight) {
      this.dirty = true;
      return;
    }
    if (!this.dirty) return;

    const toSend = this.latestText;
    // Never send empty — that replaces Thinking… with a blank bubble
    if (!toSend || toSend === this.lastSent) {
      this.dirty = false;
      return;
    }

    this.dirty = false;
    this.inFlight = true;
    try {
      const ok = await this.#sendWith429Retry(toSend);
      if (ok) {
        this.lastSent = toSend;
        this.sentCount += 1;
      } else {
        this.dirty = this.latestText !== this.lastSent;
      }
    } finally {
      this.inFlight = false;
    }

    if (!this.closed && this.dirty && this.latestText && this.latestText !== this.lastSent) {
      this.#enqueueFlush();
    }
  }

  async #sendWith429Retry(text) {
    for (;;) {
      const result = await this.sendDraft(text);
      if (result?.ok) return true;
      if (result?.error_code === 429) {
        const wait = Number(result?.parameters?.retry_after || 3);
        console.warn("[tg stream] 429 — retry after", wait, "s");
        await sleep(wait * 1000);
        continue;
      }
      console.error("[tg stream] draft failed:", result?.description || result);
      return false;
    }
  }

  async finish(finalText) {
    if (finalText != null) {
      const clipped = this.clip(finalText);
      if (clipped) {
        this.latestText = clipped;
        this.dirty = this.latestText !== this.lastSent;
        this.hasShownAnswer = true;
      }
    }

    while (this.dirty || this.inFlight) {
      if (!this.inFlight && this.dirty) {
        await this.#flushOnce();
      } else {
        await sleep(20);
      }
    }

    if (this.latestText && this.latestText !== this.lastSent) {
      this.inFlight = true;
      try {
        const ok = await this.#sendWith429Retry(this.latestText);
        if (ok) {
          this.lastSent = this.latestText;
          this.sentCount += 1;
        }
      } finally {
        this.inFlight = false;
      }
    }

    this.closed = true;
    return {
      sentCount: this.sentCount,
      text: this.latestText,
      lastSent: this.lastSent,
    };
  }

  stop() {
    this.closed = true;
  }
}
